/**
 * Накат проверенного плана на живую главную.
 *
 * Пять шагов, строго по порядку:
 *   1. план уже проверен на рабочей копии — в журнале `site-baseline/journal/<from>/` есть запись
 *      этого плана с `verify` = 0 и без отката; иначе отказ PLAN_NOT_VERIFIED;
 *   2. `dublicatepage <to>` → свежий дубль-бэкап «как есть сейчас»; снимок всей страницы
 *      (`snapshotPage`) и сверка, что снялся целиком (все блоки инвентаря прочитаны);
 *   3. сверка свежего дубля с рабочей копией. Рабочая копия уже содержит правки плана, поэтому
 *      расхождения, объяснимые журналом (`from` на дубле → `to` на копии, добавленные блоки),
 *      ожидаемы; любое другое означает, что главную правили руками после снятия рабочей копии —
 *      останов с отчётом, не продолжение;
 *   4. накат того же плана заменой `page` (recordid переносятся по позиции блока: порядок и
 *      elem_id на дубле и живой совпадают, recordid — нет) тем же циклом `apply` с той же сверкой;
 *   5. свежий дубль остаётся в кабинете навсегда как точка возврата.
 *
 * Переназначение alias (замещение главной копией) не делается: единственная операция, где ошибка
 * роняет весь сайт. Снятие защиты `TILDA_PROTECTED_PAGES` — явный флаг команды на один вызов
 * (`unprotectForThisRun` + `browser.setProtectedPages`), не переменная окружения по умолчанию.
 * Имя бэкапа `backup-<YYYY-MM-DD>-<HH-MM>` фиксируется в отчёте: сервер называет копию
 * «Copy of <заголовок>», переименование требует `savepagesettings` (пока не сделано).
 * Накопившиеся бэкапы убирает человек кнопкой — удаление страниц вне автоматизации.
 *
 * Чистые части (`expectedChanges`, `alignPages`, `comparePages`, `remapPlan`, `findVerifiedRecord`)
 * проверяются тестами без сети; `promote` — оркестровка над браузером.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir, protectedPages, unprotectForThisRun } from './lib/paths.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { recordFields } from './apply-plan.mjs';
import { listRecords, planSlug } from './journal.mjs';
import { save as saveSnapshot } from './snapshot.mjs';

const log = createLogger('promote');

export const ZERO_VOLATILE = new Set(['timestamp']);
/**
 * Темп чтений: второй полный снимок подряд выбивал сессию Тильды — на 45-м
 * запросе без пауз и на ~75-м при 800 мс сплошняком. Модель, сходящаяся с обоими обрывами и с удачной
 * пересборкой 09.09 (80 запросов за несколько минут с перезагрузками): «ведро» ~40 запросов
 * с пополнением ~0,45/с. Отсюда «рваный» режим: пачки по 10 чтений через 2,5 с, 60 с между
 * пачками, 60 с между снимками. Порог не измерен — режим проверяется прогоном с перехватом.
 */
export const SNAPSHOT_PACE = { delayMs: 2500, batch: 10, pauseMs: 60_000 };
export const BETWEEN_SNAPSHOTS_MS = 60_000;

/** Запросы к tilda.ru, которые считаем «к API» при разборе перехвата: всё, кроме статики. */
export const CAPTURE_FILTER = (url) => /^https:\/\/tilda\.ru\//.test(url) && !/\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)(\?|$)/i.test(url);

/**
 * Разбор перехвата запросов: хронология, плотность за 60/120 с и первый ответ с признаком
 * потерянной сессии (тело начинается с <!--tlp--> — страница логина, <!--tpbaa--> — чужой аккаунт,
 * либо HTML вместо JSON). Чистая функция для поиска закономерности обрыва.
 */
export function analyzeCapture(records = []) {
  const calls = records.filter((r) => r.status !== null && r.status !== undefined).map((r) => ({ ...r, t: Date.parse(r.ts) }));
  const isLost = (r) => typeof r.body === 'string' && (/^\s*<!--(tlp|tpbaa)-->/.test(r.body) || (/^\s*<|<html|<!doctype/i.test(r.body.slice(0, 300)) && /\/(page|zero|projects)\/(edit|get|submit)\//.test(r.url)));
  const marker = (r) => (typeof r.body === 'string' ? (r.body.match(/^\s*<!--(tlp|tpbaa)-->/) || [null, null])[1] : null);
  const out = { calls: calls.length, first: calls[0]?.ts ?? null, last: calls.at(-1)?.ts ?? null, spanSec: calls.length ? Math.round((calls.at(-1).t - calls[0].t) / 1000) : 0, firstLost: null, maxPerMinute: 0, retryAfter: calls.find((r) => r.retryAfter)?.retryAfter ?? null, setCookieAt: [] };
  for (const [i, r] of calls.entries()) {
    const inLast = (sec) => calls.filter((x) => x.t <= r.t && x.t > r.t - sec * 1000).length;
    const perMinute = inLast(60);
    if (perMinute > out.maxPerMinute) out.maxPerMinute = perMinute;
    if (r.setCookie) out.setCookieAt.push({ index: i, ts: r.ts, url: r.url.slice(0, 80), status: r.status });
    if (!out.firstLost && isLost(r)) {
      out.firstLost = { index: i, ts: r.ts, url: r.url, status: r.status, marker: marker(r), head: String(r.body).slice(0, 60), sinceStartSec: Math.round((r.t - calls[0].t) / 1000), inLast60s: perMinute, inLast120s: inLast(120), inLast300s: inLast(300), retryAfter: r.retryAfter ?? null, contentType: r.contentType };
    }
  }
  return out;
}
/** Служебный id элемента списка: Тильда переприсваивает его при вставке блока. */
export const LIST_VOLATILE_KEYS = new Set(['lid']);

export class PromoteError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'PromoteError';
    this.code = code;
    Object.assign(this, data);
  }
}

/** Имя бэкапа: backup-<YYYY-MM-DD>-<HH-MM> (локальное время). */
export function backupName(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `backup-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}-${p(at.getMinutes())}`;
}

/**
 * Последняя запись журнала этого плана на рабочей копии, прошедшая сверку (verify = 0), не откат
 * и не откаченная позже. records — listRecords(from), новые первыми.
 */
export function findVerifiedRecord(records, planName) {
  const rolledBack = new Set(records.filter((r) => r.rollbackOf).map((r) => r.rollbackOf));
  const hit = records.find((r) => r.plan && r.plan.name === planName && !r.rollbackOf && (r.verify || []).length === 0 && (r.written || 0) > 0 && !rolledBack.has(r.at));
  log.debug('findVerifiedRecord', hit ? 'запись найдена' : 'записи нет', { planName, at: hit ? hit.at : null, candidates: records.filter((r) => r.plan && r.plan.name === planName).length });
  return hit || null;
}

/**
 * Ожидаемые различия «свежий дубль живой ↔ рабочая копия» по записям журнала (хронологически:
 * `from` первой записи, `to` последней). Ключи — recordid рабочей копии.
 */
export function expectedChanges(records = []) {
  const exp = { created: new Set(), sortFrom: null, zero: new Map(), record: new Map(), list: new Set(), hidden: new Map() };
  const zeroOf = (recordid) => {
    if (!exp.zero.has(recordid)) exp.zero.set(recordid, { fields: new Map(), service: new Map(), added: new Set(), removed: new Set() });
    return exp.zero.get(recordid);
  };
  const chain = (map, key, from, to) => {
    const prev = map.get(key);
    map.set(key, { from: prev ? prev.from : from, to });
  };
  const ordered = [...records].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const rec of ordered) {
    for (const op of rec.ops || []) {
      if (op.kind === 'create' && op.recordid) exp.created.add(String(op.recordid));
      else if (op.kind === 'sort') exp.sortFrom = exp.sortFrom || (op.from || []).map(String);
      else if (op.kind === 'block') chain(exp.hidden, String(op.recordid), op.from, op.to);
      else if (op.kind === 'record') chain(recordOf(exp, String(op.recordid)), op.field, op.from, op.to);
      else if (op.kind === 'list') exp.list.add(String(op.recordid));
      else if (op.kind === 'zero') {
        const z = zeroOf(String(op.recordid));
        for (const id of op.added || []) z.added.add(String(id));
        for (const id of op.removed || []) z.removed.add(String(id));
        for (const c of op.changes || []) {
          if (c.elem_id) chain(z.fields, `${c.elem_id}|${c.field}`, c.from, c.to);
          else chain(z.service, String(c.key), c.from, c.to);
        }
      }
    }
  }
  log.debug('expectedChanges', 'ожидаемые различия собраны', { records: ordered.length, created: exp.created.size, zeroBlocks: exp.zero.size, recordBlocks: exp.record.size, listBlocks: exp.list.size, hidden: exp.hidden.size, sort: Boolean(exp.sortFrom) });
  return exp;
}

function recordOf(exp, recordid) {
  if (!exp.record.has(recordid)) exp.record.set(recordid, new Map());
  return exp.record.get(recordid);
}

const norm = (v) => decodeEntities(String(v ?? ''));
const same = (a, b) => norm(a) === norm(b);
const explains = (e, a, b) => Boolean(e) && same(e.from, a) && same(e.to, b);

/** Полнота снимка страницы: все блоки инвентаря прочитаны, ошибок нет. */
export function snapshotComplete(snap) {
  const inv = snap.inventory || [];
  const read = new Set([...Object.keys(snap.zero || {}), ...Object.keys(snap.records || {})]);
  const missing = inv.map((r) => String(r.recordid)).filter((id) => !read.has(id));
  return { ok: missing.length === 0 && (snap.errors || []).length === 0, missing, errors: snap.errors || [] };
}

/**
 * Совместить блоки свежего дубля живой и рабочей копии по позиции. Базовый порядок рабочей
 * копии — до правок плана: без созданных блоков, а при перестановке — порядок `from` записи sort.
 */
export function alignPages(backup, working, expected = expectedChanges()) {
  const problems = [];
  const current = (working.inventory || []).map((r) => String(r.recordid));
  const baseOrder = (expected.sortFrom || current).filter((id) => !expected.created.has(id));
  const live = backup.inventory || [];
  if (baseOrder.length !== live.length) {
    problems.push({ problem: 'число блоков не совпало', live: live.length, working: baseOrder.length, created: [...expected.created] });
    log.error('alignPages', 'число блоков не совпало', { live: live.length, working: baseOrder.length });
    return { pairs: [], problems };
  }
  const byId = new Map((working.inventory || []).map((r) => [String(r.recordid), r]));
  const pairs = [];
  live.forEach((row, i) => {
    const work = byId.get(baseOrder[i]);
    if (!work) {
      problems.push({ pos: i + 1, problem: 'блока рабочей копии нет в инвентаре', recordid: baseOrder[i] });
      return;
    }
    if (String(row.tplid) !== String(work.tplid)) problems.push({ pos: i + 1, problem: 'тип блока не совпал', live: `${row.recordid}/tpl${row.tplid}`, working: `${work.recordid}/tpl${work.tplid}` });
    pairs.push({ pos: i + 1, live: row, work });
  });
  log.debug('alignPages', 'блоки совмещены', { pairs: pairs.length, problems: problems.length });
  return { pairs, problems };
}

function elemMap(model) {
  const out = new Map();
  for (const [key, val] of Object.entries(model || {})) if (/^\d+$/.test(key) && val && typeof val === 'object') out.set(String(val.elem_id ?? `#${key}`), val);
  return out;
}

function serviceMap(model) {
  const out = new Map();
  for (const [key, val] of Object.entries(model || {})) if (!/^\d+$/.test(key) && !ZERO_VOLATILE.has(key)) out.set(key, val);
  return out;
}

/** Поле `list` без служебных ключей элементов (lid): для сравнения между страницами. */
export function stripListVolatile(value) {
  try {
    const parsed = JSON.parse(String(value));
    const arr = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
    return JSON.stringify(arr.map((item) => Object.fromEntries(Object.entries(item || {}).filter(([k]) => !LIST_VOLATILE_KEYS.has(k)))));
  } catch {
    return String(value ?? '');
  }
}

function compareZero(pos, a, b, exp, out) {
  const e = exp || { fields: new Map(), service: new Map(), added: new Set(), removed: new Set() };
  const sa = serviceMap(a);
  const sb = serviceMap(b);
  for (const key of new Set([...sa.keys(), ...sb.keys()])) {
    const va = sa.get(key);
    const vb = sb.get(key);
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (explains(e.service.get(key), va, vb)) out.explained.push({ pos, kind: 'zero', key });
    else out.problems.push({ pos, kind: 'zero', problem: 'служебное поле блока отличается', key, live: String(va ?? '').slice(0, 60), working: String(vb ?? '').slice(0, 60) });
  }
  const ea = elemMap(a);
  const eb = elemMap(b);
  for (const id of new Set([...ea.keys(), ...eb.keys()])) {
    const xa = ea.get(id);
    const xb = eb.get(id);
    if (!xa) {
      if (e.added.has(id)) out.explained.push({ pos, kind: 'zero', elem_id: id, added: true });
      else out.problems.push({ pos, kind: 'zero', problem: 'элемент есть только на рабочей копии', elem_id: id, type: xb.type });
      continue;
    }
    if (!xb) {
      if (e.removed.has(id)) out.explained.push({ pos, kind: 'zero', elem_id: id, removed: true });
      else out.problems.push({ pos, kind: 'zero', problem: 'элемент есть только на живой', elem_id: id, type: xa.type });
      continue;
    }
    for (const field of new Set([...Object.keys(xa), ...Object.keys(xb)])) {
      const fa = xa[field];
      const fb = xb[field];
      if (JSON.stringify(fa) === JSON.stringify(fb)) continue;
      if (explains(e.fields.get(`${id}|${field}`), fa, fb)) out.explained.push({ pos, kind: 'zero', elem_id: id, field });
      else out.problems.push({ pos, kind: 'zero', problem: 'поле элемента отличается', elem_id: id, field, live: String(fa ?? '').slice(0, 60), working: String(fb ?? '').slice(0, 60) });
    }
  }
}

function compareRecord(pos, a, b, expFields, isList, out) {
  const fa = recordFields(a);
  const fb = recordFields(b);
  for (const field of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    let va = fa[field];
    let vb = fb[field];
    if (field === 'list') {
      va = stripListVolatile(va);
      vb = stripListVolatile(vb);
    }
    if (same(va, vb)) continue;
    if (isList && (field === 'list' || /^li[_-]/.test(field))) {
      out.explained.push({ pos, kind: 'record', field, list: true });
      continue;
    }
    if (explains(expFields && expFields.get(field), fa[field], fb[field])) out.explained.push({ pos, kind: 'record', field });
    else out.problems.push({ pos, kind: 'record', problem: 'поле блока отличается', field, live: String(va ?? '').slice(0, 60), working: String(vb ?? '').slice(0, 60) });
  }
}

/**
 * Сверка свежего дубля живой (backup) с рабочей копией (working) — оба снимки `snapshotPage`
 * {inventory, zero, records}. Расхождения, объяснимые журналом (expected), — в `explained`;
 * остальные — в `problems` (пусто = главную руками не трогали, план встанет).
 */
export function comparePages(backup, working, expected = expectedChanges()) {
  const out = { problems: [], explained: [], blocks: 0 };
  const { pairs, problems } = alignPages(backup, working, expected);
  out.problems.push(...problems);
  for (const { pos, live, work } of pairs) {
    out.blocks += 1;
    const hl = live.hidden ? 'y' : 'n';
    const hw = work.hidden ? 'y' : 'n';
    if (hl !== hw) {
      if (explains(expected.hidden.get(String(work.recordid)), hl, hw)) out.explained.push({ pos, kind: 'block', hidden: true });
      else out.problems.push({ pos, kind: 'block', problem: 'видимость блока отличается', live: hl, working: hw });
    }
    if (String(live.tplid) === '396') {
      const a = (backup.zero || {})[String(live.recordid)];
      const b = (working.zero || {})[String(work.recordid)];
      if (!a || !b) {
        out.problems.push({ pos, kind: 'zero', problem: 'нет модели Zero Block в снимке', live: Boolean(a), working: Boolean(b) });
        continue;
      }
      compareZero(pos, a, b, expected.zero.get(String(work.recordid)), out);
    } else {
      const a = (backup.records || {})[String(live.recordid)];
      const b = (working.records || {})[String(work.recordid)];
      if (!a || !b) {
        out.problems.push({ pos, kind: 'record', problem: 'нет снимка стандартного блока', live: Boolean(a), working: Boolean(b) });
        continue;
      }
      compareRecord(pos, a, b, expected.record.get(String(work.recordid)), expected.list.has(String(work.recordid)), out);
    }
  }
  if (out.problems.length) log.error('comparePages', 'свежий дубль живой расходится с рабочей копией сверх плана', { problems: out.problems.length, explained: out.explained.length, first: out.problems[0] });
  else log.info('comparePages', `сверка чиста: ${out.blocks} блоков, ожидаемых различий ${out.explained.length}`);
  return out;
}

/**
 * Перенос плана на другую страницу: `page` → to, recordid блоков → по карте «recordid рабочей
 * копии → recordid живой» (позиция та же). Источники addZero/addRecord не трогаются — они читаются
 * с рабочей копии. Неизвестный recordid — отказ (план адресует блок, которого на живой нет).
 */
export function remapPlan(plan, to, mapping) {
  const map = (id, where) => {
    if (id === undefined || id === null || id === '') return id;
    const hit = mapping.get(String(id));
    if (!hit) throw new PromoteError('REMAP_FAILED', `${where}: recordid ${id} рабочей копии не найден на живой странице`, { recordid: String(id) });
    return hit;
  };
  const ops = (plan.ops || []).map((op, i) => {
    const o = { ...op };
    if (o.block && o.block.recordid) o.block = { ...o.block, recordid: map(o.block.recordid, `op#${i}.block`) };
    if (o.moveBlock) o.moveBlock = { ...o.moveBlock, recordid: map(o.moveBlock.recordid, `op#${i}.moveBlock`), after: map(o.moveBlock.after, `op#${i}.moveBlock.after`), before: map(o.moveBlock.before, `op#${i}.moveBlock.before`) };
    if (Array.isArray(o.setOrder)) o.setOrder = o.setOrder.map((id) => map(id, `op#${i}.setOrder`));
    return o;
  });
  const out = { ...plan, page: String(to), ops };
  if (plan.startAfter) out.startAfter = map(plan.startAfter, 'startAfter');
  log.debug('remapPlan', 'план перенесён', { to: String(to), ops: ops.length, startAfter: out.startAfter });
  return out;
}

function writeJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return path;
}

/** Снимок страницы через слой tilda-copy → в site-baseline/zero|records/<pageid>/ и инвентарь. */
async function snapshotWholePage(driver, pageid, { baseDir, source, pace = SNAPSHOT_PACE }) {
  const snap = await driver.call('snapshotPage', [pace], { timeoutMs: 30 * 60_000, attempts: 1 });
  const complete = snapshotComplete(snap);
  if (snap.timeline) {
    const okReads = snap.timeline.filter((x) => x.ok);
    log.debug('snapshotWholePage', 'хронология чтений', { pageid: String(pageid), reads: snap.timeline.length, ok: okReads.length, avgMs: okReads.length ? Math.round(okReads.reduce((a, x) => a + x.ms, 0) / okReads.length) : null, first: snap.timeline[0]?.at, last: snap.timeline.at(-1)?.at, pace: snap.pace });
  }
  if (complete.errors.some((e) => /SESSION_LOST/.test(String(e.error)))) {
    log.error('snapshotWholePage', 'сессия Тильды потеряна во время снимка', { pageid: String(pageid), read: complete.errors.length });
    throw new PromoteError('SESSION_LOST', `Сессии Тильды нет (потеряна во время снимка ${pageid}): войдите в открытом окне браузера и повторите команду`, { pageid: String(pageid) });
  }
  writeJson(join(baseDir, 'records', String(pageid), '_inventory.json'), snap.inventory);
  for (const [recordid, data] of Object.entries(snap.zero || {})) saveSnapshot({ kind: 'zero', pageid, recordid, data, source }, { baseDir });
  for (const [recordid, data] of Object.entries(snap.records || {})) saveSnapshot({ kind: 'record', pageid, recordid, data, source }, { baseDir });
  log.info('snapshotWholePage', `снимок страницы ${pageid}: ${snap.inventory.length} блоков, zero ${Object.keys(snap.zero).length}, стандартных ${Object.keys(snap.records).length}`, { complete: complete.ok, missing: complete.missing.length, errors: complete.errors.length });
  return { snap, complete };
}

/**
 * Оркестровка пяти шагов. ctx = { browser, session, cycle, ops } — модули и открытая сессия
 * браузера; opts = { plans: [{ path, plan }], from, to, unprotect, baseDir, layers }.
 * Возвращает отчёт; при останове бросает PromoteError с кодом шага.
 */
export async function promote(ctx, opts) {
  const { browser, session, cycle, ops } = ctx;
  const from = String(opts.from);
  const to = String(opts.to);
  const baseDir = opts.baseDir || baselineDir();
  const layers = opts.layers || ['tilda-zero', 'tilda-page', 'tilda-copy', 'tilda-upload', 'tilda-project'];
  const at = new Date();
  const pace = { ...SNAPSHOT_PACE, ...(opts.pace || {}) };
  const betweenMs = opts.betweenSnapshotsMs ?? BETWEEN_SNAPSHOTS_MS;
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const report = { from, to, at: at.toISOString(), pace, betweenSnapshotsMs: betweenMs, backup: null, backupName: backupName(at), plans: [], compare: null, applied: [], reportPath: null, capture: null, analysis: null };
  const reportPath = join(baseDir, 'compare', `${stamp}-promote-${to}.json`);
  // Перехват всех запросов к tilda.ru на время прогона (в том числе собственных запросов редактора
  // при открытии страницы): единственный способ увидеть, на каком запросе и при какой плотности
  // рвётся сессия. Тела режутся до 1,5 КБ, куки вырезаются (stripCookies). Папка incoming — вне git.
  const capturePath = join(baseDir, 'incoming', `${stamp}-promote-${to}-capture.json`);
  const capture = opts.noCapture ? null : browser.captureRequests(session.page, CAPTURE_FILTER, capturePath, { maxBodyBytes: 1500 });
  report.capture = capture ? capturePath : null;
  const finishCapture = async () => {
    if (!capture) return;
    const records = await capture.stop();
    report.analysis = analyzeCapture(records);
    log.info('promote', 'перехват завершён', { calls: report.analysis.calls, spanSec: report.analysis.spanSec, maxPerMinute: report.analysis.maxPerMinute, firstLost: report.analysis.firstLost ? `#${report.analysis.firstLost.index} ${report.analysis.firstLost.marker || 'html'} после ${report.analysis.firstLost.sinceStartSec} с, за 60 с до него ${report.analysis.firstLost.inLast60s}` : null, file: capturePath });
  };
  const stop = async (code, message, data) => {
    report.stoppedAt = code;
    report.error = message;
    Object.assign(report, data || {});
    await finishCapture();
    report.reportPath = writeJson(reportPath, report);
    log.error('promote', `останов: ${message}`, { code, report: reportPath });
    throw new PromoteError(code, message, { report });
  };
  if (from === to) await stop('BAD_ARGS', 'рабочая копия и живая страница совпадают');

  // Шаг 1. План проверен на рабочей копии.
  const journal = listRecords(from, { baseDir });
  const verified = [];
  for (const { path, plan } of opts.plans) {
    const name = planSlug(path, plan);
    const rec = findVerifiedRecord(journal, name);
    if (!rec) await stop('PLAN_NOT_VERIFIED', `план ${name} не имеет записи журнала с verify = 0 на рабочей копии ${from} — сначала apply на копии`, { plan: name });
    verified.push(rec);
    report.plans.push({ name, path, verifiedAt: rec.at, journal: rec.file });
    log.info('promote', `шаг 1: план ${name} проверен на ${from}`, { at: rec.at });
  }

  // Шаг 2. Свежий дубль-бэкап живой и его полный снимок.
  await browser.openEditor(session, to, { layers: ['tilda-project'] });
  const projectDriver = { call: (fn, args = []) => browser.call(session.page, fn, args, { attempts: 1 }) };
  const dup = await ops.duplicatePage(projectDriver, to);
  report.backup = dup.pageid;
  log.info('promote', `шаг 2: бэкап ${dup.pageid} снят (${report.backupName})`, { source: to, editor: dup.editor });
  await browser.openEditor(session, dup.pageid, { layers });
  const backupDriver = cycle.browserDriver(session, dup.pageid, { layers, browser });
  let backup;
  try {
    backup = await snapshotWholePage(backupDriver, dup.pageid, { baseDir, source: `promote backup of ${to}`, pace });
  } catch (e) {
    if (e.code === 'SESSION_LOST') await stop('SESSION_LOST', e.message, { pageid: dup.pageid });
    throw e;
  }
  if (!backup.complete.ok) await stop('BACKUP_INCOMPLETE', `бэкап ${dup.pageid} снялся не целиком: не прочитано ${backup.complete.missing.length}, ошибок ${backup.complete.errors.length}`, { missing: backup.complete.missing, errors: backup.complete.errors });
  log.info('promote', 'шаг 2: снимок бэкапа полный', { blocks: backup.snap.inventory.length });

  // Шаг 3. Сверка бэкапа с рабочей копией. Пауза перед вторым снимком — см. SNAPSHOT_PACE.
  log.info('promote', 'пауза перед снимком рабочей копии', { ms: betweenMs });
  await new Promise((r) => setTimeout(r, betweenMs));
  await browser.openEditor(session, from, { layers });
  const workDriver = cycle.browserDriver(session, from, { layers, browser });
  let working;
  try {
    working = await snapshotWholePage(workDriver, from, { baseDir, source: 'promote working copy', pace });
  } catch (e) {
    if (e.code === 'SESSION_LOST') await stop('SESSION_LOST', e.message, { pageid: from });
    throw e;
  }
  if (!working.complete.ok) await stop('WORKING_INCOMPLETE', `рабочая копия ${from} снялась не целиком`, { missing: working.complete.missing, errors: working.complete.errors });
  const expected = expectedChanges(verified);
  const cmp = comparePages(backup.snap, working.snap, expected);
  report.compare = { blocks: cmp.blocks, explained: cmp.explained.length, problems: cmp.problems };
  if (cmp.problems.length) await stop('DRIFT', `живая главная расходится с рабочей копией сверх плана: ${cmp.problems.length} расхождений — главную правили руками после снятия копии`, { problems: cmp.problems });
  log.info('promote', `шаг 3: сверка чиста — ${cmp.blocks} блоков, ожидаемых различий ${cmp.explained.length}`);

  // Шаг 4. Накат заменой page. Защита снимается на этот вызов явным флагом.
  if (protectedPages().includes(to)) {
    if (!opts.unprotect) await stop('PROTECTED_PAGE', `страница ${to} защищена (TILDA_PROTECTED_PAGES): накат требует явного --unprotect на этот вызов`);
    const rest = unprotectForThisRun(to);
    log.warn('promote', `защита страницы ${to} снята на этот вызов по флагу --unprotect`, { at: new Date().toISOString(), remainingProtected: rest });
  }
  await browser.openEditor(session, to, { layers });
  await browser.setProtectedPages(session.page, protectedPages());
  const liveDriver = cycle.browserDriver(session, to, { layers, browser });
  const liveInv = await cycle.inventory(liveDriver, to, { baseDir });
  const current = working.snap.inventory.map((r) => String(r.recordid));
  const baseOrder = (expected.sortFrom || current).filter((id) => !expected.created.has(id));
  if (liveInv.length !== baseOrder.length) await stop('LIVE_CHANGED', `живая страница изменилась между бэкапом и накатом: блоков ${liveInv.length}, ожидалось ${baseOrder.length}`);
  const mapping = new Map(baseOrder.map((id, i) => [id, String(liveInv[i].recordid)]));
  for (const [k, rec] of verified.entries()) {
    const { path, plan } = opts.plans[k];
    const remapped = remapPlan(plan, to, mapping);
    remapped.name = remapped.name || planSlug(path, plan); // журнал живой хранит то же имя плана, что и копия
    const remappedPath = writeJson(join(baseDir, 'payload', to, `_promote-${k + 1}-${planSlug(path, plan)}.json`), remapped);
    log.info('promote', `шаг 4: накат плана ${k + 1}/${opts.plans.length} на ${to}`, { ops: remapped.ops.length, plan: remappedPath });
    const r = await cycle.apply(liveDriver, remapped, { baseDir, planPath: remappedPath, dryRun: Boolean(opts.dryRun), noShot: opts.noShot });
    report.applied.push({ plan: planSlug(path, plan), written: r.written, verify: r.verify.length, created: r.created, journal: r.journal, dryRun: r.dryRun });
    if (r.verify.length) await stop('VERIFY_FAILED', `накат плана ${planSlug(path, plan)} на ${to}: verify ${r.verify.length} расхождений`, { verify: r.verify.slice(0, 10) });
    // Созданные планом блоки: recordid на копии (из журнала) → recordid на живой (из apply).
    const createdOnCopy = (rec.ops || []).filter((o) => o.kind === 'create');
    for (const c of r.created || []) {
      const src = createdOnCopy.find((o) => o.id === c.id);
      if (src && src.recordid) mapping.set(String(src.recordid), String(c.recordid));
    }
  }
  // Шаг 5. Бэкап остаётся в кабинете как точка возврата.
  await finishCapture();
  report.reportPath = writeJson(reportPath, report);
  log.info('promote', `шаг 5: бэкап ${report.backup} остаётся точкой возврата; отчёт ${reportPath}`);
  return report;
}

/** Читает планы для promote: --plan и позиционные пути. */
export function readPlans(paths) {
  return paths.map((path) => {
    if (!existsSync(path)) throw new PromoteError('PLAN_NOT_FOUND', `план не найден: ${path}`);
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    if (!plan.page) throw new PromoteError('BAD_PLAN', `план ${path}: нет поля page`);
    return { path, plan };
  });
}
