/**
 * Пути проекта без зашитых абсолютных значений.
 *
 * Корень репозитория вычисляется от расположения этого файла (`scripts/lib/`) и нужен
 * только для кода продукта. Данные сайта берутся из явных переменных
 * (TILDA_BASELINE_DIR, TILDA_REFERENCE_DIR, TILDA_BROWSER_PROFILE, TILDA_CATALOG_DIR)
 * либо из выбранной папки сайта (TILDA_SITE_DIR): корень репозитория для данных не используется,
 * а папка данных внутри репозитория — отказ.
 */
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { ConfigError, getProtectedPages } from './config.mjs';

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Лежит ли `child` внутри `parent` (равные пути тоже считаются «внутри»).
 * На Windows сравнение без учёта регистра. Чистая: платформа передаётся параметром.
 */
export function isInside(child, parent, platform = process.platform) {
  const p = platform === 'win32' ? win32 : posix;
  const norm = (s) => (platform === 'win32' ? p.resolve(s).toLowerCase() : p.resolve(s));
  const rel = p.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/** Вернуть `path`, если он вне репозитория продукта; иначе `ConfigError` с именем переменной. */
export function assertOutsideRepo(path, variable, { root = repoRoot(), platform = process.platform } = {}) {
  if (isInside(path, root, platform)) {
    throw new ConfigError(
      `${variable}: папка данных внутри репозитория продукта (${path}) — вынесите данные в папку сайта вне репозитория`,
      variable,
    );
  }
  return path;
}

/** Выбранная папка сайта (TILDA_SITE_DIR) или null. Проверку «вне репо» делает `applySite`. */
export function siteDir(env = process.env) {
  const value = env.TILDA_SITE_DIR?.trim();
  return value ? resolve(value) : null;
}

/** Явная переменная → подпапка папки сайта → отказ. */
function dataDir(env, variable, siteSub, what) {
  const explicit = env[variable]?.trim();
  if (explicit) return assertOutsideRepo(resolve(explicit), variable);
  const site = siteDir(env);
  if (site) return join(site, siteSub);
  throw new ConfigError(`${what}: не выбран сайт — укажите --site <папка сайта> или ${variable}`, variable);
}

/** Снимки и журнал сайта: TILDA_BASELINE_DIR или `<папка сайта>/site-baseline`. */
export function baselineDir(env = process.env) {
  return dataDir(env, 'TILDA_BASELINE_DIR', 'site-baseline', 'снимки сайта');
}

/** Слепки референс-сайтов: TILDA_REFERENCE_DIR или `<папка сайта>/site-reference`. */
export function referenceDir(env = process.env) {
  return dataDir(env, 'TILDA_REFERENCE_DIR', 'site-reference', 'слепки референса');
}

/** Профиль тестового держателя: TILDA_BROWSER_PROFILE или `<папка сайта>/.browser-profile`. */
export function testProfileDir(env = process.env) {
  return dataDir(env, 'TILDA_BROWSER_PROFILE', '.browser-profile', 'профиль браузера');
}

/** Каталог шаблонов, общий для всех сайтов: только TILDA_CATALOG_DIR, без значения по умолчанию. */
export function catalogRoot(env = process.env) {
  const value = env.TILDA_CATALOG_DIR?.trim();
  if (value) return assertOutsideRepo(resolve(value), 'TILDA_CATALOG_DIR');
  throw new ConfigError('каталог шаблонов: задайте TILDA_CATALOG_DIR — общую папку каталога для всех сайтов', 'TILDA_CATALOG_DIR');
}

/** Сгенерированные планы: `<папка сайта>/plans`. */
export function plansDir(env = process.env) {
  const site = siteDir(env);
  if (site) return join(site, 'plans');
  throw new ConfigError('папка планов: не выбран сайт — укажите --site <папка сайта> или --out <файл>', 'TILDA_SITE_DIR');
}

/** Страницы, защита которых снята на этот запуск процесса явным флагом команды. */
const unprotectedThisRun = new Set();

/** Страницы, в которые скрипты отказываются писать. По умолчанию — живая главная. */
export function protectedPages() {
  return getProtectedPages().filter((p) => !unprotectedThisRun.has(p));
}

/**
 * Снять защиту страницы на один запуск — осознанное действие человека по явному флагу команды
 * (`promote --unprotect`), а не переменная окружения по умолчанию. Возвращает оставшийся список;
 * вызывающий обязан записать WARN с меткой времени. Браузерный слой держит свою копию списка —
 * её меняет `browser.setProtectedPages`.
 */
export function unprotectForThisRun(pageid) {
  unprotectedThisRun.add(String(pageid));
  return protectedPages();
}

/** Только для тестов: вернуть защиту всем страницам. */
export function resetUnprotected() {
  unprotectedThisRun.clear();
}
