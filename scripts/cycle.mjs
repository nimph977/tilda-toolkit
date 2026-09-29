/**
 * Цикл «инвентарь → снимок → prepare → запись → перечитать → verify» в одном процессе
 * — раньше шаги 2–6 из SKILL.md делались руками через Playwright MCP.
 *
 * Транспорт абстрагирован драйвером `{ call(fn, args), reload() }`: в проде это
 * `browserDriver(session, pageid)` поверх scripts/lib/browser.mjs, в тестах — подставной объект
 * без сети. Локальный слой (prepare/verify/snapshot) не меняется.
 *
 *   inventory(driver, pageid)              → список блоков, файл records/<pageid>/_inventory.json
 *   snapshotBlocks(driver, pageid, targets) → снимки zero|records/<pageid>/<recordid>.json
 *   apply(driver, plan)                    → полный цикл; результат { written, verify, created, journal, … }
 *   rollback(driver, recordPath)           → обратный план из записи журнала тем же циклом
 *   verifyPlan(driver, plan)               → перечитать затронутые блоки и сверить
 *   mapBlocks(driver, pageid)              → карта блоков: свежий инвентарь → вид страницы с подписями → файл
 *
 * Защита живой главной проверяется и здесь (protectedPages из lib/paths.mjs), и в браузерном
 * слое — ни одна из двух не ослабляется.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir, protectedPages } from './lib/paths.mjs';
import { save as saveSnapshot, load as loadSnapshot } from './snapshot.mjs';
import { prepare, verify, resolveBlock, RECORD_SKIP_FIELDS, applyImageUpload, buildBlockSpecs } from './apply-plan.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { buildRecord, writeRecord, readRecord, reversePlan } from './journal.mjs';
import { upload } from './upload.mjs';
import { shotPage, previewUrl } from './shot.mjs';
import { mapPage } from './map-blocks.mjs';
import { collectUrls, checkUrls } from './link-check.mjs';
import { editorUrl } from './lib/browser.mjs';

const log = createLogger('cycle');

/** Поля модели Zero Block, правка которых требует скриншота: геометрия, размер, типографика, выравнивание. */
export const LAYOUT_FIELDS = /^(top|left|width|height|fontsize|lineheight|letterspacing|align|valign|textfit|widthmode|heightmode|container|margin|padding|ab_height)(-res-\d+)?$/;

function paths(opts) {
  const baseDir = opts.baseDir || baselineDir();
  return { baseDir, out: opts.out || join(baseDir, 'payload'), reread: opts.reread || join(baseDir, 'reread') };
}

function writeJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return path;
}

function assertWritable(pageid, fn) {
  if (protectedPages().includes(String(pageid))) {
    log.error(fn, 'страница защищена от записи (TILDA_PROTECTED_PAGES)', { pageid: String(pageid) });
    throw new Error(`PROTECTED_PAGE ${pageid}`);
  }
}

/**
 * Драйвер над собственным браузером. `reload()` открывает редактор заново и ставит слои —
 * нужно после blockHidden (видимость видна только по свежему DOM) и после сборки блоков.
 */
export function browserDriver(session, pageid, { layers = ['tilda-zero', 'tilda-page', 'tilda-copy', 'tilda-upload'], browser } = {}) {
  const journal = [];
  return {
    journal,
    call: (fn, args = [], opts = {}) => browser.call(session.page, fn, args, { journal, ...opts }),
    reload: () => browser.openEditor(session, pageid, { layers }),
    /** Скриншоты вида страницы (десктоп и мобайл); после них редактор открывается заново. */
    shot: async (opts = {}) => {
      try {
        return await shotPage(session.page, pageid, opts);
      } finally {
        await browser.openEditor(session, pageid, { layers });
      }
    },
    /** Карта блоков: вид страницы с подписями по свежему инвентарю; после — снова редактор. */
    mapBlocks: async (inventory, opts = {}) => {
      try {
        return await mapPage(session.page, pageid, inventory, opts);
      } finally {
        await browser.openEditor(session, pageid, { layers });
      }
    },
    /** HTML вида страницы (для проверки ссылок); после — снова редактор. */
    pageHtml: async () => {
      try {
        await session.page.goto(previewUrl(pageid), { waitUntil: 'load', referer: editorUrl(pageid) + '&previewmode=yes' });
        await session.page.waitForTimeout(1500);
        return { url: session.page.url(), html: await session.page.content() };
      } finally {
        await browser.openEditor(session, pageid, { layers });
      }
    },
    /**
     * Сырой HTML предпросмотра страницы — тело ответа навигации, до скриптов (проба: он размечен
     * как публикация). После — снова редактор.
     */
    pageRawHtml: async () => {
      try {
        await session.page.goto('about:blank');
        const resp = await session.page.goto(previewUrl(pageid), { waitUntil: 'load', referer: editorUrl(pageid) + '&previewmode=yes' });
        return { url: session.page.url(), html: resp ? await resp.text() : '' };
      } finally {
        await browser.openEditor(session, pageid, { layers });
      }
    },
    /** Скриншот элемента редактора по селектору в файл; возвращает путь. */
    screenshot: async (selector, path) => {
      mkdirSync(join(path, '..'), { recursive: true });
      await session.page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
      await session.page.locator(selector).first().screenshot({ path });
      return path;
    },
  };
}

/** Инвентарь блоков страницы: listRecords() → records/<pageid>/_inventory.json. */
export async function inventory(driver, pageid, opts = {}) {
  const { baseDir } = paths(opts);
  const list = await driver.call('listRecords', []);
  const path = writeJson(join(baseDir, 'records', String(pageid), '_inventory.json'), list);
  log.info('inventory', 'инвентарь снят', { pageid: String(pageid), records: list.length, zero: list.filter((r) => r.zeroIndex).length, hidden: list.filter((r) => r.hidden).length, path });
  return list;
}

/**
 * Блоки, снимки которых нужны плану до записи: адресуемые операциями `set`/`field` на странице
 * плана и источники операций `addZero`/`addRecord` (могут лежать на другой странице).
 * blockHidden снимка не требует — сверяется по инвентарю.
 */
export function planTargets(plan, opts = {}) {
  const { baseDir } = paths(opts);
  const pageid = String(plan.page);
  const seen = new Map();
  const add = (t) => seen.set(`${t.kind}:${t.page}:${t.recordid}`, t);
  (plan.ops || []).forEach((op, i) => {
    if (op.newRecord) return; // блок из полей: источника нет, снимок не нужен
    if (op.addZero || op.addRecord) {
      const spec = op.addZero || op.addRecord;
      const page = String((spec.source && spec.source.page) || (plan.source && plan.source.page) || '');
      const recordid = String((spec.source && spec.source.recordid) || '');
      if (!page || !recordid) throw new Error(`op#${i}: нужен source.page и source.recordid`);
      add({ kind: op.addZero ? 'zero' : 'record', page, recordid, role: 'source' });
      return;
    }
    if (op.blockHidden !== undefined || op.moveBlock || op.setOrder) return;
    const recordid = resolveBlock(op.block || {}, pageid, { baseDir });
    add({ kind: op.field || op.listSet ? 'record' : 'zero', page: pageid, recordid, role: 'target' });
  });
  return [...seen.values()];
}

/**
 * Темп чтений при длинных списках: между чтениями блоков пауза READ_DELAY_MS,
 * когда блоков больше READ_PACE_FROM; короткие циклы apply (1–5 блоков) не замедляются.
 */
export const READ_DELAY_MS = 2500;
export const READ_PACE_FROM = 5;
async function paceRead(i, total, opts = {}) {
  const delay = opts.delayMs ?? (total > READ_PACE_FROM ? READ_DELAY_MS : 0);
  if (i > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
}

/** Снимки блоков через браузер: Zero Block — getZero, стандартный — readRecordSnapshot (обе вкладки). */
export async function snapshotBlocks(driver, targets, opts = {}) {
  const { baseDir } = paths(opts);
  const saved = [];
  for (const [i, t] of targets.entries()) {
    await paceRead(i, targets.length, opts);
    const started = Date.now();
    const data = t.kind === 'zero' ? await driver.call('getZero', [t.page, t.recordid]) : await driver.call('readRecordSnapshot', [t.page, t.recordid]);
    const r = saveSnapshot({ kind: t.kind, pageid: t.page, recordid: t.recordid, data, source: opts.source || 'cycle' }, { baseDir });
    log.debug('snapshotBlocks', 'снимок снят', { kind: t.kind, page: t.page, recordid: t.recordid, ms: Date.now() - started, backup: r.backup ? 'да' : 'нет' });
    saved.push({ ...t, path: r.path, backup: r.backup });
  }
  log.info('snapshotBlocks', 'снимки сняты', { blocks: saved.length });
  return saved;
}

/** Перечитать затронутые блоки в reread/<pageid>/: Zero → <recordid>.json, стандартный → <recordid>.record.json. */
async function rereadBlocks(driver, pageid, items, opts) {
  const { reread } = paths(opts);
  const dir = join(reread, String(pageid));
  const files = [];
  for (const [i, it] of items.entries()) {
    await paceRead(i, items.length, opts);
    const started = Date.now();
    if (it.kind === 'zero') {
      const model = await driver.call('getZero', [pageid, it.recordid]);
      files.push(writeJson(join(dir, `${it.recordid}.json`), model));
    } else {
      const snap = await driver.call('readRecordSnapshot', [pageid, it.recordid]);
      // Код HTML-блока дочитывается отдельно, в снимок — декодированным (`t123code`).
      if (it.code) {
        const t = await driver.call('getT123Code', [pageid, '', it.recordid]);
        snap.t123code = t?.code ?? '';
      }
      files.push(writeJson(join(dir, `${it.recordid}.record.json`), snap));
    }
    log.debug('rereadBlocks', 'перечитан', { kind: it.kind, recordid: it.recordid, ms: Date.now() - started });
  }
  return files;
}

/** Записать один payload через браузерный слой. Возвращает ответ слоя. */
async function writePayload(driver, p, plan) {
  const started = Date.now();
  let result;
  if (p.kind === 'zero') result = await driver.call('saveZero', [p.pageid, p.recordid, p.model]);
  // formContent: 'reference' разрешает слою записать formmsgurl; получатели запрещены всегда.
  else if (p.kind === 'record') result = await driver.call('saveField', [p.pageid, p.recordid, p.field, String(p.value), ...(p.formContent === 'reference' ? [{ allowFormContent: true }] : [])]);
  else if (p.kind === 'list') result = await driver.call('saveRecordFull', [p.pageid, p.recordid, p.fields]);
  else if (p.kind === 'sort') result = await driver.call('saveRecordsSort', [p.pageid, p.order]);
  else if (p.kind === 'block') result = await driver.call('setBlockHidden', [p.pageid, p.recordid, p.hidden]);
  else throw new Error(`неизвестный payload: ${p.kind}`);
  log.debug('writePayload', 'записано', { kind: p.kind, recordid: p.recordid, field: p.field, ms: Date.now() - started, result: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 80) });
  return result;
}

/** Сборка блоков-копий одним вызовом buildBlocks; журнал → reread/<pageid>/_built.json. */
async function buildCreated(driver, pageid, createPayloads, plan, opts) {
  const { reread } = paths(opts);
  const blocks = buildBlockSpecs(createPayloads);
  const startAfter = String(plan.startAfter || '');
  const started = Date.now();
  const journal = await driver.call('buildBlocks', [pageid, blocks, { startAfter }]);
  const path = writeJson(join(reread, String(pageid), '_built.json'), journal);
  log.info('buildCreated', 'сборка блоков завершена', { blocks: blocks.length, ok: journal.ok, failed: journal.failed, ms: Date.now() - started, path });
  return journal;
}

/** Затрагивает ли план геометрию, размер, типографику или выравнивание (тогда после verify нужен скриншот). */
export function touchesLayout(plan) {
  return (plan.ops || []).some((op) => op.set && Object.keys(op.set).some((f) => LAYOUT_FIELDS.test(f)));
}

/**
 * Полный цикл одного плана. Возвращает короткий итог:
 * { pageid, ops, payloads, written, created: [{id, recordid, zeroIndex, tplid}], verify: problems, dryRun, layout }.
 *
 * @param {object} driver   { call, reload }
 * @param {object} plan     план операций (scripts/plans/README.md)
 * @param {object} opts     { baseDir, out, reread, dryRun, emitCalls, skipInventory }
 */
export async function apply(driver, plan, opts = {}) {
  const pageid = String(plan.page);
  assertWritable(pageid, 'apply');
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) throw new Error('план без операций');
  const { baseDir, out, reread } = paths(opts);
  const t0 = Date.now();
  log.info('apply', 'старт цикла', { pageid, ops: plan.ops.length, dryRun: Boolean(opts.dryRun) });

  // 1. Свежий инвентарь — по нему zeroIndex превращается в recordid (старый список опасен).
  const before = { inventory: opts.skipInventory ? JSON.parse(readFileSync(join(baseDir, 'records', pageid, '_inventory.json'), 'utf8')) : await inventory(driver, pageid, { baseDir }), records: {} };

  // 2. Снимки до записи. Снимки стандартных блоков нужны журналу как `from`.
  const targets = planTargets(plan, { baseDir });
  await snapshotBlocks(driver, targets, { baseDir, source: 'cycle.apply' });
  for (const t of targets) if (t.kind === 'record' && t.page === pageid) before.records[t.recordid] = loadSnapshot({ kind: 'record', pageid, recordid: t.recordid }, { baseDir });
  let summaryUploads = [];

  // 2b. Файлы с диска: `set.image.file` → загрузка на CDN из Node, в план подставляется
  // готовый {img, filewidth, fileheight}; base64 через контекст агента не проходит.
  const uploads = [];
  for (const op of plan.ops) {
    const spec = op.set && op.set.image;
    if (!spec || typeof spec !== 'object' || !spec.file) continue;
    if (opts.dryRun) {
      log.info('apply', 'dry-run: файл не загружается', { file: spec.file });
      continue;
    }
    const r = await upload(driver, spec.file);
    uploads.push({ file: spec.file, url: r.cdnUrl, width: r.width, height: r.height });
    op.set.image = r.image;
  }
  // Картинки newRecord: файл → CDN → URL в fields/cards до prepare (иначе в payload их не будет).
  for (const op of plan.ops) {
    const imgs = op.newRecord && Array.isArray(op.newRecord.images) ? op.newRecord.images : [];
    for (const im of imgs) {
      if (!im.file || im.url) continue;
      if (opts.dryRun) {
        log.info('apply', 'dry-run: файл не загружается', { file: im.file });
        continue;
      }
      const r = await upload(driver, im.file);
      uploads.push({ file: im.file, url: r.cdnUrl, width: r.width, height: r.height });
      applyImageUpload(op, im, r);
    }
  }
  summaryUploads = uploads;

  // 3. prepare — локально, без сети.
  const payloads = prepare(plan, { baseDir, out, emitCalls: Boolean(opts.emitCalls) });
  const changes = payloads.filter((p) => p.kind === 'zero').reduce((n, p) => n + (p.changes?.length ?? 0), 0);
  log.info('apply', 'payload подготовлен', { payloads: payloads.length, zeroChanges: changes, ms: Date.now() - t0 });
  const summary = { pageid, ops: plan.ops.length, payloads: payloads.length, written: 0, created: [], verify: [], dryRun: Boolean(opts.dryRun), layout: touchesLayout(plan), journal: null, uploads: summaryUploads, shots: [], ms: 0 };
  summary.diff = payloads.flatMap((p) =>
    p.kind === 'zero'
      ? p.changes.map((c) => ({ recordid: p.recordid, key: c.key, field: c.field, from: c.from, to: c.to }))
      : p.kind === 'record'
        ? [{ recordid: p.recordid, field: p.field, to: p.value }]
        : p.kind === 'list'
          ? p.changes.map((c) => ({ recordid: p.recordid, list: c.op, lid: c.lid, field: c.field, from: c.from, to: c.to }))
        : p.kind === 'sort'
          ? p.moves.map((m) => ({ recordid: m.recordid, sort: true, from: m.from, to: m.to }))
        : p.kind === 'block'
          ? [{ recordid: p.recordid, blockHidden: p.hidden }]
          : p.mode === 'new'
            ? [{ create: p.id, tplid: p.tplid, fields: p.fields.length }]
            : [{ create: p.id, source: `${p.source.page}/${p.source.recordid}`, tplid: p.tplid }],
  );
  if (opts.dryRun) {
    log.info('apply', 'dry-run: записи не было', { payloads: payloads.length });
    summary.ms = Date.now() - t0;
    return summary;
  }

  // 4. Запись. Порядок: сначала создание блоков (их recordid нужен свежему инвентарю), затем правки.
  const createPayloads = payloads.filter((p) => p.kind === 'create');
  const editPayloads = payloads.filter((p) => p.kind !== 'create');
  let built = null;
  if (createPayloads.length) {
    built = await buildCreated(driver, pageid, createPayloads, plan, { reread });
    if (built.failed) log.error('apply', 'часть блоков не собрана', { failed: built.failed, first: built.built.find((b) => b.status !== 'ok') });
  }
  for (const p of editPayloads) {
    await writePayload(driver, p, plan);
    summary.written += 1;
  }
  summary.written += built ? built.ok : 0;

  // 5. Перечитать. blockHidden и сборка требуют перезагрузки редактора: DOM и слои заново.
  const needReload = editPayloads.some((p) => p.kind === 'block' || p.kind === 'sort') || Boolean(built);
  if (needReload) {
    log.debug('apply', 'перезагрузка редактора перед перечитыванием', { reason: built ? 'сборка блоков' : 'blockHidden' });
    await driver.reload();
  }
  const rereadItems = editPayloads.filter((p) => p.kind !== 'block' && p.kind !== 'sort').map((p) => ({ kind: p.kind === 'zero' ? 'zero' : 'record', recordid: p.recordid }));
  if (built) {
    for (const b of built.built) if (b.status === 'ok') rereadItems.push({ kind: b.kind === 'zero' || String(b.tplid) === '396' ? 'zero' : 'record', recordid: b.recordid, created: b.id, ...(String(b.tplid) === '131' ? { code: true } : {}) });
  }
  await rereadBlocks(driver, pageid, rereadItems, { reread });
  if (needReload) {
    // Свежий инвентарь после перезагрузки: для сверки blockHidden и для zeroIndex созданных блоков.
    const inv = await driver.call('listRecords', []);
    writeJson(join(reread, pageid, '_inventory.json'), inv);
    writeJson(join(baseDir, 'records', pageid, '_inventory.json'), inv);
    if (built) {
      for (const b of built.built) {
        if (b.status !== 'ok') continue;
        const row = inv.find((r) => String(r.recordid) === String(b.recordid));
        summary.created.push({ id: b.id, recordid: b.recordid, tplid: b.tplid, zeroIndex: row ? row.zeroIndex : null, order: row ? row.order : null });
      }
      // Снимки созданных блоков — иначе следующий план не сможет их адресовать (prepare → NO_SNAPSHOT).
      const createdTargets = summary.created.map((c) => ({ kind: String(c.tplid) === '396' ? 'zero' : 'record', page: pageid, recordid: c.recordid }));
      for (const t of createdTargets) {
        const file = join(reread, pageid, t.kind === 'zero' ? `${t.recordid}.json` : `${t.recordid}.record.json`);
        saveSnapshot({ kind: t.kind, pageid, recordid: t.recordid, data: JSON.parse(readFileSync(file, 'utf8')), source: 'cycle.apply created' }, { baseDir });
      }
      log.info('apply', 'созданные блоки', { created: summary.created.map((c) => `${c.id}→${c.recordid}${c.zeroIndex ? ` (zero#${c.zeroIndex})` : ''}`) });
    }
  }

  // 6. verify.
  summary.verify = verify(plan, { baseDir, out, reread });
  summary.ms = Date.now() - t0;
  // Журнал пишется при любой записи, с результатом сверки — по нему строится откат.
  if (summary.written > 0) {
    const record = buildRecord({ plan, planPath: opts.planPath, payloads, summary, before, rollbackOf: plan.rollbackOf || null });
    summary.journal = writeRecord(record, { baseDir });
  }
  if (summary.verify.length) {
    log.error('apply', 'сверка не прошла', { problems: summary.verify.length, first: summary.verify[0] });
    return summary;
  }
  // 7. Сверка чиста — перечитанное становится снимком: baseline хранит последнее известное живое
  // состояние, а обратный план готовится от него без ручного переноса (SKILL.md «Откат»).
  for (const it of rereadItems) {
    if (it.created) continue; // снимки созданных блоков уже сняты выше
    const file = join(reread, pageid, it.kind === 'zero' ? `${it.recordid}.json` : `${it.recordid}.record.json`);
    saveSnapshot({ kind: it.kind, pageid, recordid: it.recordid, data: JSON.parse(readFileSync(file, 'utf8')), source: 'cycle.apply reread' }, { baseDir });
  }
  log.info('apply', `итог: ${plan.ops.length} операций, записано ${summary.written}, verify: 0 расхождений`, { ms: summary.ms, created: summary.created.length, snapshotsUpdated: rereadItems.length });
  // 8. План трогал геометрию, размер, типографику или выравнивание — единственный способ увидеть
  // поехавший адаптив это скриншот: в модели и в verify он выглядит корректно.
  if ((summary.layout || opts.shot) && driver.shot && !opts.noShot) {
    try {
      const r = await driver.shot({ widths: opts.widths });
      summary.shots = r.files;
      log.info('apply', 'скриншоты сняты', { files: r.files.length, widths: r.widths.map((w) => `${w.width}:${w.height}px`) });
    } catch (e) {
      log.warn('apply', 'скриншоты не сняты', { error: e.message });
      summary.shotError = e.message;
    }
  }
  return summary;
}

/**
 * Откат по записи журнала: обратный план из `from` прогоняется тем же циклом с той же сверкой
 * и сам ложится в журнал (поле rollbackOf). Повторный откат безопасен: значения уже на месте,
 * diff пуст, сверка проходит.
 */
export async function rollback(driver, recordPath, opts = {}) {
  const record = readRecord(recordPath);
  const { plan, skipped } = reversePlan(record);
  const { baseDir, out } = paths(opts);
  const planPath = join(out, String(plan.page), '_rollback-plan.json');
  mkdirSync(join(planPath, '..'), { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  log.info('rollback', `откат ${plan.ops.length} операций записи ${record.plan.name} (${record.at})`, { skipped: skipped.length, planPath });
  const r = await apply(driver, plan, { ...opts, baseDir, planPath });
  r.rollbackOf = record.at;
  r.skipped = skipped;
  if (!r.dryRun) log.info('rollback', `откат ${plan.ops.length} операций, verify: ${r.verify.length}`, { journal: r.journal });
  return r;
}

/**
 * Предпросмотр плана без записи: операции над стандартными блоками (field, listSet)
 * прогоняются через previewrecord, предпросмотр подставляется в DOM редактора, снимается скриншот
 * блока, DOM возвращается. Zero Block пишется savezerocode — серверного предпросмотра у него нет,
 * такие операции перечисляются как пропущенные.
 * @returns {{ pageid, previews: [{recordid, kind, shot, htmlBytes}], skipped: [{recordid, kind, reason}] }}
 */
export async function preview(driver, plan, opts = {}) {
  const pageid = String(plan.page);
  const { baseDir, out } = paths(opts);
  const shotsDir = opts.shotsDir || join(baseDir, 'shots', pageid);
  if (!opts.skipInventory) await inventory(driver, pageid, { baseDir });
  const targets = planTargets(plan, { baseDir });
  await snapshotBlocks(driver, targets, { baseDir, source: 'cycle.preview' });
  const payloads = prepare(plan, { baseDir, out, emitCalls: false });
  const previews = [];
  const skipped = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const p of payloads) {
    let fields = null;
    if (p.kind === 'list') fields = p.fields;
    else if (p.kind === 'record') {
      // Одно поле: тело — все поля вкладки содержимого из снимка с подставленным значением.
      const snap = loadSnapshot({ kind: 'record', pageid, recordid: p.recordid }, { baseDir });
      const rec = snap.record || snap;
      const names = snap.tabs && Array.isArray(snap.tabs.content) && snap.tabs.content.length ? snap.tabs.content : Object.keys(rec);
      fields = names.filter((n) => !RECORD_SKIP_FIELDS.has(n)).map((n) => ({ name: n, value: n === p.field ? String(p.value) : decodeEntities(rec[n] ?? '') }));
      if (!fields.some((f) => f.name === p.field)) fields.push({ name: p.field, value: String(p.value) });
    } else {
      skipped.push({ recordid: p.recordid, kind: p.kind, reason: p.kind === 'zero' ? 'Zero Block пишется savezerocode — серверного предпросмотра нет' : `предпросмотр для ${p.kind} не предусмотрен` });
      continue;
    }
    const r = await driver.call('previewRecord', [pageid, p.recordid, fields, { render: true }]);
    let shot = null;
    try {
      shot = driver.screenshot ? await driver.screenshot(`#record${p.recordid}`, join(shotsDir, `preview-${p.recordid}-${stamp}.png`)) : null;
    } finally {
      await driver.call('restorePreview', [p.recordid]);
    }
    log.debug('preview', 'предпросмотр блока', { recordid: p.recordid, kind: p.kind, htmlBytes: r.htmlBytes, rendered: r.rendered, shot });
    previews.push({ recordid: p.recordid, kind: p.kind, htmlBytes: r.htmlBytes, rendered: r.rendered, shot });
  }
  log.info('preview', `предпросмотр ${previews.length} блоков, записи не было`, { skipped: skipped.length, shots: previews.filter((x) => x.shot).length });
  return { pageid, previews, skipped };
}

/** Скриншоты и проверка ссылок вида страницы. */
export async function shot(driver, pageid, opts = {}) {
  const r = await driver.shot({ widths: opts.widths, outDir: opts.outDir });
  const out = { pageid: String(pageid), files: r.files, widths: r.widths, links: null };
  if (opts.links) out.links = await links(driver, pageid, opts);
  return out;
}

/**
 * Карта блоков: свежий инвентарь → вид страницы с подписанными номерами → файл на диске.
 * В контекст агента картинка не грузится; номер → recordid читается из легенды <ISO>-map.json.
 */
export async function mapBlocks(driver, pageid, opts = {}) {
  const inv = await inventory(driver, pageid, opts);
  const r = await driver.mapBlocks(inv, { widths: opts.widths, outDir: opts.outDir });
  log.info('mapBlocks', `карта блоков: подписано ${r.drawn} из ${inv.length}, файлов ${r.files.length}`, { pageid: String(pageid), legend: r.legend });
  return { pageid: String(pageid), inventory: inv.length, ...r };
}

/** Битые ссылки и картинки вида страницы: собрать href/src, проверить статусы из Node. */
export async function links(driver, pageid, opts = {}) {
  const { url, html } = await driver.pageHtml();
  const items = collectUrls(html, url);
  const results = await checkUrls(items, { concurrency: opts.concurrency, timeoutMs: opts.timeoutMs });
  return { pageid: String(pageid), checked: results.length, results };
}

/** Перечитать затронутые планом блоки и сверить с payload (без записи). */
export async function verifyPlan(driver, plan, opts = {}) {
  const pageid = String(plan.page);
  const { baseDir, out, reread } = paths(opts);
  const targets = planTargets(plan, { baseDir }).filter((t) => t.role === 'target');
  // Созданные блоки (addZero/addRecord/newRecord) перечитываются по журналу сборки прошлого apply:
  // без этого verify сверял бы их со старым перечитанным снимком.
  const builtPath = join(reread, pageid, '_built.json');
  if ((plan.ops || []).some((op) => op.addZero || op.addRecord || op.newRecord) && existsSync(builtPath)) {
    const built = JSON.parse(readFileSync(builtPath, 'utf8'));
    for (const b of built.built || []) if (b.status === 'ok' && b.recordid) targets.push({ kind: b.kind === 'zero' || String(b.tplid) === '396' ? 'zero' : 'record', page: pageid, recordid: String(b.recordid), role: 'created' });
  }
  await rereadBlocks(driver, pageid, targets, { reread });
  if ((plan.ops || []).some((op) => op.blockHidden !== undefined)) {
    const inv = await driver.call('listRecords', []);
    writeJson(join(reread, pageid, '_inventory.json'), inv);
  }
  const problems = verify(plan, { baseDir, out, reread });
  return { pageid, blocks: targets.length, verify: problems };
}

/** Читает план из файла с проверкой формы. */
export function readPlan(path) {
  if (!existsSync(path)) throw new Error(`план не найден: ${path}`);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  if (!plan.page) throw new Error(`план ${path}: нет поля page`);
  return plan;
}
