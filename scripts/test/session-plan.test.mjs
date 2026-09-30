import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePayloads } from '../session-plan.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

test('describePayloads gives plain lines for value changes and messages for descriptions with text', () => {
  const lines = describePayloads([
    { kind: 'record', recordid: '5001', field: 'title', value: 'New' },
    { kind: 'sort', moves: [{ recordid: '5002', from: 3, to: 1 }] },
    { kind: 'create', mode: 'new', id: 'n1', tplid: '30', fields: ['a', 'b'] },
    { kind: 'create', id: 'n2', tplid: '30', source: { page: '200002', recordid: '5003' } },
  ]);
  assert.equal(lines[0], '5001.title → "New"');
  assert.deepEqual([lines[1].key, lines[1].params], ['stage.change.position', { recordid: '5002', from: 3, to: 1 }]);
  assert.deepEqual([lines[2].key, lines[2].params.fields], ['stage.change.createFromFields', 2]);
  assert.deepEqual([lines[3].key, lines[3].params.page, lines[3].params.recordid], ['stage.change.createFromSource', '200002', '5003']);
});
