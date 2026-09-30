/**
 * Перепись ссылок на домен донора в относительные (`donor links`). Блоки перенесены
 * байт в байт, поэтому абсолютные ссылки донора (`https://<домен донора>/company`) уводили
 * посетителя копии на живой сайт донора. Ссылка становится путём на страницу копии (`/company`)
 * — только если такая страница в копии есть (адреса — `donor aliases`), иначе остаётся с причиной:
 * перепись без страницы дала бы 404 вместо рабочей ссылки на донора.
 *
 * Меняется только адрес ссылки: целое поле-адрес (`link`, `buttonlink`, `li_link`) или значения
 * атрибутов `href` внутри HTML-поля. Видимый текст (в том числе почта на домене донора и текст
 * политики) не трогается. Поля форм (`formmsgurl` — переход после отправки) не меняются —
 * называются владельцу. Поиск полей — `find()` по локальным снимкам (как `replace`), форма
 * операций — как у `buildReplacePlan` (`set` / `field` / `listSet`). Домен донора на INFO не печатается.
 */
import { createLogger } from './lib/log.mjs';
import { find } from './find-replace.mjs';
import { normalizeAlias } from './donor-map.mjs';

const log = createLogger('donor-links');

/**
 * Причины, по которым ссылка остаётся как есть: имя → английский текст. Это данные плана и итога;
 * рядом с текстом везде лежит `code` — имя причины.
 */
export const LINK_REWRITE_REASONS = {
  noPage: (path) => `page ${path} does not exist in the copy: the link stays pointing to the donor site`,
  form: (field) => `form field ${field} is not changed: tell the owner`,
  otherHost: 'the link is not to the donor domain',
};

const KEEP_RE = /^(?:#|tel:|mailto:|javascript:|data:)/i;
const WHOLE_URL_RE = /^(?:https?:)?\/\/[^\s<>"']+$/i;
/** Целое поле — относительный путь (`/page300004.html#rec1`). */
const WHOLE_PATH_RE = /^\/(?!\/)[^\s<>"']*$/;
/** Адрес страницы Tilda по ID: `/page<id>.html`. */
const PAGE_ID_RE = /^\/page(\d+)\.html$/i;
/** Технический поддомен проекта Tilda. */
const TILDA_WS_RE = /\.tilda\.ws$/i;
const HREF_RE = /(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|&quot;(.*?)&quot;)/gi;

/** Хосты донора по адресу референса: с `www.` и без. */
export function donorHosts(manifestUrl) {
  const host = new URL(String(manifestUrl)).hostname.toLowerCase().replace(/^www\./, '');
  return [host, `www.${host}`];
}

/** Пути страниц копии для сверки: `/` и `/<alias>` из перечня `page list`, нижний регистр, без завершающего `/`. */
export function knownPathsFrom(testPages) {
  const paths = new Set(['/']);
  for (const p of testPages ?? []) {
    const a = normalizeAlias(p.alias);
    if (a) paths.add(`/${a}`);
  }
  return paths;
}

/**
 * Пути страниц копии по ID страниц донора: ссылки `/page<ID донора>.html` из перенесённых
 * блоков ведут на страницы, которых в копии под этим адресом нет. Чистая: `Map<donorPageid, путь>`
 * по записям карты `site.pages` с `donorPageid` и `pageid`; путь — `/` для главной донора (роль
 * `index`), иначе `/<alias>` страницы копии из `page list`, иначе `/page<pageid>.html`. Шапка и
 * подвал не входят. Две метки с одной страницей донора (дубли карты) — путь первой метки, как в
 * `planAliases`.
 */
export function donorPageLinks(site, testPages, donorPages) {
  const donorById = new Map((donorPages ?? []).map((p) => [String(p.pageid), p]));
  const testById = new Map((testPages ?? []).map((p) => [String(p.pageid), p]));
  const links = new Map();
  for (const entry of site?.pages ?? []) {
    if (entry.role === 'header' || entry.role === 'footer' || !entry.donorPageid || !entry.pageid) continue;
    const donorPageid = String(entry.donorPageid);
    if (links.has(donorPageid)) {
      log.debug('donorPageLinks', 'duplicate donor page, path of the first label', { label: entry.label });
      continue;
    }
    const pageid = String(entry.pageid);
    const alias = normalizeAlias(testById.get(pageid)?.alias);
    const path = donorById.get(donorPageid)?.role === 'index' ? '/' : alias ? `/${alias}` : `/page${pageid}.html`;
    links.set(donorPageid, path);
    log.debug('donorPageLinks', 'pair', { label: entry.label, donorPageid, path });
  }
  log.info('donorPageLinks', `donor pages with a pair in the copy: ${links.size}`, {});
  return links;
}

/** Путь копии для `/page<ID донора>.html` или null. */
function donorPagePath(pathname, donorLinks) {
  const m = String(pathname).match(PAGE_ID_RE);
  return m && donorLinks?.has(m[1]) ? donorLinks.get(m[1]) : null;
}

/**
 * Решение по одному адресу. Чистая: `{ value, changed, donor, code?, reason? }`. `donor: true` — адрес на
 * домене донора или на страницу донора по ID (переписан или оставлен с причиной); остальные ссылки
 * не трогаются. `donorLinks` — `donorPageLinks(...)`.
 */
export function rewriteDonorHref(href, { hosts, knownPaths, donorLinks }) {
  const raw = String(href ?? '');
  const trimmed = raw.trim();
  if (!trimmed || KEEP_RE.test(trimmed)) return { value: raw, changed: false, donor: false };
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    // Относительный адрес: переписывается только страница донора по ID; `/page<id>.html` копии и
    // адреса вида `/company` (их даёт `donor aliases`) остаются как есть.
    const rel = new URL(trimmed, 'https://relative.invalid');
    const target = donorPagePath(rel.pathname, donorLinks);
    return target ? { value: `${target}${rel.search}${rel.hash}`, changed: true, donor: true } : { value: raw, changed: false, donor: false };
  }
  let url;
  try {
    url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
  } catch {
    return { value: raw, changed: false, donor: false };
  }
  if (!/^https?:$/.test(url.protocol)) return { value: raw, changed: false, donor: false, code: 'otherHost', reason: LINK_REWRITE_REASONS.otherHost };
  const host = url.hostname.toLowerCase();
  // Страница донора по ID — и на техническом поддомене проекта (`<имя>.tilda.ws`): блоки донора
  // ссылаются и так (прогон 2026-09-24, P22); ID страницы Tilda глобален, чужой сайт его не даст.
  if (hosts.includes(host) || TILDA_WS_RE.test(host)) {
    const target = donorPagePath(url.pathname, donorLinks);
    if (target) return { value: `${target}${url.search}${url.hash}`, changed: true, donor: true };
  }
  if (!hosts.includes(host)) return { value: raw, changed: false, donor: false, code: 'otherHost', reason: LINK_REWRITE_REASONS.otherHost };
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // битые проценты — путь как есть
  }
  path = path.replace(/\/+$/, '').toLowerCase() || '/';
  if (!knownPaths.has(path)) return { value: raw, changed: false, donor: true, code: 'noPage', reason: LINK_REWRITE_REASONS.noPage(path) };
  return { value: `${url.pathname}${url.search}${url.hash}`, changed: true, donor: true };
}

/**
 * Перепись значений `href` в HTML-поле: `href="…"`, `href='…'` и закодированный `href=&quot;…&quot;`.
 * Текст между тегами не меняется. Чистая: `{ value, changed, reasons: [{ href, code, reason }] }`.
 */
export function rewriteHrefsInHtml(html, ctx) {
  let changed = 0;
  const reasons = [];
  const value = String(html ?? '').replace(HREF_RE, (whole, head, dq, sq, enc) => {
    const href = dq ?? sq ?? enc;
    const r = rewriteDonorHref(href, ctx);
    if (r.donor && !r.changed) reasons.push({ href, code: r.code, reason: r.reason });
    if (!r.changed) return whole;
    changed += 1;
    if (dq !== undefined) return `${head}"${r.value}"`;
    if (sq !== undefined) return `${head}'${r.value}'`;
    return `${head}&quot;${r.value}&quot;`;
  });
  return { value, changed, reasons };
}

/** Новое значение одного поля: целое поле-адрес или HTML. */
function rewriteField(value, ctx) {
  const s = String(value);
  if (WHOLE_URL_RE.test(s.trim()) || WHOLE_PATH_RE.test(s.trim())) {
    const r = rewriteDonorHref(s.trim(), ctx);
    return { value: r.changed ? r.value : s, changed: r.changed ? 1 : 0, reasons: r.donor && !r.changed ? [{ href: s.trim(), code: r.code, reason: r.reason }] : [] };
  }
  return rewriteHrefsInHtml(s, ctx);
}

/**
 * План переписи ссылок страницы по её снимкам. `hosts` — `donorHosts(...)`, `knownPaths` —
 * `knownPathsFrom(page list)`, `donorLinks` — `donorPageLinks(...)` (ссылки по ID донора),
 * `recordids` — живые блоки (иначе инвентарь страницы). Итог
 * `{ plan, changed, unchanged: [{ recordid, field, code, reason }], skippedForm, blocks, skippedStale }`;
 * `changed` — число адресов, попавших в операции плана.
 */
export function buildLinkRewritePlan(pageid, { hosts, knownPaths, donorLinks, baseDir, recordids } = {}) {
  const ctx = { hosts, knownPaths, donorLinks };
  // Поиск по домену без www находит и вариант с www.
  const byHost = find(pageid, hosts[0], { baseDir, recordids });
  const { blocks, skippedStale } = byHost;
  // Одно поле — одна операция: вхождения домена и ссылок по ID донора в одном поле объединяются,
  // поле переписывается за один проход rewriteField.
  const fieldKey = (h) => [h.kind, h.recordid, h.key ?? '', h.lid ?? '', h.field].join('|');
  const hitsByField = new Map(byHost.hits.map((h) => [fieldKey(h), h]));
  const formsByField = new Map(byHost.skippedForm.map((x) => [fieldKey(x), x]));
  for (const id of donorLinks?.keys() ?? []) {
    const r = find(pageid, `page${id}.html`, { baseDir, recordids, quiet: true });
    for (const h of r.hits) if (!hitsByField.has(fieldKey(h))) hitsByField.set(fieldKey(h), h);
    for (const x of r.skippedForm) if (!formsByField.has(fieldKey(x))) formsByField.set(fieldKey(x), x);
  }
  const hits = [...hitsByField.values()];
  const skippedForm = [...formsByField.values()];
  const ops = [];
  const listByRecord = new Map();
  const unchanged = [];
  let changed = 0;
  for (const h of hits) {
    const r = rewriteField(h.value, ctx);
    for (const u of r.reasons) {
      unchanged.push({ recordid: h.recordid, field: h.lid ? `${h.lid}.${h.field}` : h.field, code: u.code, reason: u.reason });
      log.debug('buildLinkRewritePlan', 'kept', { recordid: h.recordid, field: h.field, href: u.href });
    }
    if (!r.changed) continue;
    changed += r.changed;
    log.debug('buildLinkRewritePlan', 'rewritten', { recordid: h.recordid, field: h.field, links: r.changed });
    if (h.kind === 'zero') ops.push({ block: { recordid: h.recordid }, elem: { elem_id: h.elem_id }, set: { [h.field]: r.value } });
    else if (h.kind === 'record') ops.push({ block: { recordid: h.recordid }, field: { name: h.field, value: r.value } });
    else {
      if (!listByRecord.has(h.recordid)) listByRecord.set(h.recordid, { block: { recordid: h.recordid }, listSet: { set: [] } });
      const op = listByRecord.get(h.recordid);
      let entry = op.listSet.set.find((s) => s.lid === h.lid);
      if (!entry) {
        entry = { lid: h.lid, fields: {} };
        op.listSet.set.push(entry);
      }
      entry.fields[h.field] = r.value;
    }
  }
  ops.push(...listByRecord.values());
  const forms = skippedForm.map((x) => ({ recordid: x.recordid, field: x.field, code: 'form', reason: LINK_REWRITE_REASONS.form(x.field) }));
  const plan = { name: `donor-links-${String(pageid)}`, page: String(pageid), ops };
  log.info('buildLinkRewritePlan', `rewritten ${changed}, kept ${unchanged.length}, form fields ${forms.length}`, { pageid: String(pageid), ops: ops.length, blocks, skippedStale });
  return { plan, changed, unchanged, skippedForm: forms, blocks, skippedStale };
}
