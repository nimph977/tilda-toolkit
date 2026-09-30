import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listProductFiles, rel } from './product-files.mjs';
import { ID_ALLOWLIST, ID_PATTERN } from './content-rules.mjs';

test('source files contain no 7-10 digit numbers that look like real Tilda ids', () => {
  const violations = [];
  for (const file of listProductFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(ID_PATTERN)) {
        if (ID_ALLOWLIST.has(match[0])) continue;
        violations.push(`${rel(file)}:${index + 1}: ${match[0]}`);
      }
    });
  }
  if (violations.length > 0) {
    assert.fail(`Найдены числа, похожие на настоящие ID Tilda:\n${violations.join('\n')}`);
  }
});
