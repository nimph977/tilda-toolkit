import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { buildUpdateOps, UPDATE_REASONS } from '../lib/plan-update.mjs';
import { normalizeFieldValue } from '../apply-plan.mjs';

setLogLevel('ERROR');

// Идентификаторы синтетические, 13 знаков (правило no-real-ids).
const R1 = '1000000000021';
const R2 = '1000000000022';
const R3 = '1000000000023';
const deps = { normalize: normalizeFieldValue };

test('a differing field gives one field op, equal JSON in another key order and an empty plan value do not', () => {
  const plan = [{ id: 'b1', newRecord: { tplid: '686', fields: [
    { name: 'blocks', value: '3' },
    { name: 'button_styles', value: '{"a":"1","b":"2"}' },
    { name: 'descr', value: '' },
  ] } }];
  const live = [{ recordid: R1, tplid: '686', fields: { blocks: '2', button_styles: '{"b":"2","a":"1"}' } }];
  const r = buildUpdateOps(plan, live, deps);
  assert.deepEqual(r.ops, [{ id: 'b1.blocks', block: { recordid: R1 }, field: { name: 'blocks', value: '3' } }]);
  assert.deepEqual(r.unmapped, []);
});

test('a field repeated in the plan is compared by its last value, as on block creation', () => {
  const plan = [{ id: 'b2', newRecord: { tplid: '794', fields: [
    { name: 'linkhook', value: '' },
    { name: 'linkhook', value: '#submenu:more' },
  ] } }];
  const live = [{ recordid: R1, tplid: '794', fields: { linkhook: '#submenu:more' } }];
  assert.deepEqual(buildUpdateOps(plan, live, deps).ops, [], 'пустое первое значение не стирает хук');
});

test('a block missing on the page becomes newRecord after its predecessor, an extra page block gets a reason', () => {
  const plan = [
    { id: 'b1', newRecord: { tplid: '213', fields: [{ name: 'title', value: 'A' }] } },
    { id: 'b2', formContent: 'reference', newRecord: { tplid: '702', fields: [{ name: 'formmsgurl', value: '/x' }] } },
    { id: 'b3', newRecord: { tplid: '30', fields: [{ name: 'title', value: 'C' }] } },
  ];
  const live = [
    { recordid: R1, tplid: '213', fields: { title: 'A' } },
    { recordid: R2, tplid: '30', fields: { title: 'C' } },
    { recordid: R3, tplid: '212', fields: {} },
  ];
  const r = buildUpdateOps(plan, live, deps);
  assert.equal(r.startAfter, R1);
  assert.deepEqual(r.ops, [{ id: 'b2', newRecord: plan[1].newRecord, hidden: 'n', formContent: 'reference' }]);
  assert.deepEqual(r.unmapped, [{ recordid: R3, tplid: '212', field: null, reason: UPDATE_REASONS.extraBlock }]);
});

test('card texts are set by index without touching images; a code difference is a manual reason', () => {
  const plan = [
    { id: 'b1', newRecord: { tplid: '686', fields: [], cards: [{ li_title: 'Один', li_buttontitle: 'Подробнее', li_img: '' }, { li_title: 'Два', li_buttontitle: 'Подробнее', li_img: '' }], images: [{ card: 0, field: 'li_img', file: 'x.jpg' }] } },
    { id: 'b2', newRecord: { tplid: '131', fields: [], code: '<div>новый</div>' } },
  ];
  const live = [
    { recordid: R1, tplid: '686', fields: { list: JSON.stringify([{ lid: '1', li_title: 'Один', li_buttontitle: '', li_img: 'https://cdn.test/a.jpg' }, { lid: '2', li_title: 'Два', li_buttontitle: '', li_img: 'https://cdn.test/b.jpg' }]) } },
    { recordid: R2, tplid: '131', fields: { code: '<div>старый</div>' } },
  ];
  const r = buildUpdateOps(plan, live, deps);
  assert.deepEqual(r.ops, [{ id: 'b1.list', block: { recordid: R1 }, listSet: { set: [{ index: 0, fields: { li_buttontitle: 'Подробнее' } }, { index: 1, fields: { li_buttontitle: 'Подробнее' } }] } }]);
  assert.ok(r.unmapped.some((u) => u.field === 'code' && u.reason === UPDATE_REASONS.codeManual));
  assert.ok(r.unmapped.some((u) => u.field === 'li_img' && u.reason === UPDATE_REASONS.imageKept));
});

test('form inputs are compared with the list of the page block and written with the form flag', () => {
  const items = [{ li_type: 'nm', li_nm: 'Имя', li_req: 'y' }];
  const plan = [{ id: 'b1', formContent: 'reference', newRecord: { tplid: '702', fields: [{ name: 'forminputs', value: JSON.stringify(items) }] } }];
  const same = buildUpdateOps(plan, [{ recordid: R1, tplid: '702', fields: { list: JSON.stringify([{ lid: '9', ls: '10', li_type: 'nm', li_nm: 'Имя', li_req: 'y' }]) } }], deps);
  assert.deepEqual(same.ops, []);
  const other = buildUpdateOps(plan, [{ recordid: R1, tplid: '702', fields: { list: JSON.stringify([{ lid: '9', li_type: 'em', li_nm: 'Email' }]) } }], deps);
  assert.deepEqual(other.ops, [{ id: 'b1.forminputs', block: { recordid: R1 }, field: { name: 'forminputs', value: JSON.stringify(items) }, formContent: 'reference' }]);
});
