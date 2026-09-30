/**
 * Выбор папки сайта.
 *
 * Папка сайта лежит вне репозитория продукта и хранит всё, что принадлежит одному сайту:
 * `.env`, `site-baseline/`, `site-reference/`, `.browser-profile/`, `plans/`. Выбирается флагом
 * `--site <папка>` или переменной `TILDA_SITE_DIR`; если заданы оба, они должны указывать на
 * одну папку. Относительный `--site` считается от текущей папки.
 *
 * `.env` сайта читается без перезаписи окружения молча: `TILDA_*`, уже заданная с другим
 * значением, — отказ с именем переменной (значения не выводятся); прочие переменные окружения
 * главнее файла. `TILDA_LANG`, как `LOG_LEVEL`, — настройка процесса: значение окружения главнее
 * файла без отказа. Относительные пути данных в `.env` считаются от папки сайта.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError } from './config.mjs';
import { assertOutsideRepo, isInside, repoRoot } from './paths.mjs';
import { createLogger } from './log.mjs';
import { msg } from './i18n.mjs';

const log = createLogger('site');

/** Переменные-пути: относительное значение в `.env` сайта считается от папки сайта. */
export const SITE_PATH_VARS = [
  'TILDA_BASELINE_DIR',
  'TILDA_REFERENCE_DIR',
  'TILDA_CATALOG_DIR',
  'TILDA_BROWSER_PROFILE',
  'TILDA_DONOR_BROWSER_PROFILE',
];

/** Переменные, определяющие проект и защиту: у выбранного сайта они берутся только из его `.env`. */
export const SITE_IDENTITY_VARS = ['TILDA_PROJECT_ID', 'TILDA_PROTECTED_PAGES', 'TILDA_DONOR_PROJECT_ID'];

/** Переменные процесса, не зависящие от сайта: из окружения допустимы без предупреждения. */
export const SITE_NEUTRAL_VARS = ['TILDA_SITE_DIR', 'TILDA_BROWSER_DAEMON', 'TILDA_BROWSER_VISIBLE', 'TILDA_LANG'];

/** Ключи `.env` сайта, которые применяются: настройки инструмента `TILDA_*` и порог логов. */
export function isSiteVar(key) {
  return key.startsWith('TILDA_') || key === 'LOG_LEVEL';
}

/** Папка сайта из флага или `TILDA_SITE_DIR`; null, если сайт не выбран. Проверяет папку. */
export function resolveSiteDir({
  flag,
  env = process.env,
  cwd = process.cwd(),
  root = repoRoot(),
  exists = existsSync,
  isDir = (p) => statSync(p).isDirectory(),
} = {}) {
  const fromFlag = typeof flag === 'string' && flag.trim() ? resolve(cwd, flag.trim()) : null;
  const fromEnv = env.TILDA_SITE_DIR?.trim() ? resolve(cwd, env.TILDA_SITE_DIR.trim()) : null;
  if (!fromFlag && !fromEnv) return null;
  if (fromFlag && fromEnv && !(isInside(fromFlag, fromEnv) && isInside(fromEnv, fromFlag))) {
    throw new ConfigError(msg('site.dirsDiffer', { flag: fromFlag, env: fromEnv }), 'TILDA_SITE_DIR');
  }
  const dir = fromFlag ?? fromEnv;
  if (!exists(dir) || !isDir(dir)) throw new ConfigError(msg('site.notFound', { dir }), 'TILDA_SITE_DIR');
  assertOutsideRepo(dir, 'TILDA_SITE_DIR', { root });
  if (!exists(join(dir, '.env'))) throw new ConfigError(msg('site.noEnv', { dir }), 'TILDA_SITE_DIR');
  return dir;
}

/**
 * Что `.env` сайта добавляет к окружению. Чистая функция: `set` — переменные к установке,
 * `ignored` — ключи `.env` вне `TILDA_*` и `LOG_LEVEL` (не применяются), `kept` — `LOG_LEVEL` и `TILDA_LANG`,
 * где остаётся значение окружения, `inherited` — прочие `TILDA_*`,
 * заданные только в окружении (предупреждение). `TILDA_PROJECT_ID`, `TILDA_PROTECTED_PAGES` и
 * `TILDA_DONOR_PROJECT_ID` только в окружении — отказ: их значения принадлежат другому сайту.
 */
export function siteEnvChanges({ siteDir, text, env = process.env }) {
  const parsed = parseEnv(text);
  if ('TILDA_SITE_DIR' in parsed) throw new ConfigError(msg('site.dirVarInSiteEnv'), 'TILDA_SITE_DIR');
  const set = {};
  const kept = [];
  const ignored = [];
  const conflicts = [];
  for (const [key, raw] of Object.entries(parsed)) {
    // Процесс и держатель получают только настройки инструмента; `NODE_OPTIONS`, `PATH` и подобное из `.env` не применяются.
    if (!isSiteVar(key)) {
      ignored.push(key);
      continue;
    }
    const value = SITE_PATH_VARS.includes(key) && raw.trim() && !isAbsolute(raw.trim()) ? resolve(siteDir, raw.trim()) : raw;
    if (env[key] === undefined) set[key] = value;
    else if (env[key] === value) continue;
    else if (key.startsWith('TILDA_') && key !== 'TILDA_LANG') conflicts.push(key);
    else kept.push(key);
  }
  if (conflicts.length) {
    throw new ConfigError(msg('site.envConflict', { names: conflicts.join(', ') }), conflicts[0]);
  }
  // TILDA_*, которых нет в .env сайта, но есть в окружении оболочки, могли остаться от другого сайта.
  const orphans = Object.keys(env).filter((k) => k.startsWith('TILDA_') && !(k in parsed) && !SITE_NEUTRAL_VARS.includes(k));
  const identityOrphans = orphans.filter((k) => SITE_IDENTITY_VARS.includes(k));
  if (identityOrphans.length) {
    log.error('siteEnvChanges', '[FIX] site variables are set only in the environment', { names: identityOrphans });
    throw new ConfigError(msg('site.identityOnlyInEnv', { names: identityOrphans.join(', ') }), identityOrphans[0]);
  }
  return { set, kept, inherited: orphans, ignored };
}

/**
 * Выбрать сайт и подгрузить его `.env` в `env`. Сайт не выбран — null (пути только из явных переменных).
 * Иначе `env.TILDA_SITE_DIR` указывает на папку, а переменные `.env` добавлены.
 */
export function applySite({ flag, env = process.env, cwd, root, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const dir = resolveSiteDir({ flag, env, cwd, root });
  if (!dir) {
    log.debug('applySite', 'site folder not selected, paths only from explicit variables');
    return null;
  }
  const { set, kept, inherited, ignored } = siteEnvChanges({ siteDir: dir, text: read(join(dir, '.env')), env });
  Object.assign(env, set);
  env.TILDA_SITE_DIR = dir;
  log.info('applySite', 'site folder selected', { site: dir.replace(/\\/g, '/'), set: Object.keys(set).length });
  log.debug('applySite', 'variables from the site .env', { set: Object.keys(set), kept });
  if (inherited.length) log.warn('applySite', 'TILDA_* taken from the environment, not in the site .env', { names: inherited });
  if (ignored.length) log.warn('applySite', '[FIX] site .env keys outside TILDA_* and LOG_LEVEL are not applied', { names: ignored });
  return { siteDir: dir, set: Object.keys(set), kept, inherited, ignored };
}

/** Готовая команда для подсказки пользователю: с `--site`, если сайт выбран. Кавычки — только двойные. */
export function cliHint(args, env = process.env) {
  const site = env.TILDA_SITE_DIR?.trim();
  return `node scripts/tilda.mjs${site ? ` --site "${site}"` : ''} ${args}`;
}
