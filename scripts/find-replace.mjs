/**
 * Поиск и массовая замена строки по странице — целиком на локальных снимках
 * site-baseline/zero|records/<pageid>/, живых запросов нет.
 *
 *   find(pageid, needle)             → {hits: [{recordid, kind, key, elem_id, field, value}], skippedForm, blocks, skippedStale}
 *                                      — точные адреса только в живых блоках (по инвентарю)
 *   buildReplacePlan(pageid, a, b)   → план операций для apply (set / field / listSet), плюс список адресов
 *
 * Поля формы (lib/form-fields.mjs) в выдачу не попадают и не заменяются — WARN на каждое вхождение.
 * Сравнение нормализует HTML-сущности и неразрывные пробелы, замена делается в
 * исходной строке поля по всем нормализованным вхождениям.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { isFormField } from './lib/form-fields.mjs';
import { decodeList } from './list-model.mjs';

const log = createLogger('find-replace');

/** Служебные поля записи, где искать бессмысленно. */
const RECORD_SKIP = new Set(['id', 'recordid', 'pageid', 'tplid', 'projectid', 'slideqty', 'formactiontype', 'off', 'list']);

/** Нормализация для сравнения: сущности, nbsp, пробелы. */
export function normalize(s) {
  return decodeEntities(String(s ?? '')).replace(/ /g, ' ').replace(/\s+/g, ' ');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Вхождения needle в value с учётом нормализации: сущности и nbsp внутри value не мешают. */
export function containsNormalized(value, needle) {
  return normalize(value).includes(normalize(needle));
}

/**
 * Замена needle → replacement в исходной строке: nbsp и `&nbsp;` внутри искомого совпадают с пробелом,
 * так что «+7 (495)» найдётся и в «+7&nbsp;(495)». Возвращает новую строку и число замен.
 */
export function replaceNormalized(value, needle, replacement) {
  const parts = normalize(needle).split(' ').map(escapeRe);
  const re = new RegExp(parts.join('(?:\\s|\\u00a0|&nbsp;)+'), 'g');
  let count = 0;
  const out = String(value).replace(re, () => {
    count += 1;
    return replacement;
  });
  return { value: out, count };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listSnapshots(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
}

/**
 * Живые блоки страницы по инвентарю `records/<pageid>/_inventory.json` → Set строковых recordid.
 * Инвентаря нет или он не разобрался → null (состав страницы неизвестен).
 */
export function liveRecordIds(baseDir, pageid) {
  const path = join(baseDir, 'records', String(pageid), '_inventory.json');
  if (!existsSync(path)) return null;
  try {
    const list = readJson(path);
    if (!Array.isArray(list)) return null;
    return new Set(list.map((r) => String(r.recordid)));
  } catch (e) {
    log.warn('liveRecordIds', 'inventory did not parse', { pageid: String(pageid), error: e.message });
    return null;
  }
}

/**
 * Найти строку по снимкам живых блоков страницы. Каждое вхождение — точный адрес:
 * Zero Block → {kind:'zero', recordid, key, elem_id, field}; стандартный блок → {kind:'record', recordid, field};
 * карточка списка → {kind:'list', recordid, lid, field}.
 *
 * Снимки удалённых блоков (`donor copy --replace`, ручная правка) остаются в папке: операция на такой
 * блок получает отказ Tilda «Record in Trash bin». Поэтому при известном составе (`opts.recordids`,
 * иначе инвентарь) снимки вне него пропускаются и считаются в `skippedStale`.
 */
export function find(pageid, needle, opts = {}) {
  const baseDir = opts.baseDir || baselineDir();
  const hits = [];
  const skippedForm = [];
  let blocks = 0;
  // quiet — повторный поиск по той же странице (ссылки по ID донора): предупреждения уже сказаны первым поиском.
  const note = opts.quiet ? log.debug : log.warn;
  const live = opts.recordids ? new Set([...opts.recordids].map(String)) : liveRecordIds(baseDir, pageid);
  if (!live) note('find', 'find: no inventory — snapshots were not checked against the page composition (snapshot/inventory)', { pageid: String(pageid) });
  const stale = [];
  const isLive = (recordid) => {
    if (!live || live.has(recordid)) return true;
    stale.push(recordid);
    return false;
  };
  const zeroDir = join(baseDir, 'zero', String(pageid));
  for (const f of listSnapshots(zeroDir)) {
    const recordid = f.replace(/\.json$/, '');
    if (!isLive(recordid)) continue;
    blocks += 1;
    const model = readJson(join(zeroDir, f));
    for (const key of Object.keys(model)) {
      if (!/^\d+$/.test(key)) continue;
      const el = model[key];
      for (const [field, value] of Object.entries(el)) {
        if (typeof value !== 'string' || !containsNormalized(value, needle)) continue;
        if (isFormField(field)) {
          skippedForm.push({ kind: 'zero', recordid, key, field });
          note('find', 'hit in a form field skipped', { recordid, key, field });
          continue;
        }
        hits.push({ kind: 'zero', recordid, key, elem_id: String(el.elem_id), elem_type: el.elem_type, field, value });
        log.debug('find', 'found', { recordid, path: `${key}.${field}`, value: normalize(value).slice(0, 80) });
      }
    }
  }
  const recDir = join(baseDir, 'records', String(pageid));
  for (const f of listSnapshots(recDir)) {
    const recordid = f.replace(/\.json$/, '');
    if (!isLive(recordid)) continue;
    blocks += 1;
    const snap = readJson(join(recDir, f));
    const rec = snap.record || snap;
    for (const [field, value] of Object.entries(rec)) {
      if (RECORD_SKIP.has(field) || typeof value !== 'string' || !containsNormalized(value, needle)) continue;
      if (isFormField(field)) {
        skippedForm.push({ kind: 'record', recordid, field });
        note('find', 'hit in a form field skipped', { recordid, field });
        continue;
      }
      hits.push({ kind: 'record', recordid, tplid: String(rec.tplid || ''), field, value: decodeEntities(value) });
      log.debug('find', 'found', { recordid, path: field, value: normalize(value).slice(0, 80) });
    }
    if (typeof rec.list === 'string' && rec.list) {
      let cards = [];
      try {
        cards = decodeList(rec.list);
      } catch (e) {
        log.warn('find', 'list did not parse', { recordid, error: e.message });
      }
      for (const c of cards) {
        for (const [field, value] of Object.entries(c)) {
          if (['lid', 'ls', 'loff'].includes(field) || typeof value !== 'string' || !containsNormalized(value, needle)) continue;
          hits.push({ kind: 'list', recordid, tplid: String(rec.tplid || ''), lid: String(c.lid), field, value });
          log.debug('find', 'found in card', { recordid, lid: c.lid, field });
        }
      }
    }
  }
  if (stale.length) {
    note('find', `skipped ${stale.length} snapshots of deleted blocks (not in the inventory)`, { pageid: String(pageid) });
    log.debug('find', 'snapshots of deleted blocks', { recordids: stale });
  }
  const byBlock = new Set(hits.map((h) => h.recordid)).size;
  (opts.quiet ? log.debug : log.info)('find', `found ${hits.length} hits in ${byBlock} blocks`, { pageid: String(pageid), blocks, skippedForm: skippedForm.length, skippedStale: stale.length });
  return { hits, skippedForm, blocks, skippedStale: stale.length };
}

/**
 * План замены: по каждому адресу — операция плана с новым значением поля.
 * Zero Block → set по elem_id; стандартный блок → field; карточка → listSet.set по lid.
 */
export function buildReplacePlan(pageid, needle, replacement, opts = {}) {
  const { hits, skippedForm, blocks, skippedStale } = find(pageid, needle, opts);
  const ops = [];
  const listByRecord = new Map();
  let replacements = 0;
  for (const h of hits) {
    const { value, count } = replaceNormalized(h.value, needle, replacement);
    replacements += count;
    if (h.kind === 'zero') ops.push({ block: { recordid: h.recordid }, elem: { elem_id: h.elem_id }, set: { [h.field]: value } });
    else if (h.kind === 'record') ops.push({ block: { recordid: h.recordid }, field: { name: h.field, value } });
    else {
      if (!listByRecord.has(h.recordid)) listByRecord.set(h.recordid, { block: { recordid: h.recordid }, listSet: { set: [] } });
      const op = listByRecord.get(h.recordid);
      let entry = op.listSet.set.find((s) => s.lid === h.lid);
      if (!entry) {
        entry = { lid: h.lid, fields: {} };
        op.listSet.set.push(entry);
      }
      entry.fields[h.field] = value;
    }
  }
  ops.push(...listByRecord.values());
  const plan = { name: `replace-${String(pageid)}`, page: String(pageid), ops };
  log.info('buildReplacePlan', 'replace plan built', { ops: ops.length, replacements, skippedForm: skippedForm.length, skippedStale });
  return { plan, hits, replacements, skippedForm, blocks, skippedStale };
}
