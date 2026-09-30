/**
 * Оформление проекта референса из его CSS: шрифты
 * `@font-face`, семейство, вес и цвет заголовков (`.t-title`) и текста (`.t-descr`, иначе
 * `.t-text`), цвет ссылок (`#allrecords a`) и подчёркивание — и перевод этого в настройки проекта
 * Tilda (`headlinefont`, `headlinefontweight`, `headlinecolor`, `textfont`, …).
 *
 * Свои шрифты проекта в настройки не переносятся (итог пробы 4, ветка C′: `myfonts_json` — список
 * загруженных в проект файлов, адресов нет). Вместо своего шрифта выбирается пресет Tilda с тем же
 * начертанием: имя семейства или имя файлов `@font-face` (`Montserrat-SemiBold.woff` → Montserrat)
 * совпадает с именем пресета без учёта регистра и пробелов. Семейство референса в настройках блоков
 * (`*_typo.fontfamily`) заменяется именем пресета — `fontAliases`.
 *
 * Чистые функции без сети; только регулярные выражения над текстом CSS.
 */
import { createLogger } from './log.mjs';
import { normalizeHex } from './reference-styles.mjs';
import { messageText, msg } from './i18n.mjs';

const log = createLogger('project-style');

/** Ключи настроек проекта, которые пишет оформление (итог пробы 4). */
export const PROJECT_STYLE_KEYS = ['headlinefont', 'headlinefontweight', 'headlinecolor', 'textfont', 'textfontweight', 'textfontsize', 'textcolor', 'linkcolor', 'linkfontweight', 'linklinecolor', 'linklineheight', 'bgcolor'];

/**
 * Причины, по которым настройка не определена: имя → ключ словаря. Подстановки: `noOption` {key, want},
 * `noPreset` {family}, `presetUnchecked` {name}. Запись `undecided` несёт `code` (имя причины),
 * `params` и английский `reason` — его пишут в файл; `Message` для итога даёт `projectReasonMessage`.
 */
export const PROJECT_REASONS = {
  noCss: 'projectStyle.reason.noCss',
  noOption: 'projectStyle.reason.noOption',
  fontsNotTransferred: 'projectStyle.reason.fontsNotTransferred',
  noPreset: 'projectStyle.reason.noPreset',
  absentHeadline: 'projectStyle.reason.absentHeadline',
  absentText: 'projectStyle.reason.absentText',
  absentLink: 'projectStyle.reason.absentLink',
  presetUnchecked: 'projectStyle.reason.presetUnchecked',
};

/** Запись `undecided`: `{ key, code, params, reason }`, `reason` — английский текст причины. */
function undecidedEntry(key, code, params = {}) {
  return { key, code, params, reason: messageText(msg(PROJECT_REASONS[code], params)) };
}

/** Причина записи `undecided` как `Message` — для итога команды. */
export function projectReasonMessage(entry) {
  return msg(PROJECT_REASONS[entry.code], entry.params ?? {});
}

/** Подпись варианта веса в форме настроек → число (`Semibold` → 600). */
const WEIGHT_BY_LABEL = { thin: 100, extralight: 200, light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
export function weightFromLabel(label) {
  return WEIGHT_BY_LABEL[String(label ?? '').replace(/[\s_-]/g, '').toLowerCase()] ?? null;
}

/** Адрес CSS проекта из `<link>` страницы: `…/tilda-blocks-page<id>.min.css[?…]`; нет — null. */
export function projectCssUrl(html) {
  const m = String(html ?? '').match(/<link\b[^>]*href="([^"]*tilda-blocks-page\d+\.min\.css[^"]*)"/i);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

/** CSS без `@media`-блоков (мобильные переопределения не должны перекрыть основные значения). */
function topLevel(css) {
  let out = '';
  let i = 0;
  const s = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  while (i < s.length) {
    const at = s.indexOf('@media', i);
    if (at < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, at);
    const open = s.indexOf('{', at);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === '{') depth += 1;
      else if (s[j] === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out;
}

function declarations(body) {
  const out = {};
  for (const d of String(body).split(';')) {
    const k = d.indexOf(':');
    if (k < 0) continue;
    const prop = d.slice(0, k).trim().toLowerCase();
    const value = d.slice(k + 1).trim().replace(/\s*!important$/i, '');
    if (prop && !(prop in out)) out[prop] = value;
  }
  return out;
}

const firstFamily = (v) => (v ? String(v).split(',')[0].trim().replace(/^['"]|['"]$/g, '') : null);

/**
 * @returns {{ fonts: Array<{family, weight, style, url}>, headline: {family, weight, color}, text: {family, weight, color}, link: {color, weight, lineColor, lineHeight}, undecided: string[] }} — `undecided`: имена причин `absentHeadline`, `absentText`, `absentLink`
 */
export function projectStyleFromCss(css) {
  const rules = [];
  const fonts = [];
  for (const m of topLevel(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decl = declarations(m[2]);
    if (/^@font-face$/i.test(selector)) {
      const url = (String(decl.src ?? '').match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/) || [])[1] ?? null;
      fonts.push({ family: firstFamily(decl['font-family']), weight: decl['font-weight'] ?? null, style: decl['font-style'] ?? null, url });
      continue;
    }
    rules.push({ selectors: selector.split(',').map((x) => x.trim()), decl });
  }
  const merged = (pred) => {
    const out = {};
    for (const r of rules) if (r.selectors.some(pred)) for (const [k, v] of Object.entries(r.decl)) if (!(k in out)) out[k] = v;
    return out;
  };
  const undecided = [];
  const pick = (decl, what) => {
    if (!Object.keys(decl).length) undecided.push(what);
    return { family: firstFamily(decl['font-family']), weight: decl['font-weight'] ?? null, color: normalizeHex(decl.color) };
  };
  const headline = pick(merged((s) => s === '.t-title'), 'absentHeadline');
  let textDecl = merged((s) => s === '.t-descr');
  if (!Object.keys(textDecl).length) textDecl = merged((s) => s === '.t-text');
  const text = pick(textDecl, 'absentText');
  const linkDecl = merged((s) => s === '#allrecords a');
  if (!Object.keys(linkDecl).length) undecided.push('absentLink');
  const line = rules.find((r) => r.selectors.some((s) => / a$/.test(s)) && /^\d+px solid /.test(r.decl['border-bottom'] ?? ''));
  const lineMatch = line ? line.decl['border-bottom'].match(/^(\d+px) solid (.+)$/) : null;
  const link = {
    color: normalizeHex(linkDecl.color),
    weight: linkDecl['font-weight'] ?? null,
    lineColor: lineMatch ? normalizeHex(lineMatch[2]) : null,
    lineHeight: lineMatch ? lineMatch[1] : null,
  };
  log.debug('projectStyleFromCss', 'css parsed', { fonts: fonts.length, rules: rules.length, undecided: undecided.length });
  return { fonts, headline, text, link, undecided };
}

const norm = (s) => String(s ?? '').replace(/[\s_-]/g, '').toLowerCase();

/** Имя семейства по имени файла шрифта: `…/Montserrat-SemiBold.woff` → `Montserrat`. */
export function fontBaseName(url) {
  const file = String(url ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
  const base = file.replace(/\.(woff2?|ttf|otf|eot)$/i, '').split(/[-_]/)[0];
  return base || null;
}

/**
 * Пресет Tilda для семейства: само имя или имя файлов его `@font-face` совпадает с пресетом.
 * @returns {string|null} имя пресета, как оно подписано в форме
 */
export function presetFor(family, fonts, presets) {
  if (!family) return null;
  const candidates = [family, ...fonts.filter((f) => norm(f.family) === norm(family)).map((f) => fontBaseName(f.url))].filter(Boolean);
  for (const c of candidates) {
    const hit = presets.find((p) => norm(p) === norm(c));
    if (hit) return hit;
  }
  return null;
}

/**
 * Желаемые настройки проекта по разбору CSS.
 * @param {object} style  итог `projectStyleFromCss`
 * @param {{ presets?: string[] }} controls  пресеты шрифтов формы настроек
 * @returns {{ values: Record<string,string>, fonts: object[], fontAliases: Record<string,string>, undecided: Array<{key, code, params, reason}> }}
 */
export function desiredProjectSettings(style, controls = {}) {
  // Пресеты неизвестны (разбор без страницы настроек) — берётся имя файлов шрифта, проверит --apply.
  const presets = controls.presets ?? null;
  const values = {};
  const undecided = (style.undecided ?? []).map((code) => undecidedEntry(null, code));
  const fontAliases = {};
  const family = (key, fam) => {
    if (!fam) return;
    const guess = [fam, ...(style.fonts ?? []).filter((f) => norm(f.family) === norm(fam)).map((f) => fontBaseName(f.url))].filter(Boolean).pop();
    const preset = presets ? presetFor(fam, style.fonts ?? [], presets) : guess;
    if (!presets) undecided.push(undecidedEntry(key, 'presetUnchecked', { name: preset }));
    if (!preset) {
      undecided.push(undecidedEntry(key, 'noPreset', { family: fam }));
      return;
    }
    values[key] = preset;
    if (norm(preset) !== norm(fam)) fontAliases[fam] = preset;
  };
  family('headlinefont', style.headline?.family);
  family('textfont', style.text?.family);
  const set = (key, value) => {
    if (value !== null && value !== undefined && value !== '') values[key] = String(value);
  };
  set('headlinefontweight', style.headline?.weight);
  set('headlinecolor', style.headline?.color);
  set('textfontweight', style.text?.weight);
  set('textcolor', style.text?.color);
  set('linkcolor', style.link?.color);
  set('linkfontweight', style.link?.weight);
  set('linklinecolor', style.link?.lineColor);
  set('linklineheight', style.link?.lineHeight);
  if ((style.fonts ?? []).length) undecided.push(undecidedEntry('myfonts_json', 'fontsNotTransferred'));
  log.debug('desiredProjectSettings', 'desired settings', { keys: Object.keys(values), aliases: Object.keys(fontAliases).length, undecided: undecided.length });
  return { values, fonts: style.fonts ?? [], fontAliases, undecided };
}
