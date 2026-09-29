import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { alignBlocks, compareBlock, COMPARE_REASONS, renderCompareReport } from '../lib/block-compare.mjs';
import { builtBlocksFromHtml } from '../reference-compare.mjs';

setLogLevel('ERROR');

const b = (order, tplid, features = []) => ({ order, tplid, features });

test('alignBlocks pairs by template order with a substitute and leaves a skipped block unpaired', () => {
  const ref = [b(1, '770'), b(2, '794'), b(3, '746'), b(4, '702')];
  const built = [b(1, '3535'), b(2, '794'), b(3, '702'), b(4, '212')];
  const r = alignBlocks(ref, built, { 770: '3535' });
  assert.deepEqual(r.pairs.map((p) => [p.ref.order, p.built.order]), [[1, 1], [2, 2], [4, 3]]);
  assert.deepEqual(r.refOnly.map((x) => x.order), [3]);
  assert.deepEqual(r.builtOnly.map((x) => x.order), [4]);
});

test('compareBlock names a value that differs, a missing map and a substitute', () => {
  const map = { fields: { blocks: { kind: 'enum', rule: { type: 'enum', cases: [{ value: '2', signature: ['class:t-col_6'] }] } } } };
  const ref = b(1, '686', ['class:t686', 'style:height:327px', 'class:t-col_4', 'class:odd']);
  const built = b(1, '686', ['class:t686', 'style:height:50px', 'class:t-col_6']);
  const c = compareBlock(ref, built, { map });
  assert.equal(c.common, 1);
  assert.equal(c.score, 0.25);
  assert.ok(c.reasons.includes(COMPARE_REASONS.valueDiffers + ' ×2'), JSON.stringify(c.reasons));
  assert.ok(c.reasons.includes(COMPARE_REASONS.markupDiffers));
  assert.deepEqual(compareBlock(ref, built, { map: null }).reasons, [COMPARE_REASONS.noMap]);
  assert.deepEqual(compareBlock(ref, built, { substituted: { from: '770', to: '3535' } }).reasons, [COMPARE_REASONS.substituted('770', '3535')]);
  assert.deepEqual(compareBlock(ref, { features: ref.features }, { map }).reasons, []);
});

test('renderCompareReport lists not built blocks and carries no long numbers', () => {
  const md = renderCompareReport({
    label: 'P00',
    rows: [
      { order: 1, tplid: '686', common: 3, refOnly: 1, builtOnly: 0, score: 0.75, reasons: [COMPARE_REASONS.valueDiffers] },
      { order: 2, tplid: '746', notBuilt: 'содержимое вне полей field= — не переносится' },
    ],
    builtOnly: [{ tplid: '212' }],
    at: '2026-01-01',
  });
  assert.match(md, /# Сверка разметки P00/);
  assert.match(md, /блок не собран: содержимое вне полей/);
  assert.match(md, /Средняя доля совпавших признаков: 75%/);
  assert.doesNotMatch(md, /\b\d{7,10}\b/);
});

test('builtBlocksFromHtml takes content records of the preview and drops header and footer zones', () => {
  const html = `<header data-tilda-page-id="1000000000001"><div id="rec1000000000011" data-record-type="770"><div class="h"></div></div></header>
<div id="rec1000000000012" class="r" data-record-type="686"><div class="t-col_4"></div></div>
<footer data-tilda-page-id="1000000000002"><div id="rec1000000000013" data-record-type="464"></div></footer>`;
  const blocks = builtBlocksFromHtml(html);
  assert.deepEqual(blocks.map((x) => x.tplid), ['686']);
  assert.ok(blocks[0].features.includes('class:t-col_4'));
  assert.ok(!blocks[0].features.some((f) => f.includes('1000000000012')));
});
