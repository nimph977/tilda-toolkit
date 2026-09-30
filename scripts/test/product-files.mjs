/**
 * Файлы продукта для тестов на содержимое: корни, обход, относительные пути.
 * Отсутствующий корень пропускается — список общий для всех тестов.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

export const PRODUCT_DIRS = ['scripts', 'docs', 'examples', 'skills', 'locales', '.github'];

export const PRODUCT_FILES = [
  'README.md', 'README.ru.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'package.json', '.env.example', '.gitignore', '.gitattributes',
];

export const PRODUCT_ROOTS = [...PRODUCT_DIRS, ...PRODUCT_FILES];

export const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.md', '.json', '.example', '.yml', '.yaml']);

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_PATHS = new Set(['scripts/plans']);

/**
 * Относится ли путь (с `/`, от корня репозитория) к файлам продукта. Сравнение по сегментам:
 * `scripts-old/x.mjs` и `docsx/a.md` — не продукт. Та же выборка, что у `listProductFiles`.
 */
export function isProductPath(path) {
  if (PRODUCT_FILES.includes(path)) return true;
  const segments = path.split('/');
  if (segments.length < 2 || !PRODUCT_DIRS.includes(segments[0])) return false;
  if (segments.some((segment) => SKIP_DIRS.has(segment))) return false;
  for (const skipped of SKIP_PATHS) {
    if (path === skipped || path.startsWith(`${skipped}/`)) return false;
  }
  return TEXT_EXTENSIONS.has(extname(segments.at(-1)));
}

export function rel(path) {
  return relative(ROOT, path).replace(/\\/g, '/');
}

function walk(dir, out, extensions) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (SKIP_DIRS.has(entry) || SKIP_PATHS.has(rel(path))) continue;
    if (statSync(path).isDirectory()) walk(path, out, extensions);
    else if (extensions.has(extname(entry))) out.push(path);
  }
}

/** Абсолютные пути файлов продукта; корень-файл берётся всегда, файлы в папках — по расширению. */
export function listProductFiles({ roots = PRODUCT_ROOTS, extensions = TEXT_EXTENSIONS } = {}) {
  const out = [];
  for (const root of roots) {
    const path = join(ROOT, root);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path, out, extensions);
    else out.push(path);
  }
  return out;
}
