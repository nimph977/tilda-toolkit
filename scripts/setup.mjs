/**
 * Установка с нуля: папка сайта вне репозитория, её `.env` и скилл `tilda-manager`.
 *
 *   node scripts/tilda.mjs setup [--site <папка>] [--project <ID>] [--agent claude|codex|all] [--lang en|ru] [--json]
 *
 * Только флаги, без вопросов в терминале. Все проверки идут до первой записи. Существующий
 * `.env` не перезаписывается: пустой `TILDA_PROJECT_ID` дополняется значением `--project`,
 * другое непустое значение — отказ. Новый `.env` не наследует ID из шаблона. `--lang` задаёт язык
 * вывода и пишется в `TILDA_LANG` файла `.env` сайта; другой язык в существующем `.env` заменяется
 * без отказа: язык не определяет сайт.
 *
 * Пишет только в папку из `--site` (папка и `.env`), а скилл — в `<корень>/.claude/skills/tilda-manager`
 * и `<корень>/.agents/skills/tilda-manager` (см. skill-install.mjs).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError, parseNumericId } from './lib/config.mjs';
import { LANGS, attachMessage, messageText, msg } from './lib/i18n.mjs';
import { createLogger } from './lib/log.mjs';
import { assertOutsideRepo, isInside, repoRoot } from './lib/paths.mjs';
import { cliHint } from './lib/site.mjs';
import { checkSkillTargets, installSkill } from './lib/skill-install.mjs';

const log = createLogger('setup');

export const SETUP_AGENTS = ['claude', 'codex', 'all'];

/** Отказ setup по существу (код 1); ошибки аргументов и границы репозитория — `ConfigError` (код 2). */
export class SetupError extends Error {
  constructor(message) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'SetupError';
    this.code = 'SETUP_REFUSED';
    this.exitCode = 1;
  }
}

/** Ключи шаблона, значения которых в новом `.env` очищаются. */
const CLEARED_KEYS = ['TILDA_DONOR_PROJECT_ID', 'TILDA_PROTECTED_PAGES', 'TILDA_DEFAULT_PAGE'];

const slash = (path) => path.replace(/\\/g, '/');

/** Имя переменной активной строки `KEY=…`; комментарии и пустые строки — null. */
function activeKey(line) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
}

const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/** Строки текста без хвостовых пустых; перевод строки в конец добавляет вызывающий. */
function linesOf(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Шаблон `.env` → `.env` нового сайта: ID проекта задаётся флагом, язык — `--lang` (иначе пусто),
 * остальные ID и защита очищаются, `TILDA_SITE_DIR` удаляется. Комментарии и прочие строки не
 * меняются; нет строки `TILDA_LANG` в шаблоне — она дописывается в конец. Чистая.
 *
 * @param {string} template содержимое `.env.example`
 * @param {{projectId?: string, lang?: string}} options
 */
export function renderSiteEnv(template, { projectId, lang } = {}) {
  const eol = eolOf(template);
  const projectLine = `TILDA_PROJECT_ID=${projectId ?? ''}`;
  const langLine = `TILDA_LANG=${lang ?? ''}`;
  let hasProject = false;
  let hasProtected = false;
  let hasLang = false;
  const out = [];
  for (const line of linesOf(template)) {
    const key = activeKey(line);
    if (key === 'TILDA_SITE_DIR') continue;
    if (key === 'TILDA_PROJECT_ID') {
      hasProject = true;
      out.push(projectLine);
    } else if (key === 'TILDA_LANG') {
      hasLang = true;
      out.push(langLine);
    } else if (CLEARED_KEYS.includes(key)) {
      if (key === 'TILDA_PROTECTED_PAGES') hasProtected = true;
      out.push(`${key}=`);
    } else {
      out.push(line);
    }
  }
  if (!hasProject) out.push(projectLine);
  if (!hasProtected) out.push('TILDA_PROTECTED_PAGES=');
  if (!hasLang) out.push(langLine);
  return out.join(eol) + eol;
}

/**
 * Что сделать с существующим `.env` при заданном `--project`. Чистая.
 *
 * @returns {{action: 'kept'|'unchanged'|'filled'|'conflict', text?: string, current?: string}}
 */
export function planEnvUpdate(existingText, { projectId } = {}) {
  if (projectId === undefined) return { action: 'kept' };
  const current = parseEnv(existingText).TILDA_PROJECT_ID?.trim();
  if (current === projectId) return { action: 'unchanged' };
  if (current) return { action: 'conflict', current };

  const eol = eolOf(existingText);
  const lines = linesOf(existingText);
  const at = lines.findIndex((line) => activeKey(line) === 'TILDA_PROJECT_ID');
  const projectLine = `TILDA_PROJECT_ID=${projectId}`;
  if (at === -1) lines.push(projectLine);
  else lines[at] = projectLine;
  return { action: 'filled', text: lines.join(eol) + eol };
}

/**
 * Что сделать со строкой `TILDA_LANG` существующего `.env` при заданном `--lang`. Чистая.
 * Отказа нет (язык не определяет сайт): другое значение заменяется, прежнее возвращается в `previous`.
 *
 * @returns {{action: 'kept'|'unchanged'|'filled'|'added'|'replaced', text?: string, previous?: string}}
 */
export function planLangUpdate(existingText, { lang } = {}) {
  if (lang === undefined) return { action: 'kept' };
  const current = parseEnv(existingText).TILDA_LANG?.trim();
  if (current === lang) return { action: 'unchanged' };

  const eol = eolOf(existingText);
  const lines = linesOf(existingText);
  const at = lines.findIndex((line) => activeKey(line) === 'TILDA_LANG');
  const langLine = `TILDA_LANG=${lang}`;
  if (at === -1) {
    lines.push(langLine);
    return { action: 'added', text: lines.join(eol) + eol };
  }
  lines[at] = langLine;
  const text = lines.join(eol) + eol;
  return current ? { action: 'replaced', previous: current, text } : { action: 'filled', text };
}

/**
 * Проверяет папку сайта без записи.
 *
 * @returns {{dir: string, exists: boolean, envExists: boolean}}
 */
export function prepareSite({ siteArg, cwd = process.cwd(), root = repoRoot() }) {
  const dir = resolve(cwd, siteArg);
  assertOutsideRepo(dir, '--site', { root });
  const exists = existsSync(dir);
  if (exists && !statSync(dir).isDirectory()) throw new SetupError(msg('setup.siteIsFile', { dir }));
  const envExists = exists && existsSync(join(dir, '.env'));
  log.debug('prepareSite', 'folder inspected', { dir: slash(dir), exists, envExists });
  return { dir, exists, envExists };
}

/**
 * Создаёт папку сайта и `.env` из `.env.example` корня; существующий `.env` только дополняет.
 * Вызывается после всех проверок.
 *
 * @returns {{dir: string, folder: 'created'|'existing', env: 'created'|'kept'|'unchanged'|'filled',
 *   lang?: {action: 'filled'|'added'|'replaced'|'unchanged', value: string, previous?: string}}}
 */
export function writeSite({ dir, projectId, lang, root = repoRoot() }) {
  let folder = 'existing';
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    folder = 'created';
    log.info('writeSite', 'site folder created', { dir: slash(dir) });
  }
  const envFile = join(dir, '.env');
  let env;
  let langResult;
  if (!existsSync(envFile)) {
    const template = readFileSync(join(root, '.env.example'), 'utf8');
    writeFileSync(envFile, renderSiteEnv(template, { projectId, lang }), { flag: 'wx' });
    env = 'created';
    if (lang !== undefined) langResult = { action: 'filled', value: lang };
  } else {
    const existing = readFileSync(envFile, 'utf8');
    const plan = planEnvUpdate(existing, { projectId });
    log.debug('writeSite', 'existing .env', { action: plan.action });
    if (plan.action === 'conflict') {
      throw new SetupError(msg('setup.projectConflict', { file: slash(envFile) }));
    }
    let text = plan.action === 'filled' ? plan.text : existing;
    const langPlan = planLangUpdate(text, { lang });
    if (langPlan.text !== undefined) text = langPlan.text;
    if (text !== existing) writeFileSync(envFile, text);
    env = plan.action;
    if (lang !== undefined) {
      langResult = { action: langPlan.action, value: lang };
      if (langPlan.previous !== undefined) langResult.previous = langPlan.previous;
      if (langPlan.action === 'replaced') log.info('writeSite', 'TILDA_LANG replaced', { previous: langPlan.previous, value: lang });
      else log.debug('writeSite', 'TILDA_LANG', { action: langPlan.action, value: lang });
    }
  }
  log.info('writeSite', 'site .env', { dir: slash(dir), env });
  const result = { dir, folder, env };
  if (langResult) result.lang = langResult;
  return result;
}

export function agentsFor(agent) {
  return agent === 'all' ? ['claude', 'codex'] : [agent];
}

/**
 * Сценарий setup: предупреждения окружения → проверки без записи → запись → итог.
 *
 * Итог: `status` и `note` — `Message`, переводит граница CLI. `lang` без `site` файлов не пишет.
 *
 * @returns {Promise<{status: any, site?: object, skills?: object[], next: string, note?: any}>}
 */
export async function runSetup({ site, project, agent, lang, env = process.env, cwd = process.cwd(), root = repoRoot() } = {}) {
  log.debug('runSetup', 'input', { site: site ? 'present' : 'absent', agent, project: project === undefined ? 'absent' : 'present', lang });
  if (!site && !agent) throw new ConfigError(msg('setup.needSiteOrAgent'), '--site');
  if (project !== undefined && !site) throw new ConfigError(msg('setup.projectNeedsSite'), '--project');
  if (agent !== undefined && !SETUP_AGENTS.includes(agent)) throw new ConfigError(msg('setup.badAgent'), '--agent');
  if (lang !== undefined && !LANGS.includes(lang)) throw new ConfigError(msg('i18n.badFlag', { value: lang }), '--lang');

  // Окружение setup не использует: папка и ID берутся только из флагов.
  const envSite = String(env.TILDA_SITE_DIR ?? '').trim();
  if (envSite) {
    if (!site) {
      log.warn('runSetup', 'TILDA_SITE_DIR is not used: setup takes the folder only from --site');
    } else {
      const a = resolve(cwd, site);
      const b = resolve(cwd, envSite);
      if (!(isInside(a, b) && isInside(b, a))) {
        throw new ConfigError(msg('site.dirsDiffer', { flag: a, env: b }), 'TILDA_SITE_DIR');
      }
    }
  }
  const projectId = project === undefined ? undefined : String(parseNumericId(project, '--project'));
  const envProject = String(env.TILDA_PROJECT_ID ?? '').trim();
  if (site && envProject && envProject !== projectId) {
    log.warn('runSetup', 'TILDA_PROJECT_ID from the environment is not used: setup takes the ID only from --project');
  }

  // Все проверки — до первой записи.
  const agents = agent === undefined ? [] : agentsFor(agent);
  const prepared = site ? prepareSite({ siteArg: site, cwd, root }) : null;
  if (prepared?.envExists) {
    const plan = planEnvUpdate(readFileSync(join(prepared.dir, '.env'), 'utf8'), { projectId });
    if (plan.action === 'conflict') {
      throw new SetupError(msg('setup.projectConflict', { file: slash(join(prepared.dir, '.env')) }));
    }
  }
  if (agents.length) checkSkillTargets({ root, agents });

  const summary = { status: msg('setup.status.done') };
  if (prepared) summary.site = writeSite({ dir: prepared.dir, projectId, lang, root });
  if (agents.length) summary.skills = agents.map((name) => installSkill({ root, agent: name }));
  summary.next = prepared ? cliHint('doctor', { TILDA_SITE_DIR: prepared.dir }) : 'node scripts/tilda.mjs doctor';
  if (summary.skills) summary.note = msg('setup.note.restartAgent');
  log.info('runSetup', 'done', { folder: summary.site?.folder, env: summary.site?.env, skills: summary.skills?.map((s) => s.action) });
  return summary;
}
