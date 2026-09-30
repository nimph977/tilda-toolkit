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
import { realpathSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { ConfigError, getProtectedPages } from './config.mjs';
import { msg } from './i18n.mjs';

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
  // Выход вверх — сегмент `..`, а не имя, начинающееся с двух точек (`..data` лежит внутри).
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** Путь с раскрытыми ярлыками: ближайший существующий предок через realpath, остаток дописывается как есть. */
function realPathDeep(path) {
  const rest = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Вернуть `path`, если он вне репозитория продукта; иначе `ConfigError` с именем переменной.
 * Ярлыки (junction/symlink) раскрываются: путь, ведущий за ярлыком внутрь репозитория, тоже отказ.
 * Раскрытие — только для платформы процесса (тесты чистой логики с чужой платформой его не делают).
 */
export function assertOutsideRepo(path, variable, { root = repoRoot(), platform = process.platform } = {}) {
  const real = platform === process.platform;
  const inside = isInside(path, root, platform) || (real && isInside(realPathDeep(path), realPathDeep(root), platform));
  if (inside) {
    throw new ConfigError(msg('paths.insideRepo', { variable, path }), variable);
  }
  return path;
}

/** Выбранная папка сайта (TILDA_SITE_DIR) или null. Проверку «вне репо» делает `applySite`. */
export function siteDir(env = process.env) {
  const value = env.TILDA_SITE_DIR?.trim();
  return value ? resolve(value) : null;
}

/** Явная переменная → подпапка папки сайта → отказ. `what` — `Message` с названием данных для текста отказа. */
function dataDir(env, variable, siteSub, what) {
  const explicit = env[variable]?.trim();
  if (explicit) return assertOutsideRepo(resolve(explicit), variable);
  const site = siteDir(env);
  if (site) return join(site, siteSub);
  throw new ConfigError(msg('paths.noSite', { what, variable }), variable);
}

/** Снимки и журнал сайта: TILDA_BASELINE_DIR или `<папка сайта>/site-baseline`. */
export function baselineDir(env = process.env) {
  return dataDir(env, 'TILDA_BASELINE_DIR', 'site-baseline', msg('paths.what.baseline'));
}

/** Слепки референс-сайтов: TILDA_REFERENCE_DIR или `<папка сайта>/site-reference`. */
export function referenceDir(env = process.env) {
  return dataDir(env, 'TILDA_REFERENCE_DIR', 'site-reference', msg('paths.what.reference'));
}

/** Профиль тестового держателя: TILDA_BROWSER_PROFILE или `<папка сайта>/.browser-profile`. */
export function testProfileDir(env = process.env) {
  return dataDir(env, 'TILDA_BROWSER_PROFILE', '.browser-profile', msg('paths.what.profile'));
}

/** Каталог шаблонов, общий для всех сайтов: только TILDA_CATALOG_DIR, без значения по умолчанию. */
export function catalogRoot(env = process.env) {
  const value = env.TILDA_CATALOG_DIR?.trim();
  if (value) return assertOutsideRepo(resolve(value), 'TILDA_CATALOG_DIR');
  throw new ConfigError(msg('paths.catalogDirRequired'), 'TILDA_CATALOG_DIR');
}

/** Сгенерированные планы: `<папка сайта>/plans`. */
export function plansDir(env = process.env) {
  const site = siteDir(env);
  if (site) return join(site, 'plans');
  throw new ConfigError(msg('paths.plansNoSite'), 'TILDA_SITE_DIR');
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
