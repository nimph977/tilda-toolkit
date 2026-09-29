/**
 * Чистый разбор опубликованного HTML референса в структуру страницы.
 *
 * Опирается на атрибуты `field=` / `imgfield=` / `bgimgfield=` стандартных блоков Tilda: в
 * опубликованной разметке они несут имена полей редактора (`title`, `descr`, `li_title__<lid>`,
 * `img`…); `bgimgfield` — картинка фоном (`t-bgimg`, адрес в `data-original`).
 * Только регулярные выражения поверх `splitRecords`/`cleanText` — без HTML-парсера и сети.
 * У текстовых полей две формы: `text` (видимый текст для поиска и превью) и `html` — тот же
 * текст с переносами строк как `<br>`, который и пишется в поля блока.
 * Соцссылки блока (`soclinks`) читаются отдельно: у иконок соцсетей нет `field=`, сервис лежит
 * в классе `t-sociallinks__item_<service>`, адрес — во вложенной ссылке.
 * Кнопки (`buttons`) без `field=` читаются по классу `t-btn`, видео обложки (`video`) — по
 * `data-content-video-url-<вид>`, зона блока (`zone`) — по `<header>`/`<footer>` с `data-tilda-page-id`.
 * HTML референса — непроверенные данные: в структуру попадают тексты после `cleanText`,
 * ссылки и URL картинок; `<script>`/`<style>` не сохраняются.
 */
import { readFileSync } from 'node:fs';
import { cleanText, liteHtml, splitRecords, ZERO_TYPE } from './html-blocks.mjs';
import { extractBlockStyles } from './reference-styles.mjs';
import { extractFeatures } from './markup-features.mjs';
import { decodeEntities } from './entities.mjs';
import { createLogger } from './log.mjs';

const log = createLogger('reference-structure');

/** Теги без закрывающей пары. */
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source']);
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const TAG_RE = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
const CARD_FIELD_RE = /^(li_[a-z]+)__(\d+)$/;
const SKIP_HREF_RE = /^(#|javascript:|mailto:|tel:)/i;
const HOOK_HREF_RE = /^#(submenu|popup):/i;
const SOCIAL_ITEM_RE = /\bt-sociallinks__item_([a-z0-9]+)\b/i;
const TOOLTIP_HOOK_RE = /\bdata-tooltip-hook="([^"]+)"/i;
export const FILE_LINK_RE = /\.(jpe?g|png|gif|webp|svg|pdf|zip|docx?|xlsx?|mp4|mp3)$/i;
const TEXT_PREVIEW_LIMIT = 400;

/** Атрибуты открывающего тега → объект; значения декодируются из HTML-сущностей. */
function attrs(tag) {
  const result = {};
  for (const m of tag.matchAll(ATTR_RE)) result[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return result;
}

/** Позиция после закрывающего тега `name`, парного открывающему, начиная с `from`. */
function findClose(chunk, name, from) {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(chunk); m; m = re.exec(chunk)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { end: m.index + m[0].length, innerEnd: m.index };
  }
  return { end: chunk.length, innerEnd: chunk.length };
}

/**
 * Все элементы куска, для которых `predicate(name, attrs)` истинен.
 * Конец элемента ищется по стеку одноимённых тегов; void-теги закрываются сразу.
 * @returns {{name: string, attrs: object, start: number, end: number, inner: string}[]}
 */
function findElements(chunk, predicate) {
  const found = [];
  for (const m of chunk.matchAll(TAG_RE)) {
    const name = m[1].toLowerCase();
    const parsed = attrs(m[2]);
    if (!predicate(name, parsed)) continue;
    const start = m.index;
    const openEnd = start + m[0].length;
    if (VOID.has(name) || m[2].trimEnd().endsWith('/')) {
      found.push({ name, attrs: parsed, start, end: openEnd, inner: '' });
      continue;
    }
    const { end, innerEnd } = findClose(chunk, name, openEnd);
    found.push({ name, attrs: parsed, start, end, inner: chunk.slice(openEnd, innerEnd) });
  }
  return found;
}

/** `href` первой ссылки `<a>`, внутри которой лежит позиция `pos`. */
function enclosingHref(anchors, pos) {
  const hit = anchors.find((a) => a.start < pos && pos < a.end && a.attrs.href);
  return hit ? hit.attrs.href : null;
}

/** Источник картинки с учётом ленивой загрузки; data-URI не считается источником. */
function pickSrc(a) {
  const src = a['data-original'] || a['data-lazy-src'] || a.src || a['data-src'] || null;
  return src && !src.startsWith('data:') ? src : null;
}

/** Абсолютный URL относительно `baseUrl`; при ошибке — исходная строка. */
function absolute(href, baseUrl) {
  if (href == null) return null;
  try {
    return new URL(href, baseUrl || undefined).href;
  } catch {
    return href;
  }
}

/** Ссылки внутри текста, которые не переносятся тегом: без адреса и `javascript:` (текст остаётся). */
const SKIP_INLINE_HREF_RE = /^\s*javascript:/i;
const LINK_COLOR_RE = /(?:^|;)\s*color\s*:\s*([^;]+)/i;
const SAFE_COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.,%\s]+\))$/i;

/** Цвет из атрибута `style` (без `!important`), если это безопасное значение; иначе null. */
function styleColor(style) {
  const color = (style || '').match(LINK_COLOR_RE)?.[1]?.replace(/!important/i, '').trim();
  return color && SAFE_COLOR_RE.test(color) ? color : null;
}

/**
 * [FIX] Цвет, который ссылка наследует внутри поля: ближайший предок с цветом в `style`
 * (`data-customstyle`-обёртка редактора, `<li style>`). Обёртки `liteHtml` убирает, поэтому без
 * этого ссылка без своего цвета брала бы цвет поля из настроек блока — у подвала 464 белый.
 * @returns {(string|null)[]} по одному значению на каждый `<a>` поля в порядке документа
 */
function inheritedLinkColors(inner) {
  const styled = findElements(inner, (_, a) => styleColor(a.style) !== null);
  return findElements(inner, (name) => name === 'a').map((a) => {
    const around = styled.filter((s) => s.start < a.start && a.start < s.end);
    return around.length ? styleColor(around[around.length - 1].attrs.style) : null;
  });
}

/** Значение атрибута для HTML в двойных кавычках. */
export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * [FIX] Открывающий тег ссылки внутри текста поля: только `href` (абсолютный, кроме `#…`, `tel:`,
 * `mailto:`), `target="_blank"` и цвет из `style` — видимый цвет пункта задаёт ссылка (у подвала 464
 * текст поля белый, пункты чёрные). Своего цвета нет — берётся унаследованный `inheritedColor`.
 * Прочие атрибуты HTML референса не переносятся.
 * @returns {string|null} null — ссылка убирается, текст остаётся
 */
export function inlineLinkTag(a, baseUrl, inheritedColor = null) {
  const raw = a.href;
  if (!raw || SKIP_INLINE_HREF_RE.test(raw)) return null;
  const href = KEEP_HREF_RE.test(raw) ? raw : absolute(raw, baseUrl);
  const target = a.target === '_blank' ? ' target="_blank"' : '';
  const color = styleColor(a.style) ?? inheritedColor;
  const style = color ? ` style="color: ${color}"` : '';
  return `<a href="${escapeAttr(href)}"${target}${style}>`;
}

/** Соцссылки блока: `<li class="… t-sociallinks__item_<service>"><a href>` → [{ service, href }]. */
function extractSocialLinks(chunk, baseUrl) {
  const out = [];
  for (const li of findElements(chunk, (name, a) => name === 'li' && SOCIAL_ITEM_RE.test(a.class || ''))) {
    const service = li.attrs.class.match(SOCIAL_ITEM_RE)[1].toLowerCase();
    const a = findElements(li.inner, (name) => name === 'a')[0];
    const href = a?.attrs.href;
    if (!href || SKIP_HREF_RE.test(href)) continue;
    out.push({ service, href: absolute(href, baseUrl) });
  }
  return out;
}

/**
 * Атрибут слота кнопки (проверено 2026-09-23): старая разметка `t-btn t-btn_md` несёт
 * `data-buttonfieldset="button|button2|li_button"`; новая `t-btnflex` его не несёт, номер есть только
 * в `data-tilda-event-name="…/button<N>"` у кнопок со счётчиком кликов.
 */
export const BUTTON_SLOT_ATTR = 'data-buttonfieldset';
const BUTTON_FIELDSET_RE = /^button(\d*)$/;
const BUTTON_EVENT_RE = /\/button(\d+)$/;
const KEEP_HREF_RE = /^(#|tel:|mailto:)/i;

/** Слот по атрибутам кнопки: `''` для первой, `'N'` для N-й; null — атрибута нет или он не про слот. */
function buttonSlotFromAttrs(a, slotAttr) {
  const fieldset = slotAttr ? a[slotAttr] : undefined;
  const byFieldset = fieldset !== undefined ? fieldset.match(BUTTON_FIELDSET_RE) : null;
  if (byFieldset) return byFieldset[1] === '1' ? '' : byFieldset[1];
  const byEvent = (a['data-tilda-event-name'] || '').match(BUTTON_EVENT_RE);
  if (byEvent) return byEvent[1] === '1' ? '' : byEvent[1];
  return null;
}

/**
 * Кнопки блока: `<a class="… t-btn …">` (класс целым словом; `t-btnflex__text` — не кнопка).
 * Текст — из `<span class="t-btnflex__text">`, иначе всё содержимое ссылки. Адрес — как есть для
 * `#…`, `tel:`, `mailto:`, иначе абсолютный. Слот — по `slotAttr`/`data-tilda-event-name`
 * (`source: 'attr'`), иначе по порядку в блоке (`source: 'order'`). Кнопки карточек
 * (`data-buttonfieldset="li_…"`) принадлежат карточкам и в список блока не входят.
 * @returns {{slot: string, text: string, html: string, href: string, source: 'attr'|'order'}[]}
 */
export function extractButtons(chunk, baseUrl, { slotAttr = BUTTON_SLOT_ATTR } = {}) {
  const found = [];
  let cardButtons = 0;
  for (const el of findElements(chunk, (name, a) => name === 'a' && /(^|\s)t-btn(\s|$)/.test(a.class ?? ''))) {
    if (slotAttr && /^li_/.test(el.attrs[slotAttr] ?? '')) {
      cardButtons += 1;
      continue;
    }
    const span = findElements(el.inner, (name, a) => name === 'span' && /(^|\s)t-btnflex__text(\s|$)/.test(a.class ?? ''))[0];
    const inner = span ? span.inner : el.inner;
    const raw = el.attrs.href ?? '';
    const href = !raw ? '' : KEEP_HREF_RE.test(raw) ? raw : absolute(raw, baseUrl);
    found.push({ bySlot: buttonSlotFromAttrs(el.attrs, slotAttr), text: cleanText(inner), html: liteHtml(inner), href });
  }
  // Слоты по атрибутам занимаются первыми (повтор уходит в общий порядок); остальные кнопки
  // получают первый свободный слот по порядку: '', '2', '3'…
  const taken = new Set();
  for (const b of found) {
    if (b.bySlot === null || taken.has(b.bySlot)) b.bySlot = null;
    else taken.add(b.bySlot);
  }
  let next = 1;
  const freeSlot = () => {
    for (;; next += 1) {
      const s = next === 1 ? '' : String(next);
      if (!taken.has(s)) {
        taken.add(s);
        return s;
      }
    }
  };
  const buttons = found.map(({ bySlot, ...b }) => (bySlot === null ? { slot: freeSlot(), ...b, source: 'order' } : { slot: bySlot, ...b, source: 'attr' }));
  log.debug('extractButtons', 'кнопки блока', { count: buttons.length, bySlotAttr: buttons.filter((b) => b.source === 'attr').length, cardButtons });
  return buttons;
}

/**
 * Кнопки карточек: элемент `a`/`div` с классом `t-btn`
 * целым словом и классом `t-card__btn` или `data-buttonfieldset="li_…"`. Карточка — по
 * `data-lid` кнопки, иначе по ближайшему предшествующему `field="li_…__<lid>"`/`data-lid`.
 * Текст — из `span.t-btnflex__text`, иначе видимый текст кнопки; адрес — как у `extractButtons`.
 * @returns {Map<string, {text: string, href: string}>} lid → кнопка (первая в карточке)
 */
export function extractCardButtons(chunk, baseUrl) {
  const out = new Map();
  const isCardButton = (name, a) => (name === 'a' || name === 'div') && /(^|\s)t-btn(\s|$)/.test(a.class ?? '') && (/(^|\s)t-card__btn(\s|$)/.test(a.class ?? '') || /^li_/.test(a[BUTTON_SLOT_ATTR] ?? ''));
  for (const el of findElements(chunk, isCardButton)) {
    let lid = el.attrs['data-lid'] ?? null;
    if (!lid) {
      const before = chunk.slice(0, el.start);
      const marks = [...before.matchAll(/(?:field="li_[a-z]+__(\d+)"|data-lid="(\d+)")/g)];
      const last = marks[marks.length - 1];
      lid = last ? last[1] ?? last[2] : null;
    }
    if (!lid || out.has(lid)) continue;
    const span = findElements(el.inner, (name, a) => name === 'span' && /(^|\s)t-btnflex__text(\s|$)/.test(a.class ?? ''))[0];
    const text = cleanText((span ? span.inner : el.inner).replace(/<style\b[\s\S]*?<\/style>/gi, ''));
    if (!text) continue;
    const raw = el.attrs.href ?? '';
    out.set(lid, { text, href: !raw ? '' : KEEP_HREF_RE.test(raw) ? raw : absolute(raw, baseUrl) });
  }
  log.debug('extractCardButtons', 'кнопки карточек', { count: out.size, withHref: [...out.values()].filter((b) => b.href).length });
  return out;
}

/**
 * Код HTML-блока T123: текст между
 * `<!-- nominify begin -->` и `<!-- nominify end -->`; `<script>` вырезаются — их запись сбрасывает
 * сессию Tilda, число вырезанных — в `scripts`. Маркеров нет — null.
 * @returns {null | { code: string, scripts: number }}
 */
export function extractT123Code(chunk) {
  const m = String(chunk).match(/<!--\s*nominify begin\s*-->([\s\S]*?)<!--\s*nominify end\s*-->/i);
  if (!m) return null;
  let scripts = 0;
  const code = m[1]
    .replace(/<script\b[^>]*\/>/gi, () => {
      scripts += 1;
      return '';
    })
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, () => {
      scripts += 1;
      return '';
    })
    .trim();
  log.debug('extractT123Code', 'код HTML-блока', { bytes: code.length, scripts });
  return { code, scripts };
}

/**
 * Мессенджеры блока 898: элементы с классами
 * `t898__icon-<service>_wrapper` и `t898__icon_link`; адрес — свой `href` или вложенной `<a>`.
 * Служебные значки (`t898__icon-close`, `t898__icon-write`) не входят.
 * @returns {{service: string, href: string}[]}
 */
export function extractMessengers(chunk, baseUrl) {
  const out = [];
  const isItem = (_, a) => /\bt898__icon_link\b/.test(a.class ?? '') && /\bt898__icon-[a-z0-9]+_wrapper\b/.test(a.class ?? '');
  for (const el of findElements(chunk, isItem)) {
    const service = el.attrs.class.match(/\bt898__icon-([a-z0-9]+)_wrapper\b/)[1];
    const raw = el.attrs.href ?? findElements(el.inner, (name) => name === 'a')[0]?.attrs.href ?? '';
    if (!raw) continue;
    out.push({ service, href: KEEP_HREF_RE.test(raw) ? raw : absolute(raw, baseUrl) });
  }
  log.debug('extractMessengers', 'мессенджеры', { services: out.map((m) => m.service) });
  return out;
}

/**
 * Форма стандартного блока: поля ввода по группам
 * `t-input-group t-input-group_<тип>` и сообщение об успехе с тега `<form>`. Получатели заявок
 * (`formservices[]`) не читаются. Нет групп и нет `<form>` — null.
 * @returns {null | { inputs: Array<{type, name, placeholder, required, rule, mask, title}>, successUrl: string|null, successMessage: string|null, successTitle: string|null }}
 */
export function extractForm(chunk, baseUrl) {
  const groups = findElements(chunk, (name, a) => name === 'div' && /(^|\s)t-input-group(\s|$)/.test(a.class ?? ''));
  const inputs = [];
  for (const g of groups) {
    const type = ((g.attrs.class ?? '').match(/\bt-input-group_([a-z0-9]+)\b/) || [])[1] ?? '';
    const field = findElements(g.inner, (name, a) => ['input', 'textarea', 'select'].includes(name) && a.type !== 'hidden')[0];
    const titleEl = findElements(g.inner, (name, a) => /(^|\s)t-input-title(\s|$)/.test(a.class ?? ''))[0];
    const a = field?.attrs ?? {};
    inputs.push({
      type,
      name: a.name ?? '',
      placeholder: a.placeholder ?? '',
      required: a['data-tilda-req'] === '1',
      rule: a['data-tilda-rule'] ?? '',
      mask: a['data-tilda-mask'] ?? '',
      title: titleEl ? cleanText(titleEl.inner) : '',
    });
  }
  const form = findElements(chunk, (name) => name === 'form')[0];
  if (!inputs.length && !form) return null;
  const fa = form?.attrs ?? {};
  const successUrl = fa['data-success-url'] ? absolute(fa['data-success-url'], baseUrl) : null;
  log.debug('extractForm', 'форма', { inputs: inputs.length, types: inputs.map((x) => x.type), successUrl: Boolean(successUrl), successMessage: Boolean(fa['data-success-message']) });
  return { inputs, successUrl, successMessage: fa['data-success-message'] ?? null, successTitle: fa['data-success-title'] ?? null };
}

/**
 * Виды видео в порядке выбора. Адрес лежит в атрибуте `data-content-video-url-<вид>` сохранённого
 * HTML (проба: обложка 213 — rutube, видеоблок 4 — youtube).
 */
export const VIDEO_KINDS = ['youtube', 'vimeo', 'rutube', 'vkvideo', 'kinescope', 'mp4', 'webm'];

/** Видео блока `{ kind, url }` по первому непустому `data-content-video-url-<вид>`; нет — null. */
export function extractVideo(chunk) {
  for (const kind of VIDEO_KINDS) {
    const m = chunk.match(new RegExp(`\\sdata-content-video-url-${kind}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (m && m[1].trim()) {
      log.debug('extractVideo', 'видео блока', { kind });
      return { kind, url: decodeEntities(m[1].trim()) };
    }
  }
  return null;
}

/**
 * [FIX] Форма разделителя 796 по пути SVG опубликованной разметки → значение настройки
 * `shapedividerstyle` (варианты редактора: zigzag, arrow, skew — `edrec__drawUI__getFieldObj`).
 * Пути сняты со слепка референса 2026-09-23 (114 разделителей: 111 skew, 3 arrow).
 */
export const SHAPE_STYLE_BY_PATH = {
  'M1280 200H0V0l1280 195.5v4.5z': 'skew',
  'M640 195.5L0 0v200h1280V0': 'arrow',
};
const SHAPE_BORDER_RE = /\bt796__shape-border_(top|bottom)\b/;

/**
 * Разделитель-фигура блока: `{ style, position, path }`; style null — путь не распознан (тогда path —
 * сам путь для причины). Блок без `t796__shape-border` → null.
 */
export function extractShape(chunk) {
  const pos = chunk.match(SHAPE_BORDER_RE);
  if (!pos) return null;
  const d = (chunk.match(/<path\s[^>]*\bd="([^"]+)"/i) || [])[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const style = SHAPE_STYLE_BY_PATH[d] ?? null;
  log.debug('extractShape', '[FIX] разделитель', { position: pos[1], style });
  return { style, position: pos[1], path: style ? null : d.slice(0, 60) };
}

/** Группирует поля/картинки `li_*__<lid>` в карточки; возвращает остаток и карточки. */
function splitCards(fields, images) {
  const cards = new Map();
  const card = (lid) => {
    if (!cards.has(lid)) cards.set(lid, { lid, fields: {}, html: {}, hrefs: {}, images: {} });
    return cards.get(lid);
  };
  const plainFields = [];
  for (const f of fields) {
    const m = f.name.match(CARD_FIELD_RE);
    if (!m) {
      plainFields.push(f);
      continue;
    }
    const c = card(m[2]);
    c.fields[m[1]] = f.text;
    c.html[m[1]] = f.html;
    if (f.href) c.hrefs[m[1]] = f.href;
  }
  const plainImages = [];
  for (const img of images) {
    const m = img.field ? img.field.match(CARD_FIELD_RE) : null;
    if (!m) {
      plainImages.push(img);
      continue;
    }
    card(m[2]).images[m[1]] = img.src;
  }
  return { fields: plainFields, images: plainImages, cards: [...cards.values()] };
}

/**
 * Собственная разметка записи: кусок `splitRecords` у последнего блока перед подвалом (и у
 * последнего блока шапки) захватывает чужую разметку до следующего `<div id="rec…">` — режем по
 * первому `<footer`, `<!--footer-->` или `</header>`.
 */
export function ownChunk(chunk) {
  const cut = ['<footer', '<!--footer-->', '</header>']
    .map((m) => chunk.toLowerCase().indexOf(m))
    .filter((i) => i > 0);
  return cut.length ? chunk.slice(0, Math.min(...cut)) : chunk;
}

/**
 * Структура одного блока из результата `splitRecords`.
 * @param {{order: number, recid: string, type: string, chunk: string}} rec
 */
export function extractBlock(rec, { baseUrl } = {}) {
  const { chunk } = rec;
  const own = ownChunk(chunk);
  const anchors = findElements(chunk, (name) => name === 'a');

  const rawFields = findElements(chunk, (_, a) => a.field !== undefined).map((el) => {
    let href = el.name === 'a' ? el.attrs.href ?? null : enclosingHref(anchors, el.start);
    const text = cleanText(el.inner);
    // [FIX] Ссылка внутри поля: одна ссылка на весь текст (заголовок карточки 686) — это ссылка
    // поля (`href` → `li_link`/поле ссылки); иначе ссылки остаются тегами в `html` поля (подвал
    // 464, текст 106, формы 704). Раньше `liteHtml` их вырезал, адрес в план не попадал.
    const inner = findElements(el.inner, (name, a) => name === 'a' && a.href && !SKIP_INLINE_HREF_RE.test(a.href));
    if (!href && inner.length === 1 && cleanText(inner[0].inner) === text) {
      href = inner[0].attrs.href;
      log.debug('extractBlock', '[FIX] ссылка на всё поле', { recid: rec.recid, field: el.attrs.field });
      return { name: el.attrs.field, text, html: liteHtml(el.inner, { format: true }), href: absolute(href, baseUrl) };
    }
    // Порядок `<a>` в liteHtml и в findElements один — порядок документа.
    const colors = inner.length ? inheritedLinkColors(el.inner) : [];
    let nth = 0;
    // [FIX] Оформление редактора (data-customstyle, жирность, размер) переносится по белому списку.
    const html = liteHtml(el.inner, { format: true, link: (attrString) => inlineLinkTag(attrs(attrString), baseUrl, colors[nth++] ?? null) });
    if (inner.length) log.debug('extractBlock', '[FIX] ссылки внутри поля', { recid: rec.recid, field: el.attrs.field, links: inner.length });
    return { name: el.attrs.field, text, html, href: absolute(href, baseUrl) };
  });

  const rawImages = findElements(chunk, (name, a) => name === 'img' || a.imgfield !== undefined || a.bgimgfield !== undefined)
    .map((el) => ({ field: el.attrs.imgfield || el.attrs.bgimgfield || null, src: absolute(pickSrc(el.attrs), baseUrl), alt: el.attrs.alt || '' }))
    .filter((img) => img.src !== null);

  const links = [];
  const seenHref = new Set();
  for (const a of anchors) {
    const href = a.attrs.href;
    // [FIX] Крючки `#submenu:<имя>` и `#popup:<имя>` — пункты меню (подменю 794 открывается по
    // имени), их не отбрасываем вместе с обычными якорями; адрес остаётся как есть.
    const hook = HOOK_HREF_RE.test(href ?? '');
    if (!href || (SKIP_HREF_RE.test(href) && !hook)) continue;
    const abs = hook ? href : absolute(href, baseUrl);
    if (seenHref.has(abs)) continue;
    seenHref.add(abs);
    links.push({ href: abs, text: cleanText(a.inner) });
  }

  const { fields, images, cards } = splitCards(rawFields, rawImages);
  // Кнопки карточек — по куску без шапки/подвала, иначе кнопки подвала попали бы в карточки.
  if (cards.length) {
    const cardButtons = extractCardButtons(own, baseUrl);
    for (const c of cards) {
      const btn = cardButtons.get(String(c.lid));
      if (!btn) continue;
      c.fields.li_buttontitle = btn.text;
      c.html.li_buttontitle = btn.text;
      if (!Object.keys(c.hrefs).length && btn.href) c.hrefs.li_buttonlink = btn.href;
    }
  }
  // Кнопка с field="buttontitle<slot>" уже в полях — поле главнее, двойной записи не будет.
  const fieldNames = new Set(fields.map((f) => f.name));
  const allButtons = extractButtons(chunk, baseUrl);
  const buttons = allButtons.filter((b) => !fieldNames.has('buttontitle' + b.slot));
  if (buttons.length !== allButtons.length) log.debug('extractBlock', 'кнопки уже в полях', { recid: rec.recid, dropped: allButtons.length - buttons.length });
  const block = {
    order: rec.order,
    recid: rec.recid,
    tplid: rec.type,
    fields,
    images,
    links,
    cards,
    buttons,
    soclinks: extractSocialLinks(chunk, baseUrl),
    // Якорь всплывающего содержимого (подменю 794, попап формы, галерея) — служебное поле блока.
    linkhook: (chunk.match(TOOLTIP_HOOK_RE) || [])[1] ?? null,
    hasForm: /data-formactiontype=/.test(chunk),
    styles: extractBlockStyles(chunk),
    text: cleanText(chunk).slice(0, TEXT_PREVIEW_LIMIT),
    // Признаки разметки для разбора настроек по карте влияния.
    features: extractFeatures(own, { recid: rec.recid }),
  };
  if (own.length !== chunk.length) log.debug('extractBlock', 'кусок обрезан по шапке/подвалу', { recid: rec.recid, dropped: chunk.length - own.length });
  if (block.hasForm) {
    const form = extractForm(own, baseUrl);
    if (form) block.form = form;
  }
  const messengers = extractMessengers(own, baseUrl);
  if (messengers.length) block.messengers = messengers;
  if (rec.type === '131') {
    const t123 = extractT123Code(own);
    if (t123) block.code = t123;
  }
  const video = extractVideo(chunk);
  if (video) block.video = video;
  // Только у самого разделителя: скрипт страницы вставляет фигуру и в соседний блок (у 704 она
  // есть в сохранённой разметке), и там она не настройка блока.
  const shape = rec.type === '796' ? extractShape(chunk) : null;
  if (shape) block.shape = shape;
  const breaks = fields.filter((f) => f.html !== f.text).length;
  const st = block.styles;
  const styled = Boolean(st.paddingTop || st.paddingBottom || st.bgColor || Object.keys(st.typo).length);
  log.debug('extractBlock', 'блок', { order: block.order, tplid: block.tplid, fields: fields.length, images: images.length, cards: cards.length, breaks, styled, soclinks: block.soclinks.length });
  return block;
}

/**
 * Зоны записей страницы: recid → 'header' | 'footer' по положению внутри тегов <header>/<footer>,
 * у которых есть атрибут data-tilda-page-id (так Tilda вставляет страницу-шапку и страницу-подвал).
 * Теги без атрибута (внутри блоков) не считаются зоной.
 * @returns {Map<string, 'header'|'footer'>}
 */
export function recordZones(html) {
  const zones = new Map();
  const count = { header: 0, footer: 0 };
  const lower = html.toLowerCase();
  for (const tag of ['header', 'footer']) {
    const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    for (const m of html.matchAll(openRe)) {
      if (!/\bdata-tilda-page-id\s*=/i.test(m[1])) continue;
      const from = m.index + m[0].length;
      const close = lower.indexOf(`</${tag}>`, from);
      const inner = html.slice(from, close === -1 ? html.length : close);
      let found = 0;
      for (const r of inner.matchAll(/<div\s+id=["']rec(\d+)/g)) {
        found += 1;
        if (zones.has(r[1])) continue;
        zones.set(r[1], tag);
        count[tag] += 1;
      }
      if (!found) log.debug('recordZones', 'зона без блоков', { tag });
    }
  }
  log.debug('recordZones', 'зоны', count);
  return zones;
}

/**
 * Структура страницы по опубликованному HTML.
 * @returns {{name: string, url: string, title: string, extractedAt: string, counts: object, blocks: object[]}}
 */
export function extractStructure(html, { url = '', name = '' } = {}) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : '';
  const zones = recordZones(html);
  const blocks = splitRecords(html).map((r) => ({ ...extractBlock(r, { baseUrl: url }), zone: zones.get(String(r.recid)) ?? 'content' }));
  const images = blocks.reduce((n, b) => n + b.images.length + b.cards.reduce((k, c) => k + Object.keys(c.images).length, 0), 0);
  const zoneCount = (z) => blocks.filter((b) => b.zone === z).length;
  const counts = {
    blocks: blocks.length,
    zero: blocks.filter((b) => b.tplid === ZERO_TYPE).length,
    images,
    forms: blocks.filter((b) => b.hasForm).length,
    tplids: [...new Set(blocks.map((b) => b.tplid))],
    zones: { header: zoneCount('header'), footer: zoneCount('footer'), content: zoneCount('content') },
    buttons: blocks.reduce((n, b) => n + b.buttons.length, 0),
    videos: blocks.filter((b) => b.video).length,
  };
  log.info('extractStructure', 'структура извлечена', { name, blocks: counts.blocks, images, forms: counts.forms, header: counts.zones.header, footer: counts.zones.footer });
  return { name, url, title, extractedAt: new Date().toISOString(), counts, blocks };
}

/** Внутренние ссылки страницы (тот же origin), без якорей, запросов и файлов; в порядке появления. */
export function collectInternalLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  const result = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    const href = attrs(m[1]).href;
    if (!href || SKIP_HREF_RE.test(href)) continue;
    let u;
    try {
      u = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (u.origin !== origin || FILE_LINK_RE.test(u.pathname)) continue;
    u.hash = '';
    u.search = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    result.push(u.href);
  }
  log.debug('collectInternalLinks', 'ссылки собраны', { count: result.length });
  return result;
}

/**
 * Адреса из sitemap.xml: страницы того же origin (без hash и query) и вложенные карты
 * (sitemapindex). Файлы (FILE_LINK_RE) и чужие адреса отбрасываются.
 * @returns {{ pages: string[], sitemaps: string[], dropped: number }}
 */
export function parseSitemap(xml, origin) {
  const locs = [...String(xml ?? '').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
  if (/<sitemapindex\b/i.test(xml ?? '')) {
    log.debug('parseSitemap', 'индекс карт', { sitemaps: locs.length });
    return { pages: [], sitemaps: locs, dropped: 0 };
  }
  const pages = [];
  const seen = new Set();
  let dropped = 0;
  for (const loc of locs) {
    let u;
    try {
      u = new URL(loc);
    } catch {
      dropped += 1;
      continue;
    }
    if (u.origin !== origin || FILE_LINK_RE.test(u.pathname)) {
      dropped += 1;
      continue;
    }
    u.hash = '';
    u.search = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    pages.push(u.href);
  }
  log.debug('parseSitemap', 'карта разобрана', { locs: locs.length, pages: pages.length, dropped });
  return { pages, sitemaps: [], dropped };
}

/** Структура страницы из HTML-файла на диске; ошибки чтения поднимаются как есть. */
export function structureFromFile(path, meta) {
  return extractStructure(readFileSync(path, 'utf8'), meta);
}
