import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReplacePlan, find, replaceNormalized } from '../find-replace.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

test('synthetic snapshots: find and replacement plan preserve form-field exclusions', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-toolkit-test-'));
  try {
    mkdirSync(join(baseDir, 'zero', '200002'), { recursive: true });
    mkdirSync(join(baseDir, 'records', '200002'), { recursive: true });
    writeFileSync(join(baseDir, 'zero', '200002', '7001.json'), JSON.stringify({
      ab_height: '300',
      0: { elem_id: '9000000000001', elem_type: 'text', text: 'Contact demo@example.test' },
      1: { elem_id: '9000000000002', elem_type: 'form', receivers: 'demo@example.test', text: 'Send a note' },
    }));
    writeFileSync(join(baseDir, 'records', '200002', '7002.json'), JSON.stringify({
      record: { recordid: '7002', tplid: '10', formmsgurl: 'demo@example.test', buttontitle: 'Email demo@example.test' },
    }));

    const result = find('200002', 'demo@example.test', { baseDir });
    assert.deepEqual(result.hits.map((hit) => `${hit.kind}:${hit.recordid}:${hit.field}`), [
      'zero:7001:text', 'record:7002:buttontitle',
    ]);
    assert.deepEqual(result.skippedForm.map((hit) => `${hit.kind}:${hit.recordid}:${hit.field}`), [
      'zero:7001:receivers', 'record:7002:formmsgurl',
    ]);

    const replacement = buildReplacePlan('200002', 'demo@example.test', 'support@example.test', { baseDir });
    assert.equal(replacement.replacements, 2);
    assert.equal(replacement.plan.ops.length, 2);
    assert.doesNotMatch(JSON.stringify(replacement.plan), /receivers|formmsgurl/);
    assert.deepEqual(replaceNormalized('demo&nbsp;@example.test', 'demo @example.test', 'x'), { value: 'x', count: 1 });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('find skips snapshots of blocks missing from the inventory', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-toolkit-test-'));
  try {
    const recDir = join(baseDir, 'records', '200003');
    mkdirSync(recDir, { recursive: true });
    for (const id of ['7101', '7102', '7103']) {
      writeFileSync(join(recDir, `${id}.json`), JSON.stringify({ record: { recordid: id, tplid: '10', title: `Call demo ${id}` } }));
    }
    const noInventory = find('200003', 'demo', { baseDir });
    assert.deepEqual([noInventory.hits.length, noInventory.skippedStale], [3, 0], 'без инвентаря — прежний обход');

    writeFileSync(join(recDir, '_inventory.json'), JSON.stringify([{ order: 1, recordid: '7101', tplid: '10' }, { order: 2, recordid: 7102, tplid: '10' }]));
    const live = find('200003', 'demo', { baseDir });
    assert.deepEqual(live.hits.map((h) => h.recordid), ['7101', '7102']);
    assert.deepEqual([live.blocks, live.skippedStale], [2, 1]);

    const explicit = find('200003', 'demo', { baseDir, recordids: ['7103'] });
    assert.deepEqual(explicit.hits.map((h) => h.recordid), ['7103'], 'recordids из опций важнее файла инвентаря');
    assert.equal(buildReplacePlan('200003', 'demo', 'x', { baseDir }).skippedStale, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
