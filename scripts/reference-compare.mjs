/**
 * `reference compare` — поблочная сверка разметки собранной страницы метки с референсом и доклад
 * «совпало / не совпало / причина».
 *
 * Референс — блоки зоны метки из структуры слепка (у блоков есть `features`). Сборка — ветка P:
 * сырой HTML предпросмотра страницы (`driver.pageRawHtml()`), он размечен как
 * публикация; ветка Q (`--published --url`) — опубликованная страница по адресу владельца через
 * фоновую вкладку держателя. У сборки сравнивается зона `content`: шапка и подвал проекта в
 * предпросмотре — чужие страницы (у `HDR`/`FTR` их блоки — содержимое своей страницы).
 * Файлы: `<slug>/compare/<метка>.json` и `<slug>/reports/<метка>.auto.md` — только метки и `tplid`.
 * Драйвер приходит снаружи — модуль не импортирует `lib/browser.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { splitRecords } from './lib/html-blocks.mjs';
import { extractFeatures } from './lib/markup-features.mjs';
import { ownChunk, recordZones } from './lib/reference-structure.mjs';
import { alignBlocks, compareBlock, renderCompareReport } from './lib/block-compare.mjs';
import { refPaths } from './lib/reference-store.mjs';
import { loadSettingsMap } from './catalog.mjs';
import { prepareReferencePlan } from './reference-plan.mjs';

const log = createLogger('reference-compare');

function compareError(message, code, exitCode = 1) {
  const e = new Error(message);
  e.code = code;
  e.exitCode = exitCode;
  return e;
}

/** Блоки HTML собранной страницы зоны `content` с признаками. */
export function builtBlocksFromHtml(html) {
  const zones = recordZones(html);
  return splitRecords(html)
    .filter((r) => (zones.get(String(r.recid)) ?? 'content') === 'content')
    .map((r) => ({ order: r.order, tplid: r.type, features: extractFeatures(ownChunk(r.chunk), { recid: r.recid }) }));
}

/**
 * @param {{ pageRawHtml: Function, publishedHtml?: Function }} driver
 * @param {{ slug: string, label: string, published?: boolean, url?: string, baseDir?: string, catalogDir?: string, now?: string }} params
 */
export async function compareReferencePage(driver, { slug, label, published = false, url, baseDir, catalogDir, substitutes = {}, now = new Date().toISOString() }) {
  if (published && !url) throw compareError('reference compare --published: нужен --url <адрес опубликованной страницы> (адрес даёт владелец)', 'NEED_PUBLISHED_URL', 2);
  // `substitutes` поверх site.json: donor verify передаёт тождественные пары — перенос через буфер несёт исходные шаблоны.
  const { built: plan, resolved, structure } = prepareReferencePlan({ slug, source: label, baseDir, catalogDir, substitutes });
  const refBlocks = (structure.blocks ?? []).filter((b) => (b.zone ?? 'content') === resolved.zone);
  if (refBlocks.some((b) => !Array.isArray(b.features))) {
    throw compareError(`в структуре ${label} нет признаков разметки — сначала reference structure --slug ${slug}`, 'NO_FEATURES', 1);
  }
  const { html } = published ? await driver.publishedHtml(url) : await driver.pageRawHtml();
  const builtBlocks = builtBlocksFromHtml(html);
  const subs = resolved.substitutes ?? {};
  const { pairs, refOnly, builtOnly } = alignBlocks(refBlocks, builtBlocks, subs);
  const maps = {};
  const mapOf = (tplid) => {
    if (!(tplid in maps)) maps[tplid] = loadSettingsMap(tplid, { baseDir: catalogDir });
    return maps[tplid];
  };
  const skippedByOrder = new Map((plan.skipped ?? []).map((s) => [s.order, s.reason]));
  const rows = [];
  for (const { ref, built } of pairs) {
    const from = String(ref.tplid);
    const to = String(subs[from] ?? from);
    const c = compareBlock(ref, built, { map: from === to ? mapOf(from) : null, substituted: from !== to ? { from, to } : null });
    rows.push({ order: ref.order, tplid: from === to ? from : `${from}→${to}`, common: c.common, refOnly: c.refOnly.length, builtOnly: c.builtOnly.length, score: c.score, reasons: c.reasons });
  }
  for (const ref of refOnly) rows.push({ order: ref.order, tplid: String(ref.tplid), notBuilt: skippedByOrder.get(ref.order) ?? true });
  rows.sort((a, b) => a.order - b.order);
  const paired = rows.filter((r) => !r.notBuilt);
  const meanScore = paired.length ? paired.reduce((s, r) => s + r.score, 0) / paired.length : 0;
  const root = refPaths(slug, { baseDir }).root;
  mkdirSync(join(root, 'compare'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  const path = join(root, 'compare', `${label}.json`);
  const report = join(root, 'reports', `${label}.auto.md`);
  const data = { label, at: now, source: published ? 'published' : 'preview', blocks: refBlocks.length, pairs: pairs.length, meanScore, rows, builtOnly: builtOnly.map((b) => b.tplid) };
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  writeFileSync(report, renderCompareReport({ label, rows, builtOnly, at: now }), 'utf8');
  log.info('compareReferencePage', 'сверка', { label, pairs: pairs.length, notBuilt: refOnly.length, extra: builtOnly.length, meanScore: Math.round(meanScore * 100) / 100 });
  return { label, blocks: refBlocks.length, pairs: pairs.length, meanScore, refOnly: refOnly.length, builtOnly: builtOnly.length, path, report, rows };
}
