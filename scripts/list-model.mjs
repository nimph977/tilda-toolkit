/**
 * Поле `list` стандартного блока-списка (FAQ, карточки) и галерея `imgs` элемента Zero Block
 * Сети нет — чистые функции над снимками.
 *
 * `list` в ответе editrecordsettings — HTML-кодированная JSON-строка массива карточек
 * `[{lid, ls, loff, li_title, li_descr, li_img, li_imgalt, …}]`. В запись уходит **полный**
 * `saverecord` без `onlythisfield` (edrec__sendForm → tc__serializeArray формы содержимого):
 * `btitle`, `bdescr`, `list` (JSON-объект с индексными ключами `{"0":{…},"1":{…}}`, значения
 * чистым текстом — кодирует сервер), затем по набору `li_title`, `li_descr`, `li_img`,
 * `li-tubutton`, `li_imgalt` на каждую карточку, затем `recordid`, `pageid`, `comm`.
 * Состав снят с формы редактора его же сериализатором 2026-09-11:
 * site-baseline/captures/2026-09-11-list-formdata.json.
 *
 * `imgs` — JSON-строка массива слайдов внутри модели Zero Block: `lid` слайда равен uuid файла
 * на CDN, размеров у слайда нет (пересчёт height не нужен).
 */
import { createLogger } from './lib/log.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { assertNoScript } from './lib/form-fields.mjs';
import { msg } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';

const log = createLogger('list-model');

/** Поля карточки, которые редактор шлёт отдельными полями формы, в его порядке. */
export const CARD_FORM_FIELDS = ['li_title', 'li_descr', 'li_img', 'li-tubutton', 'li_imgalt'];
/** Ключи слайда галереи, как их хранит редактор. */
export const SLIDE_KEYS = ['lid', 'li_img', 'li_imgalt', 'li_imgtitle', 'li_imgurl', 'li_imgtarget', 'li_imgnofollow', 'li_youtube', 'li_vimeo', 'li_webm', 'li_mp4'];

const CDN_UUID = /static\.tildacdn\.com\/(tild[0-9a-f-]+)\//;

/** Разобрать `list` из снимка: HTML-сущности → JSON; массив или объект с индексными ключами → массив карточек. */
export function decodeList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((c) => ({ ...c }));
  let text = String(raw);
  if (/&quot;|&#|&amp;/.test(text)) text = decodeEntities(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    log.error('decodeList', 'list did not parse as JSON', { head: text.slice(0, 120) });
    throw new ToolError('BAD_LIST_JSON', msg('list.badListJson', { message: e.message }));
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.keys(parsed).sort((a, b) => Number(a) - Number(b)).map((k) => parsed[k]);
  throw new ToolError('BAD_LIST_JSON', msg('list.listNotArray'));
}

/** JSON для поля `list` в запросе: объект с индексными ключами, значения чистым текстом. */
export function encodeList(cards) {
  return JSON.stringify(Object.fromEntries(cards.map((c, i) => [String(i), c])));
}

/** Уникальный lid карточки — метка времени, как у редактора. */
export function newLid(cards, now = Date.now()) {
  const used = new Set(cards.map((c) => String(c.lid)));
  let id = now;
  while (used.has(String(id))) id += 1;
  return String(id);
}

function findCard(cards, ref, what = 'card') {
  if (ref === undefined || ref === null) throw new ToolError('CARD_REF_REQUIRED', msg('list.cardRefRequired', { what }));
  if (typeof ref === 'object') {
    if (ref.lid !== undefined) return findCard(cards, String(ref.lid), what);
    if (ref.index !== undefined) return findCard(cards, Number(ref.index), what);
    throw new ToolError('CARD_REF_REQUIRED', msg('list.cardRefRequired', { what }));
  }
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 0 || ref >= cards.length) throw new ToolError('CARD_INDEX_OUT_OF_RANGE', msg('list.cardIndexOutOfRange', { what, ref, count: cards.length }));
    return ref;
  }
  const i = cards.findIndex((c) => String(c.lid) === String(ref));
  if (i < 0) throw new ToolError('CARD_NOT_FOUND', msg('list.cardNotFound', { what, ref }));
  return i;
}

/**
 * Применить операции к массиву карточек: `{ set: [{index|lid, fields}], add: [{after?: index|lid|'end', fields}],
 * remove: [index|lid] }`. Порядок: remove → set → add. `ls` перенумеровывается шагом 10 (как у редактора),
 * `lid` новых карточек — метка времени. Значения проверяются на `<script`.
 * @returns {{ cards, changes: [{op, lid, field?, from?, to?}] }}
 */
export function applyListOps(cards, spec = {}, opts = {}) {
  assertNoScript(spec, { path: 'listSet' });
  let out = cards.map((c) => ({ ...c }));
  const changes = [];
  for (const ref of spec.remove || []) {
    const i = findCard(out, ref, 'remove');
    changes.push({ op: 'remove', lid: String(out[i].lid), from: out[i] });
    out.splice(i, 1);
  }
  for (const s of spec.set || []) {
    const i = findCard(out, s.index !== undefined ? Number(s.index) : s.lid !== undefined ? String(s.lid) : s, 'set');
    for (const [field, value] of Object.entries(s.fields || {})) {
      if (field === 'lid') throw new ToolError('LID_IMMUTABLE', msg('list.cardLidImmutable'));
      changes.push({ op: 'set', lid: String(out[i].lid), field, from: out[i][field], to: value });
      out[i][field] = value === null ? '' : String(value);
    }
  }
  const template = out[0] || cards[0] || { lid: '', ls: '', loff: '', li_title: '', li_descr: '', li_img: '', li_imgalt: '' };
  let now = opts.now ?? Date.now();
  for (const a of spec.add || []) {
    const card = Object.fromEntries(Object.keys(template).map((k) => [k, '']));
    Object.assign(card, a.fields || {});
    card.lid = newLid(out, now);
    now = Number(card.lid) + 1;
    card.loff = card.loff || '';
    const at = a.after === undefined || a.after === 'end' ? out.length : findCard(out, a.after, 'add.after') + 1;
    out.splice(at, 0, card);
    changes.push({ op: 'add', lid: card.lid, to: card, at });
  }
  out = out.map((c, i) => ({ ...c, ls: String((i + 1) * 10) }));
  log.info('applyListOps', 'cards changed', { before: cards.length, after: out.length, changes: changes.length });
  log.debug('applyListOps', 'composition', { lids: out.map((c) => c.lid) });
  return { cards: out, changes };
}

/**
 * Поля полного saverecord для блока-списка, в порядке формы редактора.
 * record — содержательные поля снимка (btitle, bdescr, …), cards — итоговые карточки.
 * @returns {Array<{name, value}>}
 */
export function buildListFields({ pageid, recordid, record = {}, cards }) {
  const fields = [];
  fields.push({ name: 'btitle', value: decodeEntities(record.btitle ?? '') });
  fields.push({ name: 'bdescr', value: decodeEntities(record.bdescr ?? '') });
  fields.push({ name: 'list', value: encodeList(cards) });
  for (const c of cards) for (const f of CARD_FORM_FIELDS) fields.push({ name: f, value: String(c[f] ?? '') });
  fields.push({ name: 'recordid', value: String(recordid) });
  fields.push({ name: 'pageid', value: String(pageid) });
  fields.push({ name: 'comm', value: 'saverecord' });
  const bytes = Buffer.byteLength(new URLSearchParams(fields.map((f) => [f.name, f.value])).toString());
  if (bytes > 100 * 1024) log.warn('buildListFields', 'body larger than 100 KB', { bytes, cards: cards.length });
  log.debug('buildListFields', 'body built', { fields: fields.length, cards: cards.length, bytes, head: fields.map((f) => `${f.name}=${String(f.value).slice(0, 20)}`).join('&').slice(0, 200) });
  return fields;
}

/** Нормализация текста карточки для сверки: HTML-сущности и неразрывные пробелы. */
export function normalizeCardText(v) {
  return decodeEntities(String(v ?? '')).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Расхождения между ожидаемыми и перечитанными карточками по lid и содержательным полям. */
export function diffCards(expected, actual) {
  const problems = [];
  if (expected.length !== actual.length) problems.push({ problem: msg('list.problem.cardCountMismatch'), expected: expected.length, actual: actual.length });
  const byLid = new Map(actual.map((c) => [String(c.lid), c]));
  expected.forEach((e, i) => {
    const a = byLid.get(String(e.lid)) ?? actual[i];
    if (!a) {
      problems.push({ problem: msg('list.problem.cardNotFound'), lid: e.lid });
      return;
    }
    for (const field of Object.keys(e)) {
      if (field === 'ls' || field === 'lid') continue;
      if (normalizeCardText(e[field]) !== normalizeCardText(a[field])) problems.push({ problem: msg('list.problem.cardFieldMismatch'), lid: e.lid, field, expected: normalizeCardText(e[field]).slice(0, 60), actual: normalizeCardText(a[field]).slice(0, 60) });
    }
  });
  if (expected.map((c) => String(c.lid)).join() !== actual.map((c) => String(c.lid)).join()) problems.push({ problem: msg('list.problem.cardOrderMismatch'), expected: expected.map((c) => c.lid), actual: actual.map((c) => c.lid) });
  return problems;
}

// ---------------------------------------------------------------------------
// Галерея imgs (Zero Block)
// ---------------------------------------------------------------------------

/** JSON с не-ASCII символами в виде \uXXXX — так сервер хранит `imgs` (проверено записью 2026-09-11). */
export function jsonEscapeNonAscii(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Разобрать `imgs` элемента: JSON-строка массива слайдов. */
export function decodeSlides(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((s) => ({ ...s }));
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    throw new ToolError('BAD_IMGS_JSON', msg('list.badImgsJson', { message: e.message }));
  }
  if (!Array.isArray(parsed)) throw new ToolError('BAD_IMGS_JSON', msg('list.imgsNotArray'));
  return parsed;
}

/** lid слайда — uuid файла на CDN из адреса картинки; без CDN-адреса — метка времени. */
export function slideLid(img, slides, now = Date.now()) {
  const m = String(img || '').match(CDN_UUID);
  if (m && !slides.some((s) => s.lid === m[1])) return m[1];
  return newLid(slides, now);
}

/**
 * Применить операции к слайдам: тот же формат, что applyListOps (`set`, `add`, `remove`; адресация по
 * index или lid). `li_img` нового слайда обязателен и должен быть адресом на static.tildacdn.com.
 * @returns {{ slides, changes, imgs }} — imgs: строка для поля модели
 */
export function applyGalleryOps(slides, spec = {}, opts = {}) {
  assertNoScript(spec, { path: 'gallerySet' });
  let out = slides.map((s) => ({ ...s }));
  const changes = [];
  for (const ref of spec.remove || []) {
    const i = findCard(out, ref, 'remove');
    changes.push({ op: 'remove', lid: out[i].lid, from: out[i] });
    out.splice(i, 1);
  }
  for (const s of spec.set || []) {
    const i = findCard(out, s.index !== undefined ? Number(s.index) : s.lid !== undefined ? String(s.lid) : s, 'set');
    for (const [field, value] of Object.entries(s.fields || {})) {
      if (field === 'lid') throw new ToolError('LID_IMMUTABLE', msg('list.slideLidImmutable'));
      if (!SLIDE_KEYS.includes(field)) throw new ToolError('UNKNOWN_SLIDE_FIELD', msg('list.unknownSlideFieldSet', { field }));
      if (field === 'li_img' && value && !/^https:\/\/static\.tildacdn\.com\//.test(String(value))) throw new ToolError('IMAGE_URL_REJECTED', msg('list.imageUrlRejected', { value: String(value).slice(0, 60) }));
      changes.push({ op: 'set', lid: out[i].lid, field, from: out[i][field], to: value });
      out[i][field] = value === null ? '' : String(value);
    }
  }
  for (const a of spec.add || []) {
    const f = a.fields || {};
    if (!f.li_img || !/^https:\/\/static\.tildacdn\.com\//.test(String(f.li_img))) {
      throw new ToolError('IMAGE_URL_REJECTED', msg('list.imageUrlRejected', { value: f.li_img ? String(f.li_img).slice(0, 60) : msg('list.emptyValue') }));
    }
    for (const k of Object.keys(f)) if (!SLIDE_KEYS.includes(k)) throw new ToolError('UNKNOWN_SLIDE_FIELD', msg('list.unknownSlideFieldAdd', { field: k }));
    const slide = Object.fromEntries(SLIDE_KEYS.map((k) => [k, '']));
    Object.assign(slide, f);
    slide.lid = slideLid(f.li_img, out, opts.now);
    const at = a.after === undefined || a.after === 'end' ? out.length : findCard(out, a.after, 'add.after') + 1;
    out.splice(at, 0, slide);
    changes.push({ op: 'add', lid: slide.lid, to: slide, at });
  }
  log.info('applyGalleryOps', 'slides changed', { before: slides.length, after: out.length, changes: changes.length });
  return { slides: out, changes, imgs: jsonEscapeNonAscii(out) };
}
