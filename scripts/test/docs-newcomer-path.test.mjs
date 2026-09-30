/**
 * Настоящие документы: страница «Начало работы» держит контракт пути новичка, а короткий
 * README повторяет тот же блок команд и не заводит свой запрос агенту.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './product-files.mjs';
import { AGENT_MARKERS, PATH_MARKERS, checkAgentPrompt, extractFenced, normalizeForParity, parsePathCommands } from './docs-path.mjs';

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

const RU_GETTING_STARTED = 'docs/ru/getting-started.md';

/** Уровни заголовков `##`/`###` страницы от начала до заголовка «что сказал doctor» включительно. */
function headingLevels(text, stopPrefix) {
  const levels = [];
  for (const line of text.split('\n')) {
    const match = /^(#{2,3}) /.exec(line);
    if (!match) continue;
    levels.push(match[1].length);
    if (line.startsWith(stopPrefix)) return levels;
  }
  assert.fail(`нет заголовка ${stopPrefix}`);
}

test('ru getting started: path block and agent prompt', () => {
  const text = read(RU_GETTING_STARTED);
  assert.equal(parsePathCommands(extractFenced(text, PATH_MARKERS, 'bash')).length, 5, RU_GETTING_STARTED);
  checkAgentPrompt(extractFenced(text, AGENT_MARKERS, 'text'));
});

test('README.ru quick start repeats the ru path block', () => {
  const quickStart = section(read('README.ru.md'), 'Быстрый старт');
  const fenced = `<!-- readme:start -->\n${quickStart}\n<!-- readme:end -->`;
  const readmeCommands = parsePathCommands(extractFenced(fenced, { start: '<!-- readme:start -->', end: '<!-- readme:end -->' }, 'bash'));
  const pageCommands = parsePathCommands(extractFenced(read(RU_GETTING_STARTED), PATH_MARKERS, 'bash'));
  assert.deepEqual(readmeCommands, pageCommands, 'README.ru.md, Быстрый старт, and getting-started.md (ru) must hold the same commands');
});

test('README.ru has no own agent prompt section', () => {
  assert.ok(!read('README.ru.md').split('\n').includes('## Install with an AI agent'), 'README.ru.md: the prompt lives in getting-started.md');
});

test('en and ru path blocks match', () => {
  const en = normalizeForParity(parsePathCommands(extractFenced(read(GETTING_STARTED), PATH_MARKERS, 'bash')));
  const ru = normalizeForParity(parsePathCommands(extractFenced(read(RU_GETTING_STARTED), PATH_MARKERS, 'bash')));
  assert.deepEqual(ru, en, `${RU_GETTING_STARTED} and ${GETTING_STARTED} must hold the same commands`);
});

test('en and ru getting started have the same headings up to the doctor table', () => {
  const en = headingLevels(read(GETTING_STARTED), '### What doctor said');
  const ru = headingLevels(read(RU_GETTING_STARTED), '### Что сказал');
  assert.deepEqual(ru, en, `${RU_GETTING_STARTED} headings differ from ${GETTING_STARTED}`);
});
