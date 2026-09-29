import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { decodeSettings } from '../lib/settings-decode.mjs';

setLogLevel('ERROR');

const GRAD = (r, g, b, a) => `style:background-image:linear-gradient(to bottom,rgba(${r},${g},${b},${a}),rgba(${r},${g},${b},${a}))`;

// Синтетическая карта в форме итога buildSettingsMap.
const map = {
  tplid: '686',
  version: 1,
  baseFeatures: ['class:t686', 'class:t-col_6', 'attr:data-columns-in-row=2', GRAD(0, 0, 0, '0.70'), 'style:height:50vh', 'style:border-top:1px solid #eeeeee'],
  fields: {
    blocks: {
      kind: 'enum',
      rule: {
        type: 'enum',
        cases: [
          { value: '2', signature: ['attr:data-columns-in-row=2', 'class:t-col_6'] },
          { value: '3', signature: ['attr:data-columns-in-row=3', 'class:t-col_4'] },
          { value: '4', signature: ['attr:data-columns-in-row=4', 'class:t-col_3'] },
        ],
      },
    },
    filteropacity: {
      kind: 'enum',
      rule: { type: 'enum', cases: [{ value: '70', signature: [GRAD(0, 0, 0, '0.70')] }, { value: '30', signature: [GRAD(0, 0, 0, '0.30')] }] },
    },
    filtercolor: { kind: 'color', rule: { type: 'slot', shape: 'style:background-image:linear-gradient(to bottom,rgba(§,§,§,§),rgba(§,§,§,§))', slot: 0, encoding: 'rgb' } },
    height: { kind: 'size', rule: { type: 'slot', shape: 'style:height:§px', slot: 0, encoding: 'number', unit: 'px', also: [{ shape: 'style:height:§vh', slot: 0, encoding: 'number', unit: 'vh' }] } },
    bordercolor: { kind: 'color', rule: { type: 'slot', shape: 'style:border-top:§px solid §', slot: 1, encoding: 'hex' } },
    button_styles: {
      kind: 'json',
      keys: {
        radius: { kind: 'size', rule: { type: 'slot', shape: 'css:|#recRID .t-btn{border-radius:§px}', slot: 0, encoding: 'number', unit: 'px' } },
        bordercolor: { kind: 'color', rule: { type: 'slot', shape: 'css:|#recRID .t-btn{border-color:§}', slot: 0, encoding: 'hex' } },
        fontfamily: { kind: 'text', rule: { type: 'text', shape: "css:|#recRID .t-btn{font-family:'§t'}" } },
      },
    },
    ghost: { kind: 'color', rule: { type: 'slot', shape: 'css:|#recRID .x{color:§}', slot: 0, encoding: 'hex' } },
    twin: { kind: 'enum', rule: { type: 'enum', cases: [{ value: 'a', signature: ['class:twin'] }, { value: 'b', signature: ['class:twin'] }] } },
  },
};

const defaults = { blocks: '2', filteropacity: '70', filtercolor: '#000000', height: '', bordercolor: '#eeeeee', button_styles: '{"color":"#ffffff","radius":"5px"}' };

test('decodeSettings reads enum, slot, text and JSON keys from reference features', () => {
  const ref = [
    'class:t686', 'class:t-col_4', 'attr:data-columns-in-row=3', GRAD(0, 0, 0, '0.30'), 'style:height:327px',
    'css:|#recRID .t-btn{border-radius:20px}', 'css:|#recRID .t-btn{border-color:#4599ff}', "css:|#recRID .t-btn{font-family:'monserat'}",
    'class:twin', 'class:unknown-extra',
  ];
  const r = decodeSettings(ref, map, defaults);
  assert.equal(r.values.blocks, '3');
  assert.equal(r.values.filteropacity, '30');
  assert.equal('filtercolor' in r.values, false, 'равен умолчанию');
  assert.equal(r.values.height, '327px');
  assert.equal(r.values.bordercolor, '', 'форма есть в базе, у референса нет → пусто');
  assert.deepEqual(JSON.parse(r.values.button_styles), { color: '#ffffff', radius: '20px', bordercolor: '#4599ff', fontfamily: 'monserat' });
  assert.deepEqual(r.undecided, [
    { field: 'ghost', reason: 'absent' },
    { field: 'twin', reason: 'ambiguous' },
  ]);
  assert.deepEqual(r.unexplained, ['class:twin', 'class:unknown-extra']);
});

test('decodeSettings keeps values equal to defaults out and tolerates an empty map', () => {
  const r = decodeSettings(map.baseFeatures, { ...map, fields: { blocks: map.fields.blocks } }, defaults);
  assert.deepEqual(r.values, {});
  assert.deepEqual(decodeSettings(['class:a'], {}, {}), { values: {}, undecided: [], unexplained: ['class:a'] });
});
