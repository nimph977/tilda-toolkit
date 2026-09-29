import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWidthSpec, boxesOverlap, checkBoxes } from '../layout-sweep.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
const el = (id, type, b, extra = {}) => ({ id, type, visible: true, box: b, clipped: false, scrollHeight: 0, clientHeight: 0, text: id, ...extra });

test('parseWidthSpec: диапазон с шагом, хвост, перечисление, ошибки', () => {
  assert.deepEqual(parseWidthSpec('320-1440:40').slice(0, 3), [320, 360, 400]);
  assert.equal(parseWidthSpec('320-1440:40').length, 29);
  assert.deepEqual(parseWidthSpec('320-500:100'), [320, 420, 500]);
  assert.deepEqual(parseWidthSpec('320, 375,768'), [320, 375, 768]);
  assert.deepEqual(parseWidthSpec(undefined), parseWidthSpec('320-1440:40'));
  assert.throws(() => parseWidthSpec('900-300'), /неверный диапазон/);
  assert.throws(() => parseWidthSpec('abc'), /пусто/);
});

test('boxesOverlap: порог по обеим осям', () => {
  assert.deepEqual(boxesOverlap(box(0, 0, 100, 50), box(50, 20, 100, 50)), { w: 50, h: 30 });
  assert.equal(boxesOverlap(box(0, 0, 100, 50), box(100, 0, 100, 50)), null);
  assert.equal(boxesOverlap(box(0, 0, 100, 50), box(97, 0, 100, 50)), null, 'касание в 3 px — не пересечение');
  assert.equal(boxesOverlap(box(0, 0, 100, 50), box(0, 48, 100, 50)), null, 'по вертикали 2 px — не пересечение');
});

test('checkBoxes: overflow, outside, below, clipped, overlap; фигуры не считаются', () => {
  const env = { innerWidth: 320, blockBottom: 1000, scrollWidth: 340 };
  const elems = [
    el('bg', 'shape', box(-500, 0, 1700, 1000)),                        // фигура за краем — не нарушение
    el('t1', 'text', box(66, 900, 323, 19)),                            // правый край 389 > 320 → outside
    el('t2', 'text', box(10, 990, 200, 40), { clipped: true, scrollHeight: 60, clientHeight: 40 }), // below + clipped
    el('t3', 'text', box(10, 100, 200, 40)),
    el('t4', 'text', box(100, 120, 200, 40)),                           // пересекает t3 на 110×20
    el('hid', 'text', box(0, 0, 1000, 1000), { visible: false }),      // скрытый не считается
  ];
  const kinds = checkBoxes(elems, env).map((i) => `${i.kind}:${i.elem || ''}${i.other ? '+' + i.other : ''}`).sort();
  assert.deepEqual(kinds, ['below:t2', 'clipped:t2', 'outside:t1', 'overflow:', 'overlap:t3+t4']);
});

test('checkBoxes: кнопка, целиком накрытая формой — приём шаблона; частично — нарушение', () => {
  const env = { innerWidth: 1200, blockBottom: 2000, scrollWidth: 1200 };
  const full = [el('f', 'form', box(80, 800, 1035, 90)), el('b', 'button', box(785, 800, 330, 90))];
  assert.deepEqual(checkBoxes(full, env), []);
  const shifted = [el('f', 'form', box(315, 1396, 330, 310)), el('b', 'button', box(315, 1641, 330, 90))];
  const issues = checkBoxes(shifted, env);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'overlap');
  assert.equal(issues[0].detail, '330×65 px');
});

test('formFieldChanges: удаление элемента формы целиком допускается, правка поля — нет', async () => {
  const { formFieldChanges } = await import('../lib/form-fields.mjs');
  const before = { 0: { elem_id: 'a', elem_type: 'form', receivers: 'x', inputs: '[]' }, 1: { elem_id: 'b', elem_type: 'text', text: 't' } };
  assert.deepEqual(formFieldChanges(before, { 1: before[1] }), []);
  assert.deepEqual(formFieldChanges(before, { 0: { ...before[0], receivers: 'y' }, 1: before[1] }), [{ key: '0', field: 'receivers' }]);
  assert.deepEqual(formFieldChanges({ 1: before[1] }, before).map((c) => c.field), ['receivers', 'inputs']);
});
