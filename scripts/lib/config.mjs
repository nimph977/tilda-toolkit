/** Validated runtime configuration for online Tilda operations. */
import { resolve } from 'node:path';
import { attachMessage, messageText, msg } from './i18n.mjs';

/** Ошибка настройки. `message` — строка или `Message`: английский текст в `message`, ключ и параметры — в `key`/`params`. */
export class ConfigError extends Error {
  constructor(message, variable) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
    this.exitCode = 2;
    if (variable) this.variable = variable;
  }
}

export function parseNumericId(value, name, { required = true } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (!required) return undefined;
    throw new ConfigError(msg('config.idRequired', { name }), name);
  }
  const id = String(value).trim();
  if (!/^[1-9]\d*$/.test(id)) {
    throw new ConfigError(msg('config.idNotNumeric', { name, value: JSON.stringify(value) }), name);
  }
  return id;
}

/**
 * Роли проектов: `test` — проект владельца (запись разрешена), `donor` — проект-образец
 * (только чтение). ID и профиль браузера каждой роли берутся из своих переменных.
 */
export const PROJECT_ROLES = {
  test: { projectVar: 'TILDA_PROJECT_ID', profileVar: 'TILDA_BROWSER_PROFILE' },
  donor: { projectVar: 'TILDA_DONOR_PROJECT_ID', profileVar: 'TILDA_DONOR_BROWSER_PROFILE' },
};

export function assertRole(role) {
  if (!Object.hasOwn(PROJECT_ROLES, role)) throw new ConfigError(msg('config.unknownRole', { role }), 'role');
  return role;
}

export function getProjectIdFor(role = 'test', env = process.env) {
  const { projectVar } = PROJECT_ROLES[assertRole(role)];
  return parseNumericId(env[projectVar], projectVar);
}

export function getProjectId(env = process.env) {
  return getProjectIdFor('test', env);
}

export function resolveProjectIdFor(role, value, env = process.env) {
  const { projectVar } = PROJECT_ROLES[assertRole(role)];
  const configured = getProjectIdFor(role, env);
  if (value === undefined || value === null || String(value).trim() === '') return configured;
  const requested = parseNumericId(value, 'projectid');
  if (requested !== configured) {
    throw new ConfigError(msg('config.projectMismatch', { requested, variable: projectVar, configured }), projectVar);
  }
  return configured;
}

export function resolveProjectId(value, env = process.env) {
  return resolveProjectIdFor('test', value, env);
}

/** Каталог профиля держателя донора; значение возвращается как есть (абсолютность проверяет browser.profileDir). */
export function getDonorProfile(env = process.env) {
  const raw = env.TILDA_DONOR_BROWSER_PROFILE;
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!value) {
    throw new ConfigError(msg('config.donorProfileRequired'), 'TILDA_DONOR_BROWSER_PROFILE');
  }
  return value;
}

/**
 * Конфигурация донора: ID и профиль обязательны, ID не совпадает с тестовым.
 * `withTest` — дополнительно требует онлайн-конфигурацию тестового проекта и разные профили;
 * `testProfile` передаёт вызывающий (paths.mjs импортирует config.mjs — цикл недопустим).
 */
export function requireDonorConfig({ env = process.env, withTest = false, testProfile, withProfile = true } = {}) {
  const donorProjectId = getProjectIdFor('donor', env);
  // withProfile: false — команда не открывает держатель донора (donor aliases/links/check читают
  // только сохранённый перечень его страниц), профиль донора ей не нужен.
  const donorProfile = withProfile ? getDonorProfile(env) : null;
  const testRaw = env.TILDA_PROJECT_ID;
  if (testRaw !== undefined && testRaw !== null && String(testRaw).trim() === donorProjectId) {
    throw new ConfigError(msg('config.donorSameProject'), 'TILDA_DONOR_PROJECT_ID');
  }
  if (!withTest) return { donorProjectId, donorProfile };
  const online = requireOnlineConfig({ env });
  if (donorProfile !== null && testProfile !== undefined && sameProfile(donorProfile, testProfile)) {
    throw new ConfigError(msg('config.donorSameProfile'), 'TILDA_DONOR_BROWSER_PROFILE');
  }
  return { donorProjectId, donorProfile, ...online };
}

function sameProfile(a, b) {
  const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function getDefaultPage(env = process.env) {
  return parseNumericId(env.TILDA_DEFAULT_PAGE, 'TILDA_DEFAULT_PAGE', { required: false });
}

export function getProtectedPages(env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(env, 'TILDA_PROTECTED_PAGES')) {
    throw new ConfigError(msg('config.protectedNotSet'), 'TILDA_PROTECTED_PAGES');
  }
  const raw = String(env.TILDA_PROTECTED_PAGES ?? '');
  if (!raw.trim()) return [];
  const pages = raw.split(',').map((value, index) => parseNumericId(value, `TILDA_PROTECTED_PAGES[${index}]`));
  return [...new Set(pages)];
}

export function requireOnlineConfig({ env = process.env, requireDefaultPage = false } = {}) {
  const projectId = getProjectId(env);
  const protectedPages = getProtectedPages(env);
  const defaultPage = getDefaultPage(env);
  if (requireDefaultPage && defaultPage === undefined) {
    throw new ConfigError(msg('config.defaultPageRequired'), 'TILDA_DEFAULT_PAGE');
  }
  return { projectId, defaultPage, protectedPages };
}
