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
import { messageText, msg } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { normalizeAlias, readDonorPages } from './donor-map.mjs';
import { setPageAlias } from './page-ops.mjs';

const log = createLogger('donor-aliases');

/** Сколько отказов записи подряд останавливают прогон: повтор той же ошибки на всех страницах бесполезен. */
export const MAX_FAILURES_IN_ROW = 3;

/**
 * Причины пропуска: имя → ключ словаря. Подстановки: `roleIndex` и `roleHeaderFooter` {role},
 * `taken` {who}, `duplicate` {label}. В результате причина — `Message`, рядом её имя в `code`.
 */
export const ALIAS_REASONS = {
  noTestPage: 'donorAliases.reason.noTestPage',
  noDonorPage: 'donorAliases.reason.noDonorPage',
  notInDonorList: 'donorAliases.reason.notInDonorList',
  notInPageList: 'donorAliases.reason.notInPageList',
  noDonorAlias: 'donorAliases.reason.noDonorAlias',
  roleIndex: 'donorAliases.reason.roleIndex',
  roleHeaderFooter: 'donorAliases.reason.roleHeaderFooter',
  same: 'donorAliases.reason.same',
  taken: 'donorAliases.reason.taken',
  duplicate: 'donorAliases.reason.duplicate',
  protected: 'donorAliases.reason.protected',
};

/** Пропуск по имени из `ALIAS_REASONS`: `{ code, reason: Message }`. */
const skipBy = (code, params) => ({ code, reason: msg(ALIAS_REASONS[code], params) });

/** Причина для роли страницы: главная открывается по корню, шапка и подвал не публикуются. */
const roleSkip = (role) => (role === 'index' ? skipBy('roleIndex', { role }) : skipBy('roleHeaderFooter', { role }));

/**
 * Адрес страницы донора для метки карты. Чистая: `{ alias }` или `{ reason }` (шапка, подвал,
 * главная, нет пары, нет адреса). `donorById` — Map pageid → запись перечня донора.
 */
export function donorAliasFor(entry, donorById) {
  if (entry.role === 'header' || entry.role === 'footer') return roleSkip(entry.role);
  if (!entry.donorPageid) return skipBy('noDonorPage');
  const donor = donorById.get(String(entry.donorPageid));
  if (!donor) return skipBy('notInDonorList');
  if (donor.role === 'index') return roleSkip('index');
  const alias = normalizeAlias(donor.alias);
  return alias ? { alias } : skipBy('noDonorAlias');
}

/** Map pageid → запись перечня страниц. */
export const byPageid = (pages) => new Map((pages ?? []).map((p) => [String(p.pageid), p]));

/**
 * План адресов. Чистая: `site` — карта слепка (`pages[]` с label, role, pageid, donorPageid),
 * `donorPages` и `testPages` — записи перечней (`pageid`, `alias`, `role`, `protected`).
 * Возвращает `{ todo: [{ label, pageid, alias }], skipped: [{ label, code, reason: Message }] }`.
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
  const skip = (label, { code, reason }) => {
    skipped.push({ label, code, reason });
    log.debug('planAliases', 'skipped', { label, reason: messageText(reason) });
  };
  for (const entry of site?.pages ?? []) {
    const { label } = entry;
    const found = donorAliasFor(entry, donorById);
    if (found.reason) { skip(label, found); continue; }
    const { alias } = found;
    if (!entry.pageid) { skip(label, skipBy('noTestPage')); continue; }
    const pageid = String(entry.pageid);
    const test = testById.get(pageid);
    if (!test) { skip(label, skipBy('notInPageList')); continue; }
    if (test.protected) { skip(label, skipBy('protected')); continue; }
    if (normalizeAlias(test.alias) === alias) { skip(label, skipBy('same')); continue; }
    const holder = owner.get(alias);
    if (holder && holder !== pageid) { skip(label, skipBy('taken', { who: labelByPageid.get(holder) ?? holder })); continue; }
    if (planned.has(alias)) { skip(label, skipBy('duplicate', { label: planned.get(alias) })); continue; }
    planned.set(alias, label);
    todo.push({ label, pageid, alias });
  }
  log.info('planAliases', 'address plan', { todo: todo.length, skipped: skipped.length });
  return { todo, skipped };
}

/** Перечень страниц тестового проекта из файла `page list` (`pages/<projectid>.json`). */
export function readPageList(projectid, { pagesDir } = {}) {
  const file = join(pagesDir ?? join(baselineDir(), 'pages'), `${projectid}.json`);
  if (!existsSync(file)) throw new ToolError('NO_PAGE_LIST', msg('donorAliases.noPageList', { file: file.replace(/\\/g, '/') }));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const pages = Array.isArray(data.pages) ? data.pages : [];
  log.debug('readPageList', 'list read', { file: file.replace(/\\/g, '/'), pages: pages.length, captured: data.captured });
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
  if (!site) throw new ToolError('NO_SITE', msg('donorAliases.noSite', { slug }));
  const donorPages = readDonorPages(donorProjectId, { pagesDir });
  const testPages = readPageList(testProjectId, { pagesDir });
  const { todo, skipped } = planAliases(site, donorPages, testPages);
  if (dryRun) {
    log.info('assignDonorAliases', 'dry-run: nothing written', { todo: todo.length, skipped: skipped.length });
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
      log.info('assignDonorAliases', 'address written', { label: item.label, pageid: item.pageid });
      log.debug('assignDonorAliases', 'address', { label: item.label, alias: item.alias });
    } catch (e) {
      inRow += 1;
      failed.push({ label: item.label, pageid: item.pageid, code: e.code ?? 'ERROR', reason: String(e.message || e).slice(0, 160) });
      log.warn('assignDonorAliases', 'address not written', { label: item.label, pageid: item.pageid, code: e.code, inRow });
      if (inRow >= MAX_FAILURES_IN_ROW) {
        stopped = true;
        log.error('assignDonorAliases', `stopped: ${MAX_FAILURES_IN_ROW} refusals in a row`, { done: assigned.length, failed: failed.length, left: todo.length - i - 1 });
        break;
      }
    }
  }
  log.info('assignDonorAliases', 'result', { assigned: assigned.length, skipped: skipped.length, failed: failed.length, stopped });
  return { dryRun: false, todo, skipped, assigned, failed, stopped };
}
