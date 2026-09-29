/**
 * Установка с нуля: папка сайта вне репозитория, её `.env` и скилл `tilda-manager`.
 *
 *   node scripts/tilda.mjs setup [--site <папка>] [--project <ID>] [--agent claude|codex|all] [--json]
 *
 * Только флаги, без вопросов в терминале. Все проверки идут до первой записи. Существующий
 * `.env` не перезаписывается: пустой `TILDA_PROJECT_ID` дополняется значением `--project`,
 * другое непустое значение — отказ. Новый `.env` не наследует ID из шаблона.
 *
 * Пишет только в папку из `--site` (папка и `.env`), а скилл — в `<корень>/.claude/skills/tilda-manager`
 * и `<корень>/.agents/skills/tilda-manager` (см. skill-install.mjs).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError, parseNumericId } from './lib/config.mjs';
import { createLogger } from './lib/log.mjs';
import { assertOutsideRepo, isInside, repoRoot } from './lib/paths.mjs';
import { cliHint } from './lib/site.mjs';
import { checkSkillTargets, installSkill } from './lib/skill-install.mjs';

const log = createLogger('setup');

export const SETUP_AGENTS = ['claude', 'codex', 'all'];

/** Отказ setup по существу (код 1); ошибки аргументов и границы репозитория — `ConfigError` (код 2). */
export class SetupError extends Error {
  constructor(message) {
    super(message);
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
 * Шаблон `.env` → `.env` нового сайта: ID проекта задаётся флагом, остальные ID и защита очищаются,
 * `TILDA_SITE_DIR` удаляется. Комментарии и прочие строки не меняются. Чистая.
 *
 * @param {string} template содержимое `.env.example`
 * @param {{projectId?: string}} options
 */
export function renderSiteEnv(template, { projectId } = {}) {
  const eol = eolOf(template);
  const projectLine = `TILDA_PROJECT_ID=${projectId ?? ''}`;
  let hasProject = false;
  let hasProtected = false;
  const out = [];
  for (const line of linesOf(template)) {
    const key = activeKey(line);
    if (key === 'TILDA_SITE_DIR') continue;
    if (key === 'TILDA_PROJECT_ID') {
      hasProject = true;
      out.push(projectLine);
    } else if (CLEARED_KEYS.includes(key)) {
      if (key === 'TILDA_PROTECTED_PAGES') hasProtected = true;
      out.push(`${key}=`);
    } else {
      out.push(line);
    }
  }
  if (!hasProject) out.push(projectLine);
  if (!hasProtected) out.push('TILDA_PROTECTED_PAGES=');
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
 * Проверяет папку сайта без записи.
 *
 * @returns {{dir: string, exists: boolean, envExists: boolean}}
 */
export function prepareSite({ siteArg, cwd = process.cwd(), root = repoRoot() }) {
  const dir = resolve(cwd, siteArg);
  assertOutsideRepo(dir, '--site', { root });
  const exists = existsSync(dir);
  if (exists && !statSync(dir).isDirectory()) throw new SetupError(`--site: ${dir} — это файл, а не папка`);
  const envExists = exists && existsSync(join(dir, '.env'));
  log.debug('prepareSite', 'папка осмотрена', { dir: slash(dir), exists, envExists });
  return { dir, exists, envExists };
}

/**
 * Создаёт папку сайта и `.env` из `.env.example` корня; существующий `.env` только дополняет.
 * Вызывается после всех проверок.
 *
 * @returns {{dir: string, folder: 'created'|'existing', env: 'created'|'kept'|'unchanged'|'filled'}}
 */
export function writeSite({ dir, projectId, root = repoRoot() }) {
  let folder = 'existing';
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    folder = 'created';
    log.info('writeSite', 'папка сайта создана', { dir: slash(dir) });
  }
  const envFile = join(dir, '.env');
  let env;
  if (!existsSync(envFile)) {
    const template = readFileSync(join(root, '.env.example'), 'utf8');
    writeFileSync(envFile, renderSiteEnv(template, { projectId }), { flag: 'wx' });
    env = 'created';
  } else {
    const plan = planEnvUpdate(readFileSync(envFile, 'utf8'), { projectId });
    log.debug('writeSite', 'существующий .env', { action: plan.action });
    if (plan.action === 'conflict') {
      throw new SetupError(`в ${slash(envFile)} уже задан другой TILDA_PROJECT_ID; исправьте файл вручную или уберите --project`);
    }
    if (plan.action === 'filled') writeFileSync(envFile, plan.text);
    env = plan.action;
  }
  log.info('writeSite', '.env сайта', { dir: slash(dir), env });
  return { dir, folder, env };
}

export function agentsFor(agent) {
  return agent === 'all' ? ['claude', 'codex'] : [agent];
}

/**
 * Сценарий setup: предупреждения окружения → проверки без записи → запись → итог.
 *
 * @returns {Promise<{status: string, site?: object, skills?: object[], next: string, note?: string}>}
 */
export async function runSetup({ site, project, agent, env = process.env, cwd = process.cwd(), root = repoRoot() } = {}) {
  log.debug('runSetup', 'вход', { site: site ? 'есть' : 'нет', agent, project: project === undefined ? 'нет' : 'есть' });
  if (!site && !agent) throw new ConfigError('setup: нужен --site <папка сайта> и/или --agent claude|codex|all', '--site');
  if (project !== undefined && !site) throw new ConfigError('--project нужен вместе с --site', '--project');
  if (agent !== undefined && !SETUP_AGENTS.includes(agent)) throw new ConfigError('--agent: claude, codex или all', '--agent');

  // Окружение setup не использует: папка и ID берутся только из флагов.
  const envSite = String(env.TILDA_SITE_DIR ?? '').trim();
  if (envSite) {
    if (!site) {
      log.warn('runSetup', 'TILDA_SITE_DIR не используется: setup берёт папку только из --site');
    } else {
      const a = resolve(cwd, site);
      const b = resolve(cwd, envSite);
      if (!(isInside(a, b) && isInside(b, a))) {
        throw new ConfigError(`--site и TILDA_SITE_DIR указывают на разные папки: ${a} и ${b}`, 'TILDA_SITE_DIR');
      }
    }
  }
  const projectId = project === undefined ? undefined : String(parseNumericId(project, '--project'));
  const envProject = String(env.TILDA_PROJECT_ID ?? '').trim();
  if (site && envProject && envProject !== projectId) {
    log.warn('runSetup', 'TILDA_PROJECT_ID из окружения не используется: setup берёт ID только из --project');
  }

  // Все проверки — до первой записи.
  const agents = agent === undefined ? [] : agentsFor(agent);
  const prepared = site ? prepareSite({ siteArg: site, cwd, root }) : null;
  if (prepared?.envExists) {
    const plan = planEnvUpdate(readFileSync(join(prepared.dir, '.env'), 'utf8'), { projectId });
    if (plan.action === 'conflict') {
      throw new SetupError(`в ${slash(join(prepared.dir, '.env'))} уже задан другой TILDA_PROJECT_ID; исправьте файл вручную или уберите --project`);
    }
  }
  if (agents.length) checkSkillTargets({ root, agents });

  const summary = { status: 'готово' };
  if (prepared) summary.site = writeSite({ dir: prepared.dir, projectId, root });
  if (agents.length) summary.skills = agents.map((name) => installSkill({ root, agent: name }));
  summary.next = prepared ? cliHint('doctor', { TILDA_SITE_DIR: prepared.dir }) : 'node scripts/tilda.mjs doctor';
  if (summary.skills) summary.note = 'перезапустите сессию агента в папке репозитория, чтобы он увидел скилл';
  log.info('runSetup', 'готово', { folder: summary.site?.folder, env: summary.site?.env, skills: summary.skills?.map((s) => s.action) });
  return summary;
}
