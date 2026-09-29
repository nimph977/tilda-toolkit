/**
 * Адреса страниц копии как у донора (`donor aliases`). Блоки перенесены байт в байт,
 * поэтому относительные ссылки донора (меню шапки `/company`, ссылки на статьи) ведут на адреса
 * страниц донора; у страниц копии таких адресов не было — посетитель попадал на 404.
 *
 * План чистый и без сети (`planAliases`): метка карты → страница донора (`donorPageid`) → её
 * `alias` из перечня `donor pages` → страница копии (`pageid`). Запись — только в тестовый проект
 * через окно настроек страницы (`page-ops.setPageAlias`). Адрес, занятый другой страницей
 * тестового проекта, не отбирается — он называется владельцу. Причины пропуска — таксономия
 * `ALIAS_REASONS`. Сами адреса повторяют адреса сайта донора, поэтому на INFO не печатаются.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { readSite } from './lib/reference-store.mjs';
import { normalizeAlias, readDonorPages } from './donor-map.mjs';
import { setPageAlias } from './page-ops.mjs';

const log = createLogger('donor-aliases');

/** Сколько отказов записи подряд останавливают прогон: повтор той же ошибки на всех страницах бесполезен. */
export const MAX_FAILURES_IN_ROW = 3;

export const ALIAS_REASONS = {
  noTestPage: 'у метки нет страницы копии (pageid) — reference pages --create или donor copy',
  noDonorPage: 'у метки нет пары у донора (donorPageid) — donor map',
  notInDonorList: 'страницы донора нет в перечне donor pages — обновить donor pages',
  notInPageList: 'страницы копии нет в перечне page list — обновить page list',
  noDonorAlias: 'у страницы донора нет адреса (живёт по page<id>.html)',
  role: (role) => `роль ${role}: адрес не нужен (${role === 'index' ? 'главная открывается по корню сайта' : 'шапка и подвал не публикуются отдельно'})`,
  same: 'адрес уже как у донора',
  taken: (who) => `адрес занят другой страницей тестового проекта (${who}) — не отбирается, решает владелец`,
  duplicate: (label) => `та же страница донора, что у метки ${label}: адрес получает ${label}`,
  protected: 'страница копии защищена (TILDA_PROTECTED_PAGES)',
};

function aliasError(message, code, exitCode = 1) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = exitCode;
  return err;
}

/**
 * Адрес страницы донора для метки карты. Чистая: `{ alias }` или `{ reason }` (шапка, подвал,
 * главная, нет пары, нет адреса). `donorById` — Map pageid → запись перечня донора.
 */
export function donorAliasFor(entry, donorById) {
  if (entry.role === 'header' || entry.role === 'footer') return { reason: ALIAS_REASONS.role(entry.role) };
  if (!entry.donorPageid) return { reason: ALIAS_REASONS.noDonorPage };
  const donor = donorById.get(String(entry.donorPageid));
  if (!donor) return { reason: ALIAS_REASONS.notInDonorList };
  if (donor.role === 'index') return { reason: ALIAS_REASONS.role('index') };
  const alias = normalizeAlias(donor.alias);
  return alias ? { alias } : { reason: ALIAS_REASONS.noDonorAlias };
}

/** Map pageid → запись перечня страниц. */
export const byPageid = (pages) => new Map((pages ?? []).map((p) => [String(p.pageid), p]));

/**
 * План адресов. Чистая: `site` — карта слепка (`pages[]` с label, role, pageid, donorPageid),
 * `donorPages` и `testPages` — записи перечней (`pageid`, `alias`, `role`, `protected`).
 * Возвращает `{ todo: [{ label, pageid, alias }], skipped: [{ label, reason }] }`.
 */
export function planAliases(site, donorPages, testPages) {
  const donorById = byPageid(donorPages);
  const testById = byPageid(testPages);
  const labelByPageid = new Map((site?.pages ?? []).filter((e) => e.pageid).map((e) => [String(e.pageid), e.label]));
  // Кто уже владеет адресом в тестовом проекте.
  const owner = new Map();
  for (const p of testPages ?? []) {
    const a = normalizeAlias(p.alias);
    if (a) owner.set(a, String(p.pageid));
  }
  const planned = new Map();
  const todo = [];
  const skipped = [];
  const skip = (label, reason) => {
    skipped.push({ label, reason });
    log.debug('planAliases', 'пропуск', { label, reason });
  };
  for (const entry of site?.pages ?? []) {
    const { label } = entry;
    const found = donorAliasFor(entry, donorById);
    if (found.reason) { skip(label, found.reason); continue; }
    const { alias } = found;
    if (!entry.pageid) { skip(label, ALIAS_REASONS.noTestPage); continue; }
    const pageid = String(entry.pageid);
    const test = testById.get(pageid);
    if (!test) { skip(label, ALIAS_REASONS.notInPageList); continue; }
    if (test.protected) { skip(label, ALIAS_REASONS.protected); continue; }
    if (normalizeAlias(test.alias) === alias) { skip(label, ALIAS_REASONS.same); continue; }
    const holder = owner.get(alias);
    if (holder && holder !== pageid) { skip(label, ALIAS_REASONS.taken(labelByPageid.get(holder) ?? holder)); continue; }
    if (planned.has(alias)) { skip(label, ALIAS_REASONS.duplicate(planned.get(alias))); continue; }
    planned.set(alias, label);
    todo.push({ label, pageid, alias });
  }
  log.info('planAliases', 'план адресов', { todo: todo.length, skipped: skipped.length });
  return { todo, skipped };
}

/** Перечень страниц тестового проекта из файла `page list` (`pages/<projectid>.json`). */
export function readPageList(projectid, { pagesDir } = {}) {
  const file = join(pagesDir ?? join(baselineDir(), 'pages'), `${projectid}.json`);
  if (!existsSync(file)) throw aliasError(`перечня страниц тестового проекта нет (${file.replace(/\\/g, '/')}): сначала page list`, 'NO_PAGE_LIST', 1);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const pages = Array.isArray(data.pages) ? data.pages : [];
  log.debug('readPageList', 'перечень прочитан', { file: file.replace(/\\/g, '/'), pages: pages.length, captured: data.captured });
  return pages;
}

/**
 * Оркестратор: перечни из файлов, план, запись по одной странице с паузой. Драйвер —
 * `{ callWithResponse }` на странице проекта (как у `page title`). При `dryRun` драйвер не
 * вызывается. После MAX_FAILURES_IN_ROW отказов подряд прогон останавливается.
 * Итог `{ dryRun, todo, skipped, assigned, failed, stopped }`.
 */
export async function assignDonorAliases(driver, { slug, donorProjectId, testProjectId, baseDir, pagesDir, protectedIds = [], dryRun = false, delayMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const site = readSite(slug, { baseDir });
  if (!site) throw aliasError(`карты сайта ${slug} нет: сначала reference pages --slug ${slug}`, 'NO_SITE', 1);
  const donorPages = readDonorPages(donorProjectId, { pagesDir });
  const testPages = readPageList(testProjectId, { pagesDir });
  const { todo, skipped } = planAliases(site, donorPages, testPages);
  if (dryRun) {
    log.info('assignDonorAliases', 'dry-run: запись не выполнялась', { todo: todo.length, skipped: skipped.length });
    return { dryRun: true, todo, skipped, assigned: [], failed: [], stopped: false };
  }
  const assigned = [];
  const failed = [];
  let inRow = 0;
  let stopped = false;
  for (const [i, item] of todo.entries()) {
    if (i > 0) await sleep(delayMs);
    try {
      await setPageAlias(driver, item.pageid, item.alias, { protectedIds });
      assigned.push({ label: item.label, pageid: item.pageid });
      inRow = 0;
      log.info('assignDonorAliases', 'адрес записан', { label: item.label, pageid: item.pageid });
      log.debug('assignDonorAliases', 'адрес', { label: item.label, alias: item.alias });
    } catch (e) {
      inRow += 1;
      failed.push({ label: item.label, pageid: item.pageid, code: e.code ?? 'ERROR', reason: String(e.message || e).slice(0, 160) });
      log.warn('assignDonorAliases', 'адрес не записан', { label: item.label, pageid: item.pageid, code: e.code, inRow });
      if (inRow >= MAX_FAILURES_IN_ROW) {
        stopped = true;
        log.error('assignDonorAliases', `остановка: ${MAX_FAILURES_IN_ROW} отказа подряд`, { done: assigned.length, failed: failed.length, left: todo.length - i - 1 });
        break;
      }
    }
  }
  log.info('assignDonorAliases', 'итог', { assigned: assigned.length, skipped: skipped.length, failed: failed.length, stopped });
  return { dryRun: false, todo, skipped, assigned, failed, stopped };
}
