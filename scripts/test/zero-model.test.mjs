import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  elementKeys, findElement, setFields, setHidden, setLink, duplicateElement,
  diff, validate,
} from '../zero-model.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

function model() {
  return {
    ab_height: '360',
    'ab_height-res-320': '420',
    groups: [],
    0: {
      elem_id: '9000000000001', elem_type: 'text', text: 'Sample heading',
      top: '20', left: '30', width: '300', height: '40', fontsize: '20',
      'top-res-320': '15', 'left-res-320': '12', 'fontsize-res-320': '16', 'hidden-res-320': 'n',
    },
    1: {
      elem_id: '9000000000002', elem_type: 'shape', text: 'Action',
      top: '120', left: '20', width: '100', height: '40', zindex: '1',
      'top-res-320': '90', 'left-res-320': '10',
    },
    2: {
      elem_id: '9000000000003', elem_type: 'shape', text: 'Details',
      top: '120', left: '140', width: '100', height: '40', zindex: '2',
      'top-res-320': '90', 'left-res-320': '120',
    },
  };
}

test('synthetic Zero Block: selection, adaptive fields, and safety guards', () => {
  const before = model();
  assert.deepEqual(elementKeys(before), ['0', '1', '2']);
  assert.equal(findElement(before, { textIncludes: 'heading' }).key, '0');
  assert.throws(() => findElement(before, { textIncludes: 'e' }), /AMBIGUOUS/);

  const updated = setFields(before, '0', { fontsize: '30' });
  assert.equal(updated['0'].fontsize, '30');
  assert.equal(updated['0']['fontsize-res-320'], '24');
  assert.equal(before['0'].fontsize, '20');
  assert.ok(diff(before, updated).some((change) => change.field === 'fontsize-res-320'));

  const hidden = setHidden(before, '0', true);
  assert.deepEqual([hidden['0'].hidden, hidden['0']['hidden-res-320']], ['y', 'y']);
  assert.throws(() => setFields(before, '0', { text: '<script>alert(1)</script>' }), /SCRIPT_REJECTED/);
  assert.throws(() => setLink(before, '1', 'javascript:alert(1)'), /LINK_REJECTED/);
});

test('synthetic Zero Block: duplication produces a valid, separate element', () => {
  const before = model();
  const result = duplicateElement(before, { elem_id: '9000000000003' }, { now: 9000000000010 });
  assert.equal(result.needsConfirm, false);
  assert.equal(result.elem_id, '9000000000010');
  assert.equal(result.model[result.key].left, '260');
  assert.equal(result.model[result.key]['left-res-320'], '230');
  assert.equal(result.model[result.key].zindex, '3');
  assert.equal(before['2'].left, '140');
  assert.equal(validate(before, result.model, { allowNewElements: true }), true);
});
