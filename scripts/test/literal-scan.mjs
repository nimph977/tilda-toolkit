/**
 * Помощник тестов: разбор строковых литералов и комментариев JavaScript без зависимостей.
 * Не `*.test.mjs`, поэтому `npm test` его не запускает; его подключают тесты словарей и журнала.
 *
 * Разбор посимвольный: код, строчные и блочные комментарии, строки в одинарных и двойных кавычках,
 * шаблоны с вложенными подстановками, литералы регулярных выражений. Для каждого литерала
 * запоминается имя ближайшего охватывающего вызова (`log.warn`, `t`, `Error`).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORD_BEFORE_REGEX = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await',
]);
const CHARS_BEFORE_REGEX = '(,=:[!&|?{};+-*%<>~^';

function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * @param {string} text исходный текст модуля
 * @returns {{ literals: Array<{ value: string, line: number, kind: 'single'|'double'|'template',
 *   hasSubst: boolean, callee: string }>, comments: Array<{ line: number, text: string }> }}
 */
export function scanSource(text) {
  const literals = [];
  const comments = [];
  const calls = [];
  let pos = 0;
  let line = 1;

  const calleeNow = () => (calls.length ? calls[calls.length - 1] : '');

  function readEscape() {
    const next = text[pos + 1];
    pos += 2;
    switch (next) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case 'x': {
        const code = parseInt(text.slice(pos, pos + 2), 16);
        pos += 2;
        return String.fromCharCode(code);
      }
      case 'u': {
        if (text[pos] === '{') {
          const end = text.indexOf('}', pos);
          const code = parseInt(text.slice(pos + 1, end), 16);
          pos = end + 1;
          return String.fromCodePoint(code);
        }
        const code = parseInt(text.slice(pos, pos + 4), 16);
        pos += 4;
        return String.fromCharCode(code);
      }
      case '\n':
        line += 1;
        return '';
      default:
        return next === undefined ? '' : next;
    }
  }

  function readString(quote) {
    const startLine = line;
    const callee = calleeNow();
    let value = '';
    pos += 1;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '\\') {
        value += readEscape();
        continue;
      }
      if (ch === quote) {
        pos += 1;
        break;
      }
      if (ch === '\n') line += 1;
      value += ch;
      pos += 1;
    }
    literals.push({ value, line: startLine, kind: quote === "'" ? 'single' : 'double', hasSubst: false, callee });
  }

  function readTemplate() {
    const startLine = line;
    const callee = calleeNow();
    let value = '';
    let hasSubst = false;
    pos += 1;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '\\') {
        value += readEscape();
        continue;
      }
      if (ch === '`') {
        pos += 1;
        break;
      }
      if (ch === '$' && text[pos + 1] === '{') {
        hasSubst = true;
        value += '${}';
        pos += 2;
        scanCode(true);
        continue;
      }
      if (ch === '\n') line += 1;
      value += ch;
      pos += 1;
    }
    literals.push({ value, line: startLine, kind: 'template', hasSubst, callee });
  }

  function skipRegex() {
    let inClass = false;
    pos += 1;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === '\n') break;
      if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === '/') {
        pos += 1;
        break;
      }
      pos += 1;
    }
    while (pos < text.length && /[a-z]/i.test(text[pos])) pos += 1;
  }

  function readLineComment() {
    const end = text.indexOf('\n', pos);
    const stop = end === -1 ? text.length : end;
    comments.push({ line, text: text.slice(pos + 2, stop).trim() });
    pos = stop;
  }

  function readBlockComment() {
    const end = text.indexOf('*/', pos + 2);
    const stop = end === -1 ? text.length : end;
    const parts = text.slice(pos + 2, stop).split('\n');
    parts.forEach((part, index) => {
      comments.push({ line: line + index, text: part.replace(/^\s*\*?\s?/, '').trim() });
    });
    line += parts.length - 1;
    pos = end === -1 ? text.length : end + 2;
  }

  /** Код до конца текста или до `}`, закрывающей подстановку шаблона. */
  function scanCode(inSubst) {
    let depth = 0;
    let prev = '';
    let prevWord = '';
    let chain = '';
    let chainOpen = false;
    while (pos < text.length) {
      const ch = text[pos];
      const next = text[pos + 1];
      if (ch === '\n') {
        line += 1;
        pos += 1;
        chainOpen = false;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        pos += 1;
        chainOpen = false;
        continue;
      }
      if (ch === '/' && next === '/') {
        readLineComment();
        continue;
      }
      if (ch === '/' && next === '*') {
        readBlockComment();
        continue;
      }
      if (ch === "'" || ch === '"') {
        readString(ch);
        prev = 'a';
        prevWord = '';
        chain = '';
        chainOpen = false;
        continue;
      }
      if (ch === '`') {
        readTemplate();
        prev = 'a';
        prevWord = '';
        chain = '';
        chainOpen = false;
        continue;
      }
      if (ch === '/') {
        const isRegex = prev === '' || CHARS_BEFORE_REGEX.includes(prev)
          || (prev === 'a' && WORD_BEFORE_REGEX.has(prevWord));
        if (isRegex) {
          skipRegex();
          prev = 'a';
          prevWord = '';
        } else {
          pos += 1;
          prev = '/';
        }
        chain = '';
        chainOpen = false;
        continue;
      }
      if (isIdentChar(ch)) {
        let end = pos;
        while (end < text.length && isIdentChar(text[end])) end += 1;
        const word = text.slice(pos, end);
        chain = chainOpen ? chain + word : word;
        chainOpen = true;
        prev = 'a';
        prevWord = word;
        pos = end;
        continue;
      }
      if (ch === '.') {
        chain = chainOpen || chain === '' ? chain + '.' : '.';
        chainOpen = true;
        prev = '.';
        pos += 1;
        continue;
      }
      if (ch === '(') {
        calls.push(chain);
      } else if (ch === ')') {
        calls.pop();
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        if (inSubst && depth === 0) {
          pos += 1;
          return;
        }
        depth -= 1;
      }
      prev = ch;
      prevWord = '';
      chain = '';
      chainOpen = false;
      pos += 1;
    }
  }

  scanCode(false);
  return { literals, comments };
}

/** Все `*.mjs`/`*.js` в `<root>/scripts/`, кроме `scripts/test/`. */
export function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || (entry.name === 'test' && dir === join(root, 'scripts'))) continue;
        walk(path);
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        out.push(path);
      }
    }
  };
  walk(join(root, 'scripts'));
  return out;
}
