import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { listSourceFiles, scanSource } from './literal-scan.mjs';
import { ROOT } from './product-files.mjs';

const CYRILLIC = /[А-Яа-яЁё]/;
const LOG_CALLEES = new Set(['log.debug', 'log.info', 'log.warn', 'log.error', 'LOG']);

/**
 * Русские литералы, которые остаются в коде: `pattern` — подстанова значения литерала, `why` — причина.
 * Запись без совпадения роняет тест, поэтому список не устаревает.
 */
const ALLOWLIST = [
  { file: 'scripts/project-style.mjs', pattern: 'Шрифты', why: 'Tilda editor UI label' },
  { file: 'scripts/project-style.mjs', pattern: 'Цвета и стили', why: 'Tilda editor UI label' },
  { file: 'scripts/project-style.mjs', pattern: 'Сохранить изменения', why: 'Tilda editor UI label' },
  { file: 'scripts/project-style.mjs', pattern: 'Заголовки:', why: 'Tilda editor UI text parsed from the page' },
  { file: 'scripts/tilda.mjs', pattern: 'Шрифты', why: 'Tilda editor UI label' },
  { file: 'scripts/donor-verify.mjs', pattern: 'Заполняется', why: 'reads reports written before bilingual output' },
  { file: 'scripts/donor-verify.mjs', pattern: 'Вердикт', why: 'reads reports written before bilingual output' },
  { file: 'scripts/page-ops.mjs', pattern: 'шапка', why: 'page titles written into the Tilda project' },
  { file: 'scripts/page-ops.mjs', pattern: 'подвал', why: 'page titles written into the Tilda project' },
];

function collect() {
  const found = [];
  for (const file of listSourceFiles(ROOT)) {
    const name = relative(ROOT, file).split('\\').join('/');
    for (const literal of scanSource(readFileSync(file, 'utf8')).literals) {
      if (CYRILLIC.test(literal.value)) found.push({ file: name, line: literal.line, callee: literal.callee, value: literal.value });
    }
  }
  return found;
}

const allowed = (item) => ALLOWLIST.some((entry) => entry.file === item.file && item.value.includes(entry.pattern));

describe('язык кода', () => {
  const found = collect();

  it('в аргументах журнала нет кириллицы', () => {
    const bad = found.filter((item) => LOG_CALLEES.has(item.callee)).map((item) => `${item.file}:${item.line} ${item.value.slice(0, 60)}`);
    assert.deepEqual(bad, []);
  });

  it('в строковых литералах scripts/ нет кириллицы вне списка исключений', () => {
    const bad = found.filter((item) => !allowed(item)).map((item) => `${item.file}:${item.line} [${item.callee}] ${item.value.slice(0, 60)}`);
    assert.deepEqual(bad, []);
  });

  it('каждая запись списка исключений действует и объяснена', () => {
    assert.ok(ALLOWLIST.length <= 12);
    const stale = ALLOWLIST.filter((entry) => !found.some((item) => item.file === entry.file && item.value.includes(entry.pattern)));
    assert.deepEqual(stale.map((entry) => `${entry.file} ${entry.pattern}`), []);
    assert.ok(ALLOWLIST.every((entry) => entry.why && !/\b(ADR|RISK|DEC)-?\d/.test(entry.why)));
  });
});
