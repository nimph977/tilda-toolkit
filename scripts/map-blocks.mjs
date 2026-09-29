/**
 * Карта блоков: скриншот вида страницы с подписанными номерами блоков.
 *
 * Это способ, которым человек указывает место правки словами «третий блок сверху»: на карте
 * у каждого блока подпись «№<порядок> · <recordid> · tpl<tplid> [· Z<n>]». Номер — порядок
 * в **свежем инвентаре** (включая скрытые блоки), тот же, что у `moveBlock.index`. Файл кладётся
 * на диск и открывается человеку системным просмотрщиком; в контекст агента не грузится —
 * агенту достаточно легенды `<ISO>-map.json` (номер → recordid).
 *
 * Вид страницы — тот же предпросмотр, что у `shot.mjs`: скрытые блоки и блоки нулевой
 * высоты (pop-up `702`, индикатор `602`) на нём не рендерятся, в легенде они помечены
 * `rendered: false` с причиной. Подписи рисуются поверх страницы слоем `#__tilda_map`, страница
 * не меняется. Порции по `CHUNK_PX` — как у `shot`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { editorUrl } from './lib/browser.mjs';
import { previewUrl, chunks, CHUNK_PX } from './shot.mjs';

const log = createLogger('map');

export const DEFAULT_MAP_WIDTH = 1440;
/** Блок ниже этой высоты считается не отрисованным — подпись ему не ставится. */
export const MIN_VISIBLE_HEIGHT = 8;

/** Текст подписи: «№4 · 7001 · tpl396 · Z1». */
export function labelText(rec) {
  const parts = [`№${rec.n}`, String(rec.recordid), `tpl${rec.tplid}`];
  if (rec.zeroIndex) parts.push(`Z${rec.zeroIndex}`);
  return parts.join(' · ');
}

/** Причина, по которой блок не подписан на карте. */
export function unrenderedReason(rec, rect) {
  if (rec.hidden) return 'скрыт в редакторе';
  if (!rect) return 'нет на виде страницы';
  if (rect.height < MIN_VISIBLE_HEIGHT) return `высота ${Math.round(rect.height)} px (pop-up или служебный блок)`;
  return null;
}

/**
 * Совместить свежий инвентарь с прямоугольниками блоков вида страницы.
 * inventory — listRecords(): { order, recordid, tplid, zeroIndex, hidden, preview };
 * rects — [{ recordid, top, height }] из DOM (`.t-rec#rec<recordid>`, координаты документа).
 * Чистая функция; порядок результата — порядок инвентаря.
 */
export function buildLabels(inventory, rects) {
  const byId = new Map((rects || []).map((r) => [String(r.recordid), r]));
  const labels = inventory.map((rec, i) => {
    const rect = byId.get(String(rec.recordid));
    const reason = unrenderedReason(rec, rect);
    const label = {
      n: rec.order ?? i + 1,
      recordid: String(rec.recordid),
      tplid: String(rec.tplid ?? ''),
      zeroIndex: rec.zeroIndex ?? null,
      hidden: !!rec.hidden,
      rendered: reason === null,
      reason,
      top: rect ? Math.round(rect.top) : null,
      height: rect ? Math.round(rect.height) : null,
      preview: rec.preview || '',
    };
    label.text = labelText(label);
    return label;
  });
  const orphans = (rects || []).filter((r) => !inventory.some((rec) => String(rec.recordid) === String(r.recordid)));
  if (orphans.length) log.warn('buildLabels', 'на виде страницы есть блоки, которых нет в инвентаре — инвентарь устарел?', { recordids: orphans.map((r) => String(r.recordid)) });
  log.debug('buildLabels', 'подписи собраны', { total: labels.length, rendered: labels.filter((l) => l.rendered).length, coords: labels.filter((l) => l.rendered).map((l) => [l.n, l.top, l.height]) });
  return labels;
}

/** Выполняется в браузере: прямоугольники всех блоков `.t-rec` в координатах документа. */
function collectRects() {
  return Array.from(document.querySelectorAll('.t-rec[id^="rec"]')).map((el) => {
    const r = el.getBoundingClientRect();
    return { recordid: el.id.slice(3), top: r.top + window.scrollY, height: r.height };
  });
}

/** Выполняется в браузере: слой подписей поверх страницы; возвращает число нарисованных. */
function drawOverlay({ labels, fontPx }) {
  const old = document.getElementById('__tilda_map');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = '__tilda_map';
  layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:0;z-index:2147483647;pointer-events:none;';
  for (const l of labels) {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:0;top:${l.top}px;width:100%;height:${l.height}px;box-sizing:border-box;border:3px dashed #ff2d55;`;
    const tag = document.createElement('div');
    tag.textContent = l.text;
    tag.style.cssText = `position:absolute;left:8px;top:8px;background:#ffe600;color:#000;font:bold ${fontPx}px/1.2 Arial,sans-serif;padding:${Math.round(fontPx / 4)}px ${Math.round(fontPx / 2)}px;border:2px solid #000;border-radius:6px;white-space:nowrap;`;
    box.appendChild(tag);
    layer.appendChild(box);
  }
  document.body.appendChild(layer);
  return labels.length;
}

/**
 * Открыть вид страницы, подписать блоки, снять карту на каждой ширине и записать легенду.
 * page — страница Playwright (после снимков вызывающий переоткрывает редактор сам).
 * @returns {{ files: string[], legend: string, widths: [{width, height, files, drawn, labels}], drawn: number }}
 */
export async function mapPage(page, pageid, inventory, opts = {}) {
  const widths = opts.widths || [DEFAULT_MAP_WIDTH];
  const outDir = opts.outDir || join(baselineDir(), 'shots', String(pageid));
  const at = opts.stamp || new Date().toISOString();
  const stamp = at.replace(/[:.]/g, '-');
  const chunk = opts.chunk || CHUNK_PX;
  mkdirSync(outDir, { recursive: true });
  const url = previewUrl(pageid, opts.projectid);
  const referer = editorUrl(pageid, opts.projectid) + '&previewmode=yes';
  const result = { files: [], widths: [], drawn: 0 };
  for (const width of widths) {
    const t0 = Date.now();
    await page.setViewportSize({ width, height: width < 600 ? 640 : 900 });
    await page.goto(url, { waitUntil: 'load', referer });
    await page.waitForTimeout(opts.settleMs ?? 2500);
    const rects = await page.evaluate(collectRects);
    if (rects.length === 0) log.warn('mapPage', 'на виде страницы нет блоков — сессия или адрес предпросмотра?', { width, url: page.url() });
    const labels = buildLabels(inventory, rects);
    const drawn = labels.filter((l) => l.rendered);
    const fontPx = width < 600 ? 14 : 26;
    await page.evaluate(drawOverlay, { labels: drawn, fontPx });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const files = [];
    const parts = chunks(height, chunk);
    for (const [i, part] of parts.entries()) {
      const file = join(outDir, `${stamp}-map-${width}${parts.length > 1 ? `-${i + 1}` : ''}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 80, fullPage: true, clip: { x: 0, y: part.y, width, height: part.height } });
      files.push(file);
      log.debug('mapPage', 'порция снята', { width, part: i + 1, of: parts.length, y: part.y, height: part.height, file });
    }
    log.info('mapPage', `ширина ${width}: подписано ${drawn.length} из ${labels.length} блоков, ${files.length} файл(ов), высота ${height}`, { ms: Date.now() - t0 });
    result.widths.push({ width, height, files, drawn: drawn.length, labels });
    result.files.push(...files);
    result.drawn = Math.max(result.drawn, drawn.length);
  }
  result.legend = join(outDir, `${stamp}-map.json`);
  writeFileSync(result.legend, JSON.stringify({ pageid: String(pageid), at, widths: result.widths }, null, 2) + '\n', 'utf8');
  log.info('mapPage', 'карта блоков записана', { files: result.files.length, legend: result.legend });
  await page.setViewportSize({ width: 1440, height: 960 }).catch(() => {});
  return result;
}

/**
 * Открыть файл человеку системным просмотрщиком (отсоединённый процесс, вывод не ждём).
 * Чистая часть — выбор команды по платформе; spawnImpl подменяется в тестах.
 */
export function openFile(path, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '', path]] : platform === 'darwin' ? ['open', [path]] : ['xdg-open', [path]];
  log.debug('openFile', 'открываю файл', { cmd, args });
  try {
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
    if (child && typeof child.on === 'function') child.on('error', (e) => log.warn('openFile', 'просмотрщик не запустился', { path, error: e.message }));
  } catch (e) {
    log.warn('openFile', 'просмотрщик не запустился', { path, error: e.message });
  }
  return { cmd, args };
}
