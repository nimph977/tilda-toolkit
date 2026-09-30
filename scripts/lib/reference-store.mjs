/**
 * Хранилище слепка референс-сайта: имена страниц, пути, манифест, имена файлов картинок.
 *
 * Раскладка: `<TILDA_REFERENCE_DIR>/<slug>/{reference.json, site.json, pages/, structure/, images/}`.
 * `site.json` — карта сайта: метка страницы (`P00`…, `HDR`, `FTR`) ↔ страница слепка ↔ новый `pageid`
 * (в отчётах и планах страница называется меткой, а не именем слепка).
 * Слепок живёт вне git: домен и содержимое референса в репозиторий не попадают,
 * `slug` выбирает пользователь, домен в путях не участвует.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from './log.mjs';
import { msg } from './i18n.mjs';
import { ToolError } from './tool-error.mjs';
import { referenceDir } from './paths.mjs';

const log = createLogger('reference-store');

/** Подпапки слепка: по ним в старых путях манифеста находится начало пути от папки слепка. */
const SNAPSHOT_SUBDIRS = new Set(['pages', 'images', 'structure', 'shots', 'reports']);

/** Значение `pathBase` манифеста: пути файлов считаются от папки слепка `<TILDA_REFERENCE_DIR>/<slug>/`. */
export const MANIFEST_PATH_BASE = 'snapshot';

/** Допустимое имя слепка: латиница, цифры, дефис; до 40 символов. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Расширения картинок, которые потом примет `upload` (см. `scripts/upload.mjs`, ALLOWED_TYPES). */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** Проверяет имя слепка; ошибка → код выхода 2. */
export function assertSlug(slug) {
  if (typeof slug === 'string' && SLUG_RE.test(slug)) return slug;
  throw new ToolError('BAD_SLUG', msg('referenceStore.badSlug', { slug: JSON.stringify(slug), pattern: String(SLUG_RE) }), { exitCode: 2 });
}

/**
 * Имя страницы по URL: сегменты пути через `--`, только `[a-z0-9-]`, до 80 символов.
 * `https://example.test/` → `index`; `https://example.test/about/team?x=1#top` → `about--team`.
 */
export function pageNameFromUrl(url) {
  const { pathname } = new URL(url);
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // битые проценты — оставляем как есть
  }
  const trimmed = decoded.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'index';
  const name = trimmed
    .toLowerCase()
    .split('/')
    .map((segment) => segment.replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-'))
    .join('--');
  return name.slice(0, 80);
}

/** Пути слепка; `opts.baseDir` подменяет `referenceDir()` (нужно тестам). */
export function refPaths(slug, opts = {}) {
  const root = join(opts.baseDir || referenceDir(), slug);
  return {
    root,
    pages: join(root, 'pages'),
    images: join(root, 'images'),
    structure: join(root, 'structure'),
    manifest: join(root, 'reference.json'),
    site: join(root, 'site.json'),
  };
}

/** Создаёт каталоги слепка. */
export function ensureDirs(slug, opts) {
  const paths = refPaths(slug, opts);
  for (const dir of [paths.pages, paths.images, paths.structure]) mkdirSync(dir, { recursive: true });
  log.debug('ensureDirs', 'directories ready', { root: paths.root });
  return paths;
}

/** Абсолютный путь файла слепка по пути из манифеста (от папки слепка). */
export function snapshotFile(paths, rel) {
  return resolve(paths.root, rel);
}

/**
 * Старый путь манифеста (от корня репозитория или с `..`) → путь от папки слепка:
 * берётся хвост после сегмента `<slug>/<подпапка слепка>`. Не разобран → null.
 */
export function toSnapshotRelative(rel, slug) {
  const segs = String(rel ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    if (segs[i] === slug && SNAPSHOT_SUBDIRS.has(segs[i + 1])) return segs.slice(i + 1).join('/');
  }
  return null;
}

/**
 * Перевод старого манифеста на пути от папки слепка (меняет объект на месте).
 * Не разобранные пути сбрасываются: картинка скачается заново при `reference fetch --images`.
 * @returns {{ manifest: object, converted: number, dropped: number }}
 */
export function normalizeManifest(manifest, slug) {
  if (manifest.pathBase === MANIFEST_PATH_BASE) return { manifest, converted: 0, dropped: 0 };
  let converted = 0;
  let dropped = 0;
  for (const [src, rel] of Object.entries(manifest.images ?? {})) {
    const next = toSnapshotRelative(rel, slug);
    if (next === null) {
      delete manifest.images[src];
      dropped += 1;
    } else {
      manifest.images[src] = next;
      converted += 1;
    }
  }
  for (const page of manifest.pages ?? []) {
    if (!page.file) continue;
    const next = toSnapshotRelative(page.file, slug);
    if (next === null) dropped += 1;
    else converted += 1;
    page.file = next;
  }
  manifest.pathBase = MANIFEST_PATH_BASE;
  return { manifest, converted, dropped };
}

/** Читает манифест (старые пути переводятся на пути от папки слепка); нет файла → null; битый JSON → ошибка. */
export function readManifest(slug, opts) {
  const { manifest } = refPaths(slug, opts);
  if (!existsSync(manifest)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (e) {
    log.error('readManifest', 'manifest could not be parsed', { path: manifest, error: e.message });
    throw e;
  }
  const { converted, dropped } = normalizeManifest(data, slug);
  if (converted || dropped) log.info('readManifest', 'manifest converted to paths relative to the snapshot folder', { slug, converted, dropped });
  if (dropped) log.warn('readManifest', 'some manifest paths could not be resolved, entries dropped', { slug, dropped });
  return data;
}

/** Пишет манифест; возвращает путь. */
export function writeManifest(slug, manifest, opts) {
  const { manifest: path } = refPaths(slug, opts);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  log.debug('writeManifest', 'manifest written', { path, pages: manifest.pages?.length ?? 0 });
  return path;
}

/**
 * Новый манифест. Элемент `pages[]`: `{ name, url, file, status, title, blocks, fetchedAt, error }`;
 * `images` — объект `src → путь файла относительно папки слепка` (`pathBase: 'snapshot'`).
 */
export function newManifest({ slug, url }) {
  return { slug, url, pathBase: MANIFEST_PATH_BASE, createdAt: new Date().toISOString(), fetchedAt: null, pages: [], images: {} };
}

/** Имя файла картинки: 12 hex-символов sha1(src) + расширение из пути (или `.bin`). */
export function imageFileName(src) {
  const hash = createHash('sha1').update(String(src)).digest('hex').slice(0, 12);
  let ext = '.bin';
  try {
    const candidate = extname(new URL(src).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(candidate)) ext = candidate;
  } catch {
    // не URL — остаётся .bin
  }
  return hash + ext;
}

/** Заменяет запись страницы с тем же `name` или добавляет новую. */
export function upsertPage(manifest, entry) {
  const index = manifest.pages.findIndex((p) => p.name === entry.name);
  if (index === -1) manifest.pages.push(entry);
  else manifest.pages[index] = entry;
  return manifest;
}

/** Метка страницы карты сайта: `P00`…`P99`, `P100`…, `HDR` (шапка), `FTR` (подвал). */
export const LABEL_RE = /^(P\d{2,}|HDR|FTR)$/;

export function isLabel(s) {
  return LABEL_RE.test(String(s ?? ''));
}

/** Пустая карта сайта. `substitutes` — замены шаблонов `{ "770": "794" }`, пишутся руками. */
export function newSite(slug) {
  const createdAt = new Date().toISOString();
  return { slug, projectid: null, createdAt, updatedAt: createdAt, substitutes: {}, pages: [] };
}

/** Читает карту сайта; нет файла → null; битый JSON → ошибка. */
export function readSite(slug, opts) {
  const { site } = refPaths(slug, opts);
  if (!existsSync(site)) return null;
  try {
    return JSON.parse(readFileSync(site, 'utf8'));
  } catch (e) {
    log.error('readSite', 'site map could not be parsed', { path: site, error: e.message });
    throw e;
  }
}

/** Пишет карту сайта (`updatedAt` = сейчас); возвращает путь. */
export function writeSite(slug, site, opts) {
  const paths = refPaths(slug, opts);
  mkdirSync(paths.root, { recursive: true });
  site.updatedAt = new Date().toISOString();
  writeFileSync(paths.site, JSON.stringify(site, null, 2) + '\n', 'utf8');
  log.debug('writeSite', 'site map written', { path: paths.site, pages: site.pages.length });
  return paths.site;
}

const labelNumber = (label) => (/^P\d+$/.test(label) ? Number(label.slice(1)) : -1);
const formatLabel = (n) => 'P' + String(n).padStart(2, '0');

/**
 * Метки страниц карты сайта по манифесту слепка (чистая, меняет и возвращает `site`).
 * Страница `ok` без метки получает следующую `P<n>`; метки стабильны и не переиспользуются:
 * исчезнувшая из слепка страница остаётся с `missing: true`. `HDR`/`FTR` добавляются по флагам.
 * Порядок: `HDR`, `FTR`, затем `P` по номеру.
 * @returns {{ site: object, added: string[], missing: string[] }}
 */
export function assignLabels(site, manifest, { header = false, footer = false } = {}) {
  const okPages = (manifest?.pages ?? []).filter((p) => p.status === 'ok');
  const okNames = new Set(okPages.map((p) => p.name));
  const added = [];
  let next = Math.max(-1, ...site.pages.map((p) => labelNumber(p.label))) + 1;
  for (const p of okPages) {
    const known = site.pages.find((e) => e.role === 'content' && e.name === p.name);
    if (known) {
      if (known.missing) delete known.missing;
      known.url = p.url;
      continue;
    }
    const label = formatLabel(next);
    next += 1;
    site.pages.push({ label, role: 'content', name: p.name, url: p.url, pageid: null });
    added.push(label);
  }
  const missing = [];
  for (const e of site.pages) {
    if (e.role !== 'content' || okNames.has(e.name)) continue;
    e.missing = true;
    missing.push(e.label);
  }
  for (const [flag, label, role] of [[header, 'HDR', 'header'], [footer, 'FTR', 'footer']]) {
    if (flag && !site.pages.some((e) => e.label === label)) {
      site.pages.push({ label, role, pageid: null });
      added.push(label);
    }
  }
  const rank = (e) => (e.label === 'HDR' ? -2 : e.label === 'FTR' ? -1 : labelNumber(e.label));
  site.pages.sort((a, b) => rank(a) - rank(b));
  log.debug('assignLabels', 'labels assigned', { total: site.pages.length, added: added.length, missing: missing.length });
  return { site, added, missing };
}

/** Запись карты сайта по метке или null. */
export function resolveSource(site, label) {
  return site?.pages?.find((e) => e.label === label) ?? null;
}
