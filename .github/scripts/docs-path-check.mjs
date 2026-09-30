#!/usr/bin/env node
/**
 * Проверка пути новичка по странице «Начало работы»: блок команд из документа выполняется в bash
 * в свежем клоне, и коды выхода и итоговые строки `setup` и `doctor` сверяются с ожидаемыми.
 *
 *   EXPECT_CHROME=present|absent node .github/scripts/docs-path-check.mjs [--doc <путь>] [--lang en|ru]
 *   node .github/scripts/docs-path-check.mjs --static [--doc <путь>] [--lang en|ru]
 *   DOCS_CHECK_BASH=<путь к bash>   # необязательно, вместо поиска
 *
 * `--doc` — страница; по умолчанию `docs/en/getting-started.md`, относительный путь считается от текущей
 * папки. `--lang` — язык ожидаемых строк; по умолчанию из пути `docs/<язык>/`, иначе `en`. `--static` — только
 * разбор документа, без прогона. `present` — Google Chrome в системе есть, `absent` — нет (чистый контейнер).
 *
 * Подставляются только адрес клона (на локальный корень репозитория) и заглушка ID проекта
 * (на синтетический ID): остальное выполняется как написано, это и проверяет «команды копируются без правки».
 * Клон берётся из локального репозитория, поэтому в прогон попадает закоммиченный код; документ читается с диска.
 * Из настоящей домашней папки берутся только глобальный конфиг git и папка кэша npm.
 *
 * Итог: `docs path check: ok` и код 0; провал — `docs path check: FAIL <шаг>: <причина>` в stderr и код 1;
 * неверные аргументы или EXPECT_CHROME — код 2.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AGENT_MARKERS,
  PATH_MARKERS,
  SITE_EXAMPLE,
  SYNTHETIC_PROJECT,
  DocPathError,
  buildRunScript,
  checkAgentPrompt,
  extractFenced,
  parsePathCommands,
  parseRunCodes,
} from '../../scripts/test/docs-path.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_TIMEOUT_MS = 600000;

class CheckFailure extends Error {
  constructor(name, reason) {
    super(reason);
    this.step = name;
  }
}

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function readArguments() {
  let values;
  try {
    ({ values } = parseArgs({
      options: { doc: { type: 'string' }, lang: { type: 'string' }, static: { type: 'boolean', default: false } },
      strict: true,
    }));
  } catch (error) {
    usage(error.message);
  }
  const doc = resolve(values.doc ?? join(root, 'docs', 'en', 'getting-started.md'));
  const fromPath = /[\\/]docs[\\/](en|ru)[\\/]/.exec(doc)?.[1];
  const lang = values.lang ?? fromPath ?? 'en';
  if (lang !== 'en' && lang !== 'ru') usage('--lang: en или ru');
  if (!existsSync(doc)) usage(`--doc: файла нет: ${doc}`);
  return { doc, lang, staticOnly: values.static };
}

/** Разбор документа: пять команд пути и запрос агенту. */
function checkStatic(doc) {
  process.stdout.write('== static\n');
  const text = readFileSync(doc, 'utf8');
  try {
    const commands = parsePathCommands(extractFenced(text, PATH_MARKERS, 'bash'));
    checkAgentPrompt(extractFenced(text, AGENT_MARKERS, 'text'));
    return commands;
  } catch (error) {
    if (!(error instanceof DocPathError)) throw error;
    throw new CheckFailure('static', `${error.code}: ${error.message}`);
  }
}

/** Git Bash на Windows ищется от `git --exec-path`: `bash` из PATH там может быть WSL. */
function findBash() {
  if (process.env.DOCS_CHECK_BASH) return process.env.DOCS_CHECK_BASH;
  if (process.platform !== 'win32') return 'bash';
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (git.error || git.status !== 0) throw new CheckFailure('bash', 'git --exec-path не сработал: Git Bash не найти');
  const bash = join(resolve(git.stdout.trim(), '..', '..', '..'), 'bin', 'bash.exe');
  if (!existsSync(bash)) throw new CheckFailure('bash', `Git Bash не найден (${bash})`);
  return bash;
}

/** Окружение прогона: без TILDA_*, с временным HOME и двумя настройками из настоящей домашней папки. */
function runEnvironment(home, lang) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TILDA_')));
  const gitConfig = join(homedir(), '.gitconfig');
  // Строка команды без аргументов: на Windows npm — `npm.cmd`, ему нужна оболочка, а аргументы с `shell` Node не любит.
  const npmCache = spawnSync('npm config get cache', { encoding: 'utf8', shell: true }).stdout?.trim();
  env.HOME = process.platform === 'win32' ? home.replace(/\\/g, '/') : home;
  env.TILDA_LANG = lang;
  if (existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
  if (npmCache) env.npm_config_cache = npmCache;
  return env;
}

function expect(step, condition, reason) {
  if (!condition) throw new CheckFailure(step, reason);
}

function expectCode(codes, step, wanted) {
  const code = codes.get(step);
  expect(step, code !== undefined, 'команда не выполнилась: нет строки с кодом выхода');
  expect(step, code === wanted, `код выхода ${code} вместо ${wanted}`);
}

function runPath(commands, lang, expectChrome) {
  process.stdout.write('== run\n');
  const dictionary = JSON.parse(readFileSync(join(root, 'locales', `${lang}.json`), 'utf8'));
  const bash = findBash();
  const base = mkdtempSync(join(tmpdir(), 'tilda-docs-path-'));
  try {
    const home = join(base, 'home');
    mkdirSync(home);
    const env = runEnvironment(home, lang);
    writeFileSync(join(base, 'run.sh'), buildRunScript(commands, { repoPath: root, project: SYNTHETIC_PROJECT }));
    const result = spawnSync(bash, ['run.sh'], { cwd: base, env, encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
    process.stdout.write(result.stdout ?? '');
    process.stdout.write(result.stderr ?? '');
    if (result.error?.code === 'ETIMEDOUT') throw new CheckFailure('run', `таймаут ${RUN_TIMEOUT_MS / 1000} с`);
    if (result.error) throw new CheckFailure('run', `не удалось запустить: ${result.error.message}`);

    const codes = parseRunCodes(result.stdout ?? '');
    for (const step of ['clone', 'cd', 'npm', 'setup']) expectCode(codes, step, 0);
    expect('setup', result.stdout.includes(`status: ${dictionary['setup.status.done']}`), 'в выводе нет строки status: done');
    expectCode(codes, 'doctor', expectChrome === 'present' ? 0 : 1);
    if (expectChrome === 'present') {
      expect('doctor', result.stdout.includes(dictionary['doctor.summary.ok']), `в выводе нет строки «${dictionary['doctor.summary.ok']}»`);
    } else {
      expect('doctor', /^FAIL\s+chrome\b/m.test(result.stdout), 'в выводе нет строки FAIL про chrome');
    }
    const envFile = join(home, ...SITE_EXAMPLE.replace(/^~\//, '').split('/'), '.env');
    expect('setup', existsSync(envFile), 'setup не создал .env в папке сайта');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const { doc, lang, staticOnly } = readArguments();
const expectChrome = process.env.EXPECT_CHROME;
if (!staticOnly && expectChrome !== 'present' && expectChrome !== 'absent') usage('EXPECT_CHROME: present или absent');

try {
  const commands = checkStatic(doc);
  if (staticOnly) {
    process.stdout.write('docs path check: ok (static)\n');
  } else {
    runPath(commands, lang, expectChrome);
    process.stdout.write('docs path check: ok\n');
  }
} catch (error) {
  if (!(error instanceof CheckFailure)) throw error;
  process.stderr.write(`docs path check: FAIL ${error.step}: ${error.message}\n`);
  process.exitCode = 1;
}
