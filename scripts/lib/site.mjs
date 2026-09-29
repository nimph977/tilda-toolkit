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
 * главнее файла. Относительные пути данных в `.env` считаются от папки сайта.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError } from './config.mjs';
import { assertOutsideRepo, isInside, repoRoot } from './paths.mjs';
import { createLogger } from './log.mjs';

const log = createLogger('site');

/** Переменные-пути: относительное значение в `.env` сайта считается от папки сайта. */
export const SITE_PATH_VARS = [
  'TILDA_BASELINE_DIR',
  'TILDA_REFERENCE_DIR',
  'TILDA_CATALOG_DIR',
  'TILDA_BROWSER_PROFILE',
  'TILDA_DONOR_BROWSER_PROFILE',
];

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
    throw new ConfigError(`--site и TILDA_SITE_DIR указывают на разные папки: ${fromFlag} и ${fromEnv}`, 'TILDA_SITE_DIR');
  }
  const dir = fromFlag ?? fromEnv;
  if (!exists(dir) || !isDir(dir)) throw new ConfigError(`папка сайта не найдена: ${dir}`, 'TILDA_SITE_DIR');
  assertOutsideRepo(dir, 'TILDA_SITE_DIR', { root });
  if (!exists(join(dir, '.env'))) throw new ConfigError(`в папке сайта нет .env: ${dir}`, 'TILDA_SITE_DIR');
  return dir;
}

/**
 * Что `.env` сайта добавляет к окружению. Чистая функция: `set` — переменные к установке,
 * `kept` — не-`TILDA_*` переменные, где остаётся значение окружения.
 */
export function siteEnvChanges({ siteDir, text, env = process.env }) {
  const parsed = parseEnv(text);
  if ('TILDA_SITE_DIR' in parsed) throw new ConfigError('TILDA_SITE_DIR нельзя задавать в .env папки сайта', 'TILDA_SITE_DIR');
  const set = {};
  const kept = [];
  const conflicts = [];
  for (const [key, raw] of Object.entries(parsed)) {
    const value = SITE_PATH_VARS.includes(key) && raw.trim() && !isAbsolute(raw.trim()) ? resolve(siteDir, raw.trim()) : raw;
    if (env[key] === undefined) set[key] = value;
    else if (env[key] === value) continue;
    else if (key.startsWith('TILDA_')) conflicts.push(key);
    else kept.push(key);
  }
  if (conflicts.length) {
    throw new ConfigError(
      `переменные заданы и в окружении, и в .env папки сайта с разными значениями: ${conflicts.join(', ')} — уберите их из окружения`,
      conflicts[0],
    );
  }
  return { set, kept };
}

/**
 * Выбрать сайт и подгрузить его `.env` в `env`. Сайт не выбран — null (пути только из явных переменных).
 * Иначе `env.TILDA_SITE_DIR` указывает на папку, а переменные `.env` добавлены.
 */
export function applySite({ flag, env = process.env, cwd, root, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const dir = resolveSiteDir({ flag, env, cwd, root });
  if (!dir) {
    log.debug('applySite', 'папка сайта не выбрана — пути только из явных переменных');
    return null;
  }
  const { set, kept } = siteEnvChanges({ siteDir: dir, text: read(join(dir, '.env')), env });
  Object.assign(env, set);
  env.TILDA_SITE_DIR = dir;
  log.info('applySite', 'папка сайта выбрана', { site: dir.replace(/\\/g, '/'), set: Object.keys(set).length });
  log.debug('applySite', 'переменные из .env сайта', { set: Object.keys(set), kept });
  return { siteDir: dir, set: Object.keys(set), kept };
}

/** Готовая команда для подсказки пользователю: с `--site`, если сайт выбран. Кавычки — только двойные. */
export function cliHint(args, env = process.env) {
  const site = env.TILDA_SITE_DIR?.trim();
  return `node scripts/tilda.mjs${site ? ` --site "${site}"` : ''} ${args}`;
}
