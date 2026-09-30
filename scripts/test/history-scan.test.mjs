/**
 * Чистые функции сканера истории: отбор путей продукта, правила для строки и разбор вывода git.
 * Данные синтетические; всё, что попадает под правила содержимого, собирается из частей через `j()`,
 * чтобы сам файл теста не стал находкой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProductPath } from './product-files.mjs';
import { GITHUB_NOREPLY, j, parseLogMeta, parseLogPatch, scanLine } from './content-rules.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ID8 = j('1234', '5678');
const COAUTHOR = j('Co-', 'Authored-', 'By: Name');
const PERSONAL = j('C:', '\\Us', 'ers\\name');
const FOREIGN = j('name@', 'gmail', '.com');

/** Раздел патча для одного файла: заголовок, заголовок блока и добавленные строки. */
function fileDiff(path, hunk, ...added) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, hunk, ...added].join('\n');
}

test('isProductPath selects product files by path segments', () => {
  assert.equal(isProductPath('scripts/a.mjs'), true);
  assert.equal(isProductPath('README.md'), true);
  assert.equal(isProductPath('scripts-old/a.mjs'), false);
  assert.equal(isProductPath('docsx/a.md'), false);
  assert.equal(isProductPath('docs/en/a.png'), false);
  assert.equal(isProductPath('node_modules/x/a.js'), false);
  assert.equal(isProductPath('scripts/plans/a.json'), false);
  assert.equal(isProductPath('package-lock.json'), false);
});

test('scanLine names the rules and never the found text', () => {
  assert.deepEqual(scanLine(COAUTHOR), ['coauthor']);
  assert.deepEqual(scanLine(`path ${PERSONAL}`), ['personal-path']);
  assert.deepEqual(scanLine('from a@users.noreply.github.com'), []);
  assert.deepEqual(scanLine('from a@example.com'), []);
  assert.deepEqual(scanLine(`from ${FOREIGN}`), ['email']);
  assert.deepEqual(scanLine('z-index: 2147483647'), []);
  assert.deepEqual(scanLine(`id ${ID8}`), ['id']);
  assert.deepEqual(scanLine(j('.cla', 'ude/skills/tilda-manager/')), []);
  assert.deepEqual(scanLine(j('.cla', 'ude/skills/tilda-manager-x/')), ['agent-dirs']);
});

test('parseLogPatch counts lines of the new file and skips what is not scanned', () => {
  const added = [`+const ok = 1;`, `+const id = ${ID8};`];
  const text = [
    `__COMMIT__${A}`,
    '',
    fileDiff('scripts/a.mjs', '@@ -0,0 +5,2 @@', ...added),
    fileDiff('.github/workflows/ci.yml', '@@ -0,0 +1,2 @@', ...added),
    fileDiff('package-lock.json', '@@ -0,0 +1,2 @@', ...added),
    fileDiff('docs/en/a.md', '@@ -3,1 +3,0 @@', `-const id = ${ID8};`),
    'diff --git a/docs/en/a.png b/docs/en/a.png',
    'Binary files a/docs/en/a.png and b/docs/en/a.png differ',
    '',
  ].join('\n');
  assert.deepEqual(parseLogPatch(text), [{ commit: A, path: 'scripts/a.mjs', hunkLine: 6, rules: ['id'] }]);
});

test('parseLogPatch does not take the file header for an added line', () => {
  const text = [`__COMMIT__${A}`, 'diff --git a/scripts/a.mjs b/scripts/a.mjs', `+++ b/scripts/${ID8}.mjs`, ''].join('\n');
  assert.deepEqual(parseLogPatch(text), []);
});

test('parseLogPatch attributes each finding to its own commit', () => {
  const text = [
    `__COMMIT__${A}`,
    fileDiff('scripts/a.mjs', '@@ -0,0 +1 @@', '+const ok = 1;'),
    `__COMMIT__${B}`,
    fileDiff('README.md', '@@ -1 +1,2 @@', '+line', `+${COAUTHOR}`),
  ].join('\n');
  assert.deepEqual(parseLogPatch(text), [{ commit: B, path: 'README.md', hunkLine: 2, rules: ['coauthor'] }]);
});

test('parseLogMeta flags foreign addresses and messages with rule hits', () => {
  const meta = (author, committer, message) => [`__COMMIT__${A}`, author, committer, message, ''].join('\n');
  const clean = meta('n@users.noreply.github.com', GITHUB_NOREPLY, 'docs: fix a typo');
  assert.deepEqual(parseLogMeta(clean), []);
  assert.deepEqual(parseLogMeta(meta(FOREIGN, 'n@users.noreply.github.com', 'fix')), [{ commit: A, field: 'author', rules: ['email'] }]);
  assert.deepEqual(parseLogMeta(meta('n@users.noreply.github.com', FOREIGN, 'fix')), [{ commit: A, field: 'committer', rules: ['email'] }]);
  assert.deepEqual(parseLogMeta(meta('n@users.noreply.github.com', GITHUB_NOREPLY, `fix\n\n${COAUTHOR}`)), [
    { commit: A, field: 'message', rules: ['coauthor'] },
  ]);
  assert.deepEqual(parseLogMeta(meta('n@users.noreply.github.com', GITHUB_NOREPLY, '')), []);
});
