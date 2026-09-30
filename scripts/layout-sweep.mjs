/**
 * Прогон блока по ширинам окна (приёмка вёрстки): предпросмотр открывается один раз
 * в СВОЕЙ вкладке держателя (прямое подключение по CDP, без блокировки команды — вкладка только
 * читает предпросмотр), окно сужается/расширяется по списку ширин без перезагрузки, на каждой
 * ширине снимается только блок и считаются автопроверки в странице:
 *   overflow   — горизонтальная прокрутка страницы (scrollWidth > innerWidth);
 *   outside    — элемент блока (кроме фигур) выходит за левый/правый край окна;
 *   overlap    — пересечение видимых текстов/кнопок/форм/картинок между собой (> 4 px по обеим осям);
 *   clipped    — текст выше своей коробки (scrollHeight > clientHeight + 2);
 *   below      — элемент ниже низа блока.
 *
 *   node scripts/layout-sweep.mjs --page <pageid> --block <recordid> [--widths 320-1440:40 | 320,375,768]
 *                                 [--out <dir>] [--tag <имя>] [--mode reload|resize]
 *
 * Итог: <out>/<width>.png на каждую ширину, <out>/report.json, таблица в консоль;
 * код выхода 1, если есть нарушения. Параллельные процессы с разными --widths допустимы:
 * у каждого своя вкладка и своя папка --out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { daemonStatus, editorUrl, openBackgroundPage } from './lib/browser.mjs';
import { previewUrl } from './shot.mjs';

const log = createLogger('layout-sweep');

/** `320-1440:40` → [320, 360, …, 1440]; `320,375,768` → как перечислено. */
export function parseWidthSpec(spec) {
  const s = String(spec || '320-1440:40').trim();
  const m = s.match(/^(\d+)-(\d+)(?::(\d+))?$/);
  if (m) {
    const [from, to, step] = [Number(m[1]), Number(m[2]), Number(m[3] || 40)];
    if (!(from > 0 && to >= from && step > 0)) throw new Error(`widths: invalid range ${s}`);
    const out = [];
    for (let w = from; w <= to; w += step) out.push(w);
    if (out[out.length - 1] !== to) out.push(to);
    return out;
  }
  const list = s.split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
  if (!list.length) throw new Error(`widths: empty (${s})`);
  return list;
}

/** Пересечение двух коробок {left, top, right, bottom} с порогом по обеим осям. */
export function boxesOverlap(a, b, minPx = 4) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > minPx && h > minPx ? { w: Math.round(w), h: Math.round(h) } : null;
}

/** Проверки по списку коробок элементов (чистая функция, тестируется без браузера). */
export function checkBoxes(elems, { innerWidth, blockBottom, scrollWidth }) {
  const issues = [];
  if (scrollWidth > innerWidth + 1) issues.push({ kind: 'overflow', detail: `scrollWidth ${scrollWidth} > ${innerWidth}` });
  const content = elems.filter((e) => e.visible && e.type !== 'shape');
  for (const e of content) {
    if (e.box.right > innerWidth + 1 || e.box.left < -1) issues.push({ kind: 'outside', elem: e.id, type: e.type, detail: `left ${Math.round(e.box.left)}, right ${Math.round(e.box.right)} at width ${innerWidth}`, text: e.text });
    if (e.box.bottom > blockBottom + 1) issues.push({ kind: 'below', elem: e.id, type: e.type, detail: `bottom ${Math.round(e.box.bottom)} > block bottom ${Math.round(blockBottom)}`, text: e.text });
    if (e.type === 'text' && e.clipped) issues.push({ kind: 'clipped', elem: e.id, type: e.type, detail: `scrollHeight ${e.scrollHeight} > clientHeight ${e.clientHeight}`, text: e.text });
  }
  for (let i = 0; i < content.length; i++) {
    for (let j = i + 1; j < content.length; j++) {
      const a = content[i]; const b = content[j];
      const o = boxesOverlap(a.box, b.box);
      if (!o) continue;
      // Кнопка поверх формы — приём шаблона (прозрачная кнопка формы лежит на декоративной):
      // нарушение только если кнопка накрыта формой не целиком (разъехались на разрешении).
      const pair = [a.type, b.type].sort().join('+');
      if (pair === 'button+form') {
        const btn = a.type === 'button' ? a : b;
        const covered = (o.w * o.h) / Math.max(1, btn.box.width * btn.box.height);
        if (covered >= 0.9) continue;
      }
      issues.push({ kind: 'overlap', elem: a.id, other: b.id, type: `${a.type}+${b.type}`, detail: `${o.w}×${o.h} px`, text: `${a.text} | ${b.text}` });
    }
  }
  return issues;
}

/** Снять коробки элементов блока в странице предпросмотра. */
async function measureBlock(page, recordid) {
  return page.evaluate((rid) => {
    const block = document.getElementById(`rec${rid}`);
    if (!block) return { error: `block rec${rid} not found` };
    const br = block.getBoundingClientRect();
    const sy = window.scrollY;
    const elems = [...block.querySelectorAll('.t396__elem')].map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const atom = el.querySelector('.tn-atom') || el;
      const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0;
      return {
        id: el.getAttribute('data-elem-id'), type: el.getAttribute('data-elem-type'), visible,
        box: { left: r.left, top: r.top + sy, right: r.right, bottom: r.bottom + sy, width: r.width, height: r.height },
        clipped: atom.scrollHeight > atom.clientHeight + 2, scrollHeight: atom.scrollHeight, clientHeight: atom.clientHeight,
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      };
    });
    return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, blockTop: br.top + sy, blockBottom: br.bottom + sy, blockHeight: br.height, elems };
  }, String(recordid));
}

export async function sweep({ pageid, recordid, widths, outDir, projectid, settleMs = 700, mode = 'reload' }) {
  const st = daemonStatus();
  if (!st) throw new Error('the browser holder is not running: node scripts/tilda.mjs browser start');
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${st.port}`, { timeout: 15_000 });
  const context = browser.contexts()[0];
  const page = await openBackgroundPage(context); // окно держателя остаётся свёрнутым
  const results = [];
  try {
    // Загрузка предпросмотра: показать анимируемые элементы стилем и спрятать закреплённые элементы
    // других блоков и предпросмотра (индикатор прокрутки, кнопка телефона, плашка cookie,
    // «Вернуться к редактированию») — они попадают в кадр блока (2026-09-21: агенты приняли их за
    // дефекты вёрстки).
    const load = async () => {
      await page.goto(previewUrl(pageid, projectid), { waitUntil: 'load', referer: editorUrl(pageid, projectid) + '&previewmode=yes' });
      await page.waitForTimeout(1500);
      // До подгрузки веб-шрифта текст стоит в запасном и занимает другую высоту — замер до
      // fonts.ready давал ложный overlap текста с формой (2026-09-21, 1440).
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await page.addStyleTag({ content: '.t-animate, [data-animate-style], .t396__elem { opacity: 1 !important; transform: none !important; }' });
      const records = await page.evaluate(() => document.querySelectorAll('.t-rec').length);
      if (!records) throw new Error(`no blocks on the preview - is the session alive? url ${page.url()}`);
      const hiddenFixed = await page.evaluate((rid) => {
        const block = document.getElementById(`rec${rid}`);
        let n = 0;
        for (const el of document.querySelectorAll('body *')) {
          if (block && block.contains(el)) continue;
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed' && cs.display !== 'none') { el.style.setProperty('visibility', 'hidden', 'important'); n++; }
        }
        return n;
      }, String(recordid));
      log.debug('sweep', 'preview loaded', { width: page.viewportSize().width, records, hiddenFixed });
    };
    // Режимы: reload — каждая ширина со свежей загрузкой (то, что видит посетитель); resize — окно
    // тянется без перезагрузки (ловит залипания скриптов Тильды: форма, переключённая на ≤640 в
    // столбик, при расширении окна назад не возвращается — 2026-09-21, ложный развал на 1200).
    await page.setViewportSize({ width: widths[0], height: widths[0] < 600 ? 640 : 900 });
    await load();
    log.info('sweep', 'preview opened', { pageid, recordid, mode, widths: widths.length });
    for (const [wi, width] of widths.entries()) {
      await page.setViewportSize({ width, height: width < 600 ? 640 : 900 });
      if (mode === 'reload' && wi > 0) await load();
      // Тильда перестраивает Zero Block и форму не сразу: ждём, пока высота блока перестанет меняться
      // (два одинаковых замера подряд), но не дольше 3 с — иначе на смене брейкпоинта ловятся
      // промежуточные состояния (2026-09-21: ложные overlap на 640 и 1200).
      await page.waitForTimeout(settleMs);
      // Стабилизация: не только высота блока, а размеры всех его элементов — тексты меняют высоту,
      // когда веб-шрифт подменяет запасной уже после load/fonts.ready (ложные overlap 17–44 px).
      for (let i = 0, prev = ''; i < 10; i++) {
        const sig = await page.evaluate((rid) => { const b = document.getElementById(`rec${rid}`); if (!b) return ''; return [b.getBoundingClientRect().height, ...[...b.querySelectorAll('.t396__elem')].map((e) => Math.round(e.getBoundingClientRect().height))].join(','); }, String(recordid));
        if (sig === prev) break;
        prev = sig;
        await page.waitForTimeout(500);
      }
      const m = await measureBlock(page, recordid);
      if (m.error) throw new Error(m.error);
      const issues = checkBoxes(m.elems, m);
      const file = join(outDir, `${width}.png`);
      const block = page.locator(`#rec${recordid}`);
      await block.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await block.screenshot({ path: file, type: 'png' });
      results.push({ width, blockHeight: Math.round(m.blockHeight), elems: m.elems.filter((e) => e.visible).length, issues, file });
      log.info('sweep', `width ${width}: block height ${Math.round(m.blockHeight)}, issues ${issues.length}`, { kinds: issues.map((i) => i.kind).join(',') || '-' });
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  const report = { pageid, recordid, widths, mode, generatedAt: new Date().toISOString(), results };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

function printTable(report) {
  console.log(`\nblock ${report.recordid} on page ${report.pageid}: widths ${report.widths.join(', ')}`);
  console.log('width | height | issues');
  for (const r of report.results) {
    const kinds = {};
    for (const i of r.issues) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
    const s = Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(' ') || 'none';
    console.log(`${String(r.width).padStart(6)} | ${String(r.blockHeight).padStart(6)} | ${s}`);
    for (const i of r.issues) console.log(`         · ${i.kind} ${i.type || ''} ${i.elem || ''}${i.other ? '+' + i.other : ''}: ${i.detail}${i.text ? ' — «' + i.text + '»' : ''}`);
  }
}

const isMain = process.argv[1] && /layout-sweep\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const { values } = parseArgs({ options: { page: { type: 'string' }, block: { type: 'string' }, widths: { type: 'string' }, out: { type: 'string' }, tag: { type: 'string' }, mode: { type: 'string' } } });
  const mode = values.mode === 'resize' ? 'resize' : 'reload';
  if (!values.page || !values.block) { console.error('--page <pageid> --block <recordid> are required'); process.exit(2); }
  const widths = parseWidthSpec(values.widths);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = values.out || join(baselineDir(), 'shots', String(values.page), `sweep-${values.block}-${values.tag || stamp}`);
  sweep({ pageid: values.page, recordid: values.block, widths, outDir, mode }).then((report) => {
    printTable(report);
    const total = report.results.reduce((n, r) => n + r.issues.length, 0);
    console.log(`\ntotal issues: ${total}; screenshots and report.json — ${outDir}`);
    process.exit(total ? 1 : 0);
  }).catch((e) => { log.error('main', e.message); console.error(e.stack); process.exit(1); });
}
