/**
 * Продукт не ссылается на рабочую среду автора: инструменты, заметки, ID решений,
 * личные пути и адреса. Совпадения собираются все сразу — один прогон даёт весь список.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listProductFiles, rel } from './product-files.mjs';

const j = (...parts) => parts.join('');
const RULES = [
  ['toolchain', new RegExp(j('ai', '-fac', 'tory', '|', 'AI', ' Fac', 'tory'), 'i')],
  ['toolchain-command', new RegExp(j('(^|[^a-z0-9])', 'ai', 'f-[a-z]'), 'i')],
  ['agent-dirs', new RegExp(j('\\.', '(cla', 'ude|age', 'nts|co', 'dex)/'), 'i')],
  ['mcp-config', new RegExp(j('\\.', 'mc', 'p\\.json'), 'i')],
  ['work-notes', new RegExp(j('(back', 'log|BU', 'GS|RU', 'LES|ROAD', 'MAP|DESCRIP', 'TION|ARCHI', 'TECTURE)\\.md|known-', 'limits'))],
  ['decision-id', new RegExp(j('\\b(D', 'EC|R', 'EQ|O', 'Q|RI', 'SK|FI', 'ND)-\\d{3}\\b|\\bA', 'DR-\\d{4}\\b'))],
  ['task-ref', new RegExp(j('[Зз]ада', 'ч[аеиуй]?\\s+\\d|\\bTa', 'sk \\d'))],
  ['plan-ref', new RegExp(j('(пла', 'н|бан', 'дл|разве', 'дк)[а-я]*\\s+`?[a-z0-9]+(?:-[a-z0-9]+)+`?'), 'i')],
  ['coauthor', new RegExp(j('co-', 'authored-', 'by'), 'i')],
  ['personal-path', new RegExp(j('\\b[A-Za-z]:[\\\\/](Us', 'ers[\\\\/](?!<you>)|AI_', 'Projects|Cla', 'ude_)|/Us', 'ers/[a-z]|/ho', 'me/[a-z]'))],
];
/**
 * Два пути, куда `setup` ставит копию скилла; остальные упоминания папок агентов остаются находками.
 * Граница `(?![\w-])` не даёт разрешить соседнее имя вроде `tilda-manager-x`.
 */
const ALLOWED_AGENT_PATHS = new RegExp(j('\\.', '(cla', 'ude|age', 'nts)/skills/tilda-manager(?![\\w-])/?'), 'gi');
/** CI сам проверяет отсутствие рабочих файлов и должен их называть. */
const SELF_CHECKS = new Set(['.github/workflows/ci.yml']);

const EMAIL =/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_DOMAIN = /@(?:[A-Za-z0-9-]+\.)*(?:test|invalid|example|example\.(?:com|org|net)|users\.noreply\.github\.com)$/i;

/** Имена правил, сработавших на строке, после вычёркивания разрешённых путей установки скилла. */
function lineHits(line) {
  const checked = line.replace(ALLOWED_AGENT_PATHS, '');
  return RULES.filter(([, re]) => re.test(checked)).map(([name]) => name);
}

function scan() {
  const hits = [];
  const files = listProductFiles().filter((path) => !SELF_CHECKS.has(rel(path)));
  for (const path of files) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const name of lineHits(line)) {
        hits.push(`${rel(path)}:${index + 1}: ${name}: ${line.trim().slice(0, 100)}`);
      }
      for (const match of line.matchAll(EMAIL)) {
        if (!ALLOWED_EMAIL_DOMAIN.test(match[0])) hits.push(`${rel(path)}:${index + 1}: email: ${match[0]}`);
      }
    });
  }
  return { files: files.length, hits };
}

test('product files do not reference the author workspace', (t) => {
  const { files, hits } = scan();
  t.diagnostic(`scanned ${files} files, ${hits.length} hits`);
  assert.deepEqual(hits, [], `workspace references:\n${hits.join('\n')}`);
});

test('only the two skill install paths are allowed among agent folders', () => {
  const at = (path) => lineHits(path).includes('agent-dirs');
  assert.equal(at(j('.cla', 'ude/skills/tilda-manager')), false);
  assert.equal(at(j('.age', 'nts/skills/tilda-manager/')), false);
  assert.equal(at(j('.cla', 'ude/agents/x')), true);
  assert.equal(at(j('.co', 'dex/skills/tilda-manager')), true);
  assert.equal(at(j('.cla', 'ude/skills/tilda-manager-x')), true);
});

test('public files required by the license and agent instructions exist', () => {
  assert.equal(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) 2026 nimph977\n/);
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license, 'MIT');
  for (const path of ['AGENTS.md', 'README.md', 'README.ru.md', 'THIRD_PARTY_NOTICES.md', '.github/workflows/ci.yml']) {
    assert.ok(existsSync(join(ROOT, path)), `missing ${path}`);
  }
});
