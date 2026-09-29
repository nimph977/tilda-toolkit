#!/usr/bin/env node
/**
 * Проверка установки: только читает и печатает готовые команды исправления.
 *
 *   node scripts/doctor.mjs [--site <папка сайта>] [--json]
 *   node scripts/tilda.mjs doctor [--site <папка сайта>] [--json]
 *
 * Пункты: node, dependencies, chrome, git, repo-env, site, skill. Статусы: ok, warn, fail, skip.
 * Код выхода: 0 — провалов нет, 1 — есть хотя бы один fail, 2 — ошибка аргументов.
 *
 * Ничего не пишет: ни файлов, ни process.env, ни профиля браузера; не запускает Chrome и не
 * ходит в сеть. Статические импорты — только `node:*` и без API новее Node 16: проверка Node
 * идёт первой и отвечает понятно даже там, где tilda.mjs падает при загрузке. Остальное
 * загружается динамически после успешной проверки Node.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_NODE_MAJOR = 24;
export const CHECK_STATUS = ['ok', 'warn', 'fail', 'skip'];
export const CHECK_IDS = ['node', 'dependencies', 'chrome', 'git', 'repo-env', 'site', 'skill'];

const USAGE = 'Использование: node scripts/doctor.mjs [--site <папка сайта>] [--json]';

/**
 * Пути Google Chrome — те же, что у канала chrome в Playwright 1.63.0
 * (playwright-core/lib/coreBundle.js, _createChromiumChannel). При обновлении playwright-core
 * сверить заново.
 */
const CHROME_SUFFIX = {
  linux: '/opt/google/chrome/chrome',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: '\\Google\\Chrome\\Application\\chrome.exe',
};

/** Команды установки программ; значения — из таблицы проб плана, других команд не придумывать. */
export const INSTALL_HINTS = {
  node: {
    win32: 'winget install --id OpenJS.NodeJS.LTS -e',
    darwin: 'brew install node',
    linux: 'скачайте с https://nodejs.org/en/download',
  },
  chrome: {
    win32: 'winget install --id Google.Chrome -e',
    darwin: 'brew install --cask google-chrome',
    linux: 'скачайте с https://www.google.com/chrome/',
  },
  git: {
    win32: 'winget install --id Git.Git -e',
    darwin: 'xcode-select --install',
    linux: 'sudo apt-get install git',
  },
};

/** Ссылки загрузки для систем, которых нет в таблице команд. */
const DOWNLOAD_LINKS = {
  node: 'https://nodejs.org/en/download',
  chrome: 'https://www.google.com/chrome/',
  git: 'https://git-scm.com/downloads',
};

/** Команда установки для системы или, если её нет в таблице, ссылка загрузки. */
export function installHint(program, platform) {
  return INSTALL_HINTS[program][platform] ?? `скачайте с ${DOWNLOAD_LINKS[program]}`;
}

/** Корень репозитория от расположения этого файла (scripts/). */
export function localRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const readText = (path) => readFileSync(path, 'utf8');

/** Значение переменной окружения; в Windows имена не различают регистр. */
function envGet(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Команда с пробелами в пути — в двойных кавычках (единственный уровень кавычек для PowerShell). */
function quote(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Исключение внутри проверки становится провалом этого пункта, а не обрывом отчёта. */
function guard(id, fn) {
  try {
    return fn();
  } catch (error) {
    return { id, status: 'fail', message: `проверка не выполнена: ${error.message}` };
  }
}

export function checkNode({ version = process.versions.node, platform = process.platform } = {}) {
  const major = parseInt(String(version).split('.')[0], 10);
  if (major >= MIN_NODE_MAJOR) {
    return { id: 'node', status: 'ok', message: `Node.js ${MIN_NODE_MAJOR} или новее`, detail: `v${version}` };
  }
  return {
    id: 'node',
    status: 'fail',
    message: `нужен Node.js ${MIN_NODE_MAJOR} или новее, сейчас v${version}`,
    fix: installHint('node', platform),
  };
}

export function checkDependencies({ root = localRoot(), readFile = readText, exists = existsSync } = {}) {
  return guard('dependencies', () => {
    const expected = JSON.parse(readFile(join(root, 'package.json'))).dependencies['playwright-core'];
    const installed = join(root, 'node_modules', 'playwright-core', 'package.json');
    if (!exists(installed)) {
      return { id: 'dependencies', status: 'fail', message: 'зависимости не установлены', fix: 'npm ci' };
    }
    const actual = JSON.parse(readFile(installed)).version;
    if (actual !== expected) {
      return {
        id: 'dependencies',
        status: 'fail',
        message: `playwright-core ${actual} вместо ${expected}`,
        fix: 'npm ci',
      };
    }
    return { id: 'dependencies', status: 'ok', message: 'playwright-core установлен', detail: actual };
  });
}

/** Пути, по которым Playwright ищет Google Chrome, в его порядке; неизвестная система — пусто. */
export function chromeCandidates({ platform = process.platform, env = process.env } = {}) {
  const suffix = CHROME_SUFFIX[platform];
  if (!suffix) return [];
  if (platform !== 'win32') return [suffix];
  const drive = envGet(env, 'HOMEDRIVE');
  const prefixes = [
    envGet(env, 'LOCALAPPDATA'),
    envGet(env, 'PROGRAMFILES'),
    envGet(env, 'PROGRAMFILES(X86)'),
    drive ? `${drive}\\Program Files` : undefined,
    drive ? `${drive}\\Program Files (x86)` : undefined,
  ].filter(Boolean);
  return prefixes.map((prefix) => win32.join(prefix, suffix));
}

export function checkChrome({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const candidates = chromeCandidates({ platform, env });
  if (!candidates.length) {
    return { id: 'chrome', status: 'fail', message: `система ${platform} не поддерживается каналом chrome` };
  }
  const found = candidates.find((path) => exists(path));
  if (found) return { id: 'chrome', status: 'ok', message: 'Google Chrome найден', detail: found };
  return {
    id: 'chrome',
    status: 'fail',
    message: 'Google Chrome не найден',
    detail: `проверено: ${candidates.join('; ')}`,
    fix: installHint('chrome', platform),
  };
}

/** Запуск программы для checkGit: `{ status, stdout, error }`. */
function runProgram(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

/** git нужен только для клонирования и обновления, поэтому выше warn пункт не поднимается. */
export function checkGit({ run = runProgram, platform = process.platform } = {}) {
  const result = run('git', ['--version']);
  if (!result.error && result.status === 0) {
    return { id: 'git', status: 'ok', message: 'git найден', detail: String(result.stdout ?? '').trim() };
  }
  return {
    id: 'git',
    status: 'warn',
    message: 'git не найден — нужен только для git clone и обновления',
    fix: installHint('git', platform),
  };
}

export function checkRepoEnv({ root = localRoot(), exists = existsSync } = {}) {
  if (exists(join(root, '.env'))) {
    return {
      id: 'repo-env',
      status: 'warn',
      message: '.env в корне репозитория не читается',
      fix: 'перенесите его в папку сайта и запускайте с --site <папка>',
    };
  }
  return { id: 'repo-env', status: 'ok', message: 'в корне репозитория нет .env' };
}

const SETUP_FIX = 'node scripts/tilda.mjs setup --site <папка сайта> --project <ID проекта>';

/** Подсказка исправления по тексту ошибки выбора папки сайта. */
function siteFixFor(message, target) {
  if (/не найдена|нет \.env/.test(message)) {
    return `node scripts/tilda.mjs setup --site ${quote(target)} --project <ID проекта>`;
  }
  if (/репозитор/.test(message)) return 'выберите папку сайта вне репозитория';
  return 'укажите одну папку: уберите --site или TILDA_SITE_DIR либо направьте их на одну папку';
}

/**
 * Папка сайта и её `.env`. Работает на копии окружения, `process.env` не меняет. Приоритет файла
 * и окружения — как в `siteEnvChanges` (`deps`), своих правил слияния нет. ID проекта и
 * содержимое `.env` в отчёт не попадают.
 *
 * @param {{flag?: string, env: object, cwd: string, root: string, read?: Function,
 *   deps: {resolveSiteDir: Function, siteEnvChanges: Function, getProjectId: Function, getProtectedPages: Function}}} args
 */
export function checkSite({ flag, env, cwd, root, read = readText, deps }) {
  return guard('site', () => {
    const envCopy = { ...env };
    const target = (typeof flag === 'string' && flag.trim()) || String(envCopy.TILDA_SITE_DIR ?? '').trim() || '<папка сайта>';
    let dir;
    try {
      dir = deps.resolveSiteDir({ flag, env: envCopy, cwd, root });
    } catch (error) {
      return { id: 'site', status: 'fail', message: error.message, fix: siteFixFor(error.message, target) };
    }
    if (!dir) return { id: 'site', status: 'skip', message: 'папка сайта не указана', fix: SETUP_FIX };

    let changes;
    try {
      changes = deps.siteEnvChanges({ siteDir: dir, text: read(join(dir, '.env')), env: envCopy });
    } catch (error) {
      return { id: 'site', status: 'fail', message: error.message, fix: `исправьте ${join(dir, '.env')}` };
    }
    const merged = { ...envCopy, ...changes.set };

    try {
      deps.getProjectId(merged);
    } catch {
      return {
        id: 'site',
        status: 'fail',
        message: 'TILDA_PROJECT_ID не задан или неверен',
        fix: `впишите ID проекта Tilda в ${join(dir, '.env')}`,
      };
    }

    let pages;
    try {
      pages = deps.getProtectedPages(merged);
    } catch {
      const absent = !Object.prototype.hasOwnProperty.call(merged, 'TILDA_PROTECTED_PAGES');
      return {
        id: 'site',
        status: 'fail',
        message: absent
          ? 'TILDA_PROTECTED_PAGES не задан (пустое значение допустимо)'
          : 'TILDA_PROTECTED_PAGES содержит неверное значение',
        fix: absent
          ? `впишите строку TILDA_PROTECTED_PAGES= в ${join(dir, '.env')}`
          : `исправьте TILDA_PROTECTED_PAGES в ${join(dir, '.env')}: ID страниц через запятую`,
      };
    }
    if (!pages.length) {
      return {
        id: 'site',
        status: 'warn',
        message: 'список защиты TILDA_PROTECTED_PAGES пуст',
        detail: dir,
        fix: 'для живого сайта перечислите в нём все страницы',
      };
    }
    return {
      id: 'site',
      status: 'ok',
      message: 'папка сайта и .env в порядке',
      detail: `${dir}; защищённых страниц: ${pages.length}`,
    };
  });
}

const SKILL_AGENTS = ['claude', 'codex'];

/**
 * Копии скилла для Claude Code и Codex. Нет одной из двух — норма; хотя бы одна должна быть
 * актуальной, иначе предупреждение.
 *
 * @param {{root?: string, inspect: Function}} args `inspect` — `inspectSkill` из skill-install.mjs
 */
export function checkSkill({ root = localRoot(), inspect }) {
  return guard('skill', () => {
    const found = SKILL_AGENTS.map((agent) => inspect({ root, agent }));
    const setupFix = (agent) => `node scripts/tilda.mjs setup --agent ${agent}`;
    const odd = found.find((info) => info.state === 'link' || info.state === 'foreign');
    if (odd) {
      return {
        id: 'skill',
        status: 'warn',
        message: `${odd.path} создан не setup`,
        fix: odd.state === 'link'
          ? 'удалите ярлык вручную и повторите setup'
          : 'перенесите папку и повторите setup',
      };
    }
    const stale = found.find((info) => info.state === 'stale');
    if (stale) {
      return { id: 'skill', status: 'warn', message: `копия скилла устарела: ${stale.path}`, fix: setupFix(stale.agent) };
    }
    const installed = found.filter((info) => info.state === 'current');
    if (!installed.length) {
      return {
        id: 'skill',
        status: 'warn',
        message: 'скилл tilda-manager не установлен',
        detail: `для Codex: ${setupFix('codex')}`,
        fix: setupFix('claude'),
      };
    }
    return {
      id: 'skill',
      status: 'ok',
      message: 'скилл tilda-manager установлен',
      detail: installed.map((info) => info.path).join('; '),
    };
  });
}

/**
 * Собирает отчёт. Параметры кроме `site` нужны тестам: подмены окружения, системы, файлов и запуска.
 *
 * @returns {Promise<{status: 'ok'|'fail', checks: Array<{id: string, status: string, message: string, detail?: string, fix?: string}>}>}
 */
export async function runDoctor({
  site,
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  root = localRoot(),
  nodeVersion = process.versions.node,
  exists = existsSync,
  readFile = readText,
  run = runProgram,
  inspect,
} = {}) {
  const node = checkNode({ version: nodeVersion, platform });
  if (node.status === 'fail') {
    const skipped = CHECK_IDS.slice(1).map((id) => ({ id, status: 'skip', message: `нужен Node.js ${MIN_NODE_MAJOR}+` }));
    return { status: 'fail', checks: [node, ...skipped] };
  }

  let log = { debug() {}, info() {} };
  let deps = null;
  let siteModule = null;
  let skillModule = null;
  let loadError = null;
  try {
    log = (await import('./lib/log.mjs')).createLogger('doctor');
    siteModule = await import('./lib/site.mjs');
    const config = await import('./lib/config.mjs');
    skillModule = await import('./lib/skill-install.mjs');
    deps = {
      resolveSiteDir: siteModule.resolveSiteDir,
      siteEnvChanges: siteModule.siteEnvChanges,
      getProjectId: config.getProjectId,
      getProtectedPages: config.getProtectedPages,
    };
  } catch (error) {
    loadError = error;
  }
  const notLoaded = (id) => ({ id, status: 'fail', message: `проверка не выполнена: ${loadError?.message}` });

  log.debug('runDoctor', 'начало', { site: site ? 'есть' : 'нет', platform });
  const checks = [
    node,
    checkDependencies({ root, readFile, exists }),
    guard('chrome', () => checkChrome({ platform, env, exists })),
    guard('git', () => checkGit({ run, platform })),
    checkRepoEnv({ root, exists }),
    deps ? checkSite({ flag: site, env, cwd, root, read: readFile, deps }) : notLoaded('site'),
    skillModule ? checkSkill({ root, inspect: inspect ?? skillModule.inspectSkill }) : notLoaded('skill'),
  ];
  for (const check of checks) log.debug('runDoctor', 'пункт', { id: check.id, status: check.status });

  const fails = checks.filter((check) => check.status === 'fail').length;
  const warns = checks.filter((check) => check.status === 'warn').length;
  const status = fails ? 'fail' : 'ok';
  log.info('runDoctor', 'итог', { status, fails, warns });
  return { status, checks };
}

const STATUS_LABEL = { ok: 'ok', warn: 'WARN', fail: 'FAIL', skip: 'skip' };

/** Текст отчёта: строка на пункт, у пункта с исправлением — вторая строка со стрелкой. */
export function formatReport(report) {
  const lines = [];
  for (const check of report.checks) {
    const detail = check.detail ? ` (${check.detail})` : '';
    lines.push(`${STATUS_LABEL[check.status].padEnd(5)} ${check.id.padEnd(13)} ${check.message}${detail}`);
    if (check.fix) lines.push(`      → ${check.fix}`);
  }
  const fails = report.checks.filter((check) => check.status === 'fail').length;
  lines.push(fails ? `итог: есть провалы (${fails})` : 'итог: ok');
  return lines.join('\n');
}

/** Ошибка аргументов самостоятельного запуска → код выхода 2. */
export class DoctorUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DoctorUsageError';
    this.exitCode = 2;
  }
}

/** Ручной разбор `--site <папка>`, `--site=<папка>`, `--json`, `--help`/`-h`. */
export function parseDoctorArgs(argv) {
  const result = { site: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--site') {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new DoctorUsageError('--site: нужна папка сайта');
      result.site = argv[i];
    } else if (arg.startsWith('--site=')) {
      result.site = arg.slice('--site='.length);
      if (!result.site) throw new DoctorUsageError('--site: нужна папка сайта');
    } else {
      throw new DoctorUsageError(`неизвестный аргумент: ${arg}`);
    }
  }
  return result;
}

async function main() {
  let args;
  try {
    args = parseDoctorArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exitCode = error.exitCode ?? 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const report = await runDoctor({ site: args.site });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = report.status === 'fail' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
