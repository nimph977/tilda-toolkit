/**
 * Общий логгер скриптов проекта.
 *
 * Уровни: DEBUG < INFO < WARN < ERROR. Порог задаёт переменная окружения LOG_LEVEL
 * (по умолчанию INFO). Лог идёт в stderr, чтобы stdout скриптов можно было
 * перенаправлять в файл. Формат строки: `[модуль.функция] сообщение {данные}`.
 *
 * Использование:
 *   import { createLogger } from './lib/log.mjs';
 *   const log = createLogger('zero-model');
 *   log.debug('setText', 'элемент найден', { key, elem_id });
 */

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function resolveThreshold() {
  const raw = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
  if (!(raw in LEVELS)) {
    process.stderr.write(`[log] WARN неизвестный LOG_LEVEL=${raw}, использую INFO\n`);
    return LEVELS.INFO;
  }
  return LEVELS[raw];
}

let threshold = resolveThreshold();

/** Переустановить порог (нужно тестам). */
export function setLogLevel(level) {
  const key = String(level).toUpperCase();
  if (!(key in LEVELS)) throw new Error(`неизвестный уровень лога: ${level}`);
  threshold = LEVELS[key];
}

function formatData(data) {
  if (data === undefined) return '';
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' ' + String(data);
  }
}

/**
 * @param {string} module имя модуля для префикса
 */
export function createLogger(module) {
  const emit = (level, fn, message, data) => {
    if (LEVELS[level] < threshold) return;
    process.stderr.write(`${level} [${module}.${fn}] ${message}${formatData(data)}\n`);
  };
  return {
    debug: (fn, message, data) => emit('DEBUG', fn, message, data),
    info: (fn, message, data) => emit('INFO', fn, message, data),
    warn: (fn, message, data) => emit('WARN', fn, message, data),
    error: (fn, message, data) => emit('ERROR', fn, message, data),
  };
}
