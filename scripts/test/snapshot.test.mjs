import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { list, load, save, snapshotPath } from '../snapshot.mjs';

test('synthetic snapshots round-trip and preserve a backup before overwrite', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-snapshot-test-'));
  try {
    const ref = { kind: 'zero', pageid: '200002', recordid: '7001' };
    const first = save({ ...ref, data: { version: 1 }, source: 'synthetic-test' }, { baseDir });
    assert.equal(first.path, snapshotPath(ref, { baseDir }));
    assert.deepEqual(load(ref, { baseDir }), { version: 1 });
    const second = save({ ...ref, data: { version: 2 } }, { baseDir });
    assert.ok(second.backup && existsSync(second.backup));
    assert.deepEqual(JSON.parse(readFileSync(second.backup, 'utf8')), { version: 1 });
    save({ kind: 'record', pageid: '200002', recordid: '7002', data: { record: { recordid: '7002' } } }, { baseDir });
    assert.deepEqual(list('200002', { baseDir }).map((entry) => [entry.kind, entry.recordid]).sort(), [['record', '7002'], ['zero', '7001']]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('snapshot rejects missing records and unknown kinds', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-snapshot-test-'));
  try {
    assert.throws(() => load({ kind: 'zero', pageid: '200002', recordid: '7001' }, { baseDir }), /NO_SNAPSHOT/);
    assert.throws(() => snapshotPath({ kind: 'unknown', pageid: '200002', recordid: '7001' }, { baseDir }), /kind/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
