/**
 * Слепок референс-сайта через фоновую вкладку браузера-держателя.
 *
 * `fetchReference` обходит опубликованные страницы (HTTP-клиент из Node получает 403),
 * сохраняет HTML в `TILDA_REFERENCE_DIR/<slug>/pages/`, структуру — в `structure/`, при `images`
 * скачивает картинки в `images/`. Манифест пишется после каждой страницы: повторный запуск
 * пропускает готовые страницы и продолжает с места остановки.
 * `structureReference` переразбирает сохранённый HTML без сети.
 *
 * Редактор Tilda не открывается, записи нет: `TILDA_PROJECT_ID` и `TILDA_PROTECTED_PAGES`
 * не нужны, держатель открывается с `protectedPages: []`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { repoRoot } from './lib/paths.mjs';
import { splitRecords } from './lib/html-blocks.mjs';
import {
  assertSlug, ensureDirs, imageFileName, isLabel, newManifest, pageNameFromUrl,
  readManifest, readSite, refPaths, resolveSource, upsertPage, writeManifest,
} from './lib/reference-store.mjs';
import { collectInternalLinks, extractStructure, parseSitemap, structureFromFile } from './lib/reference-structure.mjs';

const log = createLogger('reference');

/** Темп по умолчанию: между страницами, после `load`, страниц за запуск, между картинками, таймаут перехода. */
export const DEFAULTS = { delayMs: 2500, settleMs: 1500, max: 20, imageDelayMs: 500, gotoTimeoutMs: 60_000 };

const MANIFEST_IMAGE_BATCH = 10;
/** Вложенных карт sitemapindex, читаемых за запуск. */
const MAX_NESTED_SITEMAPS = 10;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function usageError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = 2;
  return err;
}

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw usageError(`недопустимый URL референса: ${JSON.stringify(url)}`, 'BAD_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw usageError(`URL референса должен быть http(s): ${parsed.protocol}`, 'BAD_URL');
  }
  return parsed.href;
}

function writeStructure(paths, structure) {
  const file = join(paths.structure, structure.name + '.json');
  writeFileSync(file, JSON.stringify(structure, null, 2) + '\n', 'utf8');
  return file;
}

/** Уникальные `src` картинок из всех `structure/*.json` (блоки и карточки). */
function collectImageSources(paths) {
  const sources = new Set();
  if (!existsSync(paths.structure)) return [];
  for (const name of readdirSync(paths.structure)) {
    if (!name.endsWith('.json')) continue;
    const structure = JSON.parse(readFileSync(join(paths.structure, name), 'utf8'));
    for (const block of structure.blocks ?? []) {
      for (const img of block.images ?? []) if (img.src) sources.add(img.src);
      for (const card of block.cards ?? []) for (const src of Object.values(card.images ?? {})) if (src) sources.add(src);
    }
  }
  return [...sources];
}

/**
 * Скачать картинку во вкладке: сначала `page.request.get` (общие cookies контекста),
 * затем запасной `page.goto` + `response.body()` для CDN, которые отвергают первый путь.
 * @returns {Promise<'request'|'goto'|null>} использованный путь или null при неудаче
 */
export async function downloadImage(page, src, dest, { gotoTimeoutMs = DEFAULTS.gotoTimeoutMs } = {}) {
  try {
    const r = await page.request.get(src);
    if (r.ok()) {
      writeFileSync(dest, await r.body());
      return 'request';
    }
    log.debug('downloadImage', 'request.get отверг', { dest, status: r.status() });
  } catch (e) {
    log.debug('downloadImage', 'request.get упал', { dest, error: e.message });
  }
  let status = 0;
  try {
    const resp = await page.goto(src, { waitUntil: 'load', timeout: gotoTimeoutMs });
    if (resp && resp.ok()) {
      writeFileSync(dest, await resp.body());
      return 'goto';
    }
    status = resp ? resp.status() : 0;
  } catch (e) {
    log.debug('downloadImage', 'goto упал', { dest, error: e.message });
  }
  log.warn('downloadImage', 'картинка не скачана', { dest, status });
  return null;
}

async function fetchImages(page, manifest, paths, { slug, baseDir, imageDelayMs, gotoTimeoutMs }) {
  const root = repoRoot();
  const pending = collectImageSources(paths).filter((src) => {
    const known = manifest.images[src];
    return !(known && existsSync(resolve(root, known)));
  });
  log.info('fetchImages', 'картинки к скачиванию', { pending: pending.length, known: Object.keys(manifest.images).length });
  let downloaded = 0;
  let failed = 0;
  let sinceWrite = 0;
  for (const src of pending) {
    const fileName = imageFileName(src);
    if (fileName.endsWith('.bin')) {
      log.warn('fetchImages', 'картинка без известного расширения, пропуск', { src: '(скрыт)', fileName });
      failed += 1;
      continue;
    }
    const dest = join(paths.images, fileName);
    const via = await downloadImage(page, src, dest, { gotoTimeoutMs });
    if (via) {
      manifest.images[src] = relative(root, dest);
      downloaded += 1;
      sinceWrite += 1;
      log.debug('fetchImages', 'картинка сохранена', { fileName, via });
    } else {
      failed += 1;
    }
    if (sinceWrite >= MANIFEST_IMAGE_BATCH) {
      writeManifest(slug, manifest, { baseDir });
      sinceWrite = 0;
    }
    await sleep(imageDelayMs);
  }
  writeManifest(slug, manifest, { baseDir });
  log.info('fetchImages', 'картинки обработаны', { downloaded, failed });
  return { downloaded, failed };
}

/** Сырое тело ответа по адресу во вкладке: `{ status, text }`; ошибка перехода — статус 0. */
async function readXml(page, url, gotoTimeoutMs) {
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: gotoTimeoutMs });
    const status = resp ? resp.status() : 0;
    // text() читает тело ответа сети, а не DOM просмотрщика XML.
    return { status, text: status === 200 ? await resp.text() : '' };
  } catch (e) {
    log.debug('readXml', 'переход не удался', { error: e.message.slice(0, 120) });
    return { status: 0, text: '' };
  }
}

/**
 * sitemap.xml того же сайта через вкладку держателя. Индекс карт раскрывается:
 * читаются вложенные карты того же origin, не больше MAX_NESTED_SITEMAPS, с паузой `delayMs`.
 * @returns {Promise<{status: number, pages: string[], nested: number, dropped: number}>}
 */
async function readSitemap(page, origin, { gotoTimeoutMs, delayMs }) {
  const top = await readXml(page, origin + '/sitemap.xml', gotoTimeoutMs);
  if (top.status !== 200) {
    log.warn('fetchReference', 'sitemap.xml недоступен, обход без него', { status: top.status });
    await sleep(delayMs);
    return { status: top.status, pages: [], nested: 0, dropped: 0 };
  }
  const first = parseSitemap(top.text, origin);
  const pages = [...first.pages];
  let dropped = first.dropped;
  const nestedUrls = first.sitemaps.filter((u) => {
    try {
      return new URL(u).origin === origin;
    } catch {
      return false;
    }
  }).slice(0, MAX_NESTED_SITEMAPS);
  if (first.sitemaps.length > nestedUrls.length) log.warn('readSitemap', 'часть вложенных карт пропущена (чужой адрес или сверх лимита)', { total: first.sitemaps.length, read: nestedUrls.length });
  let nested = 0;
  for (const [i, u] of nestedUrls.entries()) {
    await sleep(delayMs);
    const r = await readXml(page, u, gotoTimeoutMs);
    if (r.status !== 200) {
      log.warn('readSitemap', 'вложенная карта недоступна', { n: i + 1, status: r.status });
      continue;
    }
    const part = parseSitemap(r.text, origin);
    nested += 1;
    dropped += part.dropped;
    for (const p of part.pages) if (!pages.includes(p)) pages.push(p);
    log.debug('readSitemap', 'вложенная карта', { n: i + 1, pages: part.pages.length });
  }
  await sleep(delayMs);
  log.info('fetchReference', 'sitemap.xml прочитан', { status: top.status, pages: pages.length, nested, dropped });
  return { status: top.status, pages, nested, dropped };
}

/**
 * Непройденный остаток очереди — в манифест со статусом `pending` (найдена, не снята).
 * Снятые (`ok`) пропускаются; запись с неудачным статусом (HTTP-код, `empty`) не перезаписывается —
 * её причина важнее, но в остаток она входит. Возвращает имена страниц остатка.
 */
function savePending(manifest, queue) {
  const pending = [];
  for (const u of queue) {
    const name = pageNameFromUrl(u);
    const known = manifest.pages.find((p) => p.name === name);
    if (known && known.status === 'ok') continue;
    if (!known || known.status === 'pending') upsertPage(manifest, { name, url: u, status: 'pending', fetchedAt: null });
    pending.push(name);
  }
  log.debug('savePending', 'остаток очереди', { queue: queue.length, pending: pending.length });
  return pending;
}

/**
 * Обход референса через фоновую вкладку держателя.
 * `deps.browser` подменяет `lib/browser.mjs` (нужно тестам).
 */
export async function fetchReference(
  { url, slug, follow = false, sitemap = false, max = DEFAULTS.max, delayMs = DEFAULTS.delayMs, settleMs = DEFAULTS.settleMs, images = false, baseDir, imageDelayMs = DEFAULTS.imageDelayMs, gotoTimeoutMs = DEFAULTS.gotoTimeoutMs },
  deps = {},
) {
  assertSlug(slug);
  const startUrl = assertHttpUrl(url);
  const browser = deps.browser || (await import('./lib/browser.mjs'));
  const paths = ensureDirs(slug, { baseDir });
  const manifest = readManifest(slug, { baseDir }) || newManifest({ slug, url: startUrl });
  const root = repoRoot();

  const queue = [startUrl];
  const seen = new Set(queue);
  for (const p of manifest.pages) {
    if (p.status === 'ok' || seen.has(p.url)) continue;
    seen.add(p.url);
    queue.push(p.url);
  }
  log.info('fetchReference', 'обход начат', { slug, follow, sitemap, max, queued: queue.length, known: manifest.pages.length });

  const stats = { fetched: 0, skipped: 0, failed: 0, pending: 0, images: 0, imagesFailed: 0 };
  // Очередь не ограничивается `max`: лимит держит только число снятых страниц за запуск,
  // а непройденный остаток уходит в манифест как `pending`.
  const enqueueLinks = (html, from) => {
    if (!follow) return;
    let added = 0;
    for (const link of collectInternalLinks(html, from)) {
      if (seen.has(link)) continue;
      seen.add(link);
      queue.push(link);
      added += 1;
    }
    log.debug('fetchReference', 'ссылки поставлены в очередь', { from: pageNameFromUrl(from), added, queue: queue.length });
  };

  const session = await browser.open({ protectedPages: [] });
  let page;
  try {
    page = await browser.openBackgroundPage(session.context);
    if (sitemap) {
      const r = await readSitemap(page, new URL(startUrl).origin, { gotoTimeoutMs, delayMs });
      let added = 0;
      for (const u of r.pages) {
        if (seen.has(u)) continue;
        seen.add(u);
        queue.push(u);
        added += 1;
      }
      stats.sitemap = { status: r.status, found: r.pages.length, nested: r.nested };
      log.debug('fetchReference', 'страницы карты сайта поставлены в очередь', { added, queue: queue.length });
    }
    let done = 0;
    while (queue.length && done < max) {
      const u = queue.shift();
      const name = pageNameFromUrl(u);
      const file = join(paths.pages, name + '.html');
      const known = manifest.pages.find((p) => p.name === name);
      if (known && known.status === 'ok' && existsSync(file)) {
        log.info('fetchReference', 'страница уже снята, пропуск', { name });
        stats.skipped += 1;
        if (follow) enqueueLinks(readFileSync(file, 'utf8'), u);
        continue;
      }

      const startedAt = Date.now();
      const fetchedAt = new Date().toISOString();
      let status = 0;
      let error = null;
      try {
        const resp = await page.goto(u, { waitUntil: 'load', timeout: gotoTimeoutMs });
        status = resp ? resp.status() : 0;
      } catch (e) {
        error = e.message.slice(0, 120);
      }
      log.debug('fetchReference', 'переход выполнен', { url: u, status, error });
      if (status !== 200) {
        log.warn('fetchReference', 'страница не получена', { name, status, error });
        upsertPage(manifest, { name, url: u, status, error: error ?? `HTTP ${status}`, fetchedAt });
        writeManifest(slug, manifest, { baseDir });
        stats.failed += 1;
        await sleep(delayMs);
        continue;
      }

      await sleep(settleMs);
      const html = await page.content();
      writeFileSync(file, html, 'utf8');
      const relFile = relative(root, file);
      if (splitRecords(html).length === 0) {
        log.warn('fetchReference', 'страница без блоков Tilda', { name });
        upsertPage(manifest, { name, url: u, file: relFile, status: 'empty', error: 'нет блоков Tilda в HTML (заглушка?)', fetchedAt });
        writeManifest(slug, manifest, { baseDir });
        stats.failed += 1;
        await sleep(delayMs);
        continue;
      }

      const structure = extractStructure(html, { url: u, name });
      writeStructure(paths, structure);
      upsertPage(manifest, { name, url: u, file: relFile, status: 'ok', title: structure.title, blocks: structure.counts.blocks, fetchedAt });
      manifest.fetchedAt = fetchedAt;
      writeManifest(slug, manifest, { baseDir });
      log.info('fetchReference', 'страница снята', { name, status, blocks: structure.counts.blocks, images: structure.counts.images, ms: Date.now() - startedAt });
      stats.fetched += 1;
      done += 1;
      enqueueLinks(html, u);
      if (queue.length && done < max) await sleep(delayMs);
    }
    const pending = savePending(manifest, queue);
    stats.pending = pending.length;
    if (pending.length) {
      writeManifest(slug, manifest, { baseDir });
      log.warn('fetchReference', 'лимит страниц за запуск исчерпан — остаток записан как pending, повторите запуск', { max, left: pending.length });
    }

    if (images) {
      const r = await fetchImages(page, manifest, paths, { slug, baseDir, imageDelayMs, gotoTimeoutMs });
      stats.images = r.downloaded;
      stats.imagesFailed = r.failed;
    }
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close(session);
  }

  const result = { slug, dir: paths.root, pages: manifest.pages.length, ...stats, images: Object.keys(manifest.images).length };
  log.info('fetchReference', 'обход завершён', result);
  return result;
}

function refError(message, code, exitCode) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = exitCode;
  return err;
}

/**
 * Снимок опубликованной страницы референса по метке карты сайта той же механикой, что `shot`
 * сборки (`captureWidths`): образец для сверки снимается тем же инструментом и в той же ширине
 * Снимки — `<slug>/shots/<метка>/`; адрес референса не выводится и не логируется на INFO+.
 * `deps.browser` подменяет `lib/browser.mjs` (нужно тестам).
 * @returns {Promise<{label: string, dir: string, files: number, widths: Array<{width, height, records, files: number}>}>}
 */
export async function shotReference({ slug, source, widths, baseDir, settleMs, stamp }, deps = {}) {
  assertSlug(slug);
  if (!isLabel(source)) throw refError(`reference shot: нужна метка карты сайта (P00…), получено ${JSON.stringify(source)}`, 'LABEL_REQUIRED', 2);
  const site = readSite(slug, { baseDir });
  if (!site) throw refError(`карты сайта ${slug} нет: сначала reference pages --slug ${slug}`, 'NO_SITE', 1);
  const entry = resolveSource(site, source);
  if (!entry) throw refError(`метки ${source} нет в карте сайта ${slug}`, 'UNKNOWN_LABEL', 2);
  if (!entry.url) throw refError(`у ${source} нет своего адреса: шапка и подвал видны на снимке любой страницы — снимайте P00`, 'NO_REFERENCE_URL', 2);
  const dir = join(refPaths(slug, { baseDir }).root, 'shots', source);
  const browser = deps.browser || (await import('./lib/browser.mjs'));
  const { captureWidths } = await import('./shot.mjs');
  const session = await browser.open({ protectedPages: [] });
  let page;
  try {
    page = await browser.openBackgroundPage(session.context);
    log.debug('shotReference', 'снимок', { label: source, path: new URL(entry.url).pathname });
    let r;
    try {
      r = await captureWidths(page, { url: entry.url, widths, outDir: dir, settleMs, stamp, requireOk: true });
    } catch (e) {
      if (e.code !== 'NAV_FAILED') throw e;
      throw refError(`страница референса ${source} недоступна: HTTP ${e.status}`, 'REFERENCE_UNAVAILABLE', 1);
    }
    const out = { label: source, dir, files: r.files.length, widths: r.widths.map((w) => ({ width: w.width, height: w.height, records: w.records, files: w.files.length })) };
    log.info('shotReference', 'снимок референса', { label: source, widths: out.widths.map((w) => w.width), files: out.files });
    return out;
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close(session);
  }
}

/** Переразобрать сохранённый HTML слепка в `structure/*.json` без сети. */
export async function structureReference({ slug, baseDir }) {
  assertSlug(slug);
  const manifest = readManifest(slug, { baseDir });
  if (!manifest) {
    const err = new Error(`слепок ${slug} не найден: сначала reference fetch`);
    err.code = 'NO_MANIFEST';
    err.exitCode = 1;
    throw err;
  }
  const paths = refPaths(slug, { baseDir });
  const root = repoRoot();
  const tplids = new Set();
  let pages = 0;
  for (const p of manifest.pages) {
    if (p.status !== 'ok' || !p.file) continue;
    const file = resolve(root, p.file);
    if (!existsSync(file)) {
      log.warn('structureReference', 'HTML страницы отсутствует, пропуск', { name: p.name });
      continue;
    }
    const structure = structureFromFile(file, { url: p.url, name: p.name });
    writeStructure(paths, structure);
    for (const t of structure.counts.tplids) tplids.add(t);
    pages += 1;
  }
  log.info('structureReference', 'структура пересобрана', { slug, pages, tplids: tplids.size });
  return { slug, pages, tplids: [...tplids] };
}
