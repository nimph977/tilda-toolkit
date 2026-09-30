import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRecord, listRecords, readRecord, recordName, reversePlan, writeRecord } from '../journal.mjs';
import { setLogLevel } from '../lib/log.mjs';
import { msg } from '../lib/i18n.mjs';

setLogLevel('ERROR');

test('journal writes a synthetic record and builds a rollback plan from recorded from values', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-journal-test-'));
  try {
    const record = buildRecord({
      at: '2026-01-02T03:04:05.006Z',
      plan: { name: 'synthetic-change', page: '200002', ops: [{}] },
      payloads: [{
        kind: 'zero', recordid: '7001', model: { 0: { elem_id: '9000000000001' } },
        changes: [{ key: '0', field: 'text', from: 'Before', to: 'After' }],
      }],
      summary: { written: 1, verify: [] },
    });
    assert.equal(recordName(record.at, record.plan.name), '2026-01-02T03-04-05-006Z-synthetic-change.json');
    const path = writeRecord(record, { baseDir });
    assert.deepEqual(readRecord(path).blocks, ['7001']);
    assert.equal(listRecords('200002', { baseDir }).length, 1);
    const rollback = reversePlan(record);
    assert.deepEqual(rollback.plan.ops, [{
      block: { recordid: '7001' }, elem: { elem_id: '9000000000001' }, set: { text: 'Before' },
    }]);
    assert.equal(rollback.plan.resStrategy, 'none');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('rollback refuses a journal record with no reversible operation', () => {
  const record = { at: '2026-01-02T03:04:05.006Z', page: '200002', plan: { name: 'create-only' }, ops: [{ kind: 'create', id: '1', recordid: '7001' }] };
  assert.throws(() => reversePlan(record), (error) => error.code === 'ROLLBACK_IMPOSSIBLE');
});

test('journal records a created block without a source as new:<tplid>', () => {
  const record = buildRecord({
    at: '2026-01-02T03:04:05.006Z',
    plan: { name: 'new-block', page: '200002', ops: [{ id: 'b1', newRecord: { tplid: '796', fields: [] } }] },
    payloads: [{ kind: 'create', mode: 'new', id: 'b1', tplid: '796', fields: [], hidden: 'n', expect: { values: {}, cards: [] } }],
    summary: { written: 1, verify: [], created: [{ id: 'b1', recordid: '7009' }] },
  });
  assert.deepEqual(record.ops[0], { kind: 'create', id: 'b1', recordid: '7009', tplid: '796', source: 'new:796', from: null, to: 'created' });
});

test('journal writes verify problems as English text and reports skipped operations by key', () => {
  const problem = msg('apply.problem.fieldNotSaved');
  const record = buildRecord({
    at: '2026-01-02T03:04:05.006Z',
    plan: { name: 'mixed', page: '200002', ops: [{}, {}] },
    payloads: [
      { kind: 'record', recordid: '7001', field: 'title', value: 'After' },
      { kind: 'block', recordid: '7002', hidden: 'y' },
    ],
    summary: { written: 2, verify: [{ id: '7001.title', problem, field: 'title' }] },
    before: { records: { 7001: { record: { title: 'Before' } } }, inventory: [] },
  });
  assert.equal(record.verify[0].problem, 'the field was not saved');
  assert.equal(typeof JSON.parse(JSON.stringify(record)).verify[0].problem, 'string');
  const { skipped } = reversePlan(record);
  assert.deepEqual(skipped.map((s) => [s.recordid, s.reason.key]), [['7002', 'journal.skip.noFrom']]);
});
