/**
 * Битые ссылки и картинки на виде страницы: собрать все href/src, проверить статусы.
 *
 *   collectUrls(html, baseUrl)  → [{url, kind: 'link'|'image'|'asset', tag}] — чистая часть, без сети
 *   checkUrls(urls, opts)       → [{url, kind, status, ok, note}] — HEAD (при 405 — GET), параллельно
 *
 * 2xx — ок; 3xx — WARN (редирект); 4xx/5xx и сетевые ошибки — ERROR. Якоря, mailto:, tel:,
 * javascript:, data: пропускаются.
 */
import { createLogger } from './lib/log.mjs';
import { decodeEntities } from './lib/entities.mjs';

const log = createLogger('link-check');

const SKIP = /^(#|mailto:|tel:|javascript:|data:|blob:|about:)/i;
/** Ссылки на другие страницы сайта в режиме предпросмотра ведут в редактор/предпросмотр Тильды — снаружи их не проверить. */
const INTERNAL_PREVIEW = /^https:\/\/tilda\.ru\/page\/(preview\/)?\?/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const ATTR = /<(a|img|source|link|script|iframe|video|audio)\b[^>]*?\s(href|src|srcset|data-original|data-src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Абсолютный URL или null для мусора. */
export function absolutize(raw, baseUrl) {
  const v = decodeEntities(String(raw || '')).trim();
  if (!v || SKIP.test(v)) return null;
  try {
    const u = new URL(v, baseUrl);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Все ссылки и ресурсы из HTML, без дублей; kind: link (a href), image (img/source), asset (css/js/iframe/media). */
export function collectUrls(html, baseUrl) {
  const seen = new Map();
  let m;
  while ((m = ATTR.exec(html))) {
    const tag = m[1].toLowerCase();
    const attr = m[2].toLowerCase();
    const raw = m[4] ?? m[5] ?? m[6] ?? '';
    const candidates = attr === 'srcset' ? raw.split(',').map((s) => s.trim().split(/\s+/)[0]) : [raw];
    for (const c of candidates) {
      const url = absolutize(c, baseUrl);
      if (!url || seen.has(url)) continue;
      const kind = tag === 'a' ? 'link' : tag === 'img' || tag === 'source' ? 'image' : 'asset';
      // raw — значение атрибута до absolutize: относительный адрес донора (`/company`) иначе неотличим от внешнего.
      seen.set(url, { url, raw: c, kind, tag, internal: INTERNAL_PREVIEW.test(url) });
    }
  }
  ATTR.lastIndex = 0;
  const list = [...seen.values()];
  log.debug('collectUrls', 'адреса собраны', { total: list.length, links: list.filter((x) => x.kind === 'link').length, images: list.filter((x) => x.kind === 'image').length });
  return list;
}

async function probe(url, { timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    let r = await doFetch(url, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal, headers });
    if ([400, 403, 404, 405].includes(r.status)) r = await doFetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal, headers });
    // Часть хостов (wa.me) отвечает 400 на браузерный User-Agent, часть (max.ru) — 403 без него: пробуем оба.
    if ([400, 403].includes(r.status)) r = await doFetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    return { status: r.status, location: r.headers.get('location') || undefined };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? `таймаут ${timeoutMs} мс` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Проверить статусы; возвращает записи с ok (2xx), warn (3xx) или error (0/4xx/5xx). */
export async function checkUrls(items, opts = {}) {
  const concurrency = opts.concurrency ?? 6;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      if (it.internal) {
        results[i] = { ...it, status: null, level: 'internal', note: 'страница сайта в режиме предпросмотра — снаружи не проверяется' };
        continue;
      }
      const r = await probe(it.url, { timeoutMs, fetchImpl: opts.fetchImpl });
      const level = r.status >= 200 && r.status < 300 ? 'ok' : (r.status >= 300 && r.status < 400) || r.status === 403 ? 'warn' : 'error';
      results[i] = { ...it, status: r.status, level, note: r.error || (r.status === 403 ? '403 — возможно защита от ботов, проверить руками' : r.location ? `→ ${r.location}` : '') };
      const line = `${it.kind} ${r.status} ${it.url}`;
      if (level === 'ok') log.debug('checkUrls', line, {});
      else if (level === 'warn') log.warn('checkUrls', `редирект: ${line}`, { location: r.location });
      else log.error('checkUrls', `битый адрес: ${line}`, { error: r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const broken = results.filter((x) => x.level === 'error');
  log.info('checkUrls', `проверено ${results.filter((x) => x.level !== 'internal').length}: битых ссылок ${broken.filter((x) => x.kind === 'link').length}, битых картинок ${broken.filter((x) => x.kind === 'image').length}, прочих ${broken.filter((x) => x.kind === 'asset').length}, предупреждений ${results.filter((x) => x.level === 'warn').length}, внутренних ${results.filter((x) => x.level === 'internal').length}`, {});
  return results;
}

/** Сводка для stdout. */
export function summarize(results) {
  const by = (kind, level) => results.filter((x) => x.kind === kind && x.level === level).length;
  return {
    checked: results.filter((x) => x.level !== 'internal').length,
    internal: results.filter((x) => x.level === 'internal').length,
    brokenLinks: by('link', 'error'),
    brokenImages: by('image', 'error'),
    brokenAssets: by('asset', 'error'),
    warnings: results.filter((x) => x.level === 'warn').length,
    broken: results.filter((x) => x.level === 'error').slice(0, 20).map((x) => `${x.kind} ${x.status} ${x.url}${x.note ? ' — ' + x.note : ''}`),
    warned: results.filter((x) => x.level === 'warn').slice(0, 10).map((x) => `${x.kind} ${x.status} ${x.url}${x.note ? ' — ' + x.note : ''}`),
  };
}
