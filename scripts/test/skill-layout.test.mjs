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
const LINK_ROOTS = ['skills', 'docs', 'README.md', 'README.ru.md', 'AGENTS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'];

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
        if (/^(?:https?:|mailto:)/.test(target)) continue;
        const path = decodeURI(target.split('#')[0]);
        if (path && !existsSync(join(dirname(file), path))) broken.push(`${rel(file)}:${index + 1}: ${target}`);
      }
    });
  }
  assert.deepEqual(broken, [], `Битые ссылки:\n${broken.join('\n')}`);
});

/** Якоря файла Markdown по заголовкам вне блоков кода, как их строит GitHub (повторы получают -1, -2). */
function anchorsOf(file) {
  const anchors = new Set();
  const seen = new Map();
  let inCode = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const slug = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

test('markdown link anchors exist in their target files', () => {
  const broken = [];
  for (const file of listProductFiles({ roots: LINK_ROOTS, extensions: new Set(['.md']) })) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1];
        if (/^(?:https?:|mailto:)/.test(target) || !target.includes('#')) continue;
        const [path, anchor] = target.split('#');
        const targetFile = path ? join(dirname(file), decodeURI(path)) : file;
        if (extname(targetFile) !== '.md' || !existsSync(targetFile)) continue;
        if (!anchorsOf(targetFile).has(decodeURIComponent(anchor))) broken.push(`${rel(file)}:${index + 1}: ${rel(file)} -> ${target}`);
      }
    });
  }
  assert.deepEqual(broken, [], `Битые якоря:\n${broken.join('\n')}`);
});

test('docs/en and docs/ru hold the same set of files and nothing else', () => {
  const entries = readdirSync(join(ROOT, 'docs')).sort();
  assert.deepEqual(entries, ['en', 'ru']);
  const en = readdirSync(join(ROOT, 'docs', 'en')).sort();
  const ru = readdirSync(join(ROOT, 'docs', 'ru')).sort();
  assert.ok(en.length > 0);
  assert.ok(en.every((name) => extname(name) === '.md'));
  assert.deepEqual(en, ru);
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
