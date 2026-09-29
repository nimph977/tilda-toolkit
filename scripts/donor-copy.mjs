/**
 * Перенос страницы донора через буфер аккаунта (`donor copy`): чистая логика — состав страницы,
 * сверка состава и порядка, план шагов; оркестратор ведёт два драйвера (тестовый проект и донор)
 * и пишет запись переноса в TILDA_BASELINE_DIR/transfer/<приёмник>/<метка времени>.json.
 *
 * Инварианты (AGENTS.md): проект донора только читается — состав страницы донора
 * сверяется до копирования, после копирования и после вставки, расхождение останавливает
 * команду с громкой ошибкой; в сессии донора allow-список записи содержит только приёмник
 * и только на время вставки; `--replace` удаляет блоки приёмника лишь после снимков.
 * Драйверы приходят снаружи: модуль `lib/browser.mjs` не импортирует.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import * as snapshot from './snapshot.mjs';
import { pageTitleFor } from './page-ops.mjs';

const log = createLogger('donor-copy');

/** Страницы больше этого числа блоков одним запросом не проверялись (проба: 31 блок). */
export const PASTE_CHECKED_LIMIT = 60;

export class DonorCopyError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'DonorCopyError';
    this.code = code;
    this.exitCode = 1;
    Object.assign(this, data);
  }
}

export const COPY_REASONS = {
  targetNotEmpty: (n) => `на приёмнике уже ${n} блоков — повторите с --replace или укажите пустую страницу --to`,
  zeroOnTarget: 'на приёмнике есть Zero Block (396): удаление и снимок Zero Block командой не предусмотрены',
  donorChanged: 'состав страницы донора изменился во время переноса — остановлено; проверьте страницу донора вручную',
  orderMismatch: 'порядок или состав блоков на приёмнике не совпал с донором',
  sourceEmpty: 'на странице донора нет блоков',
  protectedTarget: (id) => `страница ${id} защищена (TILDA_PROTECTED_PAGES)`,
  replaceIncomplete: (n) => `после удаления на приёмнике осталось ${n} блоков — перенос не начат`,
};

const toHidden = (v) => v === true || v === 'y';

/** Состав страницы из listRecords (hidden: boolean) или из pasteFromBuffer.records (hidden: 'y'|'n'). */
export function composition(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({ recordid: String(r.recordid), tplid: String(r.tplid ?? ''), hidden: toHidden(r.hidden) }));
}

/** Сравнение составов как последовательностей recordid. */
export function sameComposition(a, b) {
  const ida = a.map((r) => r.recordid);
  const idb = b.map((r) => r.recordid);
  const setA = new Set(ida);
  const setB = new Set(idb);
  const added = idb.filter((id) => !setA.has(id));
  const removed = ida.filter((id) => !setB.has(id));
  const sameSet = added.length === 0 && removed.length === 0;
  const reordered = sameSet && ida.some((id, i) => id !== idb[i]);
  return { equal: sameSet && !reordered, added, removed, reordered };
}

/** Порядок tplid и флаги hidden приёмника против источника (recordid приёмника новые). */
export function orderMatches(source, target) {
  const expected = source.map((r) => r.tplid);
  const actual = target.map((r) => r.tplid);
  const hiddenMismatch = [];
  const sameLength = expected.length === actual.length;
  let equal = sameLength;
  for (let i = 0; i < Math.min(expected.length, actual.length); i += 1) {
    if (expected[i] !== actual[i]) equal = false;
    if (source[i].hidden !== target[i].hidden) hiddenMismatch.push(i);
  }
  return { equal: equal && hiddenMismatch.length === 0, expected, actual, hiddenMismatch };
}

/** План шагов для --dry-run и итога. */
export function copyPlan({ source, target, replace }) {
  const steps = ['inventory-target'];
  if (replace && target.length) steps.push('snapshot-target', 'replace-delete');
  steps.push('inventory-source', 'copy', 'verify-source', 'paste', 'verify-source', 'inventory-target', 'verify-order');
  return { steps, blocks: source.length, replaced: replace ? target.length : 0 };
}

function transferPath(targetPageid, now, baseDir) {
  const dir = join(baseDir ?? baselineDir(), 'transfer', String(targetPageid));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${now.toISOString().replace(/[:.]/g, '-')}.json`);
}

/**
 * Оркестратор переноса. Driver = { call(fn, args, opts), openEditor(pageid), setWritable(list) };
 * у тестового драйвера необязательны editorState/setTitle (заголовок) и pageAlias/setAlias (адрес
 * приёмника по params.alias — адрес страницы донора).
 * @returns {{ source, target, blocks, pasted, replaced, verify: { donorUnchanged, orderMatches, hiddenMismatch }, record, dryRun, plan, title, alias }}
 */
export async function copyDonorPage({ test, donor }, params) {
  const { sourcePageid, targetPageid, replace = false, dryRun = false, protectedPages = [], label = null, baseDir, now = new Date() } = params;
  const source = String(sourcePageid);
  const target = String(targetPageid);
  if (protectedPages.map(String).includes(target)) throw new DonorCopyError('PROTECTED_TARGET', COPY_REASONS.protectedTarget(target), { target });
  log.info('copyDonorPage', 'начало', { label, source, target, replace, dryRun });

  await test.openEditor(target);
  const before = composition(await test.call('listRecords'));
  if (before.length && !replace) throw new DonorCopyError('TARGET_NOT_EMPTY', COPY_REASONS.targetNotEmpty(before.length), { target, blocks: before.length });
  if (replace && before.some((r) => r.tplid === '396')) throw new DonorCopyError('ZERO_ON_TARGET', COPY_REASONS.zeroOnTarget, { target });

  await donor.openEditor(source);
  const src = composition(await donor.call('listRecords'));
  if (!src.length) throw new DonorCopyError('SOURCE_EMPTY', COPY_REASONS.sourceEmpty, { source });
  log.debug('copyDonorPage', 'состав донора', { source, tplids: src.map((r) => r.tplid) });
  if (src.length > PASTE_CHECKED_LIMIT) log.warn('copyDonorPage', 'страница больше проверенного размера одной вставки', { blocks: src.length, checked: PASTE_CHECKED_LIMIT });

  const plan = copyPlan({ source: src, target: before, replace });
  if (dryRun) {
    log.info('copyDonorPage', 'dry-run: без записи', { blocks: src.length, steps: plan.steps.length });
    return { source, target, blocks: src.length, pasted: 0, replaced: 0, verify: null, record: null, dryRun: true, plan, before: before.length };
  }

  if (replace && before.length) {
    for (const r of before) {
      const data = await test.call('readRecordSnapshot', [target, r.recordid]);
      snapshot.save({ kind: 'record', pageid: target, recordid: r.recordid, data, source: 'donor copy --replace' }, baseDir ? { baseDir } : undefined);
    }
    for (const r of before) await test.call('deleteRecord', [target, r.recordid], { attempts: 1 });
    await test.openEditor(target);
    const left = composition(await test.call('listRecords'));
    if (left.length) throw new DonorCopyError('REPLACE_INCOMPLETE', COPY_REASONS.replaceIncomplete(left.length), { target, left: left.map((r) => r.recordid) });
    log.info('copyDonorPage', 'приёмник очищен после снимков', { target, removed: before.length });
  }

  await donor.call('copySelectedToBuffer', [source, src.map((r) => r.recordid)], { attempts: 1 });
  log.info('copyDonorPage', 'copy: скопировано в буфер', { count: src.length });

  const assertDonorUnchanged = async (stage) => {
    await donor.openEditor(source);
    const now_ = composition(await donor.call('listRecords'));
    const cmp = sameComposition(src, now_);
    if (!cmp.equal) {
      log.error('copyDonorPage', 'состав страницы донора изменился', { stage, added: cmp.added, removed: cmp.removed, reordered: cmp.reordered });
      throw new DonorCopyError('DONOR_CHANGED', COPY_REASONS.donorChanged, { stage, ...cmp });
    }
    log.debug('copyDonorPage', 'состав донора не изменился', { stage, blocks: now_.length });
  };
  await assertDonorUnchanged('after-copy');

  await donor.setWritable([target]);
  let pasted;
  try {
    pasted = await donor.call('pasteFromBuffer', [target, ''], { attempts: 1 });
  } finally {
    await donor.setWritable([]);
  }
  const pastedRecords = composition(pasted?.records);
  log.info('copyDonorPage', 'paste: вставлено', { pasted: pastedRecords.length });
  await assertDonorUnchanged('after-paste');

  await test.openEditor(target);
  const result = composition(await test.call('listRecords'));
  const order = orderMatches(src, result);
  const ok = pastedRecords.length === src.length && order.equal;
  if (ok) log.info('copyDonorPage', 'verify: порядок совпал', { blocks: result.length });
  else log.error('copyDonorPage', COPY_REASONS.orderMismatch, { expected: order.expected, actual: order.actual, hiddenMismatch: order.hiddenMismatch, pasted: pastedRecords.length });

  // Заголовок по метке: только если приёмник ещё «Blank page» — владелец мог назвать страницу сам.
  let title = null;
  if (label && typeof test.editorState === 'function' && typeof test.setTitle === 'function') {
    try {
      // document.title редактора — «Tilda: <заголовок>»; префикс отбрасывается.
      const current = String((await test.editorState())?.title ?? '').replace(/^tilda:\s*/i, '').trim();
      if (/^blank page$/i.test(current) || params.forceTitle) {
        const wanted = pageTitleFor({ label, role: params.role, donorTitle: params.donorTitle });
        await test.setTitle(target, wanted);
        title = 'записан';
        log.info('copyDonorPage', 'заголовок приёмника записан', { target, length: wanted.length });
      } else {
        title = 'оставлен';
        log.debug('copyDonorPage', 'заголовок приёмника не Blank page — оставлен', { target });
      }
    } catch (e) {
      title = `не записан: ${String(e.message || e).slice(0, 120)}`;
      log.warn('copyDonorPage', 'заголовок приёмника не записан', { target, error: String(e.message || e).slice(0, 160) });
    }
  }

  // Адрес как у страницы донора: только если у приёмника адреса ещё нет — адрес, заданный
  // владельцем, не переписывается; занятый адрес — причина, перенос не откатывается.
  let alias = null;
  if (params.alias && typeof test.pageAlias === 'function' && typeof test.setAlias === 'function') {
    try {
      const current = String((await test.pageAlias(target)) ?? '').trim();
      if (!current) {
        await test.setAlias(target, params.alias);
        alias = 'записан';
        log.info('copyDonorPage', 'адрес приёмника записан', { target });
      } else {
        alias = 'оставлен';
        log.debug('copyDonorPage', 'у приёмника уже есть адрес — оставлен', { target });
      }
    } catch (e) {
      alias = `не записан: ${String(e.message || e).slice(0, 120)}`;
      log.warn('copyDonorPage', 'адрес приёмника не записан', { target, code: e.code, error: String(e.message || e).slice(0, 160) });
    }
  }

  const record = transferPath(target, now, baseDir);
  writeFileSync(record, `${JSON.stringify({
    at: now.toISOString(),
    label,
    source: { pageid: source, blocks: src },
    target: { pageid: target, before, after: result },
    pasted: pastedRecords,
    replaced: replace ? before.length : 0,
    verify: { donorUnchanged: true, orderMatches: order.equal, hiddenMismatch: order.hiddenMismatch, pastedCount: pastedRecords.length },
  }, null, 2)}\n`);
  log.info('copyDonorPage', 'запись переноса', { record: record.replace(/\\/g, '/') });
  return {
    source, target, blocks: src.length, pasted: pastedRecords.length, replaced: replace ? before.length : 0,
    verify: { donorUnchanged: true, orderMatches: order.equal, hiddenMismatch: order.hiddenMismatch, expected: order.expected, actual: order.actual },
    record: record.replace(/\\/g, '/'), dryRun: false, plan, ok, title, alias,
  };
}
