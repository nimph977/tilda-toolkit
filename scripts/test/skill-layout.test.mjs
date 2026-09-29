import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { ROOT, listProductFiles, rel } from './product-files.mjs';

/** Каталог скилла и его справочников. */
const SKILL_DIR = join(ROOT, 'skills', 'tilda-manager');

/** Справочники скилла: каждый обязан быть в `references/` и упомянут в `SKILL.md`. */
const REFERENCES = ['manual-steps.md', 'operations.md', 'plan-schema.md', 'scenarios.md'];

/** Корни с Markdown, где относительные ссылки обязаны вести на существующие файлы. */
const LINK_ROOTS = ['skills', 'docs', 'README.md', 'AGENTS.md'];

/** Старые имена скиллов; собраны из частей, чтобы этот файл сам не попал под поиск. */
const RETIRED_NAME = new RegExp(['tilda', '(?:edit|transfer)'].join('-') + '(?![\\w-])');

/** Ссылка Markdown `](цель)`: цель без пробелов и закрывающей скобки. */
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

/** Внешние ссылки и чистые якоря на диске не проверяются. */
const EXTERNAL_LINK = /^(?:https?:|mailto:|#)/;

test('skills directory holds exactly one skill', () => {
  const dirs = readdirSync(join(ROOT, 'skills'))
    .filter((name) => statSync(join(ROOT, 'skills', name)).isDirectory());
  assert.deepEqual(dirs, ['tilda-manager']);
});

test('skill front matter names the skill', () => {
  const text = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(text.startsWith('---\n'), 'SKILL.md должен начинаться с frontmatter');
  const end = text.indexOf('\n---', 4);
  assert.ok(end > 0, 'frontmatter SKILL.md не закрыт');
  const front = text.slice(4, end);
  assert.match(front, /^name: tilda-manager$/m);
  assert.match(front, /^description: \S.*$/m);
});

test('every reference file is reachable from SKILL.md', () => {
  const files = readdirSync(join(SKILL_DIR, 'references')).filter((name) => extname(name) === '.md');
  assert.deepEqual(files.sort(), [...REFERENCES].sort());
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const missing = REFERENCES.filter((name) => !skill.includes(`references/${name}`));
  assert.deepEqual(missing, [], `SKILL.md не ссылается на: ${missing.join(', ')}`);
});

test('relative markdown links resolve', () => {
  const broken = [];
  for (const file of listProductFiles({ roots: LINK_ROOTS, extensions: new Set(['.md']) })) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1];
        if (EXTERNAL_LINK.test(target)) continue;
        const path = decodeURI(target.split('#')[0]);
        if (!existsSync(join(dirname(file), path))) broken.push(`${rel(file)}:${index + 1}: ${target}`);
      }
    });
  }
  assert.deepEqual(broken, [], `Битые ссылки:\n${broken.join('\n')}`);
});

test('live files do not mention the retired skill names', () => {
  const hits = [];
  for (const file of listProductFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (RETIRED_NAME.test(line)) hits.push(`${rel(file)}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, [], `Старые имена скиллов в живых файлах:\n${hits.join('\n')}`);
});
