/**
 * Скриншоты вида страницы на десктопной и мобильной ширине.
 *
 * Вид неопубликованной страницы (проверено 2026-09-11): кнопка «Предпросмотр» редактора
 * грузит во фрейм `https://tilda.ru/page/preview/?pageid=<id>&projectid=<pid>&domainzone=&previewmode=yes`.
 * Тот же адрес открывается верхним документом, если передать Referer редактора — без него
 * сервер отдаёт пустой `<html>`. Это вид страницы, а не редактора: обвязки нет, скрытые блоки
 * не рендерятся (37 блоков из 40 на дубле).
 *
 * Chrome не снимает кадр выше своего предела (на 320 px страница длиннее), поэтому страница
 * режется на порции по `chunk` px: <ISO>-<width>-<n>.jpg. Формат JPEG (качество 80): PNG
 * десктопа выходит 9 МБ. Сравнение «до/после» не делается — шумит на анимациях.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { msg } from './lib/i18n.mjs';
import { baselineDir } from './lib/paths.mjs';
import { editorUrl } from './lib/browser.mjs';
import { resolveProjectId } from './lib/config.mjs';

const log = createLogger('shot');

export const DEFAULT_WIDTHS = [1440, 320];
export const CHUNK_PX = 6000;

export function previewUrl(pageid, projectid) {
  const configuredProject = resolveProjectId(projectid);
  return `https://tilda.ru/page/preview/?pageid=${pageid}&projectid=${configuredProject}&domainzone=&previewmode=yes`;
}

/** Разбор `--width 1440,320` → числа; пусто → по умолчанию. */
export function parseWidths(value) {
  if (value === undefined || value === null || value === '') return [...DEFAULT_WIDTHS];
  const widths = String(value).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 200 && n <= 4000);
  if (!widths.length) throw new ToolError('BAD_WIDTHS', msg('shot.badWidths', { value }));
  return widths;
}

/** Порции по высоте: [{y, height}] для страницы высотой total. */
export function chunks(total, chunk = CHUNK_PX) {
  const out = [];
  for (let y = 0; y < total; y += chunk) out.push({ y, height: Math.min(chunk, total - y) });
  return out.length ? out : [{ y: 0, height: total }];
}

/**
 * Открыть вид страницы и снять его на каждой ширине. page — страница Playwright (после снимков
 * вызывающий переоткрывает редактор сам).
 * @returns {{ files: string[], widths: [{width, height, records, files}] }}
 */
export async function shotPage(page, pageid, opts = {}) {
  const outDir = opts.outDir || join(baselineDir(), 'shots', String(pageid));
  const url = previewUrl(pageid, opts.projectid);
  const referer = editorUrl(pageid, opts.projectid) + '&previewmode=yes';
  return captureWidths(page, { ...opts, url, referer, outDir });
}

/**
 * Число ленивых картинок, ещё не загруженных на странице: `<img data-original>` без загруженного
 * файла и фон `.t-bgimg` без `url(` или с заглушкой `-/resize/20x`. Выполняется в странице.
 */
function pendingLazyImages() {
  const nodes = [...document.querySelectorAll('[data-original], .t-bgimg')];
  return nodes.filter((e) => {
    // Скрытые `display:none` (всплывающие окна, неактивные слайды) не загрузятся прокруткой — их не
    // ждём. Размер не признак: незагруженная `<img>` без src сама 0×0.
    if (e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return false;
    if (e.tagName === 'IMG') {
      // Заглушка ленивой загрузки Tilda — адрес с модификатором `/-/empty/`: картинка «загружена»
      // (complete, есть размер), но пустая (проверено на опубликованной странице 2026-09-23).
      const src = e.getAttribute('src') || '';
      return !src || src.startsWith('data:') || src.includes('/-/empty/') || !e.complete || e.naturalWidth < 30;
    }
    const bg = getComputedStyle(e).backgroundImage || '';
    return !bg.includes('url(') || bg.includes('-/resize/20x');
  }).length;
}

/**
 * [FIX] Ленивые картинки Tilda (`data-original`, `.t-bgimg`) грузятся, только когда попадают в
 * область просмотра; снимок всей страницы без прокрутки оставлял их пустыми (сверка P00 2026-09-23:
 * на опубликованной странице до прокрутки не загружено 14 из 22). Прокрутка по экранам запускает
 * загрузку; затем ждём, пока незагруженных не станет, но не дольше `timeoutMs`. Анимации появления
 * так не показываются (см. ниже) — для них остаётся стиль.
 */
export async function loadLazyImages(page, { width, viewportHeight = 900, stepPauseMs = 400, timeoutMs = 6000 } = {}) {
  const before = await page.evaluate(pendingLazyImages);
  if (!before) {
    log.debug('loadLazyImages', '[FIX] ленивых картинок в ожидании нет', { width });
    return { before, after: 0 };
  }
  // Обработчик прокрутки у ленивой загрузки срабатывает с задержкой: при коротких паузах и сразу
  // после возврата наверх он видел только верх страницы (1440: 14 из 14 так и не загрузились).
  // Поэтому пауза на каждом экране и ожидание загрузки до возврата наверх.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += Math.round(viewportHeight * 0.8)) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(stepPauseMs);
  }
  let after = before;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    after = await page.evaluate(pendingLazyImages);
    if (!after) break;
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(stepPauseMs);
  if (after) log.warn('loadLazyImages', '[FIX] часть ленивых картинок не загрузилась к снимку', { width, before, after });
  else log.debug('loadLazyImages', '[FIX] ленивые картинки загружены прокруткой', { width, before });
  return { before, after };
}

/**
 * Проверка масштаба кадра: null — масштаб верный, иначе сообщение о причине (`Message`). Кадр в масштабе 80 %
 * давал ложное «шапка крупнее в 1,25 раза» и сверку 320 при ширине ~400 CSS px.
 * Допуск: ширина ±20 px (полоса прокрутки), dpr ±0.01.
 */
export function scaleMismatch({ width, innerWidth, dpr }) {
  const badWidth = Number.isFinite(innerWidth) && Math.abs(innerWidth - width) > 20;
  const badDpr = Number.isFinite(dpr) && Math.abs(dpr - 1) > 0.01;
  if (badWidth && badDpr) return msg('shot.scaleBoth', { innerWidth, width, dpr });
  if (badWidth) return msg('shot.scaleWidth', { innerWidth, width });
  if (badDpr) return msg('shot.scaleDpr', { dpr });
  return null;
}

/**
 * Снять адрес url на каждой ширине. Общая механика `shot` (вид страницы сборки) и
 * `reference shot` (опубликованная страница референса): те же ширины окна, ожидание, показ
 * анимированных элементов и порции — снимки сравнимы (образец для сверки снимается тем же инструментом).
 * @returns {{ files: string[], widths: [{width, height, records, files}] }}
 */
export async function captureWidths(page, opts = {}) {
  const { url, referer } = opts;
  const widths = opts.widths || DEFAULT_WIDTHS;
  const outDir = opts.outDir;
  const stamp = (opts.stamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const chunk = opts.chunk || CHUNK_PX;
  mkdirSync(outDir, { recursive: true });
  const result = { files: [], widths: [] };
  for (const width of widths) {
    const t0 = Date.now();
    await page.setViewportSize({ width, height: width < 600 ? 640 : 900 });
    const resp = await page.goto(url, { waitUntil: 'load', ...(referer ? { referer } : {}) });
    const status = resp ? resp.status() : 0;
    if (opts.requireOk && status !== 200) {
      log.warn('captureWidths', 'страница не получена — снимка нет', { width, status });
      throw new ToolError('NAV_FAILED', msg('shot.navFailed', { status }), { status });
    }
    await page.waitForTimeout(opts.settleMs ?? 2500);
    if (opts.loadLazy !== false) await loadLazyImages(page, { width, viewportHeight: width < 600 ? 640 : 900 });
    // Анимации появления (animstyle fadeinup и т.п.) держат элемент в opacity:0 до попадания в
    // область просмотра; на снимке без реальной прокрутки такие тексты пустые (2026-09-21:
    // заголовок и полоса формы Zero Block; пробег прокруткой через scrollTo не помог).
    // Для снимка принудительно показываем их стилем — страница при этом не меняется.
    // Тот же эффект даёт «анимация появления блоков» (настройка страницы): блок без animationoff
    // получает классы r_hidden r_anim и не виден до прокрутки — на снимке пустая полоса высотой
    // с блок (2026-09-22, приёмка сборки по референсу: 4 из 10 блоков).
    if (opts.revealAnimated !== false) {
      const css = '.t-animate, [data-animate-style], .t396__elem, .r_hidden { opacity: 1 !important; transform: none !important; visibility: visible !important; }';
      await page.addStyleTag({ content: css });
      const revealed = await page.evaluate(() => document.querySelectorAll('.t-animate, [data-animate-style], .r_hidden').length);
      await page.waitForTimeout(opts.animSettleMs ?? 500);
      log.debug('captureWidths', 'анимируемые элементы показаны стилем', { width, revealed });
    }
    const info = await page.evaluate(() => ({ records: document.querySelectorAll('.t-rec').length, height: document.documentElement.scrollHeight, width: window.innerWidth, dpr: window.devicePixelRatio }));
    const mismatch = scaleMismatch({ width, innerWidth: info.width, dpr: info.dpr });
    if (mismatch) {
      log.error('captureWidths', 'кадр в чужом масштабе — снимка нет', { width, innerWidth: info.width, dpr: info.dpr });
      throw new ToolError('SHOT_SCALED', msg('shot.scaled', { mismatch }));
    }
    // Адрес печатается только у предпросмотра (есть referer): адрес референса в логи не пишется.
    if (info.records === 0) log.warn('captureWidths', 'на виде страницы нет блоков — сессия или адрес предпросмотра?', { width, ...(referer ? { url: page.url() } : {}) });
    const files = [];
    const parts = chunks(info.height, chunk);
    for (const [i, part] of parts.entries()) {
      const file = join(outDir, `${stamp}-${width}${parts.length > 1 ? `-${i + 1}` : ''}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 80, fullPage: true, clip: { x: 0, y: part.y, width, height: part.height } });
      files.push(file);
      log.debug('captureWidths', 'порция снята', { width, part: i + 1, of: parts.length, y: part.y, height: part.height, file });    }
    log.info('captureWidths', `ширина ${width}: ${files.length} файл(ов), высота ${info.height}, блоков ${info.records}`, { ms: Date.now() - t0 });
    result.widths.push({ width, height: info.height, records: info.records, dpr: info.dpr, files });
    result.files.push(...files);
  }
  await page.setViewportSize({ width: 1440, height: 960 }).catch(() => {});
  return result;
}
