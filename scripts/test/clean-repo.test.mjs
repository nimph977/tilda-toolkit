/**
 * Продукт не ссылается на рабочую среду автора: инструменты, заметки, ID решений,
 * личные пути и адреса. Совпадения собираются все сразу — один прогон даёт весь список.
 * Сами правила — в `content-rules.mjs`, общие с проверкой всей истории.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, listProductFiles, rel } from './product-files.mjs';
import { SELF_CHECKS, emailHits, j, lineHits } from './content-rules.mjs';

/** Окружение для git: переменные `GIT_*` (например, из хука) не должны уводить команду в чужой репозиторий. */
function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

/**
 * Содержимое файла из корня репозитория: сначала с диска; а если файла нет и git пометил его
 * skip-worktree (`S` в `git ls-files -v`), то из индекса. Файл мог быть снят с диска локальной
 * настройкой, при этом он остаётся в индексе. Порядок «сначала диск» нарочный: настоящее удаление
 * (без пометки) не берётся из индекса и по-прежнему падает с ENOENT.
 */
function readTracked(root, name) {
  const file = join(root, name);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-v', '--', name], { encoding: 'utf8', env: gitEnv() });
  if (listed.status === 0 && /^[Ss] /.test(listed.stdout)) {
    const blob = spawnSync('git', ['-C', root, 'cat-file', '-p', `:${name}`], { encoding: 'utf8', env: gitEnv() });
    if (blob.status === 0) return blob.stdout;
  }
  return readFileSync(file, 'utf8');
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

test('CLAUDE.md points the agent to AGENTS.md', () => {
  assert.equal(readTracked(ROOT, 'CLAUDE.md'), '@AGENTS.md\n');
});

/** Временный репозиторий с `CLAUDE.md` в индексе; удаляется после `fn`. */
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-read-tracked-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv() });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  try {
    git('init', '-q');
    writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    git('add', 'CLAUDE.md');
    return fn(dir, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readTracked: the file on disk wins over the index', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'changed\n');
    assert.equal(readTracked(dir, 'CLAUDE.md'), 'changed\n');
  });
});

test('readTracked: a file removed from disk and marked skip-worktree is read from the index', () => {
  withRepo((dir, git) => {
    git('update-index', '--skip-worktree', 'CLAUDE.md');
    rmSync(join(dir, 'CLAUDE.md'));
    assert.equal(readTracked(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  });
});

test('readTracked: a file really deleted (no skip-worktree mark) is not taken from the index', () => {
  withRepo((dir) => {
    rmSync(join(dir, 'CLAUDE.md'));
    assert.throws(() => readTracked(dir, 'CLAUDE.md'), { code: 'ENOENT' });
  });
});

test('readTracked: a file missing everywhere fails with ENOENT', () => {
  withRepo((dir) => {
    assert.throws(() => readTracked(dir, 'ABSENT.md'), { code: 'ENOENT' });
  });
});

test('public files required by the license and agent instructions exist', () => {
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
