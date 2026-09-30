/**
 * Разбор опубликованного HTML страницы Tilda на записи (блоки).
 *
 * Источник данных — HTML-файл на диске: страница референса, снятая командой
 * `reference fetch` в `TILDA_REFERENCE_DIR`, или любой сохранённый HTML.
 * Опубликованный HTML не содержит скрытых блоков и скрытых элементов Zero Block,
 * поэтому по нему нельзя судить о полном составе страницы.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from './log.mjs';

const log = createLogger('html-blocks');

/** Тип записи Zero Block в атрибуте data-record-type. */
export const ZERO_TYPE = '396';

/**
 * Режет HTML на записи по маркеру `<div id="rec…">`.
 * @param {string} html
 * @returns {{order: number, recid: string, type: string, chunk: string}[]}
 */
export function splitRecords(html) {
  const parts = html.split(/(?=<div\s+id=["']rec\d+)/);
  const blocks = [];
  for (const chunk of parts) {
    const idm = chunk.match(/^<div\s+id=["']rec(\d+)/);
    if (!idm) continue;
    const typeMatch = chunk.match(/data-record-type=["'](\d+)/);
    if (!typeMatch) log.warn('splitRecords', 'record without data-record-type', { recid: idm[1] });
    blocks.push({ order: blocks.length + 1, recid: idm[1], type: typeMatch ? typeMatch[1] : '?', chunk });
  }
  log.debug('splitRecords', 'records split', { htmlBytes: html.length, records: blocks.length });
  return blocks;
}

/** Число записей каждого типа, по убыванию. */
export function countByType(blocks) {
  const byType = {};
  for (const b of blocks) byType[b.type] = (byType[b.type] || 0) + 1;
  return Object.entries(byType).sort((a, b) => b[1] - a[1]);
}

/** Сущности, видимые в тексте поля: общая часть `cleanText` и `liteHtml`. */
function decodeVisible(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&');
}

/** Убирает разметку и сущности, оставляя видимый текст. */
export function cleanText(s) {
  return decodeVisible(
    s
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Видимый текст с переносами строк как `<br>`: для текстовых полей блока, которые Tilda хранит
 * как HTML. Прочая разметка (жирный, span со стилями) убирается — она относится к редактору
 * текста, а не к полю. Переводы строк самой разметки схлопываются в пробел до разбора тегов,
 * иначе форматирование исходного HTML давало бы переносы, которых в тексте нет.
 *
 * [FIX] `opts.link(attrs)` сохраняет ссылки внутри текста: функция получает строку атрибутов
 * `<a …>` и возвращает готовый открывающий тег или null (ссылка убирается, текст остаётся).
 * Без опции ссылки убираются, как раньше.
 *
 * [FIX] `opts.format` сохраняет оформление текста из редактора по белому списку (решение владельца
 * 2026-09-23): `<strong>`, `<b>`, `<em>`, `<i>`, `<u>` без атрибутов; `<span style>` и обёртку
 * `<div data-customstyle="yes" style>` — только со свойствами `safeInlineStyle`. Остальные теги и
 * атрибуты убираются, как раньше (снятый тег — пробел, закрытый блочный — перенос).
 * Сохраняемые теги на время разбора заменяются маркерами из области частного использования
 * Unicode — их не трогают ни разбор тегов, ни схлопывание пробелов.
 */
const TOKEN_OPEN = '';
const TOKEN_MID = '';
const TOKEN = `${TOKEN_OPEN}\\d+${TOKEN_MID}`;
const TOKEN_RE = new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_MID}`, 'g');
const LEADING_TOKENS_RE = new RegExp(`^(?:${TOKEN}|\\s)+`);
const TRAILING_TOKENS_RE = new RegExp(`(?:${TOKEN}|\\s)+$`);
const EDGE_NEWLINES_RE = new RegExp(`^((?:${TOKEN})+)\\n+|\\n+((?:${TOKEN})+)$`, 'g');

const FORMAT_TAGS = new Set(['strong', 'b', 'em', 'i', 'u']);
const NUMBER_RE = /^\d+(\.\d+)?(px)?$/;
/** Разрешённые свойства встроенного стиля и допустимые значения. */
const STYLE_RULES = {
  'font-size': NUMBER_RE,
  'line-height': NUMBER_RE,
  'letter-spacing': /^-?\d+(\.\d+)?(px)?$/,
  'font-weight': /^(\d{3}|bold|normal)$/i,
  color: /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.,%\s]+\))$/i,
};

/** Значение атрибута из строки атрибутов тега (без разбора сущностей). */
function attrValue(attrString, name) {
  const m = attrString.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/** [FIX] Встроенный стиль только из разрешённых свойств с безопасными значениями; '' — ничего не осталось. */
export function safeInlineStyle(style) {
  const out = [];
  for (const decl of String(style ?? '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).replace(/!important/i, '').trim();
    if (STYLE_RULES[prop]?.test(value)) out.push(`${prop}: ${value};`);
  }
  return out.join(' ');
}

/** Открывающий тег оформления из белого списка или null (тег снимается). */
function formatTag(name, attrString) {
  if (FORMAT_TAGS.has(name)) return `<${name}>`;
  const style = safeInlineStyle(attrValue(attrString, 'style'));
  if (!style) return null;
  if (name === 'span') return `<span style="${style}">`;
  if (name === 'div' && attrValue(attrString, 'data-customstyle') === 'yes') return `<div style="${style}" data-customstyle="yes">`;
  return null;
}

export function liteHtml(s, opts = {}) {
  const kept = [];
  const token = (tag) => {
    kept.push(tag);
    return `${TOKEN_OPEN}${kept.length - 1}${TOKEN_MID}`;
  };
  const withLinks = typeof opts.link === 'function';
  const format = opts.format === true;
  const open = [];
  let source = s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  if (withLinks || format) {
    source = source.replace(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi, (tag, closing, rawName, attrString) => {
      const name = rawName.toLowerCase();
      const handled = (name === 'a' && withLinks) || (format && (FORMAT_TAGS.has(name) || name === 'span' || name === 'div'));
      if (!handled) return tag;
      if (closing) {
        for (let k = open.length - 1; k >= 0; k -= 1) {
          if (open[k].name !== name) continue;
          const [entry] = open.splice(k, 1);
          return entry.kept ? token(`</${name}>`) : tag;
        }
        return tag;
      }
      if (/\/\s*$/.test(attrString)) return tag;
      const kepts = name === 'a' ? opts.link(attrString) : formatTag(name, attrString);
      open.push({ name, kept: Boolean(kepts) });
      return kepts ? token(kepts) : tag;
    });
  }
  const withBreaks = source
    .replace(/\r?\n/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeVisible(withBreaks)
    .split('\n')
    .map((line) => line
      .replace(/[^\S\n]+/g, ' ')
      .trim()
      // Пробел между краем строки и сохранённым тегом незначим: `<div …> Раз` → `<div …>Раз`.
      .replace(LEADING_TOKENS_RE, (m) => m.replace(/\s+/g, ''))
      .replace(TRAILING_TOKENS_RE, (m) => m.replace(/\s+/g, '')));
  const html = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    // Строка из одних сохранённых тегов у края (закрывающий `</div>` после переноса) — не перенос.
    .replace(EDGE_NEWLINES_RE, (_, lead, tail) => lead ?? tail)
    .replace(/\n/g, '<br>');
  if (!kept.length) return html;
  // Тег без закрывающего в исходнике закрывается в конце текста — поле не получит незакрытый
  // `<a>`/`<strong>`, который растянулся бы на соседние блоки.
  const unclosed = open.filter((e) => e.kept).reverse().map((e) => `</${e.name}>`).join('');
  log.debug('liteHtml', '[FIX] text markup kept', { tags: kept.length, links: withLinks, format, unclosed: unclosed.length > 0 });
  return html.replace(TOKEN_RE, (_, i) => kept[Number(i)]) + unclosed;
}

/**
 * Сводка по одному Zero Block из опубликованной разметки.
 * @param {{recid: string, chunk: string}} block
 */
export function zeroSummary(block) {
  const { chunk } = block;
  const elemIds = [...new Set([...chunk.matchAll(/data-elem-id=["'](\d+)["']/g)].map((m) => m[1]))];
  const typeCounts = {};
  for (const m of chunk.matchAll(/data-elem-type=["']([a-z]+)["']/g)) typeCounts[m[1]] = (typeCounts[m[1]] || 0) + 1;
  const height = (chunk.match(/data-artboard-height=["']([^"']+)/) || [])[1] || '?';
  const zMax = Math.max(0, ...[...chunk.matchAll(/z-index:\s*(\d+)/g)].map((m) => +m[1]));
  const hasForm = /data-elem-type=["']form["']/.test(chunk);
  const summary = { recid: block.recid, elemIds, typeCounts, height, zMax, hasForm, text: cleanText(chunk) };
  log.debug('zeroSummary', 'block summary', { recid: block.recid, elems: elemIds.length, height, hasForm });
  return summary;
}

/**
 * Разбирает аргументы командной строки отчётов: `[путь-к-html]`.
 * Без аргументов — ошибка, код выхода 2.
 */
export function resolveHtmlArg(argv) {
  const arg = argv[2];
  if (!arg) {
    log.error('resolveHtmlArg', 'HTML file path required', { usage: 'node <script> <path.html>' });
    process.exit(2);
  }
  const path = resolve(arg);
  log.debug('resolveHtmlArg', 'file selected', { path });
  return path;
}

/** Читает HTML; при отсутствии файла завершает процесс с кодом 2. */
export function readHtml(path) {
  try {
    const html = readFileSync(path, 'utf8');
    log.debug('readHtml', 'file read', { path, bytes: html.length });
    return html;
  } catch (err) {
    log.error('readHtml', 'file not found or unreadable', { path, error: err.message });
    process.exit(2);
  }
}
