/**
 * Перевод сообщений CLI: выбор языка, словари `locales/<язык>.json`, подстановки.
 *
 * Модуль без зависимостей: статически импортирует только `node:*` и не использует API новее
 * Node 16 — его подключает `doctor.mjs`, который должен отработать и на старой Node.
 * Из-за этого журнал передаётся снаружи (`setI18nLogger`): своей цепочки импортов у модуля нет.
 *
 * Модули ниже границы CLI язык не знают: они создают `msg(ключ, параметры)`, а переводят
 * `scripts/tilda.mjs`, `scripts/doctor.mjs` и генераторы докладов, которым язык передан явно.
 */
import { readFileSync } from 'node:fs';

/** Поддерживаемые языки вывода. */
export const LANGS = ['en', 'ru'];
export const DEFAULT_LANG = 'en';

/** Ключ: пространство имён (модуль-источник) и один или несколько сегментов через точку. */
export const KEY_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;

const noop = () => {};
let logger = { debug: noop, warn: noop };

/**
 * Подключить журнал: объект с методами `debug`/`warn(функция, сообщение, данные)`.
 * Без вызова журнал модуля — пустая заглушка.
 */
export function setI18nLogger(next) {
  logger = { debug: (next && next.debug) || noop, warn: (next && next.warn) || noop };
}

/** Сообщение до перевода: ключ словаря и именованные подстановки. */
export class Message {
  constructor(key, params) {
    this.key = key;
    this.params = params || {};
    Object.freeze(this);
  }
}

/** Создать сообщение; ключ проверяется по `KEY_PATTERN`. */
export function msg(key, params) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new TypeError('bad message key: ' + key);
  return new Message(key, params);
}

export function isMessage(v) {
  return v instanceof Message;
}

/** Язык системы по локали ICU: `ru*` даёт ru, всё остальное — en. */
export function systemLang(locale) {
  const value = locale === undefined ? Intl.DateTimeFormat().resolvedOptions().locale : locale;
  return /^ru(\b|[-_])/i.test(String(value || '')) ? 'ru' : 'en';
}

/** Ошибка выбора языка: неверный флаг `--lang` или неверный `TILDA_LANG`. Код выхода 2. */
export class LangError extends Error {
  constructor(source, value) {
    const key = source === 'flag' ? 'i18n.badFlag' : 'i18n.badEnv';
    const params = { value };
    super(t('en', key, params));
    this.name = source === 'flag' ? 'UsageError' : 'ConfigError';
    this.code = source === 'flag' ? 'USAGE_ERROR' : 'CONFIG_ERROR';
    this.exitCode = 2;
    this.variable = source === 'flag' ? '--lang' : 'TILDA_LANG';
    this.key = key;
    this.params = params;
  }
}

function normalizeLang(value) {
  return String(value).trim().toLowerCase();
}

/**
 * Выбрать язык: флаг `--lang` → `TILDA_LANG` → язык системы.
 * Пустой `TILDA_LANG` считается незаданным.
 * @returns {{ lang: string, source: 'flag' | 'env' | 'system' }}
 */
export function resolveLang({ flag, env = process.env, locale } = {}) {
  let result;
  if (flag !== undefined) {
    const value = normalizeLang(flag);
    if (!LANGS.includes(value)) throw new LangError('flag', flag);
    result = { lang: value, source: 'flag' };
  } else if (typeof env.TILDA_LANG === 'string' && env.TILDA_LANG.trim() !== '') {
    const value = normalizeLang(env.TILDA_LANG);
    if (!LANGS.includes(value)) throw new LangError('env', env.TILDA_LANG);
    result = { lang: value, source: 'env' };
  } else {
    result = { lang: systemLang(locale), source: 'system' };
  }
  logger.debug('resolveLang', 'language resolved', { lang: result.lang, source: result.source });
  return result;
}

/**
 * Язык для текста ошибок, случившихся до или во время разбора аргументов. Не бросает:
 * недопустимые значения пропускаются.
 */
export function peekLang(argv, env = process.env, locale) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    let value;
    if (arg === '--lang') value = args[i + 1];
    else if (arg.startsWith('--lang=')) value = arg.slice('--lang='.length);
    else continue;
    if (value !== undefined && LANGS.includes(normalizeLang(value))) return normalizeLang(value);
  }
  const fromEnv = env && typeof env.TILDA_LANG === 'string' ? normalizeLang(env.TILDA_LANG) : '';
  if (LANGS.includes(fromEnv)) return fromEnv;
  return systemLang(locale);
}

const dictionaries = new Map();

/** Загрузить словарь `locales/<lang>.json` (с кэшем). */
export function loadDictionary(lang) {
  if (!LANGS.includes(lang)) throw new RangeError('unknown language: ' + lang);
  if (dictionaries.has(lang)) return dictionaries.get(lang);
  let dictionary;
  try {
    dictionary = JSON.parse(readFileSync(new URL('../../locales/' + lang + '.json', import.meta.url), 'utf8'));
  } catch (e) {
    throw new Error('I18N_DICTIONARY: cannot read locales/' + lang + '.json: ' + e.message);
  }
  dictionaries.set(lang, dictionary);
  logger.debug('loadDictionary', 'dictionary loaded', { lang, keys: Object.keys(dictionary).length });
  return dictionary;
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Форма множественного числа по правилам языка (`one`/`few`/`many`/`other`). */
export function pluralForm(lang, n) {
  return new Intl.PluralRules(lang).select(n);
}

/**
 * Перевести ключ на язык `lang`. Нет в словаре языка — берётся английский; нет и там —
 * возвращается сам ключ. Значение-объект — формы числа, выбираются по `params.count`.
 * Подстановки `{имя}` вставляются как есть, без форматирования чисел.
 */
export function t(lang, key, params = {}) {
  let value;
  if (has(loadDictionary(lang), key)) value = loadDictionary(lang)[key];
  else if (lang !== 'en' && has(loadDictionary('en'), key)) value = loadDictionary('en')[key];
  else {
    logger.warn('t', 'missing message key', { key, lang });
    return key;
  }
  let text = value;
  if (value !== null && typeof value === 'object') {
    let form = 'other';
    if (params.count === undefined) logger.warn('t', 'plural without count', { key });
    else form = pluralForm(lang, Number(params.count));
    text = has(value, form) ? value[form] : value.other;
  }
  return String(text).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => {
    if (has(params, name) && params[name] !== undefined) return String(params[name]);
    logger.debug('t', 'missing param', { key, name });
    return whole;
  });
}

/** Английский текст сообщения (для журнала и стека); строка возвращается как есть. */
export function messageText(m) {
  if (isMessage(m)) return t('en', m.key, m.params);
  return typeof m === 'string' ? m : String(m);
}

/** Привязать к ошибке ключ и параметры сообщения (если это `Message`). */
export function attachMessage(error, m) {
  if (isMessage(m)) {
    error.key = m.key;
    error.params = m.params;
  }
  return error;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Перевести значение: `Message` — в текст (параметры-`Message` переводятся раньше),
 * массив и простой объект — поэлементно, остальное — как есть.
 */
export function render(lang, value) {
  if (isMessage(value)) return t(lang, value.key, render(lang, value.params));
  if (Array.isArray(value)) return value.map((item) => render(lang, item));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = render(lang, value[key]);
    return out;
  }
  return value;
}

/** Текст ошибки для пользователя: по ключу, а без ключа — `КОД: английский текст`. */
export function renderError(lang, error) {
  if (error && error.key) return t(lang, error.key, render(lang, error.params || {}));
  return t(lang, 'i18n.unknownError', {
    code: (error && (error.code || error.name)) || 'Error',
    message: error && error.message,
  });
}
