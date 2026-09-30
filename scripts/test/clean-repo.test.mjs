/**
 * Продукт не ссылается на рабочую среду автора: инструменты, заметки, ID решений,
 * личные пути и адреса. Совпадения собираются все сразу — один прогон даёт весь список.
 * Сами правила — в `content-rules.mjs`, общие с проверкой всей истории.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listProductFiles, rel } from './product-files.mjs';
import { SELF_CHECKS, emailHits, j, lineHits } from './content-rules.mjs';

function scan() {
  const hits = [];
  const files = listProductFiles().filter((path) => !SELF_CHECKS.has(rel(path)));
  for (const path of files) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const name of lineHits(line)) {
        hits.push(`${rel(path)}:${index + 1}: ${name}: ${line.trim().slice(0, 100)}`);
      }
      for (const address of emailHits(line)) {
        hits.push(`${rel(path)}:${index + 1}: email: ${address}`);
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
  const required = [
    'AGENTS.md', 'README.md', 'README.ru.md', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md',
    '.github/workflows/ci.yml', '.github/pull_request_template.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml',
  ];
  for (const path of required) {
    assert.ok(existsSync(join(ROOT, path)), `missing ${path}`);
  }
});
