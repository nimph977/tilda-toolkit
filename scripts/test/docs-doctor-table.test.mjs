import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './product-files.mjs';

const START = '<!-- doctor-messages:start -->';
const END = '<!-- doctor-messages:end -->';

/** Шаблоны сообщений `doctor` из таблицы между метками: первое содержимое в обратных кавычках первой колонки каждой строки. */
function tableMessages(lang) {
  const file = join(ROOT, 'docs', lang, 'getting-started.md');
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  assert.ok(from >= 0 && to > from, `${file}: нет меток ${START} … ${END}`);
  const rows = text.slice(from + START.length, to).split('\n').filter((line) => line.startsWith('|'));
  const messages = [];
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const match = /`([^`]+)`/.exec(cells[0] ?? '');
    if (match) messages.push({ row, text: match[1] });
  }
  return messages;
}

describe('таблица «что сказал doctor» в документации совпадает со словарями', () => {
  for (const lang of ['en', 'ru']) {
    it(lang, () => {
      const dictionary = JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8'));
      const known = new Set(Object.entries(dictionary).filter(([key]) => key.startsWith('doctor.')).map(([, value]) => value));
      const messages = tableMessages(lang);
      assert.ok(messages.length >= 5, `${lang}: в таблице слишком мало сообщений`);
      const unknown = messages.filter((item) => !known.has(item.text)).map((item) => `${lang}: ${item.text}`);
      assert.deepEqual(unknown, []);
    });
  }
});
