import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { normalizeSchema, KIND_BY_TYPE } from '../lib/settings-schema.mjs';

setLogLevel('ERROR');

test('normalizeSchema maps editor types to field kinds', () => {
  const raw = {
    tplid: '686',
    fields: [
      { name: 'blocks', type: 'sb', options: ['2', '3', '4', '4'], jsonFields: null, mobile: 'blocks_res_480', desktop: null },
      { name: 'blocks_res_480', type: 'sb', options: ['1', '2'], jsonFields: null, mobile: null, desktop: 'blocks' },
      { name: 'filtercolor', type: 'co', options: null, jsonFields: null, mobile: null, desktop: null },
      { name: 'button_styles', type: 'json', options: null, jsonFields: ['color', 'radius'], mobile: null, desktop: null },
      { name: 'screenmax', type: 'screen', options: null, jsonFields: null, mobile: null, desktop: null },
      { name: 'animationoff', type: 'cb', options: null, jsonFields: null, mobile: null, desktop: null },
      { name: 'height', type: 'in_vh', options: null, jsonFields: null, mobile: null, desktop: null },
      { name: 'x', type: 'strange', options: null, jsonFields: null, mobile: null, desktop: null },
      { name: 'empty', type: 'sb', options: [], jsonFields: null, mobile: null, desktop: null },
    ],
  };
  const s = normalizeSchema(raw);
  assert.equal(s.tplid, '686');
  assert.deepEqual(s.fields.blocks, { type: 'sb', kind: 'enum', options: ['2', '3', '4'] });
  assert.deepEqual(s.fields.blocks_res_480, { type: 'sb', kind: 'enum', options: ['1', '2'], mobileOf: 'blocks' });
  assert.equal(s.fields.filtercolor.kind, 'color');
  assert.deepEqual(s.fields.button_styles, { type: 'json', kind: 'json', jsonFields: ['color', 'radius'] });
  assert.equal(s.fields.screenmax.kind, 'size');
  assert.equal(s.fields.animationoff.kind, 'flag');
  assert.equal(s.fields.height.kind, 'size');
  assert.equal(s.fields.x.kind, 'unknown');
  assert.equal(s.fields.empty.kind, 'unknown', 'список без вариантов не калибруется');
  assert.equal(KIND_BY_TYPE.radius, 'size');
});

test('normalizeSchema tolerates empty input', () => {
  assert.deepEqual(normalizeSchema({}), { tplid: '', fields: {} });
  assert.deepEqual(normalizeSchema(null), { tplid: '', fields: {} });
});
