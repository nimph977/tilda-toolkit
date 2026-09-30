/**
 * Признаки разметки блока Tilda — единственная форма сравнения разметки для калибровки настроек
 * (карта влияния), разбора референса и поблочной сверки.
 *
 * Признак — строка одного из видов:
 *   `class:<имя>`                         класс открывающего тега;
 *   `attr:<data-имя>=<значение>`          атрибут `data-*` со значением не длиннее 80 символов;
 *   `style:<свойство>:<значение>`         объявление инлайн-стиля;
 *   `css:<@media-условие>|<селектор>{<свойство>:<значение>}`  объявление правила из `<style>`
 *                                          (условие без пробелов, пустое вне `@media`).
 * `recid` блока заменяется на `RID`, адреса `http(s)://…` — на `URL`, поэтому признаки блоков
 * с разными ID и разными доменами сравнимы.
 *
 * Нормализация уровня Tilda, общая для всех шаблонов (итог пробы
 * 2026-09-23): предпросмотр блока (`previewrecord`) несёт служебную
 * разметку редактора (`EDITOR_ONLY`) и называет видимость по экранам иначе, чем публикация
 * (`RENAMES`); слепок опубликованной страницы снят после скриптов (`RUNTIME_ONLY`); публикация
 * дублирует видимость классом (`PUBLISH_ONLY`). Правил под отдельный шаблон здесь нет.
 *
 * Только регулярные выражения — без DOM, сети и файловой системы.
 */
import { createLogger } from './log.mjs';

const log = createLogger('markup-features');

/** Признаки, которые пишет только редактор (предпросмотр блока), — у публикации их нет. */
export const EDITOR_ONLY = [
  /^class:record$/,
  /^class:t-column-draggable$/,
  /^attr:data-record-(category|cod)=/,
  /^attr:data-ai-tpl=/,
  /^attr:data-column-(helper-[a-z-]+|id)=/,
  /^attr:data-buttonfieldset=/,
  /^attr:data-redactor-nohref=/,
  /--tilda-typo-hook:/,
];

/** Признаки, которые появляются только после скриптов страницы (слепок референса снят после них). */
export const RUNTIME_ONLY = [
  /^class:loaded$/,
  /^class:r_hidden$/,
  /^class:t-animate_wait$/,
  /^class:t-animate_started$/,
  /^style:cursor:pointer$/,
  /^style:min-height:auto$/,
  /^style:height:0px$/,
  /^style:transform:unset$/,
  /^attr:data-observer-ready=/,
  /^attr:data-tilda-mask-init=/,
  /^attr:data-(lid|elem-id|original|tu-[a-z-]+)=/,
];

/**
 * Публикация дублирует видимость по экранам классом `t-screenmax-<w>`/`t-screenmin-<w>` рядом с
 * атрибутом `data-screen-max`/`data-screen-min`. Атрибут уже несёт значение — класс
 * выбрасывается, чтобы предпросмотр и публикация дали один набор.
 */
export const PUBLISH_ONLY = [/^class:t-screen(max|min)-/];

/** Форма редактора → форма публикации (`data-screenmax` у предпросмотра блока). */
export const RENAMES = [
  [/^attr:data-screenmax=/, 'attr:data-screen-max='],
  [/^attr:data-screenmin=/, 'attr:data-screen-min='],
];

const MAX_ATTR_VALUE = 80;
const VENDOR_PROP_RE = /^-(webkit|moz|o|ms)-/;
const VENDOR_GRADIENT_RE = /-(?:webkit|moz|o)-(linear-gradient)\((top|left|bottom|right),/g;
const GRADIENT_DIRECTION = { top: 'to bottom', left: 'to right', bottom: 'to top', right: 'to left' };
const VENDOR_VALUE_RE = /(^|[\s,(])-(webkit|moz|o|ms)-/;
const URL_RE = /https?:\/\/[^\s"')]+/g;
const TOKEN_RE = /#[0-9a-f]{6}(?![0-9a-z])|(?<![\w.-])-\d+(?:\.\d+)?|\d+(?:\.\d+)?/g;

const decodeQuotes = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&amp;/g, '&');

const byteToHex = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');

/** `rgb(r,g,b)` и `rgba(r,g,b,1)` → `#rrggbb`; `#abc` → `#aabbcc`; hex — нижним регистром. */
function normalizeColors(value) {
  return value
    .replace(/rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,(1|1\.0+))?\)/gi, (_, r, g, b) => `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`)
    .replace(/#([0-9a-f]{3})(?![0-9a-z])/gi, (_, h) => `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`)
    .replace(/#[0-9a-f]{6}(?![0-9a-z])/gi, (h) => h.toLowerCase());
}

/**
 * Нормализация одного объявления CSS. Свойство с префиксом браузера → null; значение с префиксом
 * браузера → null, кроме градиента `-webkit-linear-gradient(top,…)`, который приводится к
 * `linear-gradient(to bottom,…)` (так его пишет слепок после скриптов).
 * @returns {[string, string] | null}
 */
export function normalizeDecl(prop, value) {
  const p = String(prop ?? '').trim().toLowerCase();
  if (!p || VENDOR_PROP_RE.test(p)) return null;
  let v = decodeQuotes(value ?? '').trim().replace(/\s+/g, ' ');
  let important = false;
  if (/\s*!important$/i.test(v)) {
    important = true;
    v = v.replace(/\s*!important$/i, '');
  }
  v = v.replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  v = v.replace(VENDOR_GRADIENT_RE, (_, fn, dir) => `${fn}(${GRADIENT_DIRECTION[dir]},`);
  if (VENDOR_VALUE_RE.test(v)) return null;
  v = normalizeColors(v);
  if (important) v = `${v} !important`;
  return [p, v];
}

/** Объявления `a:b;c:d` → нормализованные пары. */
function declarations(body) {
  const out = [];
  for (const decl of String(body).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const pair = normalizeDecl(decl.slice(0, i), decl.slice(i + 1));
    if (pair) out.push(pair);
  }
  return out;
}

/**
 * Правила CSS: `[{ media, selector, body }]`, в том числе внутри `@media (…){…}`. Прочие
 * at-правила (`@keyframes`, `@font-face`, `@supports`) пропускаются целиком.
 */
function cssRules(css) {
  const rules = [];
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (s, media) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      // Конец блока с учётом вложенности.
      let depth = 1;
      let j = open + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth += 1;
        else if (s[j] === '}') depth -= 1;
        j += 1;
      }
      const inner = s.slice(open + 1, j - 1);
      if (/^@media\b/i.test(head)) walk(inner, head.replace(/^@media\s*/i, '').replace(/\s+/g, ''));
      else if (!head.startsWith('@') && head) rules.push({ media, selector: head.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ','), body: inner });
      i = j;
    }
  };
  walk(text, '');
  return rules;
}

const ATTR_RE = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * Признаки куска HTML одного блока. Детерминирована: одинаковый вход → одинаковый массив.
 * @param {string} html
 * @param {{ recid?: string }} opts
 * @returns {string[]} отсортированные уникальные признаки
 */
export function extractFeatures(html, { recid } = {}) {
  let s = String(html ?? '');
  if (recid) s = s.split(String(recid)).join('RID');
  s = s.replace(URL_RE, 'URL');
  const found = new Set();
  const styles = [];
  s = s.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    styles.push(css);
    return '';
  });
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of s.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    for (const a of tag[2].matchAll(ATTR_RE)) {
      const name = a[1].toLowerCase();
      const value = decodeQuotes(a[2] ?? a[3] ?? a[4] ?? '');
      if (name === 'class') for (const c of value.split(/\s+/).filter(Boolean)) found.add(`class:${c}`);
      else if (name.startsWith('data-') && value.length <= MAX_ATTR_VALUE) found.add(`attr:${name}=${value}`);
      else if (name === 'style') for (const [p, v] of declarations(value)) found.add(`style:${p}:${v}`);
    }
  }
  for (const css of styles) for (const r of cssRules(css)) for (const [p, v] of declarations(r.body)) found.add(`css:${r.media}|${r.selector}{${p}:${v}}`);
  const dropped = { editor: 0, runtime: 0, publish: 0 };
  let renamed = 0;
  const out = new Set();
  for (let f of found) {
    for (const [re, to] of RENAMES) {
      if (re.test(f)) {
        f = f.replace(re, to);
        renamed += 1;
      }
    }
    if (EDITOR_ONLY.some((re) => re.test(f))) dropped.editor += 1;
    else if (RUNTIME_ONLY.some((re) => re.test(f))) dropped.runtime += 1;
    else if (PUBLISH_ONLY.some((re) => re.test(f))) dropped.publish += 1;
    else out.add(f);
  }
  const result = [...out].sort();
  log.debug('extractFeatures', 'features', { count: result.length, dropped, renamed });
  return result;
}

/**
 * Форма признака: токены — `#rrggbb` и числа слева направо; в форме каждый токен заменён на `§`.
 * Число после буквы или дефиса внутри имени (`t-screenmax-980px`) не считается отрицательным.
 */
export function shapeOf(feature) {
  const tokens = [];
  const shape = String(feature).replace(TOKEN_RE, (t) => {
    tokens.push(t);
    return '§';
  });
  return { shape, tokens };
}

/** Разница наборов признаков: `added` = b∖a, `removed` = a∖b, в порядке сортировки. */
export function diffFeatures(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  return {
    added: [...B].filter((f) => !A.has(f)).sort(),
    removed: [...A].filter((f) => !B.has(f)).sort(),
  };
}
