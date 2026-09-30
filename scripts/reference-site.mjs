/**
 * Карта сайта референса: метки страниц (`P00`…, `HDR`, `FTR`) ↔ страницы слепка ↔ новые `pageid`.
 *
 * `syncSite` строит или обновляет `TILDA_REFERENCE_DIR/<slug>/site.json` по манифесту и структурам
 * слепка без сети. Имена страниц слепка и адреса референса не выводятся и не логируются — только
 * метки: имя `page<id>-html` несёт ID страницы референса.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { msg } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { baselineDir } from './lib/paths.mjs';
import { cliHint } from './lib/site.mjs';
import { assertSlug, assignLabels, isLabel, newSite, readManifest, readSite, refPaths, resolveSource, writeSite } from './lib/reference-store.mjs';
import { collectUrls } from './link-check.mjs';

const log = createLogger('reference-site');

function siteError(message, code, exitCode) {
  return new ToolError(code, message, { exitCode });
}

/** Есть ли в структурах слепка блоки шапки и подвала (`counts.zones`). */
function zonesPresent(paths) {
  const found = { header: false, footer: false };
  if (!existsSync(paths.structure)) return found;
  for (const file of readdirSync(paths.structure)) {
    if (!file.endsWith('.json')) continue;
    const zones = JSON.parse(readFileSync(join(paths.structure, file), 'utf8')).counts?.zones;
    if (zones?.header > 0) found.header = true;
    if (zones?.footer > 0) found.footer = true;
    if (found.header && found.footer) break;
  }
  return found;
}

/** Пауза между созданиями страниц, мс. */
export const SITE_CREATE_DELAY_MS = 3000;
/** Предохранитель: лимит Tilda — 100 новых страниц в сутки, повторные сборки тоже считаются. */
export const SITE_CREATE_GUARD = 90;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Создать в проекте пустые страницы для записей карты без `pageid` (по одной, пауза `delayMs`).
 * `pageid` пишется в `site.json` сразу после каждой страницы — сбой или лимит Tilda не теряют
 * созданные. Вызов `createPage` не повторяется: повтор после сбоя мог бы создать лишнюю страницу.
 * @returns {Promise<{created: string[], skipped: string[], left: string[], path: string}>}
 */
export async function createSitePages(driver, { slug, projectid, delayMs = SITE_CREATE_DELAY_MS, sleep = defaultSleep, baseDir } = {}) {
  assertSlug(slug);
  const site = readSite(slug, { baseDir });
  if (!site) throw siteError(msg('referenceSite.noSite', { slug }), 'NO_SITE', 1);
  const pid = String(projectid);
  if (site.projectid && String(site.projectid) !== pid) {
    log.error('createSitePages', 'карта сайта создана для другого проекта', { slug, siteProject: String(site.projectid), projectid: pid });
    throw siteError(msg('referenceSite.projectMismatch', { slug, projectid: site.projectid, pid }), 'SITE_PROJECT_MISMATCH', 1);
  }
  const todo = site.pages.filter((p) => !p.pageid && !p.missing);
  const skipped = site.pages.filter((p) => p.pageid).map((p) => p.label);
  if (todo.length > SITE_CREATE_GUARD) {
    log.error('createSitePages', 'страниц к созданию больше предохранителя', { todo: todo.length, guard: SITE_CREATE_GUARD });
    throw siteError(msg('referenceSite.createGuard', { count: todo.length, guard: SITE_CREATE_GUARD }), 'SITE_CREATE_GUARD', 1);
  }
  site.projectid = pid;
  let path = writeSite(slug, site, { baseDir });
  log.info('createSitePages', 'создание страниц карты', { slug, todo: todo.length, skipped: skipped.length });
  const created = [];
  const titleFailed = [];
  const { createPage, pageTitleFor, setPageTitle } = await import('./page-ops.mjs');
  for (const [i, entry] of todo.entries()) {
    if (i > 0) await sleep(delayMs);
    try {
      const r = await createPage(driver, { projectid: pid });
      entry.pageid = r.pageid;
      entry.createdAt = new Date().toISOString();
      path = writeSite(slug, site, { baseDir });
      created.push(entry.label);
      log.info('createSitePages', 'страница создана', { label: entry.label, pageid: r.pageid });
      // Заголовок по метке: ошибка заголовка не откатывает создание страницы.
      try {
        await setPageTitle(driver, r.pageid, pageTitleFor(entry));
      } catch (e) {
        titleFailed.push(entry.label);
        log.warn('createSitePages', 'заголовок не записан', { label: entry.label, pageid: r.pageid, error: String(e.message || e).slice(0, 160) });
      }
    } catch (e) {
      const left = site.pages.filter((p) => !p.pageid && !p.missing).map((p) => p.label);
      if (e.code === 'PAGE_LIMIT') log.warn('createSitePages', 'лимит Tilda на новые страницы', { created: created.length, left: left.length });
      else log.error('createSitePages', 'страница не создана', { label: entry.label, error: String(e.message || e).slice(0, 200) });
      e.created = created;
      e.left = left;
      e.path = path;
      throw e;
    }
  }
  const left = site.pages.filter((p) => !p.pageid && !p.missing).map((p) => p.label);
  return { created, skipped, left, path, titleFailed };
}

/** Виды нарушений проверки ссылок собранной страницы. */
export const AUDIT_KINDS = {
  referenceDomain: 'referenceDomain',
  unknownPage: 'unknownPage',
  previewNoPage: 'previewNoPage',
  noAliasPage: 'noAliasPage',
  donorPage: 'donorPage',
};

/**
 * Сообщение с названием вида нарушения для итога и докладов; неизвестный вид возвращается
 * как есть.
 */
export function auditKindMessage(kind) {
  if (kind === AUDIT_KINDS.referenceDomain) return msg('referenceSite.auditKind.referenceDomain');
  if (kind === AUDIT_KINDS.unknownPage) return msg('referenceSite.auditKind.unknownPage');
  if (kind === AUDIT_KINDS.previewNoPage) return msg('referenceSite.auditKind.previewNoPage');
  if (kind === AUDIT_KINDS.noAliasPage) return msg('referenceSite.auditKind.noAliasPage');
  if (kind === AUDIT_KINDS.donorPage) return msg('referenceSite.auditKind.donorPage');
  return kind;
}

/** Адрес страницы для сверки: без ведущих и завершающих "/", нижний регистр, с ведущим "/". */
const aliasPath = (alias) => `/${String(alias ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase()}`;

const PAGE_PATH_RE = /^\/page(\d+)\.html$/;

/**
 * Чистая проверка ссылок HTML вида страницы: нет адресов на домен референса, каждая ссылка на
 * страницу (`/page<id>.html` или адрес предпросмотра Тильды с `pageid`) ведёт на страницу проекта;
 * с `knownAliases` (адреса страниц проекта, `/company`) — относительный адрес (`href="/company"`)
 * ведёт на страницу проекта с таким адресом, иначе на публикации он даст 404. С `donorPageIds`
 * (ID страниц донора из карты сайта) ссылка на такую страницу — отдельный вид `donorPage`: её
 * чинит `donor links`, а не ручная правка.
 * Нарушения сгруппированы по (вид, путь); домен в путях не участвует.
 * @returns {{ total: number, internal: number, external: number, violations: Array<{kind: string, path: string, count: number}> }}
 */
export function auditLinks(html, { baseUrl, referenceHost, knownPageIds, knownAliases, donorPageIds }) {
  const known = new Set((knownPageIds ?? []).map(String));
  const donorIds = new Set((donorPageIds ?? []).map(String));
  const unknownKind = (pageid) => (donorIds.has(pageid) ? AUDIT_KINDS.donorPage : AUDIT_KINDS.unknownPage);
  const aliases = knownAliases ? new Set([...knownAliases].map(aliasPath)) : null;
  const groups = new Map();
  const violate = (kind, path) => {
    const key = `${kind}\u0000${path}`;
    const g = groups.get(key) ?? { kind, path, count: 0 };
    g.count += 1;
    groups.set(key, g);
  };
  let total = 0;
  let internal = 0;
  let external = 0;
  for (const item of collectUrls(html, baseUrl)) {
    if (item.kind !== 'link') continue;
    total += 1;
    let u;
    try {
      u = new URL(item.url);
    } catch {
      external += 1;
      continue;
    }
    if (referenceHost && u.hostname === referenceHost) {
      violate(AUDIT_KINDS.referenceDomain, u.pathname);
      continue;
    }
    if (item.internal) {
      internal += 1;
      const pageid = u.searchParams.get('pageid');
      if (!pageid) violate(AUDIT_KINDS.previewNoPage, u.pathname);
      else if (!known.has(pageid)) violate(unknownKind(pageid), `pageid=${pageid}`);
      continue;
    }
    // Предпросмотр сам переводит адрес существующей страницы в ссылку предпросмотра (выше);
    // относительный адрес, оставшийся как есть, на публикации ведёт на 404, если страницы с ним нет.
    const raw = String(item.raw ?? '').trim();
    if (aliases && raw.startsWith('/') && !raw.startsWith('//')) {
      const path = aliasPath(raw.split(/[?#]/)[0]);
      if (path !== '/' && !PAGE_PATH_RE.test(path)) {
        internal += 1;
        if (!aliases.has(path)) violate(AUDIT_KINDS.noAliasPage, path);
        continue;
      }
    }
    const m = u.pathname.match(PAGE_PATH_RE);
    if (m) {
      internal += 1;
      if (!known.has(m[1])) violate(unknownKind(m[1]), u.pathname);
      continue;
    }
    external += 1;
  }
  const violations = [...groups.values()];
  log.debug('auditLinks', 'ссылки проверены', { total, internal, external, violations: violations.length });
  return { total, internal, external, violations };
}

/**
 * Проверка ссылок собранной страницы метки по её виду (предпросмотр): `driver.pageHtml()` →
 * `{ url, html }`. Перечень страниц проекта — файл `page list`. Итог пишется в
 * `<slug>/audit/<метка>.json` без домена референса.
 */
export async function auditPage(driver, { slug, label, projectid, baseDir, pagesFile }) {
  assertSlug(slug);
  if (!isLabel(label)) throw siteError(msg('referenceSite.labelRequired', { label: JSON.stringify(label) }), 'LABEL_REQUIRED', 2);
  const site = readSite(slug, { baseDir });
  if (!site) throw siteError(msg('referenceSite.noSite', { slug }), 'NO_SITE', 1);
  const entry = resolveSource(site, label);
  if (!entry) throw siteError(msg('referenceSite.unknownLabel', { label, slug }), 'UNKNOWN_LABEL', 2);
  if (!entry.pageid) throw siteError(msg('referenceSite.noPageid', { label, slug }), 'NO_PAGEID', 1);
  const manifest = readManifest(slug, { baseDir });
  if (!manifest) throw siteError(msg('referenceSite.noManifest', { slug }), 'NO_MANIFEST', 1);
  const file = pagesFile || join(baselineDir(), 'pages', `${projectid}.json`);
  if (!existsSync(file)) throw siteError(msg('referenceSite.noPageList', { hint: cliHint('page list') }), 'NO_PAGE_LIST', 1);
  const list = JSON.parse(readFileSync(file, 'utf8'));
  const knownPageIds = (list.pages ?? []).map((p) => String(p.pageid));
  const knownAliases = (list.pages ?? []).filter((p) => String(p.alias ?? '').trim()).map((p) => aliasPath(p.alias));
  const donorPageIds = (site.pages ?? []).filter((p) => p.donorPageid).map((p) => String(p.donorPageid));
  const { url, html } = await driver.pageHtml();
  const result = auditLinks(html, { baseUrl: url, referenceHost: new URL(manifest.url).hostname, knownPageIds, knownAliases, donorPageIds });
  for (const v of result.violations) log.warn('auditPage', 'нарушение', { label, kind: v.kind, path: v.path, count: v.count });
  const dir = join(refPaths(slug, { baseDir }).root, 'audit');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${label}.json`);
  writeFileSync(path, JSON.stringify({ label, pageid: String(entry.pageid), at: new Date().toISOString(), ...result }, null, 2) + '\n', 'utf8');
  log.info('auditPage', 'ссылки проверены', { label, total: result.total, internal: result.internal, violations: result.violations.length });
  return { ...result, label, pageid: String(entry.pageid), path };
}

/** Построить или обновить карту сайта по манифесту и структурам слепка (без сети). */
export function syncSite({ slug, baseDir }) {
  assertSlug(slug);
  const manifest = readManifest(slug, { baseDir });
  if (!manifest) throw siteError(msg('referenceSite.noManifest', { slug }), 'NO_MANIFEST', 1);
  const paths = refPaths(slug, { baseDir });
  const { header, footer } = zonesPresent(paths);
  const site = readSite(slug, { baseDir }) || newSite(slug);
  const { added, missing } = assignLabels(site, manifest, { header, footer });
  for (const label of missing) log.warn('syncSite', 'страницы нет в слепке', { label });
  const path = writeSite(slug, site, { baseDir });
  log.info('syncSite', 'карта сайта обновлена', { slug, total: site.pages.length, added: added.length, missing: missing.length, header, footer });
  return { path, site, added, missing, header, footer };
}
