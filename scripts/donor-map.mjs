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
import { messageText, msg } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';

const log = createLogger('donor-map');

/**
 * Причины несопоставления: имя → ключ словаря. Подстановки: `noRole` {role}, `noMatch` {path},
 * `ambiguous` {path, n}. В результате причина — `Message` и рядом её имя в поле `code`.
 */
export const MAP_REASONS = {
  noUrl: 'donorMap.reason.noUrl',
  noRole: 'donorMap.reason.noRole',
  noMatch: 'donorMap.reason.noMatch',
  ambiguous: 'donorMap.reason.ambiguous',
  missing: 'donorMap.reason.missing',
};

/** Несопоставленная метка: причина по имени из `MAP_REASONS` с подстановками. */
const unmatchedBy = (code, params) => ({ code, reason: msg(MAP_REASONS[code], params) });

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
  if (entry.missing) return unmatchedBy('missing');
  if (entry.role === 'header' || entry.role === 'footer') {
    const found = byRole(donorPages, entry.role);
    return found.length ? { page: found[0], by: 'role' } : unmatchedBy('noRole', { role: entry.role });
  }
  const path = referencePath(entry.url);
  if (path === null) return unmatchedBy('noUrl');
  if (path === '') {
    const found = byRole(donorPages, 'index');
    return found.length ? { page: found[0], by: 'index' } : unmatchedBy('noRole', { role: 'index' });
  }
  // Страница без alias живёт по адресу /page<pageid>.html — ID донора прямо в пути.
  const byId = path.match(/^\/page(\d+)\.html$/i);
  if (byId) {
    const found = donorPages.filter((p) => String(p.pageid) === byId[1]);
    return found.length ? { page: found[0], by: 'pageid' } : unmatchedBy('noMatch', { path });
  }
  const wanted = normalizeAlias(path);
  const candidates = donorPages.filter((p) => normalizeAlias(p.alias) === wanted);
  if (candidates.length === 0) return unmatchedBy('noMatch', { path });
  if (candidates.length > 1) return unmatchedBy('ambiguous', { path, n: candidates.length });
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
      unmatched.push({ label: entry.label, code: r.code, reason: r.reason });
      log.warn('matchDonorPages', 'метка без пары', { label: entry.label, reason: messageText(r.reason) });
    }
  }
  log.info('matchDonorPages', 'сопоставлено', { matched: matched.length, unmatched: unmatched.length });
  return { site: copy, matched, unmatched };
}

/** Перечень страниц донора из файла `donor pages` (`pages/<donorProjectId>.json`). */
export function readDonorPages(donorProjectId, { pagesDir } = {}) {
  const file = join(pagesDir ?? join(baselineDir(), 'pages'), `${donorProjectId}.json`);
  if (!existsSync(file)) throw new ToolError('NO_DONOR_PAGES', msg('donorMap.noDonorPages', { file: file.replace(/\\/g, '/') }));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const pages = Array.isArray(data.pages) ? data.pages : [];
  log.debug('readDonorPages', 'перечень донора прочитан', { file: file.replace(/\\/g, '/'), pages: pages.length, captured: data.captured });
  return pages;
}

/** Файловая: читает site.json и перечень донора, пишет site.json, возвращает итог matchDonorPages + path. */
export function mapDonorPages({ slug, donorProjectId, baseDir, pagesDir }) {
  const site = readSite(slug, { baseDir });
  if (!site) throw new ToolError('NO_SITE', msg('donorMap.noSite', { slug }));
  const donorPages = readDonorPages(donorProjectId, { pagesDir });
  const result = matchDonorPages(site, donorPages);
  const path = writeSite(slug, result.site, { baseDir });
  log.info('mapDonorPages', 'карта донора записана', { slug, matched: result.matched.length, unmatched: result.unmatched.length });
  return { ...result, path: path.replace(/\\/g, '/') };
}
