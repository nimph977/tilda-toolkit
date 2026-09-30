import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { alignPages, comparePages, expectedChanges, remapPlan, writeJson } from '../promote.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

function snapshot(pageid, recordid, text = 'Before') {
  return {
    pageid, errors: [],
    inventory: [{ recordid, tplid: '396', zeroIndex: 1, order: 1, hidden: false }],
    zero: { [recordid]: { ab_height: '300', timestamp: 'volatile', 0: { elem_id: '9000000000001', elem_type: 'text', text } } },
    records: {},
  };
}

test('promotion comparison rejects drift unless an exact verified journal change explains it', () => {
  const backup = snapshot('300003', '8001');
  const working = snapshot('200002', '7001', 'After');
  assert.equal(comparePages(backup, working).problems.length, 1);
  const journal = [{
    at: '2026-01-02T03:04:05.006Z', verify: [], written: 1,
    ops: [{ kind: 'zero', recordid: '7001', added: [], removed: [], changes: [
      { key: '0', elem_id: '9000000000001', field: 'text', from: 'Before', to: 'After' },
    ] }],
  }];
  const compared = comparePages(backup, working, expectedChanges(journal));
  assert.deepEqual(compared.problems, []);
  assert.equal(compared.explained.length, 1);
  backup.zero['8001'][0].text = 'Manual edit';
  assert.equal(comparePages(backup, working, expectedChanges(journal)).problems.length, 1);
});

test('promotion remaps plan block identifiers to the target page and rejects unknown blocks', () => {
  const mapping = new Map([['7001', '9001'], ['7002', '9002']]);
  const plan = { page: '200002', startAfter: '7001', ops: [
    { block: { recordid: '7001' }, elem: { elem_id: '9000000000001' }, set: { text: 'After' } },
    { moveBlock: { recordid: '7002', after: '7001' } },
    { setOrder: ['7001', '7002'] },
  ] };
  const target = remapPlan(plan, '200001', mapping);
  assert.deepEqual([target.page, target.startAfter, target.ops[0].block.recordid, target.ops[1].moveBlock.recordid, target.ops[1].moveBlock.after, target.ops[2].setOrder], ['200001', '9001', '9001', '9002', '9001', ['9001', '9002']]);
  assert.equal(plan.page, '200002');
  assert.throws(() => remapPlan({ page: '200002', ops: [{ block: { recordid: 'nope' } }] }, '200001', mapping), (error) => error.code === 'REMAP_FAILED' && error.key === 'promote.remapFailed' && error.params.id === 'nope');
});

test('promotion problems are messages with a key, and the report file gets their English text', () => {
  const backup = snapshot('300003', '8001');
  const working = snapshot('200002', '7001', 'After');
  const problem = comparePages(backup, working).problems[0];
  assert.equal(problem.problem.key, 'promote.problem.elementFieldDiffers');
  assert.equal(alignPages({ inventory: [] }, working).problems[0].problem.key, 'promote.problem.blockCountMismatch');
  const dir = mkdtempSync(join(tmpdir(), 'promote-report-'));
  try {
    const file = writeJson(join(dir, 'report.json'), { problems: [problem] });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).problems[0].problem, 'an element field differs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
