/**
 * Журнал правок и откат пакета.
 *
 * Каждый `apply`, который что-то записал, оставляет запись
 *   site-baseline/journal/<pageid>/<ISO>-<slug>.json
 * с планом, списком блоков, значениями `from`/`to` каждой операции, результатом `verify`
 * и версией инструмента. Папка `site-baseline/` лежит вне git (`.gitignore`).
 *
 * Откат строится **из журнала, а не из payload** (`prepare` чистит payload/<pageid>/):
 * `reversePlan(record)` даёт обратный план, который прогоняется тем же циклом с той же сверкой.
 * Отката всей страницы к дате нет — он неполон и дороже.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createLogger } from './lib/log.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { msg, isMessage, messageText } from './lib/i18n.mjs';
import { baselineDir, repoRoot } from './lib/paths.mjs';

const log = createLogger('journal');

export const JOURNAL_FORMAT = 1;

/** Версия инструмента — короткий SHA коммита; вне git — 'unknown'. */
export function toolVersion() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function journalDir(pageid, opts = {}) {
  return join(opts.baseDir || baselineDir(), 'journal', String(pageid));
}

/** Имя файла записи: время ISO без двоеточий + slug плана. */
export function recordName(at, slug) {
  const stamp = at.replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const clean = String(slug || 'plan').replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
  return `${stamp}-${clean}.json`;
}

export function planSlug(planPath, plan) {
  if (plan && plan.name) return String(plan.name);
  if (planPath) return basename(planPath).replace(/\.json$/i, '');
  return 'plan';
}

/**
 * Расхождения verify как данные для файла: `problem` — английский текст, а не `Message`
 * (в файл идёт один язык, перевод остаётся только в итоге команды).
 */
export function verifyData(problems) {
  return (problems || []).map((p) => (isMessage(p.problem) ? { ...p, problem: messageText(p.problem) } : p));
}

/**
 * Собирает запись журнала из итога цикла и подготовленных payload'ов.
 * @param {object} args
 * @param {object} args.plan          план операций
 * @param {string} [args.planPath]    путь плана (для slug и ссылки)
 * @param {object[]} args.payloads    результат prepare (модель, changes, поле, видимость, create)
 * @param {object} args.summary       итог cycle.apply: written, verify, created
 * @param {object} args.before        { inventory: [...], records: { recordid: snapshot } } — состояние до записи
 */
export function buildRecord({ plan, planPath, payloads, summary, before = {}, at = new Date().toISOString(), rollbackOf = null }) {
  const pageid = String(plan.page);
  const ops = [];
  for (const p of payloads) {
    if (p.kind === 'zero') {
      ops.push({
        kind: 'zero',
        recordid: String(p.recordid),
        added: (p.duplicates || []).map((d) => d.elem_id),
        removed: p.removed || [],
        changes: (p.changes || []).map((c) => ({
          key: c.key,
          elem_id: /^\d+$/.test(String(c.key)) && p.model[c.key] ? String(p.model[c.key].elem_id) : null,
          field: c.field,
          from: c.from,
          to: c.to,
        })),
      });
    } else if (p.kind === 'record') {
      const snap = before.records && before.records[String(p.recordid)];
      const rec = snap ? snap.record || snap : null;
      ops.push({ kind: 'record', recordid: String(p.recordid), field: p.field, from: rec && p.field in rec ? rec[p.field] : null, to: p.value });
    } else if (p.kind === 'list') {
      ops.push({ kind: 'list', recordid: String(p.recordid), from: p.before, to: p.cards, changes: p.changes });
    } else if (p.kind === 'sort') {
      ops.push({ kind: 'sort', recordid: null, from: p.before, to: p.order, moves: p.moves });
    } else if (p.kind === 'block') {
      const row = (before.inventory || []).find((r) => String(r.recordid) === String(p.recordid));
      ops.push({ kind: 'block', recordid: String(p.recordid), from: row ? (row.hidden ? 'y' : 'n') : null, to: p.hidden });
    } else if (p.kind === 'create') {
      const made = (summary.created || []).find((c) => c.id === p.id);
      ops.push({ kind: 'create', id: p.id, recordid: made ? String(made.recordid) : null, tplid: p.tplid, source: p.source ? `${p.source.page}/${p.source.recordid}` : `new:${p.tplid}`, from: null, to: 'created' });
    }
  }
  const blocks = [...new Set(ops.map((o) => o.recordid).filter(Boolean))];
  const record = {
    format: JOURNAL_FORMAT,
    tool: { name: 'tilda.mjs apply', version: toolVersion() },
    at,
    page: pageid,
    plan: { name: planSlug(planPath, plan), path: planPath ? planPath.replace(/\\/g, '/') : null, ops: (plan.ops || []).length },
    rollbackOf,
    blocks,
    ops,
    written: summary.written,
    verify: verifyData(summary.verify),
  };
  const incomplete = ops.filter((o) => o.from === null || o.from === undefined);
  if (incomplete.length) log.warn('buildRecord', 'journal record is incomplete: some operations have no from', { ops: incomplete.map((o) => `${o.kind}:${o.recordid || o.id}`) });
  return record;
}

/** Пишет запись журнала, возвращает путь. */
export function writeRecord(record, opts = {}) {
  const dir = journalDir(record.page, opts);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, recordName(record.at, record.plan.name));
  const text = JSON.stringify(record, null, 2) + '\n';
  writeFileSync(path, text, 'utf8');
  log.debug('writeRecord', 'journal record', { path, bytes: text.length, ops: record.ops.length });
  log.info('writeRecord', 'journal appended', { path: path.replace(repoRoot(), '').replace(/\\/g, '/'), blocks: record.blocks.length });
  return path;
}

export function readRecord(path) {
  const p = resolve(path);
  if (!existsSync(p)) throw new ToolError('JOURNAL_NOT_FOUND', msg('journal.recordNotFound', { path: p }));
  const record = JSON.parse(readFileSync(p, 'utf8'));
  if (record.format !== JOURNAL_FORMAT) throw new ToolError('BAD_JOURNAL_FORMAT', msg('journal.unknownFormat', { format: record.format, expected: JOURNAL_FORMAT }));
  return record;
}

/** Записи журнала страницы, новые первыми. */
export function listRecords(pageid, opts = {}) {
  const dir = journalDir(pageid, opts);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => ({ file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

/**
 * Обратный план из записи журнала: каждое изменение возвращается к `from`.
 * Операции без `from` (создание блоков, поля без прежнего значения) в план не входят —
 * они перечислены в `skipped`; если откатить нечего — ошибка ROLLBACK_IMPOSSIBLE.
 *
 * Поля элементов Zero Block пишутся «как есть» через `set` (любое поле модели);
 * изменения служебных ключей блока (`ab_height`, `groups`) откатом пока не покрываются.
 */
export function reversePlan(record) {
  const ops = [];
  const skipped = [];
  for (const op of record.ops) {
    if (op.kind === 'zero') {
      const byElem = new Map();
      const blockSet = {};
      const added = new Set(op.added || []);
      // Добавленные элементы откатываются удалением; их поля в обратный план не входят.
      for (const id of added) ops.push({ block: { recordid: op.recordid }, elem: { elem_id: id }, removeElement: true });
      for (const c of op.changes) {
        if (c.elem_id && added.has(String(c.elem_id))) continue;
        if (c.elem_id && (op.removed || []).includes(String(c.elem_id))) {
          skipped.push({ kind: 'zero', recordid: op.recordid, key: c.key, field: c.field, reason: msg('journal.skip.removedElement') });
          continue;
        }
        if (!c.elem_id && c.field === '' && c.from !== undefined && c.from !== null && typeof c.from !== 'object') {
          // Служебный скалярный ключ блока (ab_height и т.п.) — обратно через blockSet.
          blockSet[c.key] = c.from;
          continue;
        }
        if (c.from === undefined || c.from === null || !c.elem_id) {
          skipped.push({ kind: 'zero', recordid: op.recordid, key: c.key, field: c.field, reason: !c.elem_id ? msg('journal.skip.structuralKey') : msg('journal.skip.noFrom') });
          continue;
        }
        if (!byElem.has(c.elem_id)) byElem.set(c.elem_id, {});
        byElem.get(c.elem_id)[c.field] = c.from;
      }
      for (const [elem_id, set] of byElem) ops.push({ block: { recordid: op.recordid }, elem: { elem_id }, set });
      if (Object.keys(blockSet).length) ops.push({ block: { recordid: op.recordid }, blockSet });
    } else if (op.kind === 'record') {
      if (op.from === null || op.from === undefined) {
        skipped.push({ kind: 'record', recordid: op.recordid, field: op.field, reason: msg('journal.skip.noFrom') });
        continue;
      }
      ops.push({ block: { recordid: op.recordid }, field: { name: op.field, value: op.from } });
    } else if (op.kind === 'list') {
      if (!Array.isArray(op.from)) {
        skipped.push({ kind: 'list', recordid: op.recordid, reason: msg('journal.skip.noFrom') });
        continue;
      }
      // Полная замена состава карточек прежним — порядок, lid и тексты возвращаются как были.
      ops.push({ block: { recordid: op.recordid }, listSet: { cards: op.from } });
    } else if (op.kind === 'sort') {
      if (!Array.isArray(op.from)) {
        skipped.push({ kind: 'sort', recordid: 'page', reason: msg('journal.skip.noFrom') });
        continue;
      }
      ops.push({ setOrder: op.from });
    } else if (op.kind === 'block') {
      if (op.from === null || op.from === undefined) {
        skipped.push({ kind: 'block', recordid: op.recordid, reason: msg('journal.skip.noFrom') });
        continue;
      }
      ops.push({ block: { recordid: op.recordid }, blockHidden: op.from });
    } else if (op.kind === 'create') {
      skipped.push({ kind: 'create', id: op.id, recordid: op.recordid, reason: msg('journal.skip.createdBlock') });
    }
  }
  if (skipped.length) log.warn('reversePlan', 'some operations cannot be rolled back', { skipped: skipped.map((s) => `${s.kind}:${s.recordid || s.id}${s.field ? '.' + s.field : ''} (${messageText(s.reason)})`) });
  if (ops.length === 0) {
    log.error('reversePlan', 'rollback impossible: no operation has from', { record: record.at, plan: record.plan.name });
    throw new ToolError('ROLLBACK_IMPOSSIBLE', msg('journal.rollbackImpossible', { name: record.plan.name, at: record.at }));
  }
  // Обратный план пишет поля ровно как в журнале: изменённые -res-* варианты там перечислены явно,
  // а неизменённые пересчитывать нельзя (2026-09-11: откат картинки масштабировал height-res-*).
  const plan = { name: `rollback-${record.plan.name}`, page: record.page, rollbackOf: record.at, resStrategy: 'none', ops };
  log.debug('reversePlan', 'reverse plan', { ops: plan.ops.length, plan: JSON.stringify(plan).slice(0, 2000) });
  log.info('reversePlan', 'reverse plan built', { ops: ops.length, skipped: skipped.length });
  return { plan, skipped };
}
