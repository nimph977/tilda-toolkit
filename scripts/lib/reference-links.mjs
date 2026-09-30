/**
 * Перепись адресов референса на страницы тестового проекта (решение 2026-09-23).
 *
 * Ссылка на страницу референса становится родным адресом Tilda `/page<новый pageid>.html` по карте
 * сайта (`site.json`); якорь своей страницы (`#prodpopup`, `#popup:<имя>`) возвращается к виду
 * `#якорь`; внешние ссылки не трогаются. Непереписанный адрес на домен референса получает причину
 * `LINK_REASONS` и `text` — путь без домена. Модуль чистый: без файлов и сети.
 */
import { FILE_LINK_RE } from './reference-structure.mjs';

export const LINK_REASONS = {
  unknownPage: { code: 'linkUnknownPage', reason: 'link to a reference page that is not in the site map — the reference address is kept' },
  notCreated: (label) => ({ code: 'linkPageNotCreated', reason: `page ${label} is not created yet (reference pages --create) — the reference address is kept` }),
  file: { code: 'linkFile', reason: 'file on the reference domain — not transferred, the reference address is kept' },
  outsideFields: { code: 'linkOutsideFields', reason: 'link outside the block fields — not transferred' },
};

const KEEP_RE = /^(#|tel:|mailto:|javascript:)/i;

/** Ключ страницы: origin + путь без завершающего '/', без query и hash; хост в нижнем регистре. */
export function pageKey(url) {
  const u = new URL(url);
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    // битые проценты — путь как есть
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return u.origin.toLowerCase() + (path || '/');
}

/** Индекс карты сайта: pageKey(url) → { label, pageid }; записи без url (HDR, FTR) не входят. */
export function buildLinkIndex(site) {
  const index = new Map();
  for (const p of site?.pages ?? []) {
    if (!p.url) continue;
    try {
      index.set(pageKey(p.url), { label: p.label, pageid: p.pageid ?? null });
    } catch {
      // неразборчивый адрес записи — пропуск
    }
  }
  return index;
}

/**
 * Решение по одному адресу.
 * @param {string} href       адрес из структуры (абсолютный или '#…', 'tel:' и т.п.)
 * @param {{ origin: string, pageUrl: string, index: Map }} ctx
 * @returns {{ value: string, changed: boolean, code?: string, reason?: string, text?: string }}
 */
export function rewriteReferenceUrl(href, ctx) {
  if (typeof href !== 'string' || !href) return { value: href, changed: false };
  if (KEEP_RE.test(href)) return { value: href, changed: false };
  let u;
  try {
    u = new URL(href);
  } catch {
    return { value: href, changed: false };
  }
  if (u.origin.toLowerCase() !== String(ctx.origin).toLowerCase()) return { value: href, changed: false };
  const text = u.pathname.slice(0, 40);
  const key = pageKey(href);
  if (u.hash && ctx.pageUrl && key === pageKey(ctx.pageUrl)) return { value: u.hash, changed: true };
  if (FILE_LINK_RE.test(u.pathname)) return { value: href, changed: false, ...LINK_REASONS.file, text };
  const hit = ctx.index?.get(key);
  if (hit && hit.pageid) return { value: `/page${hit.pageid}.html${u.hash}`, changed: true };
  if (hit) return { value: href, changed: false, ...LINK_REASONS.notCreated(hit.label), text };
  return { value: href, changed: false, ...LINK_REASONS.unknownPage, text };
}
