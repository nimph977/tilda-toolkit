/**
 * Перечень страниц проекта (`page list`) без публичного API: тот же запрос, которым кабинет
 * рисует страницу проекта (`comm=getprojectslist`, прочитано 2026-09-23 из
 * td__projectslist__loadList). Транспорт — драйвер (`driver.call(fn, args)` поверх слоя
 * scripts/browser/tilda-project.js), разбор и нормализация — чистые функции, проверяемые без сети.
 *
 * Ответ кабинета содержит служебные ключи (csrf, jwt, upload key): из него берутся только
 * `pages` и несколько полей `project`, сырой текст не логируется и не сохраняется.
 */
import { createLogger } from './lib/log.mjs';
import { attachMessage, messageText, msg } from './lib/i18n.mjs';

const log = createLogger('page-list');

/** Причины пропуска записи. `other-project` — кабинет сам отбрасывает такие (td__project__drawPages). */
const SKIP_REASONS = ['no-pageid', 'other-project', 'no-title', 'duplicate'];

export class PageListError extends Error {
  constructor(code, message, data = {}) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'PageListError';
    this.code = code;
    this.exitCode = 1;
    Object.assign(this, data);
  }
}

/** Начало ответа для сообщения об ошибке — без значений служебных ключей. */
function redactedHead(text, max = 200) {
  return String(text ?? '')
    .slice(0, max)
    .replace(/("?(?:csrf|errors_jwtsign|jwt|useruploadkey)"?\s*[:=]\s*"?)[^"&,}]*/gi, '$1<cut>');
}

const isZero = (value) => value !== undefined && value !== null && value !== '' && Number(value) === 0;

/**
 * Разбор ответа getprojectslist. Возвращает сырые записи `pages`, нужные поля `project` и
 * признак пустого проекта. Массив страниц может прийти объектом с числовыми ключами — кабинет
 * обходит его через for-in, мы берём значения. Нет ни страниц, ни признака пустого проекта —
 * PAGES_PARSE_FAILED: «список не распознан» безопаснее, чем молча «страниц нет».
 */
export function parsePagesResponse(text, { emptyMarker = false } = {}) {
  const value = String(text ?? '');
  let json;
  try {
    json = JSON.parse(value);
  } catch (e) {
    log.error('parsePagesResponse', 'ответ не JSON', { bytes: value.length, error: e.message });
    throw new PageListError('PAGES_BAD_JSON', msg('pageList.badJson', { bytes: value.length, head: redactedHead(value) }));
  }
  if (!json || typeof json !== 'object') {
    throw new PageListError('PAGES_PARSE_FAILED', msg('pageList.notObject', { type: typeof json }));
  }
  const p = json.project && typeof json.project === 'object' ? json.project : {};
  const project = {
    id: p.id !== undefined ? String(p.id) : undefined,
    indexpageid: String(p.indexpageid ?? ''),
    headerpageid: String(p.headerpageid ?? ''),
    footerpageid: String(p.footerpageid ?? ''),
    page404id: String(p.page404id ?? ''),
    pagesCount: p.pages_count === undefined ? undefined : Number(p.pages_count),
  };
  let raw;
  if (Array.isArray(json.pages)) raw = json.pages;
  else if (json.pages && typeof json.pages === 'object') raw = Object.values(json.pages);
  else raw = [];
  const empty = raw.length === 0 && (Boolean(emptyMarker) || isZero(p.pages_count));
  if (raw.length === 0 && !empty) {
    log.error('parsePagesResponse', 'страниц нет и признака пустого проекта нет', { pagesType: typeof json.pages, pagesCount: p.pages_count, emptyMarker });
    throw new PageListError('PAGES_PARSE_FAILED', msg('pageList.noPagesArray', { type: json.pages === null ? 'null' : typeof json.pages }));
  }
  log.debug('parsePagesResponse', 'ответ разобран', { records: raw.length, pagesCount: project.pagesCount, emptyMarker: empty });
  return { raw, project, emptyMarker: empty };
}

function roleOf(pageid, project) {
  if (!project) return undefined;
  if (pageid === project.indexpageid) return 'index';
  if (pageid === project.headerpageid) return 'header';
  if (pageid === project.footerpageid) return 'footer';
  if (pageid === project.page404id) return '404';
  return undefined;
}

/**
 * Нормализация: `{ pageid, title, alias?, published?, folder?, role?, protected }` в порядке
 * источника. Пропуски считаются по причинам SKIP_REASONS и возвращаются только ненулевые.
 */
export function normalizePages(raw, { protectedIds = [], project } = {}) {
  const guard = new Set(protectedIds.map(String));
  const counts = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0]));
  const seen = new Set();
  const pages = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const rec = r && typeof r === 'object' ? r : {};
    const pageid = String(rec.id ?? rec.pageid ?? '').trim();
    if (!/^\d+$/.test(pageid)) {
      counts['no-pageid'] += 1;
      continue;
    }
    if (project?.id && rec.projectid !== undefined && String(rec.projectid) !== project.id) {
      counts['other-project'] += 1;
      continue;
    }
    const title = String(rec.title ?? '').trim();
    if (!title) {
      counts['no-title'] += 1;
      continue;
    }
    if (seen.has(pageid)) {
      counts.duplicate += 1;
      continue;
    }
    seen.add(pageid);
    const page = { pageid, title };
    if (rec.alias) page.alias = String(rec.alias);
    if (rec.published !== undefined) page.published = Number(rec.published) > 0;
    if (rec.folderid !== undefined && String(rec.folderid) !== '0' && String(rec.folderid) !== '') page.folder = String(rec.folderid);
    const role = roleOf(pageid, project);
    if (role) page.role = role;
    page.protected = guard.has(pageid);
    pages.push(page);
  }
  const skipped = SKIP_REASONS.filter((reason) => counts[reason] > 0).map((reason) => ({ reason, count: counts[reason] }));
  for (const s of skipped) log.warn('normalizePages', 'записи пропущены', s);
  return { pages, skipped };
}

/** Оркестратор: вызов слоя → разбор → нормализация. Драйвер приходит снаружи, как в page-ops.mjs. */
export async function listPages(driver, { projectid, protectedIds = [] } = {}) {
  const id = String(projectid ?? '');
  log.debug('listPages', 'вызов слоя', { projectid: id });
  const r = await driver.call('listPages', [id]);
  log.debug('listPages', 'ответ слоя', { source: r?.source, status: r?.status, bytes: String(r?.text ?? '').length });
  if (r?.source !== 'api') throw new PageListError('PAGES_PARSE_FAILED', msg('pageList.unknownLayerAnswer', { source: r?.source }));
  const parsed = parsePagesResponse(r.text, { emptyMarker: r.emptyMarker });
  const { pages, skipped } = normalizePages(parsed.raw, { protectedIds, project: parsed.project });
  log.info('listPages', 'страниц получено', { count: pages.length, protected: pages.filter((p) => p.protected).length, skipped: skipped.length });
  return { source: r.source, pages, skipped, emptyMarker: parsed.emptyMarker, pagesCount: parsed.project.pagesCount };
}
