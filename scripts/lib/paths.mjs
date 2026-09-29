/**
 * Пути проекта без зашитых абсолютных значений.
 *
 * Корень репозитория вычисляется от расположения этого файла (`scripts/lib/`),
 * папка baseline — из переменной TILDA_BASELINE_DIR либо `<корень>/site-baseline`,
 * папка слепков референсов — из TILDA_REFERENCE_DIR либо `<корень>/site-reference`.
 */
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getProtectedPages } from './config.mjs';

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Путь к `.env` для автозагрузки при запуске не из папки проекта или null:
 * переменные уже заданы (ID тестового или донорского проекта), выключено `TILDA_ENV_AUTOLOAD=0`,
 * файла нет. `process.loadEnvFile` уже заданные переменные не переопределяет (проверено на Node 24,
 * как и `--env-file`); условие по ID нужно, чтобы явно настроенное окружение файл вообще не читало.
 */
export function envFileToLoad({ env = process.env, root = repoRoot(), exists = existsSync } = {}) {
  if (env.TILDA_ENV_AUTOLOAD === '0') return null;
  if (env.TILDA_PROJECT_ID || env.TILDA_DONOR_PROJECT_ID) return null;
  const file = resolve(root, '.env');
  return exists(file) ? file : null;
}

export function baselineDir() {
  return process.env.TILDA_BASELINE_DIR ? resolve(process.env.TILDA_BASELINE_DIR) : resolve(repoRoot(), 'site-baseline');
}

/** Каталог слепков референс-сайтов: TILDA_REFERENCE_DIR или <repo>/site-reference (вне git). */
export function referenceDir() {
  return process.env.TILDA_REFERENCE_DIR ? resolve(process.env.TILDA_REFERENCE_DIR) : resolve(repoRoot(), 'site-reference');
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
