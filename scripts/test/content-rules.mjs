/**
 * Общие правила содержимого продукта: рабочая среда автора, ID Tilda, личные пути и адреса.
 * Одни и те же правила проверяют рабочее дерево (тесты) и всю историю (`.github/scripts/history-scan.mjs`).
 * Функции чистые: без сети, файлов и запуска git. Файл не `*.test.mjs`, `node --test` его не запускает.
 */
import { isProductPath } from './product-files.mjs';

/** Склейка частей: правило не срабатывает на собственный исходный текст. */
export const j = (...parts) => parts.join('');

export const RULES = [
  ['toolchain', new RegExp(j('ai', '-fac', 'tory', '|', 'AI', ' Fac', 'tory'), 'i')],
  ['toolchain-command', new RegExp(j('(^|[^a-z0-9])', 'ai', 'f-[a-z]'), 'i')],
  ['agent-dirs', new RegExp(j('\\.', '(cla', 'ude|age', 'nts|co', 'dex)/'), 'i')],
  ['mcp-config', new RegExp(j('\\.', 'mc', 'p\\.json'), 'i')],
  ['work-notes', new RegExp(j('(back', 'log|BU', 'GS|RU', 'LES|ROAD', 'MAP|DESCRIP', 'TION|ARCHI', 'TECTURE)\\.md|known-', 'limits'))],
  ['decision-id', new RegExp(j('\\b(D', 'EC|R', 'EQ|O', 'Q|RI', 'SK|FI', 'ND)-\\d{3}\\b|\\bA', 'DR-\\d{4}\\b'))],
  ['task-ref', new RegExp(j('[Зз]ада', 'ч[аеиуй]?\\s+\\d|\\bTa', 'sk \\d'))],
  ['plan-ref', new RegExp(j('(пла', 'н|бан', 'дл|разве', 'дк)[а-я]*\\s+`?[a-z0-9]+(?:-[a-z0-9]+)+`?'), 'i')],
  ['coauthor', new RegExp(j('co-', 'authored-', 'by'), 'i')],
  ['personal-path', new RegExp(j('\\b[A-Za-z]:[\\\\/](Us', 'ers[\\\\/](?!<you>)|AI_', 'Projects|Cla', 'ude_)|/Us', 'ers/[a-z]|/ho', 'me/[a-z]'))],
];

/**
 * Два пути, куда `setup` ставит копию скилла; остальные упоминания папок агентов остаются находками.
 * Граница `(?![\w-])` не даёт разрешить соседнее имя вроде `tilda-manager-x`.
 */
export const ALLOWED_AGENT_PATHS = new RegExp(j('\\.', '(cla', 'ude|age', 'nts)/skills/tilda-manager(?![\\w-])/?'), 'gi');

/** CI сам проверяет отсутствие рабочих файлов и должен их называть. */
export const SELF_CHECKS = new Set(['.github/workflows/ci.yml']);

export const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
export const ALLOWED_EMAIL_DOMAIN = /@(?:[A-Za-z0-9-]+\.)*(?:test|invalid|example|example\.(?:com|org|net)|users\.noreply\.github\.com)$/i;

/** Адрес, которым GitHub подписывает коммиты из веб-интерфейса; собран из частей, чтобы не стать находкой. */
export const GITHUB_NOREPLY = j('noreply', '@github', '.com');

/** Числа из 7–10 знаков — форма настоящих ID страниц, блоков и элементов Tilda. */
export const ID_PATTERN = /\b\d{7,10}\b/g;

/** Разрешённые значения; список не расширять — синтетические ID берите 13-значные. */
export const ID_ALLOWLIST = new Set([
  '2147483647', // CSS z-index max в scripts/map-blocks.mjs:90, не ID Tilda
]);

/** Имена правил, сработавших на строке, после вычёркивания разрешённых путей установки скилла. */
export function lineHits(line) {
  const checked = line.replace(ALLOWED_AGENT_PATHS, '');
  return RULES.filter(([, re]) => re.test(checked)).map(([name]) => name);
}

/** Адреса почты в строке, кроме разрешённых доменов. */
export function emailHits(line) {
  return [...line.matchAll(EMAIL)].map((match) => match[0]).filter((address) => !ALLOWED_EMAIL_DOMAIN.test(address));
}

/** Числа формы ID в строке, кроме разрешённых. */
export function idHits(line) {
  return [...line.matchAll(ID_PATTERN)].map((match) => match[0]).filter((value) => !ID_ALLOWLIST.has(value));
}

/** Имена всех сработавших правил для строки; найденный текст не возвращается. */
export function scanLine(line) {
  return [...lineHits(line), ...(emailHits(line).length ? ['email'] : []), ...(idHits(line).length ? ['id'] : [])];
}

const COMMIT_MARK = '__COMMIT__';
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Находки в добавленных строках файлов продукта. Вход — вывод
 * `git log --branches --remotes --tags --no-color --no-renames --unified=0 --format=__COMMIT__%H -p`.
 * Номер строки считается в новом файле от заголовка `@@ -a,b +c,d @@`; строки заголовка файла (`+++`) не считаются.
 * @returns {Array<{commit: string, path: string, hunkLine: number, rules: string[]}>}
 */
export function parseLogPatch(text) {
  const found = [];
  let commit = '';
  let path = '';
  let scanned = false;
  let inHunk = false;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(COMMIT_MARK.length).trim();
      scanned = false;
      inHunk = false;
    } else if (line.startsWith('diff --git ')) {
      const at = line.lastIndexOf(' b/');
      path = at === -1 ? '' : line.slice(at + 3).trim();
      scanned = path !== '' && isProductPath(path) && !SELF_CHECKS.has(path);
      inHunk = false;
    } else if (line.startsWith('@@')) {
      const match = HUNK_HEADER.exec(line);
      inHunk = match !== null;
      if (match) newLine = Number(match[1]);
    } else if (inHunk && line.startsWith('+')) {
      if (scanned) {
        const rules = scanLine(line.slice(1));
        if (rules.length > 0) found.push({ commit, path, hunkLine: newLine, rules });
      }
      newLine += 1;
    }
  }
  return found;
}

/**
 * Находки в метаданных коммитов: адреса автора и коммиттера, текст сообщения. Вход — вывод
 * `git log --branches --remotes --tags --no-color --format=__COMMIT__%H%n%ae%n%ce%n%B`.
 * Общий адрес GitHub без имени (`GITHUB_NOREPLY`) допустим: так GitHub подписывает коммиты из веб-интерфейса.
 * @returns {Array<{commit: string, field: 'author'|'committer'|'message', rules: string[]}>}
 */
export function parseLogMeta(text) {
  const found = [];
  let commit = '';
  let step = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      commit = line.slice(COMMIT_MARK.length).trim();
      step = 1;
    } else if (step === 1 || step === 2) {
      const field = step === 1 ? 'author' : 'committer';
      const address = line.trim();
      if (address !== '' && address !== GITHUB_NOREPLY && !ALLOWED_EMAIL_DOMAIN.test(address)) {
        found.push({ commit, field, rules: ['email'] });
      }
      step += 1;
    } else if (step === 3) {
      const rules = scanLine(line);
      if (rules.length > 0) found.push({ commit, field: 'message', rules });
    }
  }
  return found;
}
