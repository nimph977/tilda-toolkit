import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { probeVariants, sampleContent, buildSettingsMap, jsonKeyKind, CALIBRATION_REASONS, MAP_VERSION } from '../lib/settings-calibration.mjs';

setLogLevel('ERROR');

const schema = {
  tplid: '686',
  fields: {
    blocks: { type: 'sb', kind: 'enum', options: ['2', '3', '4'] },
    filteropacity: { type: 'sb', kind: 'enum', options: ['70', '30'] },
    filtercolor: { type: 'co', kind: 'color' },
    height: { type: 'in_vh', kind: 'size' },
    animationoff: { type: 'cb', kind: 'flag' },
    title_typo: { type: 'json', kind: 'json', jsonFields: ['fontfamily', 'color', 'mystery'] },
    weird: { type: 'x', kind: 'unknown' },
  },
};

test('probeVariants lists values by field kind and skips unknown types', () => {
  const { variants, skipped } = probeVariants(schema, { blocks: '2', filteropacity: '70', animationoff: '', title_typo: '{"color":"#000000"}' });
  const of = (field, key) => variants.filter((v) => v.field === field && v.key === key).map((v) => v.keyValue ?? v.value);
  assert.deepEqual(of('blocks'), ['3', '4']);
  assert.deepEqual(of('filteropacity'), ['30']);
  assert.deepEqual(of('filtercolor'), ['#123456', '#65a3c1']);
  assert.deepEqual(of('height'), ['337px', '63vh']);
  assert.deepEqual(of('animationoff'), ['on']);
  assert.deepEqual(of('title_typo', 'fontfamily'), ['CalibA', 'CalibB']);
  const json = variants.find((v) => v.key === 'fontfamily');
  assert.deepEqual(JSON.parse(json.value), { color: '#000000', fontfamily: 'CalibA' }, 'остальные ключи JSON сохраняются');
  assert.deepEqual(skipped, [
    { field: 'title_typo', key: 'mystery', reason: CALIBRATION_REASONS.jsonKeyUntyped('mystery') },
    { field: 'weird', reason: CALIBRATION_REASONS.unknownType('x') },
  ]);
  assert.equal(jsonKeyKind('bordercolorhover').kind, 'color');
  assert.equal(jsonKeyKind('fontsize_res_480').kind, 'size');
});

const B = ['class:t686', 'class:t-col_6', 'attr:data-columns-in-row=2', 'style:background-image:linear-gradient(to bottom,rgba(0,0,0,0.70),rgba(0,0,0,0.70))', 'style:height:50vh'];
const swap = (from, to) => B.map((f) => (f === from ? to : f));
const grad = B[3];

test('buildSettingsMap derives enum, slot and text rules and skips silent fields', () => {
  const observations = [
    { field: 'blocks', value: '3', features: swap('class:t-col_6', 'class:t-col_4').map((f) => (f === 'attr:data-columns-in-row=2' ? 'attr:data-columns-in-row=3' : f)) },
    { field: 'blocks', value: '4', features: swap('class:t-col_6', 'class:t-col_3').map((f) => (f === 'attr:data-columns-in-row=2' ? 'attr:data-columns-in-row=4' : f)) },
    { field: 'filtercolor', value: '#123456', features: swap(grad, 'style:background-image:linear-gradient(to bottom,rgba(18,52,86,0.70),rgba(0,0,0,0.70))') },
    { field: 'filtercolor', value: '#65a3c1', features: swap(grad, 'style:background-image:linear-gradient(to bottom,rgba(101,163,193,0.70),rgba(0,0,0,0.70))') },
    { field: 'height', value: '337px', features: swap('style:height:50vh', 'style:height:337px') },
    { field: 'height', value: '63vh', features: swap('style:height:50vh', 'style:height:63vh') },
    { field: 'title_typo', key: 'fontfamily', value: '{"fontfamily":"CalibA"}', keyValue: 'CalibA', features: [...B, "css:|#recRID .t-card__title{font-family:'CalibA'}"] },
    { field: 'title_typo', key: 'fontfamily', value: '{"fontfamily":"CalibB"}', keyValue: 'CalibB', features: [...B, "css:|#recRID .t-card__title{font-family:'CalibB'}"] },
    { field: 'animationoff', value: 'on', features: [...B] },
  ];
  const map = buildSettingsMap({ tplid: '686', schema, baseFeatures: B, observations, current: { blocks: '2' }, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(map.version, MAP_VERSION);
  assert.equal(map.calibratedAt, '2026-01-01T00:00:00.000Z');

  const blocks = map.fields.blocks.rule;
  assert.equal(blocks.type, 'enum');
  assert.deepEqual(blocks.cases.map((c) => c.value), ['2', '3', '4']);
  assert.deepEqual(blocks.cases[1].signature, ['attr:data-columns-in-row=3', 'class:t-col_4']);

  const color = map.fields.filtercolor.rule;
  assert.equal(color.type, 'slot');
  assert.equal(color.encoding, 'rgb');
  assert.equal(color.slot, 0);
  assert.equal(color.shape, 'style:background-image:linear-gradient(to bottom,rgba(§,§,§,§),rgba(§,§,§,§))');
  assert.equal(color.confirmed, true);

  const height = map.fields.height.rule;
  assert.equal(height.type, 'slot');
  assert.equal(height.encoding, 'number');
  assert.ok(['px', 'vh'].includes(height.unit));

  const font = map.fields.title_typo.keys.fontfamily;
  assert.equal(font.kind, 'text');
  assert.deepEqual(font.rule, { type: 'text', shape: "css:|#recRID .t-card__title{font-family:'§t'}", confirmed: true });

  assert.deepEqual(map.skipped, [{ field: 'animationoff', reason: CALIBRATION_REASONS.noSignal }]);
});

test('buildSettingsMap ignores noise features and reports failed previews', () => {
  const noisy = [...B, 'attr:data-random=1'];
  const map = buildSettingsMap({
    tplid: '1',
    schema,
    baseFeatures: noisy,
    noiseFeatures: ['attr:data-random=1', 'attr:data-random=2'],
    observations: [{ field: 'animationoff', value: 'on', features: [...B, 'attr:data-random=2'] }],
    failed: [{ field: 'blocks', error: 'TIMEOUT' }],
  });
  assert.deepEqual(map.fields, {});
  assert.deepEqual(map.skipped, [
    { field: 'blocks', reason: CALIBRATION_REASONS.previewFailed('TIMEOUT') },
    { field: 'animationoff', reason: CALIBRATION_REASONS.noSignal },
  ]);
});

test('sampleContent fills empty texts, buttons and card keys', () => {
  const entry = {
    defaults: { id: '1', title: '', btitle: 'Head', list: JSON.stringify([{ lid: '1', li_title: 'A', li_buttontitle: '', li_link: '' }]) },
    tplFields: ['title', 'buttontitle', 'buttonlink2', 'img'],
    cardKeys: ['li_title', 'li_descr', 'li_buttontitle', 'li_link'],
  };
  const s = sampleContent(entry);
  assert.equal(s.id, undefined);
  assert.equal(s.title, 'Sample');
  assert.equal(s.btitle, 'Head');
  assert.equal(s.buttontitle, 'Button');
  assert.equal(s.buttonlink2, '#');
  assert.equal(s.img, undefined);
  assert.deepEqual(JSON.parse(s.list), [{ lid: '1', li_title: 'A', li_descr: 'Sample', li_buttontitle: 'Button', li_link: '#' }]);
});
