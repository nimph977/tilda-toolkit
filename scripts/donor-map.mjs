/**
 * Карта донора (`donor map`): метки карты сайта слепка (`P00…`, `HDR`, `FTR`) ↔ страницы проекта
 * донора из перечня `donor pages`. Сопоставление чистое и без сети: шапка и подвал — по роли
 * страницы донора, главная — по роли `index`, остальные — по совпадению пути страницы референса
 * с `alias` страницы донора. Результат пишется в `site.json` полями `donorPageid`/`donorTitle`.
 *
 * Причины несопоставления — именованная таксономия `MAP_REASONS`: человек решает, добавить ли
 * пару вручную (`donor copy --from <pageid>`), по причине, а не по одному общему слову.
 * Заголовки страниц донора на уровне INFO не печатаются (в них имя компании).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { readSite, writeSite } from './lib/reference-store.mjs';

const log = createLogger('donor-map');

export const MAP_REASONS = {
  noUrl: 'у метки нет адреса референса (шапка/подвал сопоставляются по роли)',
  noRole: (role) => `у донора нет страницы с ролью ${role}`,
  noMatch: (path) => `у донора нет страницы с адресом ${path}`,
  ambiguous: (path, n) => `адресу ${path} соответствует ${n} страниц донора`,
  missing: 'страница пропала из слепка (missing)',
};

function mapError(message, code, exitCode = 1) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = exitCode;
  return err;
}

/** Путь страницы референса для сопоставления: pathname без завершающего "/", "" для главной; null если url нет или битый. */
export function referencePath(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // битые проценты — путь как есть
  }
  path = path.replace(/\/+$/, '');
  return path === '' ? '' : path;
}

/** alias донора → без ведущих и завершающих "/", в нижнем регистре. */
export function normalizeAlias(alias) {
  return String(alias ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

const byRole = (donorPages, role) => donorPages.filter((p) => p.role === role);

function matchOne(entry, donorPages) {
  if (entry.missing) return { reason: MAP_REASONS.missing };
  if (entry.role === 'header' || entry.role === 'footer') {
    const found = byRole(donorPages, entry.role);
    return found.length ? { page: found[0], by: 'role' } : { reason: MAP_REASONS.noRole(entry.role) };
  }
  const path = referencePath(entry.url);
  if (path === null) return { reason: MAP_REASONS.noUrl };
  if (path === '') {
    const found = byRole(donorPages, 'index');
    return found.length ? { page: found[0], by: 'index' } : { reason: MAP_REASONS.noRole('index') };
  }
  // Страница без alias живёт по адресу /page<pageid>.html — ID донора прямо в пути.
  const byId = path.match(/^\/page(\d+)\.html$/i);
  if (byId) {
    const found = donorPages.filter((p) => String(p.pageid) === byId[1]);
    return found.length ? { page: found[0], by: 'pageid' } : { reason: MAP_REASONS.noMatch(path) };
  }
  const wanted = normalizeAlias(path);
  const candidates = donorPages.filter((p) => normalizeAlias(p.alias) === wanted);
  if (candidates.length === 0) return { reason: MAP_REASONS.noMatch(path) };
  if (candidates.length > 1) return { reason: MAP_REASONS.ambiguous(path, candidates.length) };
  return { page: candidates[0], by: 'alias' };
}

/**
 * Чистая: возвращает { site, matched, unmatched }; `site` — новая копия с полями donorPageid/donorTitle
 * у сопоставленных записей; у несопоставленных эти поля удалены (старое значение не остаётся).
 */
export function matchDonorPages(site, donorPages) {
  const copy = structuredClone(site);
  const pages = Array.isArray(donorPages) ? donorPages : [];
  const matched = [];
  const unmatched = [];
  for (const entry of copy.pages ?? []) {
    const r = matchOne(entry, pages);
    if (r.page) {
      entry.donorPageid = String(r.page.pageid);
      entry.donorTitle = String(r.page.title ?? '');
      matched.push({ label: entry.label, donorPageid: entry.donorPageid, donorTitle: entry.donorTitle, by: r.by });
      log.debug('matchDonorPages', 'пара найдена', { label: entry.label, donorPageid: entry.donorPageid, by: r.by });
    } else {
      delete entry.donorPageid;
      delete entry.donorTitle;
      unmatched.push({ label: entry.label, reason: r.reason });
      log.warn('matchDonorPages', 'метка без пары', { label: entry.label, reason: r.reason });
    }
  }
  log.info('matchDonorPages', 'сопоставлено', { matched: matched.length, unmatched: unmatched.length });
  return { site: copy, matched, unmatched };
}

/** Перечень страниц донора из файла `donor pages` (`pages/<donorProjectId>.json`). */
export function readDonorPages(donorProjectId, { pagesDir } = {}) {
  const file = join(pagesDir ?? join(baselineDir(), 'pages'), `${donorProjectId}.json`);
  if (!existsSync(file)) throw mapError(`перечня страниц донора нет (${file.replace(/\\/g, '/')}): сначала donor pages`, 'NO_DONOR_PAGES', 1);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const pages = Array.isArray(data.pages) ? data.pages : [];
  log.debug('readDonorPages', 'перечень донора прочитан', { file: file.replace(/\\/g, '/'), pages: pages.length, captured: data.captured });
  return pages;
}

/** Файловая: читает site.json и перечень донора, пишет site.json, возвращает итог matchDonorPages + path. */
export function mapDonorPages({ slug, donorProjectId, baseDir, pagesDir }) {
  const site = readSite(slug, { baseDir });
  if (!site) throw mapError(`карты сайта ${slug} нет: сначала reference pages --slug ${slug}`, 'NO_SITE', 1);
  const donorPages = readDonorPages(donorProjectId, { pagesDir });
  const result = matchDonorPages(site, donorPages);
  const path = writeSite(slug, result.site, { baseDir });
  log.info('mapDonorPages', 'карта донора записана', { slug, matched: result.matched.length, unmatched: result.unmatched.length });
  return { ...result, path: path.replace(/\\/g, '/') };
}
