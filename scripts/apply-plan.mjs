/**
 * План операций: подготовка payload'ов и сверка после записи. Сети нет.
 *
 *   node scripts/apply-plan.mjs prepare   <план.json> [--out <папка>]
 *   node scripts/apply-plan.mjs verify    <план.json> [--out <папка>] [--reread <папка>]
 *   node scripts/apply-plan.mjs plan-copy <pageid-источника> <pageid-приёмника> [--out <файл.json>]
 *
 * prepare: по снимкам блоков (site-baseline/zero|records/<pageid>/…, снятым до правки)
 *          строит новые модели, проверяет validate(), пишет
 *          <out>/<pageid>/<recordid>.payload.json и печатает diff.
 *          Запись делает scripts/cycle.mjs (свой браузер); `*.call.js` для browser_evaluate
 *          пишутся только при opts.emitCalls (CLI apply-plan.mjs — всегда, tilda.mjs — по --emit-calls).
 *          Для операций создания блока (addZero/addRecord) модель через Node не проходит:
 *          пишется <id>.create.payload.json с эталоном сверки и общий _build.call.js —
 *          вызов buildBlocks, который копирует блоки внутри браузера.
 * verify:  сравнивает перечитанные после записи модели из <reread>/<pageid>/<recordid>.json
 *          с ожидаемыми из payload; любое расхождение — код выхода 1.
 *          Собранные блоки сопоставляются с операциями плана по журналу сборки
 *          <reread>/<pageid>/_built.json (его возвращает buildBlocks).
 * plan-copy: по инвентарю источника строит план сборки его копии — операция на блок,
 *          порядок исходный, скрытые блоки помечены hidden.
 *
 * Формат плана — skills/tilda-manager/references/plan-schema.md.
 * По умолчанию out = <baseline>/payload, reread = <baseline>/reread.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger } from './lib/log.mjs';
import { baselineDir, protectedPages } from './lib/paths.mjs';
import { load as loadSnapshot, snapshotPath } from './snapshot.mjs';
import { findElement, setFields, diff, validate, duplicateElement, removeElement, setBlockFields } from './zero-model.mjs';
import { assertNotFormField, assertNoScript, formFieldChanges } from './lib/form-fields.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { RECORD_SKIP_FIELDS, recordFields } from './lib/record-fields.mjs';
import { decodeList, applyListOps, buildListFields, diffCards, decodeSlides, applyGalleryOps, newLid, normalizeCardText, CARD_FORM_FIELDS } from './list-model.mjs';
import { FORM_FIELDS } from './lib/form-fields.mjs';
import { loadCatalog, loadSettingsMap } from './catalog.mjs';

const log = createLogger('apply-plan');

/** Ключи модели, которые Тильда вправе менять сама при записи. */
const VOLATILE_KEYS = new Set(['timestamp']);

export { decodeEntities };
// `RECORD_SKIP_FIELDS` и `recordFields` живут в lib/record-fields.mjs (общие с catalog.mjs и promote.mjs).
export { RECORD_SKIP_FIELDS, recordFields } from './lib/record-fields.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Короткая запись значения для лога: объект (например spec картинки) не превращается в [object Object]. */
function short(v) {
  if (v === undefined || v === null) return '';
  return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 80);
}

function loadInventory(pageid, opts) {
  const p = join(opts.baseDir, 'records', String(pageid), '_inventory.json');
  if (!existsSync(p)) {
    log.error('loadInventory', 'нет инвентаря страницы; снять через listRecords()', { path: p });
    throw new Error(`NO_INVENTORY ${p}`);
  }
  return readJson(p);
}

/** Возраст файла инвентаря в мс — для перестановки блоков нужен свежий. */
export function inventoryAgeMs(pageid, opts) {
  const p = join(opts.baseDir, 'records', String(pageid), '_inventory.json');
  if (!existsSync(p)) return Infinity;
  return Date.now() - statSync(p).mtimeMs;
}

/**
 * Полный порядок блоков после перестановок. moves — [{recordid, after|before|index}] по очереди;
 * setOrder — готовый полный список (откат). Незнакомый recordid или неполный список — ошибка.
 * @returns {{ before: string[], after: string[], moves: [{recordid, from, to}] }}
 */
export function reorderBlocks(inventory, moves = [], setOrder = null) {
  const before = inventory.map((r) => String(r.recordid));
  let order = [...before];
  const applied = [];
  if (setOrder) {
    const want = setOrder.map(String);
    if ([...want].sort().join() !== [...before].sort().join()) {
      log.error('reorderBlocks', 'setOrder не совпадает по составу с инвентарём', { inventory: before.length, setOrder: want.length });
      throw new Error(`BAD_ORDER: setOrder должен содержать ровно те же ${before.length} recordid, что и инвентарь`);
    }
    order = want;
  }
  for (const m of moves) {
    const id = String(m.recordid);
    const from = order.indexOf(id);
    if (from < 0) throw new Error(`NO_RECORD ${id}: нет в инвентаре`);
    order.splice(from, 1);
    let to;
    if (m.after !== undefined) {
      const i = order.indexOf(String(m.after));
      if (i < 0) throw new Error(`NO_RECORD ${m.after}: нет в инвентаре (after)`);
      to = i + 1;
    } else if (m.before !== undefined) {
      const i = order.indexOf(String(m.before));
      if (i < 0) throw new Error(`NO_RECORD ${m.before}: нет в инвентаре (before)`);
      to = i;
    } else if (m.index !== undefined) {
      to = Math.max(0, Math.min(order.length, Number(m.index)));
    } else throw new Error(`moveBlock ${id}: нужен after, before или index`);
    order.splice(to, 0, id);
    applied.push({ recordid: id, from, to: order.indexOf(id) });
    log.debug('reorderBlocks', 'перестановка', { recordid: id, from, to: order.indexOf(id) });
  }
  const diffPositions = before.map((id, i) => ({ id, from: i, to: order.indexOf(id) })).filter((x) => x.from !== x.to);
  log.debug('reorderBlocks', 'порядок', { before: before.join(','), after: order.join(','), moved: diffPositions.length });
  return { before, after: order, moves: applied };
}

/** Разрешает block-селектор в recordid. */
export function resolveBlock(block, pageid, opts) {
  if (block.recordid) return String(block.recordid);
  if (block.zeroIndex !== undefined) {
    const inv = loadInventory(pageid, opts);
    const hit = inv.find((r) => r.zeroIndex === Number(block.zeroIndex));
    if (!hit) {
      log.error('resolveBlock', 'Zero Block с таким порядковым номером не найден', { pageid, zeroIndex: block.zeroIndex });
      throw new Error(`NO_ZERO_INDEX ${block.zeroIndex}`);
    }
    log.debug('resolveBlock', 'zeroIndex → recordid', { zeroIndex: block.zeroIndex, recordid: hit.recordid });
    return String(hit.recordid);
  }
  throw new Error('block: нужен recordid или zeroIndex');
}

/**
 * Готовит одну операцию создания блока (`addZero` / `addRecord`).
 *
 * Модель и поля источника через Node не проходят: копирование целиком выполняет браузерный слой
 * (`copyZero` / `copyRecord`), потому что редактор читает любую страницу проекта. Здесь снимок
 * источника нужен как эталон сверки и как доказательство, что он снят до записи.
 */
function prepareCreateOp(op, i, pageid, plan, o) {
  const id = op.id || `b${i + 1}`;
  const spec = op.addZero || op.addRecord;
  const blockKind = op.addZero ? 'zero' : 'record';
  const source = { ...(spec.source || {}) };
  source.page = String(source.page || (plan.source && plan.source.page) || '');
  source.recordid = String(source.recordid || '');
  if (!source.page || !source.recordid) throw new Error(`op#${i} (${id}): нужен source.page и source.recordid`);
  const tplid = String(op.addZero ? '396' : spec.tplid || '');
  if (!tplid) throw new Error(`op#${i} (${id}): у addRecord нужен tplid`);
  if (blockKind === 'record' && tplid === '396') throw new Error(`op#${i} (${id}): Zero Block копируется операцией addZero`);

  // Снимок источника обязан существовать — иначе сверять получившийся блок будет не с чем.
  const snapshot = loadSnapshot({ kind: blockKind, pageid: source.page, recordid: source.recordid }, o);
  const expect =
    blockKind === 'zero'
      ? { keys: Object.keys(snapshot).length, elemIds: Object.keys(snapshot).filter((k) => /^\d+$/.test(k)).map((k) => snapshot[k].elem_id) }
      : { fields: Object.keys(recordFields(snapshot)) };
  const hidden = op.hidden === true || op.hidden === 'y' ? 'y' : 'n';
  log.info('prepare', `op#${i}: создать блок ${id} (${blockKind}, tpl ${tplid})`, { source: `${source.page}/${source.recordid}`, hidden, expect: blockKind === 'zero' ? expect.keys + ' ключей' : expect.fields.length + ' полей' });
  return { kind: 'create', mode: 'copy', pageid, id, blockKind, tplid, source, hidden, after: op.after || null, expect };
}

/**
 * Нормализация значения поля для сверки: сущности, неразрывные пробелы, схлопывание пробелов
 * (как у карточек), затем канон переносов `<br>` и канон JSON.
 * Tilda хранит переносы как `<br />` (проверено на перечитанных снимках, 2026-09-22; форма
 * `<br>` встречается в снимках, снятых раньше), а JSON-поля (`*_typo`, `soclinks`, `menuitems`)
 * отдаёт пересериализованными: слэши как `\/`, кириллица как `\uXXXX`, кавычки у части полей
 * как `&quot;` (их снимает декодирование сущностей).
 */
export function normalizeFieldValue(v) {
  const text = normalizeCardText(v).replace(/\s*<br\s*\/?>\s*/gi, '<br>');
  return canonicalJson(text);
}

/** Строка-JSON (массив или объект) → `JSON.stringify(JSON.parse(...))`; иначе строка как есть. */
export function canonicalJson(text) {
  if (!/^[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

const CARD_FIELD_RE = /^li[_-]/;

/**
 * Ключи сверки карточки: форма редактора плюс всё, что план задал сам (например `li_link`,
 * который уходит внутри `list`). `lid` присваивает сервер, сверке он не подлежит.
 */
export function expectedCardKeys(cards) {
  return [...new Set([...CARD_FORM_FIELDS, ...cards.flatMap((c) => Object.keys(c).filter((k) => k !== 'lid'))])];
}

/** Ожидаемые значения карточек плана — по ключам `expectedCardKeys`, через канон сверки. */
function expectedCards(cards) {
  const keys = expectedCardKeys(cards);
  return cards.map((c) => Object.fromEntries(keys.map((k) => [k, normalizeFieldValue(c[k] ?? '')])));
}

/**
 * Операция `newRecord` — стандартный блок из полей без источника: `addRecord(tplid)` +
 * `saveRecordFull(fields)`. Эталон сверки — сами значения плана (`expect`), снимка источника нет.
 * Каталог (`catalog capture`) даёт имена полей шаблона: отсутствие поля в каталоге — WARN,
 * недоступный шаблон — ошибка до сети.
 */
/**
 * Флаг `formContent` операции: допустимо только
 * `'reference'` — он разрешает поля `FORM_CONTENT_FIELDS` (`formmsgurl`); получатели запрещены всегда.
 */
function formContentOf(op, i, id) {
  if (op.formContent === undefined || op.formContent === null) return false;
  if (op.formContent !== 'reference') throw new Error(`op#${i} (${id}): formContent допускает только 'reference'`);
  return true;
}

/** Лимит кода HTML-блока T123 — тот же, что у `T.saveT123Code` (`T123_LIMIT`). */
export const T123_CODE_LIMIT = 25 * 1024;

/** Поле списка полей формы стандартного блока: пишется так, читается как `list` (итог пробы 3). */
export const FORM_INPUTS_FIELD = 'forminputs';

/** Элементы формы из значения `forminputs`: массив объектов, `lid`/`ls` дописываются. */
function formInputsOf(value, i, id, now) {
  let items;
  try {
    items = JSON.parse(String(value));
  } catch {
    throw new Error(`op#${i} (${id}): forminputs должно быть JSON-массивом элементов формы`);
  }
  if (!Array.isArray(items)) throw new Error(`op#${i} (${id}): forminputs должно быть JSON-массивом элементов формы`);
  return items.map((el, idx) => ({
    ...el,
    lid: el.lid ? String(el.lid) : newLid(items.slice(0, idx), now + idx),
    ls: String((idx + 1) * 10),
    loff: el.loff ?? '',
    li_parent_id: el.li_parent_id ?? '',
  }));
}

function prepareNewOp(op, i, pageid, plan, o) {
  const id = op.id || `b${i + 1}`;
  const spec = op.newRecord;
  const tplid = String(spec.tplid || '');
  if (!/^\d+$/.test(tplid)) throw new Error(`op#${i} (${id}): у newRecord нужен числовой tplid`);
  if (tplid === '396') throw new Error(`op#${i} (${id}): Zero Block из полей не собирается`);
  const allowContent = formContentOf(op, i, id);

  const rawFields = Array.isArray(spec.fields) ? spec.fields : [];
  for (const f of rawFields) {
    if (!f || typeof f.name !== 'string' || !f.name) throw new Error(`op#${i} (${id}): у поля newRecord нужно имя`);
    if (typeof f.value !== 'string' && typeof f.value !== 'number') throw new Error(`op#${i} (${id}): значение поля ${f.name} должно быть строкой или числом`);
    assertNotFormField(f.name, { op: i }, { allowContent });
    assertNoScript(String(f.value), { op: i, field: f.name });
  }
  // Код HTML-блока: только у 131, не больше 25 КБ, без <script> (сбрасывает сессию Tilda).
  const code = spec.code === undefined || spec.code === null ? undefined : String(spec.code);
  if (code !== undefined) {
    if (tplid !== '131') throw new Error(`op#${i} (${id}): code пишется только в HTML-блок 131, а не в ${tplid}`);
    if (code.length > T123_CODE_LIMIT) throw new Error(`op#${i} (${id}): код HTML-блока ${code.length} байт больше лимита ${T123_CODE_LIMIT}`);
    assertNoScript(code, { op: i, field: 'code' });
  }
  const pendingImages = Array.isArray(spec.images) ? spec.images.filter((im) => im.file && !im.url) : [];
  if (pendingImages.length) log.warn('prepare', 'картинки newRecord не загружены (офлайн)', { id, count: pendingImages.length });

  const byName = Object.fromEntries(rawFields.map((f) => [f.name, String(f.value)]));
  const cards = Array.isArray(spec.cards) ? spec.cards.map((c) => ({ ...c })) : [];
  const now = Date.now();
  cards.forEach((c, idx) => {
    if (c.lid === undefined || c.lid === null || c.lid === '') c.lid = newLid(cards.slice(0, idx), now + idx);
    for (const [k, v] of Object.entries(c)) assertNoScript(String(v ?? ''), { op: i, field: `card#${idx}.${k}` });
  });
  let fields = rawFields.map((f) => ({ name: f.name, value: String(f.value) }));
  if (cards.length) {
    const listFields = buildListFields({ pageid, recordid: '0', record: { btitle: byName.btitle ?? '', bdescr: byName.bdescr ?? '' }, cards }).filter((f) => !['recordid', 'pageid', 'comm'].includes(f.name));
    fields = fields.filter((f) => !['btitle', 'bdescr', 'list'].includes(f.name) && !CARD_FIELD_RE.test(f.name)).concat(listFields);
  }
  // Поля формы: пишутся полем forminputs, сервер хранит их в list — сверка идёт по list как по карточкам.
  let formItems = [];
  const formField = fields.find((f) => f.name === FORM_INPUTS_FIELD);
  if (formField) {
    if (cards.length) throw new Error(`op#${i} (${id}): у newRecord не может быть одновременно cards и forminputs`);
    formItems = formInputsOf(formField.value, i, id, now);
    formField.value = JSON.stringify(formItems);
    log.debug('prepare', 'поля формы', { id, items: formItems.length, types: formItems.map((x) => x.li_type) });
  }

  const cat = loadCatalog(tplid, o);
  if (cat === null) {
    log.warn('prepare', 'каталог для tplid не снят — имена полей не проверены', { id, tplid });
  } else if (cat.available === false) {
    throw new Error(`op#${i} (${id}): шаблон ${tplid} недоступен на тарифе (каталог)`);
  } else {
    // tplFields — полный список полей шаблона (buttonlink, rutubeid пустыми в tabs не видны).
    const allowed = new Set([...(cat.tabs?.content ?? []), ...(cat.tabs?.settings ?? []), ...(cat.tplFields ?? [])]);
    // Поля «Настроек» из карты влияния (screenmax, пустые у свежего блока) — тоже поля шаблона.
    const map = loadSettingsMap(tplid, o);
    if (map) for (const name of Object.keys(map.schema ?? map.fields ?? {})) allowed.add(name);
    for (const f of fields) {
      if (allowed.has(f.name) || CARD_FORM_FIELDS.includes(f.name) || f.name === 'list' || IMAGE_UPLOAD_FIELD_RE.test(f.name)) continue;
      log.warn('prepare', 'поля нет в каталоге шаблона', { id, tplid, field: f.name });
    }
  }

  const expect = {
    values: Object.fromEntries([
      ...fields.filter((f) => f.name !== 'list' && f.name !== FORM_INPUTS_FIELD && !CARD_FIELD_RE.test(f.name) && !IMAGE_UPLOAD_FIELD_RE.test(f.name)).map((f) => [f.name, normalizeFieldValue(f.value)]),
      // `<поле>-del=yes` сбрасывает картинку: после записи поле должно быть пустым.
      ...fields.filter((f) => /-del$/.test(f.name) && f.value === 'yes').map((f) => [f.name.replace(/-del$/, ''), '']),
    ]),
    cards: expectedCards(cards.length ? cards : formItems),
  };
  const hidden = op.hidden === true || op.hidden === 'y' ? 'y' : 'n';
  log.info('prepare', `op#${i}: новый блок ${id} (tpl ${tplid})`, { fields: fields.length, cards: cards.length, formItems: formItems.length, hidden, formContent: allowContent });
  log.debug('prepare', 'поля нового блока', { id, names: fields.map((f) => f.name), cardKeys: [...new Set(cards.flatMap((c) => Object.keys(c)))] });
  if (code !== undefined) expect.code = code;
  const out = { kind: 'create', mode: 'new', pageid, id, blockKind: 'record', tplid, fields, hidden, after: op.after || null, expect };
  if (allowContent) out.formContent = 'reference';
  if (code !== undefined) out.code = code;
  return out;
}

/** Служебные поля картинки (`<поле>-uploadmethod`, `<поле>-tuinfo-*`, `<поле>-del`) — не поля шаблона. */
export const IMAGE_UPLOAD_FIELD_RE = /-(uploadmethod|tuinfo-[a-z]+|del)$/;

/**
 * Поля `saverecord` для картинки стандартного блока — так же, как это делает редактор
 * (`tp__record__addEditEventsForImageField`, прочитано 2026-09-22): сервер берёт картинку из
 * `<поле>-uploadmethod=tu` и `<поле>-tuinfo-{uuid,cdnurl,name,width,size}`, а голое `<поле>=url`
 * молча игнорирует (приёмка 2026-09-22: `img` остался стоковым). Само `<поле>=url` тоже кладём —
 * по нему сверяется результат.
 */
export function imageUploadFields(field, up) {
  return [
    { name: field, value: up.cdnUrl },
    { name: `${field}-uploadmethod`, value: 'tu' },
    { name: `${field}-tuinfo-uuid`, value: String(up.uuid ?? '') },
    { name: `${field}-tuinfo-cdnurl`, value: up.cdnUrl },
    { name: `${field}-tuinfo-name`, value: String(up.name ?? up.file ?? '') },
    { name: `${field}-tuinfo-width`, value: String(up.width ?? '') },
    { name: `${field}-tuinfo-size`, value: String(up.size ?? up.bytes ?? '') },
  ];
}

/**
 * Подставляет загруженную картинку в операцию `newRecord` (шаг 2b цикла, до `prepare`):
 * `image.card` задан — URL в карточку (внутри `list` сервер принимает голый адрес), иначе —
 * служебные поля загрузки для поля `image.field`. `up` — ответ `upload()` (`{cdnUrl, uuid, width,
 * size, file}`) или строка URL (тогда только голое поле — для тестов и ручных планов).
 * Чистая функция, возвращает op.
 */
export function applyImageUpload(op, image, up) {
  const spec = op.newRecord;
  if (!spec) throw new Error('applyImageUpload: операция не newRecord');
  const info = typeof up === 'string' ? { cdnUrl: up } : up;
  if (!info || !info.cdnUrl) throw new Error('applyImageUpload: нет cdnUrl загрузки');
  if (image.card !== undefined) {
    const card = Array.isArray(spec.cards) ? spec.cards[image.card] : undefined;
    if (!card) throw new Error(`applyImageUpload: карточки #${image.card} нет в операции`);
    card[image.field] = info.cdnUrl;
  } else {
    spec.fields = Array.isArray(spec.fields) ? spec.fields : [];
    const add = info.uuid ? imageUploadFields(image.field, info) : [{ name: image.field, value: info.cdnUrl }];
    for (const f of add) {
      const existing = spec.fields.find((x) => x.name === f.name);
      if (existing) existing.value = f.value;
      else spec.fields.push(f);
    }
  }
  image.url = info.cdnUrl;
  log.debug('applyImageUpload', 'картинка подставлена', { field: image.field, card: image.card, tu: Boolean(info.uuid) });
  return op;
}

/**
 * Пишет `_build.call.js` — готовый вызов сборки для browser_evaluate: один вызов на всю
 * последовательность блоков, цепочку `afterid` браузерный слой ведёт сам.
 *
 * Порциями: заменить `startAfter: ""` на `lastRecordid` предыдущего вызова и урезать список.
 */
/** Список блоков для `buildBlocks` из payload'ов create: режим `new` — поля, `copy` — источник. */
export function buildBlockSpecs(createOps) {
  return createOps.map((c) =>
    c.mode === 'new'
      ? { id: c.id, mode: 'new', tplid: c.tplid, fields: c.fields, hidden: c.hidden, ...(c.formContent ? { formContent: c.formContent } : {}), ...(c.code !== undefined ? { code: c.code } : {}) }
      : { id: c.id, srcPage: c.source.page, srcRecordid: c.source.recordid, tplid: c.tplid, hidden: c.hidden },
  );
}

function writeBuildCall(dir, pageid, createOps, plan) {
  const blocks = buildBlockSpecs(createOps);
  const startAfter = String((plan && plan.startAfter) || '');
  const call = `async () => window.__tilda.buildBlocks(${JSON.stringify(pageid)}, ${JSON.stringify(blocks)}, ${JSON.stringify({ startAfter })})`;
  const path = join(dir, '_build.call.js');
  writeFileSync(path, call + '\n', 'utf8');
  log.info('prepare', 'вызов сборки записан', { path, blocks: blocks.length, startAfter: startAfter || '(в конец страницы)' });
  return path;
}

/**
 * Готовит payload'ы. Возвращает массив {kind, pageid, recordid, ...}.
 * @param {object} plan {page, ops}
 */
export function prepare(plan, opts = {}) {
  const o = { out: null, emitCalls: true, ...opts };
  o.baseDir ||= baselineDir();
  o.out = o.out || join(o.baseDir, 'payload');
  const pageid = String(plan.page);
  if (protectedPages().includes(pageid)) {
    log.error('prepare', 'страница защищена от записи (TILDA_PROTECTED_PAGES)', { pageid });
    throw new Error(`PROTECTED_PAGE ${pageid}`);
  }
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) throw new Error('план без операций');
  log.info('prepare', 'начало', { pageid, ops: plan.ops.length });

  const zeroWork = new Map(); // recordid → {before, model}
  const recordOps = [];
  const listOps = [];
  const sortMoves = [];
  let sortSetOrder = null;
  const blockOps = [];
  const createOps = [];
  plan.ops.forEach((op, i) => {
    // Операции создания блока адресуются не recordid (его ещё нет), а собственным id внутри плана.
    if (op.newRecord) {
      createOps.push(prepareNewOp(op, i, pageid, plan, o));
      return;
    }
    if (op.addZero || op.addRecord) {
      createOps.push(prepareCreateOp(op, i, pageid, plan, o));
      return;
    }
    if (op.setOrder) {
      sortSetOrder = op.setOrder.map(String);
      log.info('prepare', `op#${i}: полный порядок блоков`, { blocks: sortSetOrder.length });
      return;
    }
    const recordid = resolveBlock(op.block || {}, pageid, o);
    if (op.moveBlock) {
      const m = op.moveBlock === true ? {} : op.moveBlock;
      const spec = { recordid };
      if (m.after !== undefined) spec.after = String(m.after.zeroIndex !== undefined ? resolveBlock(m.after, pageid, o) : m.after.recordid ?? m.after);
      if (m.before !== undefined) spec.before = String(m.before.zeroIndex !== undefined ? resolveBlock(m.before, pageid, o) : m.before.recordid ?? m.before);
      if (m.index !== undefined) spec.index = Number(m.index);
      log.info('prepare', `op#${i}: блок ${recordid} → переставить`, spec);
      sortMoves.push(spec);
      return;
    }
    // Общий guard над всеми строковыми значениями операции: <script не пишется ни в одно поле.
    assertNoScript(op, { op: i, recordid });
    if (op.listSet) {
      // Блок-список: полный saverecord собирается из снимка обеих вкладок и новых карточек.
      const snapshot = loadSnapshot({ kind: 'record', pageid, recordid }, o);
      const rec = snapshot.record || snapshot;
      const present = FORM_FIELDS.filter((f) => f in rec && rec[f] !== '');
      if (present.length) {
        log.warn('prepare', 'отказ: блок с полями формы через listSet не пишется — полный saverecord переслал бы их', { recordid, fields: present });
        const e = new Error(`FORM_FIELD_REJECTED ${recordid}: блок содержит ${present.join(', ')}`);
        e.code = 'FORM_FIELD_REJECTED';
        throw e;
      }
      const before = decodeList(rec.list);
      const spec = Array.isArray(op.listSet.cards) ? null : op.listSet;
      const { cards, changes } = spec ? applyListOps(before, spec) : { cards: op.listSet.cards.map((c, i) => ({ ...c, ls: String((i + 1) * 10) })), changes: [{ op: 'replaceAll', to: op.listSet.cards.length }] };
      const fields = buildListFields({ pageid, recordid, record: rec, cards });
      log.info('prepare', `op#${i}: блок ${recordid} → список карточек`, { before: before.length, after: cards.length, changes: changes.length, fields: fields.length });
      listOps.push({ i, recordid, before, cards, changes, fields });
      return;
    }
    if (op.field) {
      // Чёрный список полей формы действует и на путь saverecord; formmsgurl — только с флагом.
      const allowContent = formContentOf(op, i, recordid);
      assertNotFormField(op.field.name, { recordid, path: 'prepare.field' }, { allowContent });
      recordOps.push({ i, recordid, field: op.field.name, value: op.field.value, ...(allowContent ? { formContent: 'reference' } : {}) });
      log.info('prepare', `op#${i}: блок ${recordid} → поле ${op.field.name}`, { value: String(op.field.value).slice(0, 60) });
      return;
    }
    if (op.blockHidden !== undefined) {
      const hidden = op.blockHidden === true || op.blockHidden === 'y' ? 'y' : 'n';
      blockOps.push({ i, recordid, hidden });
      log.info('prepare', `op#${i}: блок ${recordid} → видимость блока`, { hidden });
      return;
    }
    if (!op.blockSet && (!op.elem || !(op.set || op.duplicateElement || op.removeElement || op.gallerySet))) throw new Error(`op#${i}: нужны elem и set (или duplicateElement / removeElement / gallerySet), либо field, listSet или blockSet`);
    let entry = zeroWork.get(recordid);
    if (!entry) {
      const before = loadSnapshot({ kind: 'zero', pageid, recordid }, o);
      entry = { before, model: before, duplicates: [], removed: [] };
      zeroWork.set(recordid, entry);
    }
    if (op.blockSet) {
      log.info('prepare', `op#${i}: блок ${recordid} → служебные ключи`, { keys: Object.keys(op.blockSet) });
      entry.model = setBlockFields(entry.model, op.blockSet);
      return;
    }
    if (op.removeElement) {
      const rm = removeElement(entry.model, op.elem);
      log.info('prepare', `op#${i}: блок ${recordid} → удалить элемент ${rm.elem_id}`, {});
      entry.model = rm.model;
      entry.removed.push(rm.elem_id);
      return;
    }
    if (op.duplicateElement) {
      // Дублирование элемента: раскладка разная или соседей мало → нужно явное confirm.
      const spec = op.duplicateElement === true ? {} : op.duplicateElement;
      const dup = duplicateElement(entry.model, op.elem, { gap: spec.gap, set: spec.set, resStrategy: spec.resStrategy || op.resStrategy || plan.resStrategy });
      log.info('prepare', `op#${i}: блок ${recordid} → копия элемента ${dup.elem_id}`, { needsConfirm: dup.needsConfirm, reason: dup.reason, proposal: dup.proposal.map((p) => `${p.res}: top ${p.top}, left ${p.left}`) });
      if (dup.needsConfirm && spec.confirm !== true) {
        log.error('prepare', 'DUPLICATE_NEEDS_CONFIRM: копия рассчитана, но раскладка требует подтверждения человека', { recordid, reason: dup.reason, proposal: dup.proposal });
        const e = new Error(`DUPLICATE_NEEDS_CONFIRM ${recordid}: ${dup.reason}. Предложение: ${dup.proposal.map((p) => `${p.res}: top ${p.top}, left ${p.left}`).join('; ')}. Добавьте "confirm": true в duplicateElement, чтобы записать так`);
        e.code = 'DUPLICATE_NEEDS_CONFIRM';
        e.proposal = dup.proposal;
        e.reason = dup.reason;
        throw e;
      }
      entry.model = dup.model;
      entry.duplicates.push({ elem_id: dup.elem_id, key: dup.key, proposal: dup.proposal, abHeightRaised: dup.abHeightRaised });
      return;
    }
    if (op.gallerySet) {
      const { key: gk, elem: gel } = findElement(entry.model, op.elem);
      const slides = decodeSlides(gel.imgs);
      const g = applyGalleryOps(slides, op.gallerySet);
      log.info('prepare', `op#${i}: блок ${recordid} → элемент ${gel.elem_id} (${gel.elem_type}) → галерея`, { before: slides.length, after: g.slides.length, changes: g.changes.length });
      entry.model = setFields(entry.model, gk, { imgs: g.imgs });
      return;
    }
    const { key, elem } = findElement(entry.model, op.elem);
    for (const [field, value] of Object.entries(op.set)) {
      // У операции `image` имя поля плана не совпадает с полем модели: пишутся img/filewidth/fileheight.
      const current = field === 'image' ? entry.model[key].img : entry.model[key][field];
      log.info('prepare', `op#${i}: блок ${recordid} → элемент ${elem.elem_id} (${elem.elem_type}) → ${field}`, { from: short(current), to: short(value) });
    }
    // Все поля операции — одним вызовом: стратегия -res-* смотрит на явно заданные варианты.
    entry.model = setFields(entry.model, key, op.set, { resStrategy: op.resStrategy || plan.resStrategy });
  });

  const payloads = [];
  for (const [recordid, { before, model, duplicates, removed }] of zeroWork) {
    // Вторая линия запрета полей формы: даже если поле формы изменилось обходным путём, модель не уйдёт в запись.
    const formChanged = formFieldChanges(before, model);
    if (formChanged.length) {
      log.warn('prepare', 'отказ: модель меняет поля формы', { recordid, changed: formChanged });
      const e = new Error(`FORM_FIELD_REJECTED ${recordid}: ${formChanged.map((c) => `${c.key}.${c.field}`).join(', ')}`);
      e.code = 'FORM_FIELD_REJECTED';
      throw e;
    }
    validate(before, model, { allowNewElements: duplicates.length > 0, allowRemovedElements: removed.length > 0 && duplicates.length === 0 });
    const changes = diff(before, model);
    if (changes.length === 0) log.warn('prepare', 'модель не изменилась', { recordid });
    payloads.push({ kind: 'zero', pageid, recordid, model, changes, duplicates, removed });
  }
  for (const r of recordOps) payloads.push({ kind: 'record', pageid, recordid: r.recordid, field: r.field, value: r.value, ...(r.formContent ? { formContent: r.formContent } : {}) });
  if (sortMoves.length || sortSetOrder) {
    // Перестановка пишет полный порядок: инвентарь обязан быть свежим, иначе затрём чужую вставку.
    const age = inventoryAgeMs(pageid, o);
    const maxAge = o.maxInventoryAgeMs ?? 120_000;
    if (age > maxAge) {
      log.error('prepare', 'STALE_INVENTORY: инвентарь старше допустимого для перестановки', { ageSec: Math.round(age / 1000), maxSec: Math.round(maxAge / 1000) });
      const e = new Error(`STALE_INVENTORY: инвентарь снят ${Math.round(age / 1000)} с назад (допустимо ${Math.round(maxAge / 1000)} с) — снимите заново перед перестановкой`);
      e.code = 'STALE_INVENTORY';
      throw e;
    }
    if (age > 30_000) log.warn('prepare', 'инвентарь старше 30 с', { ageSec: Math.round(age / 1000) });
    const inv = loadInventory(pageid, o);
    const r = reorderBlocks(inv, sortMoves, sortSetOrder);
    const moved = r.before.filter((id, i) => r.after[i] !== id).length;
    if (moved === 0) log.warn('prepare', 'порядок блоков не изменился', {});
    payloads.push({ kind: 'sort', pageid, recordid: '_sort', before: r.before, order: r.after, moves: r.moves, moved });
  }
  for (const l of listOps) payloads.push({ kind: 'list', pageid, recordid: l.recordid, before: l.before, cards: l.cards, changes: l.changes, fields: l.fields });
  for (const b of blockOps) payloads.push({ kind: 'block', pageid, recordid: b.recordid, hidden: b.hidden });
  for (const c of createOps) payloads.push(c);

  const dir = join(o.out, pageid);
  mkdirSync(dir, { recursive: true });
  // Старые payload'ы прошлых планов не должны попасть в запись — папка страницы очищается.
  for (const f of readdirSync(dir)) {
    if (/\.(payload\.json|call\.js)$/.test(f)) {
      rmSync(join(dir, f));
      log.debug('prepare', 'удалён старый payload', { file: f });
    }
  }
  if (createOps.length && o.emitCalls) writeBuildCall(dir, pageid, createOps, plan);
  for (const p of payloads) {
    if (p.kind === 'create') {
      const cpath = join(dir, `${p.id}.create.payload.json`);
      writeFileSync(cpath, JSON.stringify(p, null, 2) + '\n', 'utf8');
      p.path = cpath;
      log.info('prepare', 'payload записан', { path: cpath, kind: p.kind, id: p.id });
      continue;
    }
    const suffix = p.kind === 'record' ? `.${p.field}` : p.kind === 'block' ? '.block' : p.kind === 'list' ? '.list' : p.kind === 'sort' ? '' : '';
    const path = join(dir, `${p.recordid}${suffix}.payload.json`);
    writeFileSync(path, JSON.stringify(p, null, 2) + '\n', 'utf8');
    p.path = path;
    if (!o.emitCalls) {
      log.info('prepare', 'payload записан', { path, kind: p.kind });
      continue;
    }
    // Готовый текст функции для browser_evaluate — отладочный канал (`tilda.mjs apply --emit-calls`);
    // штатная запись идёт через scripts/cycle.mjs, где модель уходит аргументом вызова, а не текстом.
    const call =
      p.kind === 'zero'
        ? `async () => window.__tilda.saveZero(${JSON.stringify(pageid)}, ${JSON.stringify(p.recordid)}, ${JSON.stringify(p.model)})`
        : p.kind === 'block'
          ? `async () => window.__tilda.setBlockHidden(${JSON.stringify(pageid)}, ${JSON.stringify(p.recordid)}, ${JSON.stringify(p.hidden)})`
          : p.kind === 'list'
            ? `async () => window.__tilda.saveRecordFull(${JSON.stringify(pageid)}, ${JSON.stringify(p.recordid)}, ${JSON.stringify(p.fields)})`
          : p.kind === 'sort'
            ? `async () => window.__tilda.saveRecordsSort(${JSON.stringify(pageid)}, ${JSON.stringify(p.order)})`
            : `async () => window.__tilda.saveField(${JSON.stringify(pageid)}, ${JSON.stringify(p.recordid)}, ${JSON.stringify(p.field)}, ${JSON.stringify(String(p.value))}${p.formContent === 'reference' ? ', {"allowFormContent":true}' : ''})`;
    p.callPath = path.replace(/\.payload\.json$/, '.call.js');
    writeFileSync(p.callPath, call + '\n', 'utf8');
    log.info('prepare', 'payload записан', { path, call: p.callPath, kind: p.kind });
  }
  return payloads;
}

/**
 * Строит план сборки копии страницы по инвентарю источника: одна операция создания на каждый
 * блок, в исходном порядке, скрытые блоки помечаются `hidden`. Снимки не читает, только
 * проверяет их наличие — без снимка блок нечем будет сверить, и `prepare` откажется.
 *
 * @returns {{plan: object, missing: Array<{recordid, kind}>}}
 */
export function buildCopyPlan({ from, to, startAfter = '' }, opts = {}) {
  const o = { ...opts };
  o.baseDir ||= baselineDir();
  const src = String(from);
  const dst = String(to);
  if (protectedPages().includes(dst)) {
    log.error('buildCopyPlan', 'страница-приёмник защищена от записи', { pageid: dst });
    throw new Error(`PROTECTED_PAGE ${dst}`);
  }
  const inv = loadInventory(src, o);
  const missing = [];
  const ops = inv.map((r) => {
    const kind = String(r.tplid) === '396' ? 'zero' : 'record';
    const recordid = String(r.recordid);
    if (!existsSync(snapshotPath({ kind, pageid: src, recordid }, o))) missing.push({ recordid, kind, tplid: String(r.tplid), order: r.order });
    const op = { id: `b${r.order}`, hidden: r.hidden ? 'y' : 'n' };
    if (kind === 'zero') op.addZero = { source: { recordid } };
    else op.addRecord = { tplid: String(r.tplid), source: { recordid } };
    return op;
  });
  const plan = { page: dst, source: { page: src }, startAfter, ops };
  if (missing.length) log.warn('buildCopyPlan', 'снимков источника не хватает — снять их до prepare', { missing: missing.length, first: missing.slice(0, 5).map((m) => `${m.recordid}(${m.kind})`) });
  log.info('buildCopyPlan', 'план сборки готов', { from: src, to: dst, ops: ops.length, zero: ops.filter((op) => op.addZero).length, hidden: ops.filter((op) => op.hidden === 'y').length, missingSnapshots: missing.length });
  return { plan, missing };
}

function stripVolatile(model) {
  const m = { ...model };
  for (const k of VOLATILE_KEYS) delete m[k];
  return m;
}

/**
 * Сверяет собранные блоки с их источниками. Соответствие «операция плана → получившийся
 * recordid» берётся из журнала сборки `<reread>/<pageid>/_built.json`, который возвращает
 * `buildBlocks` браузерного слоя.
 */
function verifyCreated(createIds, pageid, o) {
  const problems = [];
  const journalPath = join(o.reread, pageid, '_built.json');
  if (!existsSync(journalPath)) {
    log.error('verify', 'нет журнала сборки', { path: journalPath });
    return [{ id: '(сборка)', problem: 'нет журнала сборки (buildBlocks не выполнялся?)', path: journalPath }];
  }
  const raw = readJson(journalPath);
  const journal = Array.isArray(raw) ? raw : raw.built || [];

  for (const id of createIds) {
    const payloadPath = join(o.out, pageid, `${id}.create.payload.json`);
    if (!existsSync(payloadPath)) {
      problems.push({ id, problem: 'нет payload (prepare не выполнялся?)', path: payloadPath });
      continue;
    }
    const payload = readJson(payloadPath);
    const entry = journal.find((b) => b.id === id);
    if (!entry) {
      problems.push({ id, problem: 'блока нет в журнале сборки' });
      continue;
    }
    if (entry.status !== 'ok' || !entry.recordid) {
      problems.push({ id, problem: 'блок не собран', error: entry.error || entry.status });
      continue;
    }
    if (payload.hidden === 'y' && entry.hidden !== 'y') problems.push({ id, recordid: entry.recordid, problem: 'блок должен быть скрыт, но виден' });

    if (payload.mode === 'new') {
      // Блок из полей: эталон — значения плана (expect), источника нет.
      const rereadPath = join(o.reread, pageid, `${entry.recordid}.record.json`);
      if (!existsSync(rereadPath)) {
        problems.push({ id, recordid: entry.recordid, problem: 'нет перечитанного снимка собранного блока', path: rereadPath });
        continue;
      }
      const rereadSnap = readJson(rereadPath);
      const got = recordFields(rereadSnap);
      // Код HTML-блока хранится как есть: сверка по trim, без normalizeFieldValue.
      if (payload.expect.code !== undefined) {
        const actualCode = String(rereadSnap.t123code ?? decodeEntities(String(rereadSnap.record?.code ?? '')));
        if (actualCode.trim() !== payload.expect.code.trim()) {
          problems.push({ id, recordid: entry.recordid, problem: 'код HTML-блока не совпал', field: 'code', expected: payload.expect.code.trim().slice(0, 60), actual: actualCode.trim().slice(0, 60) });
        }
      }
      for (const [field, want] of Object.entries(payload.expect.values)) {
        // recordFields отбрасывает пустые значения: пустое ожидание и отсутствующее поле — совпадение.
        if (!(field in got)) {
          if (want !== '') problems.push({ id, recordid: entry.recordid, problem: 'поле не записалось', field });
        } else if (normalizeFieldValue(got[field]) !== want) {
          problems.push({ id, recordid: entry.recordid, problem: 'значение поля не совпало', field, expected: String(want).slice(0, 60), actual: normalizeFieldValue(got[field]).slice(0, 60) });
        }
      }
      const expectCards = payload.expect.cards || [];
      if (expectCards.length) {
        const actualCards = decodeList(got.list);
        if (actualCards.length !== expectCards.length) {
          problems.push({ id, recordid: entry.recordid, problem: 'число карточек не совпало', expected: expectCards.length, actual: actualCards.length });
        } else {
          expectCards.forEach((e, ci) => {
            for (const k of Object.keys(e)) {
              const a = normalizeFieldValue(actualCards[ci][k] ?? '');
              if (a !== e[k]) problems.push({ id, recordid: entry.recordid, problem: 'карточка не совпала', card: ci, field: k, expected: String(e[k]).slice(0, 60), actual: a.slice(0, 60) });
            }
          });
        }
      }
      continue;
    }

    const source = loadSnapshot({ kind: payload.blockKind, pageid: payload.source.page, recordid: payload.source.recordid }, o);
    const rereadPath = join(o.reread, pageid, payload.blockKind === 'zero' ? `${entry.recordid}.json` : `${entry.recordid}.record.json`);
    if (!existsSync(rereadPath)) {
      problems.push({ id, recordid: entry.recordid, problem: 'нет перечитанного снимка собранного блока', path: rereadPath });
      continue;
    }
    const actual = readJson(rereadPath);

    if (payload.blockKind === 'zero') {
      for (const x of diff(stripVolatile(source), stripVolatile(actual))) {
        problems.push({ id, recordid: entry.recordid, problem: 'модель не совпала с источником', key: x.key, field: x.field, expected: x.from, actual: x.to });
      }
    } else {
      const want = recordFields(source);
      const got = recordFields(actual);
      for (const [field, value] of Object.entries(want)) {
        if (!(field in got)) {
          problems.push({ id, recordid: entry.recordid, problem: 'поле не перенеслось', field });
        } else if (got[field] !== value) {
          problems.push({ id, recordid: entry.recordid, problem: 'значение поля не совпало', field, expected: String(value).slice(0, 60), actual: String(got[field]).slice(0, 60) });
        }
      }
    }
  }
  return problems;
}

/**
 * Сверяет перечитанные модели с ожидаемыми. Возвращает список расхождений (пустой = успех).
 */
export function verify(plan, opts = {}) {
  const o = { out: null, reread: null, ...opts };
  o.baseDir ||= baselineDir();
  o.out = o.out || join(o.baseDir, 'payload');
  o.reread = o.reread || join(o.baseDir, 'reread');
  const pageid = String(plan.page);
  const problems = [];
  const ids = new Set();
  const createIds = [];
  plan.ops.forEach((op, i) => {
    if (op.addZero || op.addRecord || op.newRecord) {
      createIds.push(op.id || `b${i + 1}`);
      return;
    }
    if (op.setOrder) {
      ids.add('_sort');
      return;
    }
    const recordid = resolveBlock(op.block || {}, pageid, o);
    ids.add(op.field ? `${recordid}.${op.field.name}` : op.blockHidden !== undefined ? `${recordid}.block` : op.listSet ? `${recordid}.list` : op.moveBlock ? '_sort' : recordid);
  });
  if (createIds.length) problems.push(...verifyCreated(createIds, pageid, o));
  for (const id of ids) {
    const payloadPath = join(o.out, pageid, `${id}.payload.json`);
    if (!existsSync(payloadPath)) {
      problems.push({ id, problem: 'нет payload (prepare не выполнялся?)', path: payloadPath });
      continue;
    }
    const payload = readJson(payloadPath);
    if (payload.kind === 'sort') {
      // Порядок сверяется по инвентарю, снятому после перезагрузки редактора.
      const invPath = join(o.reread, pageid, '_inventory.json');
      if (!existsSync(invPath)) {
        problems.push({ id, problem: 'нет перечитанного инвентаря', path: invPath });
        continue;
      }
      const got = readJson(invPath).map((r) => String(r.recordid));
      if (got.join() !== payload.order.join()) problems.push({ id, problem: 'порядок блоков не совпал', expected: payload.order, actual: got });
      continue;
    }
    if (payload.kind === 'block') {
      // Видимость блока сверяется по инвентарю, снятому listRecords() после перезагрузки редактора.
      const invPath = join(o.reread, pageid, '_inventory.json');
      if (!existsSync(invPath)) {
        problems.push({ id, problem: 'нет перечитанного инвентаря', path: invPath });
        continue;
      }
      const row = readJson(invPath).find((r) => String(r.recordid) === String(payload.recordid));
      const got = row ? (row.hidden ? 'y' : 'n') : undefined;
      if (got !== payload.hidden) problems.push({ id, problem: 'видимость блока не совпала', expected: payload.hidden, actual: got });
      continue;
    }
    // Модель Zero Block и запись стандартного блока могут относиться к одному recordid — разные имена.
    const rereadPath = join(o.reread, pageid, payload.kind === 'zero' ? `${payload.recordid}.json` : `${payload.recordid}.record.json`);
    if (!existsSync(rereadPath)) {
      problems.push({ id, problem: 'нет перечитанного снимка', path: rereadPath });
      continue;
    }
    const actual = readJson(rereadPath);
    if (payload.kind === 'list') {
      const rec = actual.record || actual;
      for (const x of diffCards(payload.cards, decodeList(rec.list))) problems.push({ id, ...x });
      continue;
    }
    if (payload.kind === 'zero') {
      const d = diff(stripVolatile(payload.model), stripVolatile(actual));
      for (const x of d) problems.push({ id, problem: 'расхождение', key: x.key, field: x.field, expected: x.from, actual: x.to });
      if (VOLATILE_KEYS.has('timestamp') && payload.model.timestamp !== actual.timestamp) log.debug('verify', 'timestamp изменился (допустимо)', { id, from: payload.model.timestamp, to: actual.timestamp });
    } else {
      const rec = actual.record || actual;
      // Пустое значение Tilda не хранит: поле пропадает из записи — это и есть «пусто».
      const got = rec[payload.field] === undefined && String(payload.value) === '' ? '' : rec[payload.field];
      // [FIX] Поле, записанное с onlythisfield, Tilda хранит экранированным (`&lt;a …&gt;`, `<br />`) —
      // сравнение через тот же канон, что у newRecord; буквально равные значения проходят сразу.
      const same = String(got) === String(payload.value) || (got !== undefined && normalizeFieldValue(got) === normalizeFieldValue(payload.value));
      if (!same) problems.push({ id, problem: 'поле не сохранилось', field: payload.field, expected: payload.value, actual: got });
      else if (String(got) !== String(payload.value)) log.debug('verify', '[FIX] поле совпало после нормализации формы хранения', { id, field: payload.field });
    }
  }
  if (problems.length) log.error('verify', 'сверка не прошла', { problems: problems.length, first: problems[0] });
  else log.info('verify', 'сверка прошла', { blocks: ids.size, created: createIds.length });
  return problems;
}

// ---- CLI ----
if (process.argv[1]?.endsWith('apply-plan.mjs')) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, reread: { type: 'string' }, baseline: { type: 'string' } },
  });
  const [cmd, planFile, third] = positionals;
  if (!cmd || !planFile) {
    log.error('cli', 'использование', {
      usage: 'apply-plan.mjs prepare|verify <план.json> [--out d] [--reread d] [--baseline d]',
      copy: 'apply-plan.mjs plan-copy <pageid-источника> <pageid-приёмника> [--out файл.json] [--baseline d]',
    });
    process.exit(2);
  }

  if (cmd === 'plan-copy') {
    if (!third) {
      log.error('cli', 'нужны два pageid', { usage: 'apply-plan.mjs plan-copy <из> <в> [--out файл.json]' });
      process.exit(2);
    }
    try {
      const baseDir = values.baseline ? resolve(values.baseline) : baselineDir();
      const { plan, missing } = buildCopyPlan({ from: planFile, to: third }, { baseDir });
      const text = JSON.stringify(plan, null, 2) + '\n';
      if (values.out) {
        writeFileSync(resolve(values.out), text, 'utf8');
        log.info('cli', 'план записан', { path: resolve(values.out), ops: plan.ops.length, missingSnapshots: missing.length });
        console.log(JSON.stringify({ path: resolve(values.out), ops: plan.ops.length, missingSnapshots: missing.map((m) => m.recordid) }, null, 2));
      } else {
        console.log(text);
      }
      process.exit(0);
    } catch (e) {
      log.error('cli', e.message);
      process.exit(1);
    }
  }

  const plan = readJson(resolve(planFile));
  const opts = { baseDir: values.baseline ? resolve(values.baseline) : baselineDir(), out: values.out && resolve(values.out), reread: values.reread && resolve(values.reread) };
  try {
    if (cmd === 'prepare') {
      const payloads = prepare(plan, opts);
      console.log(
        JSON.stringify(
          payloads.map((p) =>
            p.kind === 'create'
              ? { kind: p.kind, id: p.id, block: p.blockKind, tplid: p.tplid, source: `${p.source.page}/${p.source.recordid}`, hidden: p.hidden, path: p.path }
              : { kind: p.kind, recordid: p.recordid, path: p.path, changes: p.changes?.length ?? 1 },
          ),
          null,
          2,
        ),
      );
    } else if (cmd === 'verify') {
      const problems = verify(plan, opts);
      console.log(JSON.stringify(problems, null, 2));
      process.exit(problems.length ? 1 : 0);
    } else {
      log.error('cli', 'неизвестная команда', { cmd });
      process.exit(2);
    }
  } catch (e) {
    log.error('cli', e.message);
    process.exit(1);
  }
}
