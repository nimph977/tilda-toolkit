/**
 * Разбор страницы «Начало работы»: блок команд пути новичка и запрос агенту.
 * Чистая логика без файлов, сети и процессов — ею пользуются тесты, скрипт прогона
 * `.github/scripts/docs-path-check.mjs` и проверки цикла улучшения документа.
 *
 * Контракт страницы: между метками лежит ровно один блок кода нужного языка —
 * пять команд bash для пути (`PATH_MARKERS`) или текст запроса агенту (`AGENT_MARKERS`).
 */

export const PATH_MARKERS = { start: '<!-- newcomer-path:start -->', end: '<!-- newcomer-path:end -->' };
export const AGENT_MARKERS = { start: '<!-- agent-prompt:start -->', end: '<!-- agent-prompt:end -->' };

export const REPO_URL = 'https://github.com/nimph977/tilda-toolkit.git';
export const SITE_EXAMPLE = '~/tilda-sites/example-site';
/** Синтетический ID проекта: 13 цифр, как в примерах и тестах. */
export const SYNTHETIC_PROJECT = '1000000000001';

/** Пять шагов пути по порядку; заглушка ID — единственное `<…>` в команде setup. */
export const STEP_PATTERNS = [
  { step: 'clone', pattern: /^git clone https:\/\/github\.com\/nimph977\/tilda-toolkit\.git$/ },
  { step: 'cd', pattern: /^cd tilda-toolkit$/ },
  { step: 'npm', pattern: /^npm ci$/ },
  {
    step: 'setup',
    pattern: /^node scripts\/tilda\.mjs setup --site ~\/tilda-sites\/example-site --project <[^<>]+> --agent (claude|codex|all)$/,
  },
  { step: 'doctor', pattern: /^node scripts\/tilda\.mjs --site ~\/tilda-sites\/example-site doctor$/ },
];

/** Что должен по порядку содержать запрос агенту: имя пункта и подстрока. */
const AGENT_NEEDLES = [
  { name: 'repository', text: 'https://github.com/nimph977/tilda-toolkit' },
  { name: 'npm ci', text: 'npm ci' },
  { name: 'setup --site', text: 'setup --site' },
  { name: '--project', text: '--project' },
  { name: 'doctor', text: 'doctor' },
  { name: 'FAIL', text: 'FAIL' },
];

const PLACEHOLDER = /<[^<>]+>/;
const FENCE_OPEN = /^(`{3,})(\S*)\s*$/;

/** Ошибка разбора; `code` — машинная причина: MARKERS, FENCE, COMMANDS, AGENT_PROMPT. */
export class DocPathError extends Error {
  name = 'DocPathError';

  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Тело единственного блока кода между метками, без строк-ограждений.
 * @param {string} text документ целиком (CRLF допустим)
 * @param {{start: string, end: string}} markers пара меток
 * @param {'bash'|'text'} fenceLang язык блока
 * @returns {string[]} строки тела блока
 */
export function extractFenced(text, markers, fenceLang) {
  const source = text.replace(/\r\n/g, '\n');
  const starts = countOf(source, markers.start);
  const ends = countOf(source, markers.end);
  if (starts !== 1 || ends !== 1) {
    throw new DocPathError('MARKERS', `ожидается по одной метке ${markers.start} и ${markers.end}, найдено ${starts} и ${ends}`);
  }
  const from = source.indexOf(markers.start) + markers.start.length;
  const to = source.indexOf(markers.end);
  if (to < from) throw new DocPathError('MARKERS', `метка ${markers.end} стоит раньше ${markers.start}`);

  const blocks = [];
  let open = null;
  for (const line of source.slice(from, to).split('\n')) {
    if (open) {
      if (line.trim() === open.fence) {
        blocks.push(open);
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const match = FENCE_OPEN.exec(line.trim());
    if (match) open = { fence: match[1], lang: match[2], body: [] };
  }
  if (open) throw new DocPathError('FENCE', `блок ${open.lang || 'без языка'} между метками не закрыт`);
  if (blocks.length !== 1) throw new DocPathError('FENCE', `между метками ожидается один блок кода, найдено ${blocks.length}`);
  if (blocks[0].lang !== fenceLang) {
    throw new DocPathError('FENCE', `блок должен быть \`${fenceLang}\`, а он \`${blocks[0].lang || 'без языка'}\``);
  }
  return blocks[0].body;
}

/**
 * Проверяет пять команд пути; пустые строки и строки-комментарии `#` пропускаются.
 * @param {string[]} lines строки блока
 * @returns {{step: string, line: string}[]}
 */
export function parsePathCommands(lines) {
  const commands = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (line.endsWith('\\') || /&&|;|\|/.test(line)) {
      throw new DocPathError('COMMANDS', `строка ${index + 1}: одна команда на строку, без переноса \\, &&, ; и |`);
    }
    commands.push({ line, number: index + 1 });
  });
  if (commands.length !== STEP_PATTERNS.length) {
    throw new DocPathError('COMMANDS', `ожидается ${STEP_PATTERNS.length} команд, найдено ${commands.length}`);
  }
  return commands.map(({ line, number }, position) => {
    const { step, pattern } = STEP_PATTERNS[position];
    if (!pattern.test(line)) throw new DocPathError('COMMANDS', `строка ${number}: шаг ${step} не совпадает с образцом: ${line}`);
    return { step, line };
  });
}

/**
 * Запрос агенту содержит по порядку: репозиторий, `npm ci`, `setup --site`, `--project`, `doctor`, `FAIL`.
 * @param {string[]} lines строки блока `text`
 */
export function checkAgentPrompt(lines) {
  const text = lines.join('\n');
  let position = 0;
  for (const { name, text: needle } of AGENT_NEEDLES) {
    const found = text.indexOf(needle, position);
    if (found === -1) throw new DocPathError('AGENT_PROMPT', `в запросе агенту нет «${name}» на своём месте`);
    position = found + needle.length;
  }
}

/**
 * Команды для сверки en и ru: заглушка `<…>` заменяется на `<>`.
 * @param {{line: string}[]} commands
 * @returns {string[]}
 */
export function normalizeForParity(commands) {
  return commands.map(({ line }) => line.replace(new RegExp(PLACEHOLDER, 'g'), '<>'));
}

/**
 * Bash-скрипт прогона: команды как в документе, две подстановки, после каждой — код возврата.
 * Адрес клона заменяется локальным путём с явной целевой папкой, заглушка ID — синтетическим ID.
 * @param {{step: string, line: string}[]} commands
 * @param {{repoPath: string, project: string}} options
 * @returns {string}
 */
export function buildRunScript(commands, { repoPath, project }) {
  const local = `'${repoPath.replace(/\\/g, '/').replace(/'/g, `'\\''`)}' tilda-toolkit`;
  const lines = ['set -u'];
  for (const { step, line } of commands) {
    lines.push(line.split(REPO_URL).join(local).replace(PLACEHOLDER, () => project));
    lines.push(`echo "__rc ${step} $?"`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Коды возврата из вывода скрипта прогона; посторонние строки пропускаются.
 * @param {string} stdout
 * @returns {Map<string, number>}
 */
export function parseRunCodes(stdout) {
  const codes = new Map();
  for (const match of stdout.matchAll(/^__rc (\w+) (-?\d+)\s*$/gm)) codes.set(match[1], Number(match[2]));
  return codes;
}
