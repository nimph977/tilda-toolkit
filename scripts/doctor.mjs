#!/usr/bin/env node
/**
 * Проверка установки: только читает и печатает готовые команды исправления.
 *
 *   node scripts/doctor.mjs [--site <папка сайта>] [--lang en|ru] [--json]
 *   node scripts/tilda.mjs doctor [--site <папка сайта>] [--lang en|ru] [--json]
 *
 * Пункты: node, dependencies, chrome, git, repo-env, site, skill. Статусы: ok, warn, fail, skip.
 * Код выхода: 0 — провалов нет, 1 — есть хотя бы один fail, 2 — ошибка аргументов.
 *
 * Ничего не пишет: ни файлов, ни process.env, ни профиля браузера; не запускает Chrome и не
 * ходит в сеть. Статические импорты — только `node:*` и `./lib/i18n.mjs` (он сам тянет лишь `node:*`)
 * и без API новее Node 16: проверка Node идёт первой и отвечает понятно даже там, где tilda.mjs
 * падает при загрузке. Остальное загружается динамически после успешной проверки Node.
 *
 * Текстовые поля пунктов (`message`, `detail`, `fix`) — `Message` или готовые строки (пути, версии,
 * команды); в `Error` из site/config лежит ключ словаря. Язык выбирает вызывающий: `renderReport`
 * и `formatReport` получают его параметром.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGS, attachMessage, messageText, msg, peekLang, render, renderError, resolveLang, setI18nLogger } from './lib/i18n.mjs';

export const MIN_NODE_MAJOR = 24;
export const CHECK_STATUS = ['ok', 'warn', 'fail', 'skip'];
export const CHECK_IDS = ['node', 'dependencies', 'chrome', 'git', 'repo-env', 'site', 'skill'];

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

/** Ссылки загрузки для систем, которых нет в таблице команд. */
const DOWNLOAD_LINKS = {
  node: 'https://nodejs.org/en/download',
  chrome: 'https://www.google.com/chrome/',
  git: 'https://git-scm.com/downloads',
};

/**
 * Команды установки программ; значения — из таблицы проб плана, других команд не придумывать.
 * Где команды нет, подсказка — `Message` со ссылкой на страницу загрузки.
 */
export const INSTALL_HINTS = {
  node: {
    win32: 'winget install --id OpenJS.NodeJS.LTS -e',
    darwin: 'brew install node',
    linux: msg('doctor.fix.download', { url: DOWNLOAD_LINKS.node }),
  },
  chrome: {
    win32: 'winget install --id Google.Chrome -e',
    darwin: 'brew install --cask google-chrome',
    linux: msg('doctor.fix.download', { url: DOWNLOAD_LINKS.chrome }),
  },
  git: {
    win32: 'winget install --id Git.Git -e',
    darwin: 'xcode-select --install',
    linux: 'sudo apt-get install git',
  },
};

/** Команда установки для системы или, если её нет в таблице, ссылка загрузки (`Message`). */
export function installHint(program, platform) {
  return INSTALL_HINTS[program][platform] ?? msg('doctor.fix.download', { url: DOWNLOAD_LINKS[program] });
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
    return { id, status: 'fail', message: msg('doctor.guard.failed', { reason: error.message }) };
  }
}

export function checkNode({ version = process.versions.node, platform = process.platform } = {}) {
  const major = parseInt(String(version).split('.')[0], 10);
  if (major >= MIN_NODE_MAJOR) {
    return { id: 'node', status: 'ok', message: msg('doctor.node.ok', { min: MIN_NODE_MAJOR }), detail: `v${version}` };
  }
  return {
    id: 'node',
    status: 'fail',
    message: msg('doctor.node.old', { min: MIN_NODE_MAJOR, version }),
    fix: installHint('node', platform),
  };
}

export function checkDependencies({ root = localRoot(), readFile = readText, exists = existsSync } = {}) {
  return guard('dependencies', () => {
    const expected = JSON.parse(readFile(join(root, 'package.json'))).dependencies['playwright-core'];
    const installed = join(root, 'node_modules', 'playwright-core', 'package.json');
    if (!exists(installed)) {
      return { id: 'dependencies', status: 'fail', message: msg('doctor.dependencies.missing'), fix: 'npm ci' };
    }
    const actual = JSON.parse(readFile(installed)).version;
    if (actual !== expected) {
      return {
        id: 'dependencies',
        status: 'fail',
        message: msg('doctor.dependencies.wrongVersion', { actual, expected }),
        fix: 'npm ci',
      };
    }
    return { id: 'dependencies', status: 'ok', message: msg('doctor.dependencies.ok'), detail: actual };
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
    return { id: 'chrome', status: 'fail', message: msg('doctor.chrome.unsupported', { platform }) };
  }
  const found = candidates.find((path) => exists(path));
  if (found) return { id: 'chrome', status: 'ok', message: msg('doctor.chrome.ok'), detail: found };
  return {
    id: 'chrome',
    status: 'fail',
    message: msg('doctor.chrome.missing'),
    detail: msg('doctor.chrome.checked', { paths: candidates.join('; ') }),
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
    return { id: 'git', status: 'ok', message: msg('doctor.git.ok'), detail: String(result.stdout ?? '').trim() };
  }
  return {
    id: 'git',
    status: 'warn',
    message: msg('doctor.git.missing'),
    fix: installHint('git', platform),
  };
}

export function checkRepoEnv({ root = localRoot(), exists = existsSync } = {}) {
  if (exists(join(root, '.env'))) {
    return {
      id: 'repo-env',
      status: 'warn',
      message: msg('doctor.repoEnv.ignored'),
      fix: msg('doctor.repoEnv.fix'),
    };
  }
  return { id: 'repo-env', status: 'ok', message: msg('doctor.repoEnv.absent') };
}

/** Команда `setup` с подставленной папкой сайта и ID проекта (значения — строки или `Message`-заглушки). */
function setupCommand(site, project) {
  return msg('doctor.site.setupCommand', { site, project });
}

/** Подсказка исправления по ключу ошибки выбора папки сайта (тексты ошибок для выбора не разбираются). */
export function siteFixFor(error, target) {
  const key = error && error.key;
  if (key === 'site.notFound' || key === 'site.noEnv') {
    return setupCommand(typeof target === 'string' ? quote(target) : target, msg('doctor.placeholder.projectId'));
  }
  if (key === 'paths.insideRepo') return msg('doctor.site.fixOutsideRepo');
  return msg('doctor.site.fixOneDir');
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
    const named = (typeof flag === 'string' && flag.trim()) || String(envCopy.TILDA_SITE_DIR ?? '').trim();
    const target = named || msg('doctor.placeholder.siteDir');
    let dir;
    try {
      dir = deps.resolveSiteDir({ flag, env: envCopy, cwd, root });
    } catch (error) {
      return { id: 'site', status: 'fail', message: error, fix: siteFixFor(error, target) };
    }
    if (!dir) {
      return {
        id: 'site',
        status: 'skip',
        message: msg('doctor.site.skip'),
        fix: setupCommand(msg('doctor.placeholder.siteDir'), msg('doctor.placeholder.projectId')),
      };
    }

    const envFile = join(dir, '.env');
    let changes;
    try {
      changes = deps.siteEnvChanges({ siteDir: dir, text: read(envFile), env: envCopy });
    } catch (error) {
      return { id: 'site', status: 'fail', message: error, fix: msg('doctor.site.fixEnvFile', { file: envFile }) };
    }
    const merged = { ...envCopy, ...changes.set };

    try {
      deps.getProjectId(merged);
    } catch {
      return {
        id: 'site',
        status: 'fail',
        message: msg('doctor.site.projectInvalid'),
        fix: msg('doctor.site.fixProjectId', { file: envFile }),
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
        message: msg(absent ? 'doctor.site.protectedAbsent' : 'doctor.site.protectedInvalid'),
        fix: msg(absent ? 'doctor.site.fixProtectedAbsent' : 'doctor.site.fixProtectedInvalid', { file: envFile }),
      };
    }
    if (!pages.length) {
      return {
        id: 'site',
        status: 'warn',
        message: msg('doctor.site.protectedEmpty'),
        detail: dir,
        fix: msg('doctor.site.fixProtectedEmpty'),
      };
    }
    return {
      id: 'site',
      status: 'ok',
      message: msg('doctor.site.ok'),
      detail: msg('doctor.site.okDetail', { dir, count: pages.length }),
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
        message: msg('doctor.skill.foreign', { path: odd.path }),
        fix: msg(odd.state === 'link' ? 'doctor.skill.fixLink' : 'doctor.skill.fixMove'),
      };
    }
    const stale = found.find((info) => info.state === 'stale');
    if (stale) {
      return { id: 'skill', status: 'warn', message: msg('doctor.skill.stale', { path: stale.path }), fix: setupFix(stale.agent) };
    }
    const installed = found.filter((info) => info.state === 'current');
    if (!installed.length) {
      return {
        id: 'skill',
        status: 'warn',
        message: msg('doctor.skill.missing'),
        detail: msg('doctor.skill.forCodex', { command: setupFix('codex') }),
        fix: setupFix('claude'),
      };
    }
    return {
      id: 'skill',
      status: 'ok',
      message: msg('doctor.skill.ok'),
      detail: installed.map((info) => info.path).join('; '),
    };
  });
}

/**
 * Собирает отчёт. Параметры кроме `site` нужны тестам: подмены окружения, системы, файлов и запуска.
 * Язык не участвует: пункты хранят `Message`, переводит вызывающий (`renderReport`, `formatReport`).
 *
 * @returns {Promise<{status: 'ok'|'fail', checks: Array<{id: string, status: string, message: any, detail?: any, fix?: any}>}>}
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
    const skipped = CHECK_IDS.slice(1).map((id) => ({ id, status: 'skip', message: msg('doctor.needNode', { min: MIN_NODE_MAJOR }) }));
    return { status: 'fail', checks: [node, ...skipped] };
  }

  let log = { debug() {}, info() {} };
  let deps = null;
  let siteModule = null;
  let skillModule = null;
  let loadError = null;
  try {
    const logModule = await import('./lib/log.mjs');
    log = logModule.createLogger('doctor');
    setI18nLogger(logModule.createLogger('i18n'));
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
  const notLoaded = (id) => ({ id, status: 'fail', message: msg('doctor.notLoaded', { reason: loadError?.message }) });

  log.debug('runDoctor', 'start', { site: site ? 'present' : 'absent', platform });
  const checks = [
    node,
    checkDependencies({ root, readFile, exists }),
    guard('chrome', () => checkChrome({ platform, env, exists })),
    guard('git', () => checkGit({ run, platform })),
    checkRepoEnv({ root, exists }),
    deps ? checkSite({ flag: site, env, cwd, root, read: readFile, deps }) : notLoaded('site'),
    skillModule ? checkSkill({ root, inspect: inspect ?? skillModule.inspectSkill }) : notLoaded('skill'),
  ];
  for (const check of checks) log.debug('runDoctor', 'check', { id: check.id, status: check.status });

  const fails = checks.filter((check) => check.status === 'fail').length;
  const warns = checks.filter((check) => check.status === 'warn').length;
  const status = fails ? 'fail' : 'ok';
  log.info('runDoctor', 'summary', { status, fails, warns });
  return { status, checks };
}

const STATUS_LABEL = { ok: 'ok', warn: 'WARN', fail: 'FAIL', skip: 'skip' };

/** Текстовое поле пункта на языке `lang`: ошибка — по её ключу, `Message` и строки — через `render`. */
function renderField(lang, value) {
  if (value instanceof Error) return renderError(lang, value);
  return render(lang, value);
}

/** Ключ сообщения пункта (для машинного разбора); у готовой строки его нет. */
function fieldKey(value) {
  return value && typeof value === 'object' && typeof value.key === 'string' ? value.key : null;
}

/**
 * Отчёт с переведёнными строками для `--json`: `{ status, checks: [{ id, status, key, message, detail?, fix? }] }`.
 * `key` — ключ словаря сообщения (не зависит от языка), остальное — текст на `lang`.
 */
export function renderReport(report, lang = 'en') {
  return {
    status: report.status,
    checks: report.checks.map((check) => {
      const out = { id: check.id, status: check.status, key: fieldKey(check.message), message: renderField(lang, check.message) };
      if (check.detail !== undefined) out.detail = renderField(lang, check.detail);
      if (check.fix !== undefined) out.fix = renderField(lang, check.fix);
      return out;
    }),
  };
}

/** Текст отчёта: строка на пункт, у пункта с исправлением — вторая строка со стрелкой. */
export function formatReport(report, lang = 'en') {
  const lines = [];
  for (const check of renderReport(report, lang).checks) {
    const detail = check.detail ? ` (${check.detail})` : '';
    lines.push(`${STATUS_LABEL[check.status].padEnd(5)} ${check.id.padEnd(13)} ${check.message}${detail}`);
    if (check.fix) lines.push(`      → ${check.fix}`);
  }
  const fails = report.checks.filter((check) => check.status === 'fail').length;
  lines.push(fails ? render(lang, msg('doctor.summary.fail', { count: fails })) : render(lang, msg('doctor.summary.ok')));
  return lines.join('\n');
}

/** Текст справки самостоятельного запуска на языке `lang`. */
export function usageText(lang = 'en') {
  return render(lang, msg('doctor.usage'));
}

/** Ошибка аргументов самостоятельного запуска → код выхода 2. Принимает строку или `Message`. */
export class DoctorUsageError extends Error {
  constructor(message) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'DoctorUsageError';
    this.code = 'USAGE_ERROR';
    this.exitCode = 2;
  }
}

/** Значение `--lang`: только `en` или `ru` (регистр и пробелы не важны). */
function langArg(value) {
  const lang = String(value).trim().toLowerCase();
  if (!LANGS.includes(lang)) throw new DoctorUsageError(msg('i18n.badFlag', { value }));
  return lang;
}

/** Ручной разбор `--site <папка>`, `--site=<папка>`, `--lang <язык>`, `--lang=<язык>`, `--json`, `--help`/`-h`. */
export function parseDoctorArgs(argv) {
  const result = { site: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--site') {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new DoctorUsageError(msg('doctor.args.siteValue'));
      result.site = argv[i];
    } else if (arg.startsWith('--site=')) {
      result.site = arg.slice('--site='.length);
      if (!result.site) throw new DoctorUsageError(msg('doctor.args.siteValue'));
    } else if (arg === '--lang') {
      i += 1;
      if (i >= argv.length || argv[i].startsWith('--')) throw new DoctorUsageError(msg('doctor.args.langValue'));
      result.lang = langArg(argv[i]);
    } else if (arg.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length);
      if (!value) throw new DoctorUsageError(msg('doctor.args.langValue'));
      result.lang = langArg(value);
    } else {
      throw new DoctorUsageError(msg('doctor.args.unknown', { arg }));
    }
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  let args;
  let lang;
  try {
    args = parseDoctorArgs(argv);
    lang = resolveLang({ flag: args.lang }).lang;
  } catch (error) {
    const errorLang = peekLang(argv);
    process.stderr.write(`${renderError(errorLang, error)}\n${usageText(errorLang)}\n`);
    process.exitCode = error.exitCode ?? 2;
    return;
  }
  if (args.help) {
    console.log(usageText(lang));
    return;
  }
  const report = await runDoctor({ site: args.site });
  console.log(args.json ? JSON.stringify(renderReport(report, lang), null, 2) : formatReport(report, lang));
  process.exitCode = report.status === 'fail' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
