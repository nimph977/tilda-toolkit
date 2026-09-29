#!/usr/bin/env node
/**
 * Проверка установки с нуля на свежем клоне: путь пользователя от `setup` до `doctor`.
 *
 *   EXPECT_CHROME=present|absent node .github/scripts/install-check.mjs
 *
 * `present` — Google Chrome в системе есть (машины GitHub), `absent` — нет (чистый контейнер
 * Linux): пункт `chrome` отчёта `doctor` обязан быть `ok` или `fail` соответственно. Все шаги
 * идут в одном клоне; временная папка сайта лежит в os.tmpdir() и удаляется в конце.
 * Копии скилла в клоне не удаляются: клон одноразовый.
 *
 * Итог: `install check: ok` и код 0; первая провалившаяся проверка — `install check: FAIL <шаг>: <причина>`
 * в stderr и код 1; неверный EXPECT_CHROME — код 2.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'scripts', 'tilda.mjs');

/** Синтетический ID проекта (13 цифр). */
const PROJECT = '1000000000001';

class CheckFailure extends Error {
  constructor(name, reason) {
    super(reason);
    this.step = name;
  }
}

const expectChrome = process.env.EXPECT_CHROME;
if (expectChrome !== 'present' && expectChrome !== 'absent') {
  process.stderr.write('EXPECT_CHROME: present или absent\n');
  process.exit(2);
}

/** Окружение шага без настроек Tilda: пути и сайт берутся только из флагов. */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TILDA_')));

/** Запускает CLI, печатает вывод шага целиком; код не равен ожидаемому — провал. */
function step(name, args, expectCode) {
  process.stdout.write(`== ${name}\n`);
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: cleanEnv, timeout: 60000 });
  process.stdout.write(result.stdout ?? '');
  process.stdout.write(result.stderr ?? '');
  if (result.error) throw new CheckFailure(name, `не удалось запустить: ${result.error.message}`);
  if (result.status !== expectCode) {
    throw new CheckFailure(name, `код выхода ${result.status} вместо ${expectCode}`);
  }
  return result;
}

function json(name, result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new CheckFailure(name, `вывод не разбирается как JSON: ${error.message}`);
  }
}

function expect(name, condition, reason) {
  if (!condition) throw new CheckFailure(name, reason);
}

function run() {
  const base = mkdtempSync(join(tmpdir(), 'tilda-install-'));
  const site = join(base, 'site');
  const skillFiles = ['.claude', '.agents'].map((dir) => join(root, dir, 'skills', 'tilda-manager', 'SKILL.md'));
  const setupArgs = ['setup', '--site', site, '--project', PROJECT, '--agent', 'all', '--json'];
  try {
    const first = json('setup-1', step('setup-1', setupArgs, 0));
    expect('setup-1', first.site?.folder === 'created', `site.folder: ${first.site?.folder}`);
    expect('setup-1', first.site?.env === 'created', `site.env: ${first.site?.env}`);
    // В свежем клоне копии ставятся (`installed`); при повторном запуске в том же клоне они уже есть (`unchanged`).
    const skillActions = ['installed', 'updated', 'unchanged'];
    expect('setup-1', first.skills?.length === 2 && first.skills.every((s) => skillActions.includes(s.action)), 'скилл должен быть установлен для двух агентов');
    expect('setup-1', existsSync(join(site, '.env')), 'нет .env в папке сайта');
    for (const file of skillFiles) expect('setup-1', existsSync(file), `нет ${file}`);

    const second = json('setup-2', step('setup-2', setupArgs, 0));
    expect('setup-2', ['kept', 'unchanged'].includes(second.site?.env), `site.env: ${second.site?.env}`);
    expect('setup-2', second.skills?.every((s) => s.action === 'unchanged'), 'повтор не должен менять копии скилла');

    const inside = join(root, 'site-inside-check');
    step('setup-inside', ['setup', '--site', inside], 2);
    expect('setup-inside', !existsSync(inside), 'папка внутри репозитория не должна создаваться');

    const doctorCode = expectChrome === 'present' ? 0 : 1;
    const report = json('doctor', step('doctor', ['--site', site, 'doctor', '--json'], doctorCode));
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    for (const id of ['node', 'dependencies', 'git', 'repo-env', 'skill']) {
      expect('doctor', byId[id]?.status === 'ok', `${id}: ${byId[id]?.status} ${byId[id]?.message ?? ''}`);
    }
    // Свежий сайт: пустой список защиты даёт предупреждение, всё остальное в пункте site должно быть в порядке.
    const siteCheck = byId.site;
    const siteFine = siteCheck?.status === 'ok' || (siteCheck?.status === 'warn' && /TILDA_PROTECTED_PAGES/.test(siteCheck.message));
    expect('doctor', siteFine, `site: ${siteCheck?.status} ${siteCheck?.message ?? ''}`);
    const chromeWanted = expectChrome === 'present' ? 'ok' : 'fail';
    expect('doctor', byId.chrome?.status === chromeWanted, `chrome: ${byId.chrome?.status} вместо ${chromeWanted}; ${byId.chrome?.detail ?? byId.chrome?.message ?? ''}`);

    step('doctor-text', ['--site', site, 'doctor'], doctorCode);

    process.stdout.write('== git-clean\n');
    const git = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    if (git.error) throw new CheckFailure('git-clean', `git не запустился: ${git.error.message}`);
    expect('git-clean', git.status === 0, `git status: код ${git.status} ${git.stderr ?? ''}`);
    expect('git-clean', git.stdout.trim() === '', `в клоне появились изменения:\n${git.stdout}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

try {
  run();
  process.stdout.write('install check: ok\n');
} catch (error) {
  if (!(error instanceof CheckFailure)) throw error;
  process.stderr.write(`install check: FAIL ${error.step}: ${error.message}\n`);
  process.exitCode = 1;
}
