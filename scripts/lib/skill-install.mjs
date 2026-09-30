/**
 * Установка скилла `tilda-manager` в папку агента внутри клона.
 *
 * Скилл копируется, а не подключается ярлыком: копия одинакова в Windows, macOS и Linux и не
 * зависит от прав на символические ссылки. Ссылки скилла, выходящие за его папку
 * (`../../docs/…`), при копировании пересчитываются; источник `skills/tilda-manager` не меняется.
 * Актуальность копии определяется sha256 дерева файлов; файл-маркер отличает копию, сделанную
 * этим модулем, от чужой папки — чужую модуль не трогает.
 *
 * Модуль пишет только в `<root>/.claude/skills/tilda-manager`, `<root>/.agents/skills/tilda-manager`
 * и их временные папки `.tmp-<pid>`.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';
import { attachMessage, messageText, msg } from './i18n.mjs';
import { createLogger } from './log.mjs';
import { repoRoot } from './paths.mjs';

const log = createLogger('skill-install');

export const SKILL_NAME = 'tilda-manager';

/** Источник скилла в репозитории; сегменты массивом, чтобы путь собирался `join` на любой системе. */
export const SKILL_SOURCE = ['skills', SKILL_NAME];

/** Куда ставится копия для каждого агента; папку скиллов Codex подтвердила документация Codex. */
export const AGENT_TARGETS = {
  claude: ['.claude', 'skills', SKILL_NAME],
  codex: ['.agents', 'skills', SKILL_NAME],
};

/** Файл-маркер в установленной копии; в хеш дерева не входит. */
export const MARKER = '.tilda-toolkit-skill.json';

const SOURCE_ROOT = SKILL_SOURCE.join('/');

/** Ссылка Markdown `](цель)`: цель без пробелов и закрывающей скобки. */
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

/** Ссылки, которые при копировании не пересчитываются. */
const UNTOUCHED_LINK = /^(?:https?:|mailto:|#|\/)/;

export class SkillInstallError extends Error {
  /**
   * @param {'SKILL_TARGET_LINK'|'SKILL_TARGET_FOREIGN'|'SKILL_UNKNOWN_AGENT'} code
   * @param {string} path путь относительно корня, прямые слэши
   * @param {string|import('./i18n.mjs').Message} message строка или `Message` (английский текст в `message`, ключ в `key`)
   */
  constructor(code, path, message) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'SkillInstallError';
    this.code = code;
    this.exitCode = 1;
    this.path = path;
  }
}

/** Путь с разделителями системы → прямые слэши. */
export function toPosix(p) {
  return p.split(sep).join('/');
}

/**
 * Пересчитывает ссылки Markdown, выходящие за папку скилла, под новое место копии.
 * Ссылки внутри скилла, внешние, якоря и абсолютные не меняются.
 *
 * @param {string} text содержимое файла
 * @param {{fileRel: string, srcRoot: string, dstRoot: string}} where все пути posix от корня клона
 * @returns {string}
 */
export function rewriteLinks(text, { fileRel, srcRoot, dstRoot }) {
  const srcDir = posix.dirname(`${srcRoot}/${fileRel}`);
  const dstDir = posix.dirname(`${dstRoot}/${fileRel}`);
  let rewritten = 0;
  const result = text.replace(MARKDOWN_LINK, (whole, target) => {
    if (UNTOUCHED_LINK.test(target)) return whole;
    const hashAt = target.indexOf('#');
    const path = hashAt === -1 ? target : target.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : target.slice(hashAt);
    if (path === '') return whole;
    const resolved = posix.normalize(posix.join(srcDir, path));
    if (resolved === srcRoot || resolved.startsWith(`${srcRoot}/`)) return whole;
    let fixed = posix.relative(dstDir, resolved);
    if (path.endsWith('/') && !fixed.endsWith('/')) fixed += '/';
    rewritten += 1;
    return `](${fixed}${anchor})`;
  });
  log.debug('rewriteLinks', 'links rewritten', { fileRel, rewritten });
  return result;
}

/**
 * Ожидаемое дерево копии: `.md` с пересчитанными ссылками, остальное как есть.
 *
 * @param {Map<string, Buffer>} files источник: относительный posix-путь → содержимое
 * @param {{dstRoot: string}} where
 * @returns {Map<string, Buffer>} в порядке сортировки ключей
 */
export function expectedTree(files, { dstRoot }) {
  const tree = new Map();
  for (const fileRel of [...files.keys()].sort()) {
    const content = files.get(fileRel);
    tree.set(
      fileRel,
      fileRel.endsWith('.md')
        ? Buffer.from(rewriteLinks(content.toString('utf8'), { fileRel, srcRoot: SOURCE_ROOT, dstRoot }))
        : content,
    );
  }
  return tree;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** sha256 дерева: не зависит от порядка вставки в `Map`; маркер в хеш не входит. */
export function treeHash(tree) {
  const hash = createHash('sha256');
  for (const fileRel of [...tree.keys()].filter((key) => key !== MARKER).sort()) {
    hash.update(`${fileRel}\0${sha256(tree.get(fileRel))}\n`);
  }
  return hash.digest('hex');
}

/** Рекурсивно читает папку в `Map` (относительный posix-путь → содержимое), маркер пропускается. */
function readTree(dir) {
  const files = new Map();
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fileRel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), fileRel);
      else if (fileRel !== MARKER) files.set(fileRel, readFileSync(join(current, entry.name)));
    }
  };
  walk(dir, '');
  return files;
}

/** Читает источник скилла из `<root>/skills/tilda-manager`. */
export function readSkillSource({ root = repoRoot() } = {}) {
  return readTree(join(root, ...SKILL_SOURCE));
}

function targetOf(agent) {
  const segments = Object.hasOwn(AGENT_TARGETS, agent) ? AGENT_TARGETS[agent] : null;
  if (!segments) {
    throw new SkillInstallError(
      'SKILL_UNKNOWN_AGENT',
      '',
      msg('skillInstall.unknownAgent', { agent, allowed: Object.keys(AGENT_TARGETS).join(', ') }),
    );
  }
  return segments;
}

/**
 * Состояние установленной копии скилла.
 *
 * @param {{root?: string, agent: string}} args
 * @returns {{agent: string, path: string, state: 'missing'|'link'|'foreign'|'current'|'stale', expectedHash: string, actualHash: string|null}}
 */
export function inspectSkill({ root = repoRoot(), agent }) {
  const segments = targetOf(agent);
  const path = segments.join('/');
  const dst = join(root, ...segments);
  const expectedHash = treeHash(expectedTree(readSkillSource({ root }), { dstRoot: path }));
  const done = (state, actualHash = null) => {
    log.debug('inspectSkill', 'copy inspected', { agent, path, state });
    return { agent, path, state, expectedHash, actualHash };
  };

  let stat;
  try {
    stat = lstatSync(dst);
  } catch (error) {
    if (error.code === 'ENOENT') return done('missing');
    throw error;
  }
  if (stat.isSymbolicLink()) return done('link');
  if (!stat.isDirectory() || !existsSync(join(dst, MARKER))) return done('foreign');
  const actualHash = treeHash(readTree(dst));
  return done(actualHash === expectedHash ? 'current' : 'stale', actualHash);
}

function refuse(info) {
  if (info.state === 'link') {
    throw new SkillInstallError(
      'SKILL_TARGET_LINK',
      info.path,
      msg('skillInstall.targetLink', { path: info.path }),
    );
  }
  if (info.state === 'foreign') {
    throw new SkillInstallError(
      'SKILL_TARGET_FOREIGN',
      info.path,
      msg('skillInstall.targetForeign', { path: info.path }),
    );
  }
}

/**
 * Проверяет места установки без записи: первая же чужая папка или ярлык — ошибка.
 * Нужна `setup`, чтобы отказать до создания папки сайта.
 */
export function checkSkillTargets({ root = repoRoot(), agents }) {
  for (const agent of agents) refuse(inspectSkill({ root, agent }));
}

/**
 * Ставит или обновляет копию скилла.
 *
 * @returns {{agent: string, path: string, action: 'installed'|'updated'|'unchanged'}}
 */
export function installSkill({ root = repoRoot(), agent }) {
  const info = inspectSkill({ root, agent });
  refuse(info);
  if (info.state === 'current') {
    log.info('installSkill', 'copy is up to date', { agent, path: info.path, action: 'unchanged' });
    return { agent, path: info.path, action: 'unchanged' };
  }

  const dst = join(root, ...targetOf(agent));
  const tmp = `${dst}.tmp-${process.pid}`;
  const tree = expectedTree(readSkillSource({ root }), { dstRoot: info.path });
  try {
    rmSync(tmp, { recursive: true, force: true });
    // Родитель может быть ярлыком папки — запись проходит сквозь него.
    mkdirSync(dirname(dst), { recursive: true });
    for (const [fileRel, content] of tree) {
      const file = join(tmp, ...fileRel.split('/'));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const marker = { skill: SKILL_NAME, source: SOURCE_ROOT, sha256: info.expectedHash };
    writeFileSync(join(tmp, MARKER), `${JSON.stringify(marker)}\n`);
    if (info.state === 'stale') {
      log.warn('installSkill', 'removing outdated copy', { agent, path: info.path });
      // Состояние `stale` значит: настоящая папка с маркером (проверено выше).
      rmSync(dst, { recursive: true, force: true });
    }
    renameSync(tmp, dst);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  const action = info.state === 'stale' ? 'updated' : 'installed';
  log.info('installSkill', 'copy written', { agent, path: info.path, action });
  return { agent, path: info.path, action };
}
