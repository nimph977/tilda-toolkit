/**
 * Настоящие документы: страница «Начало работы» держит контракт пути новичка, а короткий
 * README повторяет тот же блок команд и не заводит свой запрос агенту.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './product-files.mjs';
import { AGENT_MARKERS, PATH_MARKERS, checkAgentPrompt, extractFenced, parsePathCommands } from './docs-path.mjs';

const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const GETTING_STARTED = 'docs/en/getting-started.md';

/** Тело раздела `## <title>` от заголовка до следующего `## `. */
function section(text, title) {
  const lines = text.split('\n');
  const from = lines.indexOf(`## ${title}`);
  assert.notEqual(from, -1, `в README нет раздела «${title}»`);
  const rest = lines.slice(from + 1);
  const next = rest.findIndex((line) => line.startsWith('## '));
  return (next === -1 ? rest : rest.slice(0, next)).join('\n');
}

test('en getting started: path block and agent prompt', () => {
  const text = read(GETTING_STARTED);
  assert.equal(parsePathCommands(extractFenced(text, PATH_MARKERS, 'bash')).length, 5, GETTING_STARTED);
  checkAgentPrompt(extractFenced(text, AGENT_MARKERS, 'text'));
});

test('README quick start repeats the path block', () => {
  const quickStart = section(read('README.md'), 'Quick start');
  const fenced = `<!-- readme:start -->\n${quickStart}\n<!-- readme:end -->`;
  const readmeCommands = parsePathCommands(extractFenced(fenced, { start: '<!-- readme:start -->', end: '<!-- readme:end -->' }, 'bash'));
  const pageCommands = parsePathCommands(extractFenced(read(GETTING_STARTED), PATH_MARKERS, 'bash'));
  assert.deepEqual(readmeCommands, pageCommands, 'README.md, Quick start, and getting-started.md must hold the same commands');
});

test('README has no own agent prompt section', () => {
  assert.ok(!read('README.md').split('\n').includes('## Install with an AI agent'), 'README.md: the prompt lives in getting-started.md');
});
