#!/usr/bin/env node
/**
 * Проверка всей истории репозитория: в добавленных строках файлов продукта и в метаданных коммитов
 * ищется то же, что тесты ищут в рабочем дереве, — числа формы ID, личные пути, чужие адреса почты,
 * строки соавторства, следы рабочей среды. Правила общие: `scripts/test/content-rules.mjs`.
 *
 *   node .github/scripts/history-scan.mjs
 *
 * Область — опубликуемые ссылки (`--branches --remotes --tags`), без отложенных правок (`refs/stash`).
 * Найденный текст, адреса и числа не печатаются: вывод попадает в журнал CI открытого репозитория.
 *
 * Итог: `history scan: ok (<N> commits)` и код 0; находки — по строке `history scan: FAIL <sha7> ...` в stderr,
 * затем `history scan: FAIL <K> findings` и код 1; неверные аргументы или ошибка git — код 2.
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ROOT } from '../../scripts/test/product-files.mjs';
import { parseLogMeta, parseLogPatch } from '../../scripts/test/content-rules.mjs';

const REFS = ['--branches', '--remotes', '--tags'];
const MAX_BUFFER = 512 * 1024 * 1024;

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Запуск git в корне репозитория; ошибка git — первая строка stderr и код 2. */
function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (result.error || result.status !== 0) {
    const reason = (result.error?.message ?? result.stderr ?? '').trim().split('\n')[0];
    process.stderr.write(`history scan: FAIL git: ${reason}\n`);
    process.exit(2);
  }
  return result.stdout;
}

try {
  parseArgs({ options: {}, strict: true });
} catch (error) {
  usage(error.message);
}

const commits = Number(git(['rev-list', ...REFS, '--count']).trim());
if (!(commits > 0)) {
  process.stderr.write('history scan: FAIL git: no commits found in branches, remotes or tags\n');
  process.exit(2);
}

const patch = git(['log', ...REFS, '--no-color', '--no-renames', '--unified=0', '--format=__COMMIT__%H', '-p']);
const meta = git(['log', ...REFS, '--no-color', '--format=__COMMIT__%H%n%ae%n%ce%n%B']);

const findings = [
  ...parseLogPatch(patch).map((hit) => `${hit.commit.slice(0, 7)} ${hit.path}:${hit.hunkLine} ${hit.rules.join(',')}`),
  ...parseLogMeta(meta).map((hit) => `${hit.commit.slice(0, 7)} ${hit.field} ${hit.rules.join(',')}`),
];

if (findings.length === 0) {
  process.stdout.write(`history scan: ok (${commits} commits)\n`);
} else {
  for (const finding of findings) process.stderr.write(`history scan: FAIL ${finding}\n`);
  process.stderr.write(`history scan: FAIL ${findings.length} findings\n`);
  process.exitCode = 1;
}
