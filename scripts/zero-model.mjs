/**
 * Чистые функции над JSON-моделью Zero Block (тип 396). Сети здесь нет.
 *
 * Структура модели (проверена на живом проекте):
 *   числовые ключи "0", "1", … — элементы: elem_id, elem_type, hidden (y/n), text, координаты;
 *   служебные ключи — артборд: ab_height, ab_bgcolor, groups, timestamp и т.д.
 *
 * Все функции возвращают новую модель и не мутируют вход.
 *
 * CLI для ручной отладки:
 *   node scripts/zero-model.mjs elements <модель.json>
 *   node scripts/zero-model.mjs find <модель.json> <elem_id | текст>
 *   node scripts/zero-model.mjs diff <до.json> <после.json>
 */
import { readFileSync } from 'node:fs';
import { createLogger } from './lib/log.mjs';
import { assertNotFormField, assertNoScript } from './lib/form-fields.mjs';

const log = createLogger('zero-model');

const isElemKey = (k) => /^\d+$/.test(k);

/** Ключи элементов в числовом порядке. */
export function elementKeys(model) {
  return Object.keys(model).filter(isElemKey).sort((a, b) => Number(a) - Number(b));
}

/** Служебные ключи артборда. */
export function serviceKeys(model) {
  return Object.keys(model).filter((k) => !isElemKey(k)).sort();
}

/** Краткий список элементов. */
export function elements(model) {
  const list = elementKeys(model).map((key) => {
    const e = model[key] || {};
    return { key, elem_id: String(e.elem_id ?? ''), elem_type: e.elem_type ?? '', hidden: e.hidden === 'y', text: typeof e.text === 'string' ? e.text : undefined };
  });
  log.debug('elements', 'список элементов', { count: list.length, elemIds: list.map((e) => e.elem_id) });
  return list;
}

/** Нормализация текста для сравнения: без тегов, &nbsp; → пробел, схлопнутые пробелы. */
export function normalizeText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Находит ровно один элемент по elem_id, точному тексту или подстроке текста.
 * Ноль или несколько совпадений — ошибка.
 * @param {object} model
 * @param {{elem_id?: string, text?: string, textIncludes?: string}} selector
 * @returns {{key: string, elem: object}}
 */
export function findElement(model, selector) {
  const sel = selector || {};
  const keys = elementKeys(model);
  let hits;
  if (sel.elem_id !== undefined) {
    hits = keys.filter((k) => String(model[k].elem_id) === String(sel.elem_id));
  } else if (sel.text !== undefined) {
    const want = normalizeText(sel.text);
    hits = keys.filter((k) => normalizeText(model[k].text) === want);
  } else if (sel.textIncludes !== undefined) {
    const want = normalizeText(sel.textIncludes);
    hits = keys.filter((k) => normalizeText(model[k].text).includes(want));
  } else {
    throw new Error('findElement: нужен elem_id, text или textIncludes');
  }
  log.debug('findElement', 'поиск', { selector: sel, hits: hits.map((k) => ({ key: k, elem_id: model[k].elem_id })) });
  if (hits.length === 0) {
    log.error('findElement', 'элемент не найден', { selector: sel });
    throw new Error(`NOT_FOUND ${JSON.stringify(sel)}`);
  }
  if (hits.length > 1) {
    log.error('findElement', 'найдено несколько элементов', { selector: sel, hits });
    throw new Error(`AMBIGUOUS ${JSON.stringify(sel)}: ${hits.length} совпадений`);
  }
  return { key: hits[0], elem: model[hits[0]] };
}

const clone = (model) => JSON.parse(JSON.stringify(model));

function assertKey(model, key, fn) {
  if (!isElemKey(String(key)) || !(key in model)) {
    log.error(fn, 'нет элемента с таким ключом', { key });
    throw new Error(`NO_SUCH_KEY ${key}`);
  }
}

/** Новая модель с заменённым текстом элемента. `<script` отвергается. */
export function setText(model, key, text) {
  assertKey(model, key, 'setText');
  if (/<script/i.test(String(text))) {
    log.error('setText', 'отказ: текст содержит <script', { key });
    throw new Error('SCRIPT_REJECTED');
  }
  const next = clone(model);
  const from = next[key].text;
  next[key].text = String(text);
  log.info('setText', 'текст заменён', { key, elem_id: next[key].elem_id, from: normalizeText(from).slice(0, 60), to: normalizeText(text).slice(0, 60) });
  return next;
}

/**
 * Новая модель с изменённой видимостью элемента: hidden 'y' | 'n'. Пишется и базовое поле,
 * и все имеющиеся у элемента `hidden-res-*` — иначе элемент, скрытый на десктопе, остаётся
 * видимым на ширинах со своим вариантом.
 */
export function setHidden(model, key, hidden) {
  assertKey(model, key, 'setHidden');
  const value = hidden === true || hidden === 'y' ? 'y' : 'n';
  const next = clone(model);
  const from = next[key].hidden ?? 'n';
  next[key].hidden = value;
  const variants = resVariants(next[key], 'hidden');
  for (const res of variants) next[key][`hidden-res-${res}`] = value;
  log.info('setHidden', 'видимость изменена', { key, elem_id: next[key].elem_id, from, to: value, variants });
  return next;
}

// ---------------------------------------------------------------------------
// Адаптивные варианты -res-*
// ---------------------------------------------------------------------------

export const RES_KEY = /^(.+)-res-(\d+)$/;

/** Поля, у которых на дубле встречаются -res-* варианты; для них отсутствие вариантов стоит WARN. */
export const RES_TYPICAL = new Set(['left', 'top', 'width', 'height', 'container', 'textfit', 'fontsize', 'valign', 'heightunits', 'heightmode', 'parent_hidden', 'widthmode', 'align', 'margin', 'letterspacing', 'widthunits', 'lineheight', 'hidden']);

/** Разрешения (строками, по возрастанию), для которых у элемента есть `<field>-res-*`. Список не хардкодится. */
export function resVariants(elem, field) {
  const out = [];
  for (const key of Object.keys(elem || {})) {
    const m = key.match(RES_KEY);
    if (m && m[1] === field) out.push(m[2]);
  }
  return out.sort((a, b) => Number(a) - Number(b));
}

/**
 * Значение варианта при стратегии `scale`: числовое — пропорционально старому базовому
 * (при нулевом базовом — тем же приращением), нечисловое — копия нового базового.
 * Тип сохраняется: строка остаётся строкой, число числом.
 */
export function scaleVariant(oldVariant, oldBase, newBase) {
  const ov = Number(oldVariant);
  const ob = Number(oldBase);
  const nb = Number(newBase);
  const numeric = [oldVariant, oldBase, newBase].every((v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)));
  if (!numeric) return newBase;
  const raw = ob === 0 ? ov + (nb - ob) : (ov * nb) / ob;
  const integers = [ov, ob, nb].every(Number.isInteger);
  const v = integers ? Math.round(raw) : Math.round(raw * 100) / 100;
  return typeof oldVariant === 'number' ? v : String(v);
}

/**
 * Дописать адаптивные варианты после записи базового поля. Стратегии:
 *   scale    — недостающие варианты пересчитываются от имеющихся (см. scaleVariant);
 *   explicit — все варианты, которые есть у элемента, обязан дать план (`<field>-res-N`),
 *              иначе RES_VARIANTS_MISSING со списком недостающих.
 * Варианты, заданные планом явно, не пересчитываются. Пишутся только те, что у элемента уже есть.
 */
function applyResVariants(next, key, field, oldBase, newBase, fields, strategy) {
  const el = next[key];
  const variants = resVariants(el, field);
  if (variants.length === 0) {
    if (RES_TYPICAL.has(field)) log.warn('setFields', 'у поля нет -res-* вариантов, пишем только базовое', { key, elem_id: el.elem_id, field });
    return;
  }
  const explicit = variants.filter((res) => `${field}-res-${res}` in fields);
  const missing = variants.filter((res) => !(`${field}-res-${res}` in fields));
  log.debug('setFields', 'адаптивные варианты поля', { key, field, variants, strategy, explicit });
  if (strategy === 'explicit') {
    if (missing.length) {
      const names = missing.map((res) => `${field}-res-${res}`);
      log.error('setFields', 'RES_VARIANTS_MISSING: план не дал значения имеющихся у элемента вариантов', { key, elem_id: el.elem_id, field, missing: names });
      const e = new Error(`RES_VARIANTS_MISSING ${field}: нет ${names.join(', ')}`);
      e.code = 'RES_VARIANTS_MISSING';
      e.missing = names;
      throw e;
    }
    return; // явные значения запишутся как обычные поля
  }
  for (const res of missing) {
    const name = `${field}-res-${res}`;
    const value = scaleVariant(el[name], oldBase, newBase);
    log.debug('setFields', 'вариант пересчитан', { key, field, res, from: el[name], to: value });
    el[name] = value;
  }
}

/**
 * Схемы ссылок, встреченные на странице:
 * якорь `#faq`, поп-ап `#popup:call`, `tel:`, `mailto:`, относительный `/privacy`, полный `https://`.
 * Всё остальное — в первую очередь `javascript:` — отвергается.
 */
const LINK_ALLOWED = /^(https?:\/\/|\/|#|tel:|mailto:)/i;

/** Типы элементов, у которых есть поле `link` (проверено на дубле). */
const LINKABLE_TYPES = new Set(['button', 'shape', 'text']);

/** Новая модель с изменённой ссылкой элемента. Пустая строка снимает ссылку. */
export function setLink(model, key, url) {
  assertKey(model, key, 'setLink');
  const value = String(url ?? '');
  if (value !== '' && !LINK_ALLOWED.test(value)) {
    log.error('setLink', 'отказ: недопустимая схема ссылки', { key, value: value.slice(0, 60) });
    throw new Error(`LINK_REJECTED ${value.slice(0, 60)}`);
  }
  const next = clone(model);
  const type = next[key].elem_type;
  if (!LINKABLE_TYPES.has(type)) log.warn('setLink', 'у этого типа элемента ссылка не проверялась', { key, elem_type: type });
  const from = next[key].link ?? '';
  next[key].link = value;
  log.info('setLink', 'ссылка изменена', { key, elem_id: next[key].elem_id, from, to: value });
  return next;
}

/**
 * Новая модель с изменённым способом перехода: '_blank' — в новом окне, пустое значение —
 * в том же. У Тильды «в том же окне» — это отсутствие поля, а не пустая строка, поэтому
 * пустое значение поле удаляет: иначе откат правки оставляет в модели `linktarget: ""`,
 * которого там не было (замечено при приёмке).
 */
export function setLinkTarget(model, key, target) {
  assertKey(model, key, 'setLinkTarget');
  const value = target === '_blank' || target === true ? '_blank' : '';
  const next = clone(model);
  const from = next[key].linktarget ?? '';
  if (value === '') delete next[key].linktarget;
  else next[key].linktarget = value;
  log.info('setLinkTarget', 'способ перехода изменён', { key, elem_id: next[key].elem_id, from: from || '(то же окно)', to: value || '(то же окно)' });
  return next;
}

const IMAGE_URL = /^https?:\/\//i;

/**
 * Новая модель с заменённой картинкой элемента `image`.
 *
 * Редактор Тильды при замене файла меняет четыре поля, и операция обязана делать то же,
 * иначе картинка встанет с пропорциями старой:
 *   img, filewidth, fileheight и пересчитанная по пропорции height.
 *
 * @param {object} spec {img, filewidth, fileheight} — размеры берутся из ответа загрузки на CDN
 *                      (поля width/height), либо строка с одним URL (тогда пропорции не трогаются).
 */
export function setImage(model, key, spec) {
  assertKey(model, key, 'setImage');
  const s = typeof spec === 'string' ? { img: spec } : spec || {};
  const img = String(s.img ?? '');
  if (!IMAGE_URL.test(img)) {
    log.error('setImage', 'отказ: img должен быть http(s)-адресом картинки', { key, img: img.slice(0, 60) });
    throw new Error(`IMAGE_URL_REJECTED ${img.slice(0, 60)}`);
  }
  if (!/^https?:\/\/[^/]*tildacdn\./i.test(img)) {
    log.warn('setImage', 'адрес не на tildacdn — приём внешних адресов Тильдой не проверялся', { key, img: img.slice(0, 60) });
  }
  const next = clone(model);
  const el = next[key];
  if (el.elem_type !== 'image') {
    log.error('setImage', 'операция image применима только к elem_type image; для фона shape есть bgimg', { key, elem_type: el.elem_type });
    throw new Error(`WRONG_ELEM_TYPE ${el.elem_type} (нужен image)`);
  }
  const from = { img: el.img, filewidth: el.filewidth, fileheight: el.fileheight, height: el.height };
  el.img = img;
  if (s.filewidth !== undefined && s.fileheight !== undefined) {
    el.filewidth = String(s.filewidth);
    el.fileheight = String(s.fileheight);
    const w = Number(el.width);
    const fw = Number(el.filewidth);
    const fh = Number(el.fileheight);
    if (w > 0 && fw > 0 && fh > 0) {
      el.height = String(Math.round((w * fh) / fw));
      // Адаптивные варианты высоты — от ширины на том же разрешении, иначе мобильная
      // вёрстка остаётся с пропорциями прежней картинки.
      const variants = {};
      for (const res of resVariants(el, 'height')) {
        const wr = Number(el[`width-res-${res}`] ?? el.width);
        if (wr > 0) {
          el[`height-res-${res}`] = String(Math.round((wr * fh) / fw));
          variants[res] = el[`height-res-${res}`];
        }
      }
      log.debug('setImage', 'высота пересчитана по пропорции', { key, width: el.width, file: `${fw}x${fh}`, height: el.height, variants });
    } else {
      log.warn('setImage', 'высота не пересчитана: нет ширины элемента или размеров файла', { key, width: el.width, filewidth: el.filewidth, fileheight: el.fileheight });
    }
  } else {
    log.warn('setImage', 'filewidth/fileheight не заданы: пропорции останутся от прежней картинки', { key });
  }
  log.info('setImage', 'картинка заменена', { key, elem_id: el.elem_id, from: from.img, to: img, height: `${from.height} → ${el.height}` });
  return next;
}

/** Новая модель с заменённой фоновой картинкой элемента `shape` (поле bgimg). */
export function setBgImage(model, key, url) {
  assertKey(model, key, 'setBgImage');
  const img = String(url ?? '');
  if (img !== '' && !IMAGE_URL.test(img)) {
    log.error('setBgImage', 'отказ: bgimg должен быть http(s)-адресом или пустой строкой', { key, img: img.slice(0, 60) });
    throw new Error(`IMAGE_URL_REJECTED ${img.slice(0, 60)}`);
  }
  const next = clone(model);
  const el = next[key];
  if (el.elem_type !== 'shape') log.warn('setBgImage', 'поле bgimg проверено только у shape', { key, elem_type: el.elem_type });
  const from = el.bgimg ?? '';
  el.bgimg = img;
  log.info('setBgImage', 'фоновая картинка заменена', { key, elem_id: el.elem_id, from, to: img });
  return next;
}

/**
 * Поля со своей логикой записи: у ссылки белый список схем, у картинки пересчёт размеров,
 * у linktarget «в том же окне» = отсутствие поля. Остальные поля пишутся как есть.
 */
const SPECIAL_FIELDS = new Set(['text', 'hidden', 'link', 'linktarget', 'image', 'bgimg']);

/** Новая модель с изменённым произвольным полем элемента; поле по умолчанию пишется как есть. */
export function setPlainField(model, key, field, value) {
  assertKey(model, key, 'setPlainField');
  if (!/^[\w-]+$/.test(String(field))) throw new Error(`BAD_FIELD_NAME ${String(field).slice(0, 40)}`);
  if (value !== null && typeof value === 'object') throw new Error(`BAD_FIELD_VALUE ${field}: ожидается строка или число`);
  const next = clone(model);
  const from = next[key][field];
  if (value === null || value === undefined) delete next[key][field];
  else next[key][field] = typeof value === 'number' ? value : String(value);
  log.info('setPlainField', 'поле изменено', { key, elem_id: next[key].elem_id, field, from: String(from ?? '(нет)').slice(0, 60), to: String(value ?? '(удалено)').slice(0, 60) });
  return next;
}

/**
 * Задать элементу любые поля модели: `{ field: value, … }` → новая модель.
 * Guard'ы на каждое поле: чёрный список полей формы и `<script` в значении.
 * Базовое поле с адаптивными вариантами тянет их за собой: opts.resStrategy
 * 'scale' (по умолчанию) или 'explicit'.
 */
export function setFields(model, key, fields, opts = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('setFields: ожидается объект { поле: значение }');
  const strategy = opts.resStrategy || 'scale';
  if (!['scale', 'explicit', 'none'].includes(strategy)) throw new Error(`BAD_RES_STRATEGY ${strategy}: ожидается scale, explicit или none`);
  let next = model;
  for (const [field, value] of Object.entries(fields)) {
    assertNotFormField(field, { key, elem_id: model[key] && model[key].elem_id, path: 'zero-model.setFields' });
    assertNoScript(value, { key, field });
    const el = model[key] || {};
    log.debug('setFields', 'поле', { key, field, from: String((field === 'image' ? el.img : el[field]) ?? '').slice(0, 60), to: String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 60) });
    const oldBase = next[key] ? next[key][field] : undefined;
    switch (field) {
      case 'text': next = setText(next, key, value); break;
      case 'hidden': next = setHidden(next, key, value); break; // варианты hidden-res-* пишет сам
      case 'link': next = setLink(next, key, value); break;
      case 'linktarget': next = setLinkTarget(next, key, value); break;
      case 'image': next = setImage(next, key, value); break;
      case 'bgimg': next = setBgImage(next, key, value); break;
      default: {
        next = setPlainField(next, key, field, value);
        // Явно заданный вариант (`top-res-320`) — обычное поле; базовое поле тянет свои варианты.
        // none — поля пишутся ровно как заданы (обратные планы журнала: там все изменённые варианты перечислены явно).
        if (strategy !== 'none' && !RES_KEY.test(field) && value !== null && value !== undefined) applyResVariants(next, key, field, oldBase, next[key][field], fields, strategy);
      }
    }
  }
  return next;
}

/** Одно поле — тонкая обёртка над setFields (совместимость с prepare). */
export function setField(model, key, field, value) {
  return setFields(model, key, { [field]: value });
}

export { SPECIAL_FIELDS };

/**
 * Список изменений между двумя моделями: {key, field, from, to}.
 * key — ключ элемента или служебный ключ; для служебных полей field = '' .
 */
export function diff(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const a = before[key];
    const b = after[key];
    if (isElemKey(key)) {
      const fields = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      for (const field of [...fields].sort()) {
        const fa = a ? a[field] : undefined;
        const fb = b ? b[field] : undefined;
        if (JSON.stringify(fa) !== JSON.stringify(fb)) out.push({ key, field, from: fa, to: fb });
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ key, field: '', from: a, to: b });
    }
  }
  for (const d of out) log.info('diff', 'изменение', { key: d.key, field: d.field, from: String(d.from ?? '').slice(0, 60), to: String(d.to ?? '').slice(0, 60) });
  if (out.length === 0) log.info('diff', 'различий нет');
  return out;
}

/**
 * Проверка, что правка не потеряла структуру: те же служебные ключи, то же число
 * элементов, те же elem_id. Иначе — исключение.
 */
export function validate(before, after, opts = {}) {
  const sb = serviceKeys(before);
  const sa = serviceKeys(after);
  if (JSON.stringify(sb) !== JSON.stringify(sa)) {
    log.error('validate', 'служебные ключи изменились', { before: sb, after: sa });
    throw new Error('VALIDATE service keys differ');
  }
  const eb = elementKeys(before);
  const ea = elementKeys(after);
  const ib = eb.map((k) => String(before[k].elem_id)).sort();
  const ia = ea.map((k) => String(after[k].elem_id)).sort();
  if (opts.allowRemovedElements) {
    // Откат дублирования: элементов может стать меньше, новых elem_id не появляется.
    const added = ia.filter((id) => !ib.includes(id));
    if (added.length) {
      log.error('validate', 'при удалении появились новые elem_id', { added });
      throw new Error(`VALIDATE unexpected elem_id: ${added.join(', ')}`);
    }
    log.debug('validate', 'структура цела (разрешено удаление элементов)', { before: eb.length, after: ea.length });
    return true;
  }
  if (opts.allowNewElements) {
    // Режим дублирования: элементов может стать больше, но ни один прежний elem_id не пропадает.
    if (ea.length < eb.length) {
      log.error('validate', 'число элементов уменьшилось', { before: eb.length, after: ea.length });
      throw new Error(`VALIDATE element count ${eb.length} -> ${ea.length}`);
    }
    const lost = ib.filter((id) => !ia.includes(id));
    if (lost.length) {
      log.error('validate', 'прежние elem_id потеряны', { lost });
      throw new Error(`VALIDATE elem_id lost: ${lost.join(', ')}`);
    }
    if (new Set(ia).size !== ia.length) {
      log.error('validate', 'elem_id повторяются', { ids: ia });
      throw new Error('VALIDATE elem_id duplicated');
    }
    log.debug('validate', 'структура цела (разрешены новые элементы)', { before: eb.length, after: ea.length, added: ea.length - eb.length });
    return true;
  }
  if (eb.length !== ea.length) {
    log.error('validate', 'число элементов изменилось', { before: eb.length, after: ea.length });
    throw new Error(`VALIDATE element count ${eb.length} -> ${ea.length}`);
  }
  if (JSON.stringify(ib) !== JSON.stringify(ia)) {
    log.error('validate', 'набор elem_id изменился', { before: ib, after: ia });
    throw new Error('VALIDATE elem_id set differs');
  }
  log.debug('validate', 'структура цела', { elements: ea.length, serviceKeys: sa.length });
  return true;
}

// ---- CLI ----
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('zero-model.mjs')) {
  const [cmd, a, b] = process.argv.slice(2);
  const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
  if (cmd === 'elements') {
    console.log(JSON.stringify(elements(load(a)), null, 2));
  } else if (cmd === 'find') {
    const m = load(a);
    const sel = /^\d{10,}$/.test(b) ? { elem_id: b } : { textIncludes: b };
    console.log(JSON.stringify(findElement(m, sel), null, 2));
  } else if (cmd === 'diff') {
    console.log(JSON.stringify(diff(load(a), load(b)), null, 2));
  } else if (cmd) {
    log.error('cli', 'неизвестная команда', { cmd, usage: 'elements <m.json> | find <m.json> <elem_id|текст> | diff <a.json> <b.json>' });
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Дублирование элемента
// ---------------------------------------------------------------------------

const numOr = (v, d = 0) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));

/** Разрешения, на которых у элемента есть собственная позиция (top/left-res-*); '' — базовое. */
function positionResolutions(elem) {
  const set = new Set(['']);
  for (const key of Object.keys(elem)) {
    const m = key.match(RES_KEY);
    if (m && (m[1] === 'top' || m[1] === 'left')) set.add(m[2]);
  }
  return [...set].sort((a, b) => Number(a) - Number(b));
}

const posField = (field, res) => (res ? `${field}-res-${res}` : field);

/** Позиция и размер элемента на разрешении res ('' — базовое); вариант отсутствует → базовое значение. */
function geometryAt(elem, res) {
  const get = (f) => numOr(elem[posField(f, res)] ?? elem[f]);
  return { top: get('top'), left: get('left'), width: get('width'), height: get('height') };
}

/** Однотипные соседи: тот же elem_type и тот же базовый размер (±2 px), не сам элемент. */
export function siblings(model, key) {
  const el = model[key];
  const w = numOr(el.width);
  const h = numOr(el.height);
  return elementKeys(model)
    .filter((k) => k !== key)
    .filter((k) => model[k].elem_type === el.elem_type)
    .filter((k) => Math.abs(numOr(model[k].width) - w) <= 2 && Math.abs(numOr(model[k].height) - h) <= 2)
    .filter((k) => (model[k].hidden ?? 'n') !== 'y');
}

/** Уникальный elem_id в стиле редактора — метка времени (13 цифр), с проверкой уникальности в модели. */
export function newElemId(model, now = Date.now()) {
  const used = new Set(elementKeys(model).map((k) => String(model[k].elem_id)));
  let id = now;
  while (used.has(String(id))) id += 1;
  return String(id);
}

/**
 * Копия элемента рядом с ним. Шаг — разница между двумя последними однотипными соседями
 * (сам элемент считается), **отдельно на каждом разрешении**, где у элемента есть своя позиция.
 * Раскладка на всех разрешениях однотипна (одна и та же ось шага) — `needsConfirm: false`;
 * ось разная или соседей меньше двух — `needsConfirm: true`, предложение считается запасным
 * способом (под элементом с зазором `gap`). `ab_height` разрешения поднимается, если копия не влезает.
 *
 * @returns {{ model, key, elem_id, needsConfirm, reason, proposal: [{res, top, left, axis, step}], abHeightRaised }}
 */
export function duplicateElement(model, selector, opts = {}) {
  const { key: srcKey, elem: src } = findElement(model, selector);
  const gap = numOr(opts.gap, 20);
  const sib = siblings(model, srcKey);
  const chain = [...sib, srcKey];
  const proposal = [];
  const axes = new Set();
  let reason = null;
  for (const res of positionResolutions(src)) {
    const g = geometryAt(src, res);
    let entry;
    if (chain.length >= 2) {
      // Два последних по позиции (сначала top, потом left) однотипных элемента задают шаг.
      const sorted = chain.map((k) => ({ k, ...geometryAt(model[k], res) })).sort((a, b) => a.top - b.top || a.left - b.left);
      const last = sorted[sorted.length - 1];
      const prev = sorted[sorted.length - 2];
      const step = { top: last.top - prev.top, left: last.left - prev.left };
      const axis = Math.abs(step.left) > Math.abs(step.top) ? 'x' : 'y';
      entry = { res: res || 'base', top: last.top + step.top, left: last.left + step.left, axis, step, from: `${prev.k}→${last.k}` };
      if (step.top === 0 && step.left === 0) {
        entry = { res: res || 'base', top: g.top + g.height + gap, left: g.left, axis: 'y', step: { top: g.height + gap, left: 0 }, fallback: true };
        reason = reason || 'соседи стоят на одном месте';
      }
      axes.add(entry.axis);
    } else {
      entry = { res: res || 'base', top: g.top + g.height + gap, left: g.left, axis: 'y', step: { top: g.height + gap, left: 0 }, fallback: true };
      reason = reason || `однотипных соседей меньше двух (найдено ${sib.length})`;
    }
    proposal.push(entry);
    log.debug('duplicateElement', 'шаг на разрешении', { res: res || 'base', neighbours: chain.length, ...entry });
  }
  if (!reason && axes.size > 1) reason = `раскладка разная: оси ${[...axes].join(',')} на разных разрешениях`;
  const needsConfirm = Boolean(reason);

  const next = clone(model);
  const copy = clone(src);
  const elem_id = newElemId(model, opts.now);
  copy.elem_id = elem_id;
  if (copy.groupid) {
    log.debug('duplicateElement', 'копия выходит из группы источника', { groupid: copy.groupid });
    delete copy.groupid;
  }
  const maxZ = Math.max(0, ...elementKeys(model).map((k) => numOr(model[k].zindex)));
  copy.zindex = String(maxZ + 1);
  for (const p of proposal) {
    const res = p.res === 'base' ? '' : p.res;
    copy[posField('top', res)] = String(p.top);
    copy[posField('left', res)] = String(p.left);
  }
  const newKey = String(Math.max(-1, ...elementKeys(model).map(Number)) + 1);
  next[newKey] = copy;

  // ab_height по каждому разрешению: копия обязана влезать в блок.
  const abHeightRaised = [];
  for (const p of proposal) {
    const res = p.res === 'base' ? '' : p.res;
    const bottom = p.top + geometryAt(src, res).height + gap;
    const abKey = posField('ab_height', res);
    const current = numOr(next[abKey] ?? next.ab_height);
    if (bottom > current) {
      log.debug('duplicateElement', 'ab_height поднят', { res: p.res, from: current, to: bottom });
      next[abKey] = String(bottom);
      abHeightRaised.push({ res: p.res, from: current, to: bottom });
    }
  }
  // Правки копии (например новый текст) — тем же путём, что и любое поле: guard'ы включены.
  const out = opts.set && Object.keys(opts.set).length ? setFields(next, newKey, opts.set, { resStrategy: opts.resStrategy }) : next;
  log.info('duplicateElement', needsConfirm ? 'копия рассчитана, нужно подтверждение' : `копия элемента ${elem_id} создана`, { source: src.elem_id, elem_id, key: newKey, needsConfirm, reason, proposal: proposal.map((p) => `${p.res}: top ${p.top}, left ${p.left} (${p.axis})`), abHeightRaised: abHeightRaised.length });
  return { model: out, key: newKey, elem_id, needsConfirm, reason, proposal, abHeightRaised };
}

/** Убрать элемент из модели (обратная операция к duplicateElement; откат по журналу). */
export function removeElement(model, selector) {
  const { key, elem } = findElement(model, selector);
  const next = clone(model);
  delete next[key];
  log.info('removeElement', 'элемент удалён из модели', { key, elem_id: elem.elem_id, elem_type: elem.elem_type });
  return { model: next, key, elem_id: String(elem.elem_id) };
}

/**
 * Задать служебные ключи блока (артборда): `ab_height`, `ab_height-res-320`, `ab_bgcolor`, …
 * Только существующие скалярные ключи — структура (groups, meta) и элементы так не пишутся.
 */
export function setBlockFields(model, fields) {
  const next = clone(model);
  for (const [key, value] of Object.entries(fields || {})) {
    if (isElemKey(key) || !(key in next)) throw new Error(`BAD_BLOCK_KEY ${key}: нет такого служебного ключа`);
    if (typeof next[key] === 'object' && next[key] !== null) throw new Error(`BAD_BLOCK_KEY ${key}: структурный ключ не пишется`);
    assertNoScript(value, { key });
    const from = next[key];
    next[key] = typeof value === 'number' ? value : String(value);
    log.info('setBlockFields', 'служебный ключ изменён', { key, from: String(from).slice(0, 40), to: String(value).slice(0, 40) });
  }
  return next;
}
