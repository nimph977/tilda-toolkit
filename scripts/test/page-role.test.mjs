import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { assignPageRoles, diffFingerprints, parseRoleArg, ROLE_CONFIRM, validateRoles } from '../page-role.mjs';

setLogLevel('ERROR');

const settings = (headerpageid, footerpageid, fingerprints = { sitename: 'aaaa', headerpageid: 'h0', footerpageid: 'f0' }) => ({
  count: Object.keys(fingerprints).length,
  fingerprints,
  headerpageid,
  footerpageid,
  headerOptions: ['', '100002', '100003'],
  footerOptions: ['', '100002', '100003'],
});

/** Фейковый драйвер: readProjectSettings — ответы по очереди; callWithResponse — заданный текст. */
function fakeDriver(reads, { text = 'OK' } = {}) {
  const calls = [];
  const queue = [...reads];
  return {
    calls,
    call: async (fn, args) => {
      calls.push({ fn, args });
      return queue.shift();
    },
    callWithResponse: async (fn, args, opts) => {
      calls.push({ fn, args, opts });
      return { status: 200, text };
    },
    reload: async () => calls.push({ fn: 'reload' }),
  };
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'page-role-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseRoleArg keeps ids, turns none into empty and leaves undefined alone', () => {
  assert.equal(parseRoleArg('100001'), '100001');
  assert.equal(parseRoleArg('none'), '');
  assert.equal(parseRoleArg(undefined), undefined);
});

test('validateRoles rejects pages outside the options and one page for both roles', () => {
  const s = settings('', '');
  assert.deepEqual(validateRoles({ header: '100002', footer: '' }, s), []);
  assert.equal(validateRoles({ header: '100009' }, s)[0].key, 'pageRole.notInHeaders');
  assert.deepEqual(validateRoles({ header: '100009' }, s)[0].params, { value: '100009' });
  assert.equal(validateRoles({ header: '100002', footer: '100002' }, s)[0].key, 'pageRole.sameHeaderFooter');
  assert.deepEqual(validateRoles({ header: '' }, { headerOptions: null }), []);
});

test('diffFingerprints ignores roles and names other changed settings', () => {
  assert.deepEqual(diffFingerprints({ sitename: 'a', headerpageid: 'x' }, { sitename: 'a', headerpageid: 'y' }), []);
  assert.deepEqual(diffFingerprints({ sitename: 'a', lang: 'r' }, { sitename: 'b', lang: 'r' }), ['sitename']);
  assert.deepEqual(diffFingerprints({ a: '1' }, { a: '1', b: '2' }), ['b']);
});

test('assignPageRoles refuses without confirmation before any driver call', async () => {
  const driver = fakeDriver([]);
  await assert.rejects(assignPageRoles(driver, { header: '100002', projectid: '100001' }), (e) => e.code === 'ROLE_NOT_CONFIRMED' && e.exitCode === 1);
  assert.equal(driver.calls.length, 0);
});

test('assignPageRoles writes roles, rereads them and keeps a rollback record', () =>
  withDir(async (dir) => {
    const driver = fakeDriver([settings('', ''), settings('100002', '100003', { sitename: 'aaaa', headerpageid: 'h1', footerpageid: 'f1' })]);
    const r = await assignPageRoles(driver, { header: '100002', footer: '100003', confirmed: true, projectid: '100001', recordDir: dir });
    assert.equal(r.changed, true);
    assert.deepEqual(r.after, { headerpageid: '100002', footerpageid: '100003' });
    assert.deepEqual(r.otherChanged, []);
    assert.equal(r.rollback, 'page role --header none --footer none --confirm');
    const save = driver.calls.find((c) => c.fn === 'setPageRoles');
    assert.deepEqual(save.args, [{ headerpageid: '100002', footerpageid: '100003', confirm: ROLE_CONFIRM }]);
    assert.deepEqual(save.opts, { urlPart: '/projects/submit/', bodyPart: 'comm=saveprojectsettings' });
    assert.ok(driver.calls.some((c) => c.fn === 'reload'));
    assert.ok(existsSync(r.record));
    const saved = JSON.parse(readFileSync(r.record, 'utf8'));
    assert.deepEqual(saved.before, { headerpageid: '', footerpageid: '' });
    assert.deepEqual(saved.requested, { headerpageid: '100002', footerpageid: '100003' });
    assert.deepEqual(saved.otherChanged, []);
  }));

test('assignPageRoles names other settings that changed', () =>
  withDir(async (dir) => {
    const driver = fakeDriver([settings('', ''), settings('100002', '', { sitename: 'bbbb', headerpageid: 'h1', footerpageid: 'f0' })]);
    const r = await assignPageRoles(driver, { header: '100002', confirmed: true, projectid: '100001', recordDir: dir });
    assert.deepEqual(r.otherChanged, ['sitename']);
    const save = driver.calls.find((c) => c.fn === 'setPageRoles');
    assert.equal(save.args[0].footerpageid, undefined, 'подвал не трогается, если не запрошен');
  }));

test('assignPageRoles reports a failed save and a role that did not apply', () =>
  withDir(async (dir) => {
    const bad = fakeDriver([settings('', '')], { text: 'ERROR' });
    await assert.rejects(assignPageRoles(bad, { header: '100002', confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'SAVE_FAILED');
    const stale = fakeDriver([settings('', ''), settings('', '')]);
    await assert.rejects(assignPageRoles(stale, { header: '100002', confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'ROLE_NOT_APPLIED');
    const invalid = fakeDriver([settings('', '')]);
    await assert.rejects(assignPageRoles(invalid, { header: '100009', confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'ROLE_INVALID' && e.key === 'pageRole.notInHeaders');
    const many = fakeDriver([settings('', '')]);
    await assert.rejects(assignPageRoles(many, { header: '100009', footer: '100009', confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'ROLE_INVALID' && e.key === 'pageRole.invalidJoin' && /^NOT_IN_OPTIONS: .*; NOT_IN_OPTIONS: .*; SAME_PAGE/.test(e.message));
    assert.ok(!invalid.calls.some((c) => c.fn === 'setPageRoles'));
  }));

test('assignPageRoles does nothing when the roles are already set', () =>
  withDir(async (dir) => {
    const driver = fakeDriver([settings('100002', '100003')]);
    const r = await assignPageRoles(driver, { header: '100002', footer: '100003', confirmed: true, projectid: '100001', recordDir: dir });
    assert.equal(r.changed, false);
    assert.ok(!driver.calls.some((c) => c.fn === 'setPageRoles'));
    assert.equal(readdirSync(dir).length, 0);
  }));

const indexSettings = (indexpageid, fingerprints = { sitename: 'aaaa', indexpageid: 'i0' }) => ({
  ...settings('100002', '100003', fingerprints),
  indexpageid,
  indexOptions: ['100004', '100005', '100002'],
});

test('validateRoles checks the index page against its options and the current header and footer', () => {
  const s = indexSettings('100004');
  assert.deepEqual(validateRoles({ index: '100005' }, s), []);
  assert.equal(validateRoles({ index: '100009' }, s)[0].key, 'pageRole.notInIndexes');
  assert.equal(validateRoles({ index: '' }, s)[0].key, 'pageRole.indexRequired');
  assert.deepEqual(validateRoles({ index: '100002' }, s).map((m) => m.key), ['pageRole.indexIsHeader']);
  assert.deepEqual(validateRoles({ index: '100003' }, s).map((m) => m.key), ['pageRole.notInIndexes', 'pageRole.indexIsFooter']);
  assert.equal(validateRoles({ index: '100005' }, { ...s, indexOptions: null })[0].key, 'pageRole.notInIndexes');
});

test('assignPageRoles sets the index page, rereads it and offers a rollback to the old one', () =>
  withDir(async (dir) => {
    const driver = fakeDriver([indexSettings('100004'), indexSettings('100005', { sitename: 'aaaa', indexpageid: 'i1' })]);
    const r = await assignPageRoles(driver, { index: '100005', confirmed: true, projectid: '100001', recordDir: dir });
    assert.equal(r.changed, true);
    assert.deepEqual(r.before, { indexpageid: '100004' });
    assert.deepEqual(r.after, { indexpageid: '100005' });
    assert.deepEqual(r.otherChanged, []);
    assert.equal(r.rollback, 'page role --index 100004 --confirm');
    const save = driver.calls.find((c) => c.fn === 'setPageRoles');
    assert.deepEqual(save.args, [{ indexpageid: '100005', confirm: ROLE_CONFIRM }]);
    const saved = JSON.parse(readFileSync(r.record, 'utf8'));
    assert.deepEqual(saved.requested, { indexpageid: '100005' });
    assert.deepEqual(saved.after, { indexpageid: '100005' });
  }));

test('assignPageRoles ignores the not-published flag of the index page but names other changed settings', () =>
  withDir(async (dir) => {
    const flagGone = fakeDriver([
      indexSettings('100004', { sitename: 'aaaa', indexpageid: 'i0', indexpagenotpublished: 'n0' }),
      indexSettings('100005', { sitename: 'aaaa', indexpageid: 'i1' }),
    ]);
    const r = await assignPageRoles(flagGone, { index: '100005', confirmed: true, projectid: '100001', recordDir: dir });
    assert.deepEqual(r.otherChanged, []);
    const other = fakeDriver([indexSettings('100004'), indexSettings('100005', { sitename: 'bbbb', indexpageid: 'i1' })]);
    const r2 = await assignPageRoles(other, { index: '100005', confirmed: true, projectid: '100001', recordDir: dir });
    assert.deepEqual(r2.otherChanged, ['sitename']);
  }));

test('assignPageRoles refuses a protected index page and index together with header before saving', () =>
  withDir(async (dir) => {
    const toProtected = fakeDriver([indexSettings('100004')]);
    await assert.rejects(assignPageRoles(toProtected, { index: '100005', protectedIds: ['100005'], confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'PROTECTED_PAGE');
    assert.ok(!toProtected.calls.some((c) => c.fn === 'setPageRoles'));
    const fromProtected = fakeDriver([indexSettings('100004')]);
    await assert.rejects(assignPageRoles(fromProtected, { index: '100005', protectedIds: [100004], confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'PROTECTED_PAGE');
    assert.ok(!fromProtected.calls.some((c) => c.fn === 'setPageRoles'));
    const both = fakeDriver([]);
    await assert.rejects(assignPageRoles(both, { index: '100005', header: '100002', confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'ROLE_INVALID');
    assert.equal(both.calls.length, 0);
    assert.equal(readdirSync(dir).length, 0);
  }));

test('assignPageRoles leaves the index page alone when it is already set and reports one that did not apply', () =>
  withDir(async (dir) => {
    const same = fakeDriver([indexSettings('100005')]);
    const r = await assignPageRoles(same, { index: '100005', confirmed: true, projectid: '100001', recordDir: dir });
    assert.equal(r.changed, false);
    assert.ok(!same.calls.some((c) => c.fn === 'setPageRoles'));
    const stale = fakeDriver([indexSettings('100004'), indexSettings('100004')]);
    await assert.rejects(assignPageRoles(stale, { index: '100005', confirmed: true, projectid: '100001', recordDir: dir }), (e) => e.code === 'ROLE_NOT_APPLIED' && e.key === 'pageRole.notApplied' && e.params.got.key === 'pageRole.gotIndex' && e.params.got.params.index === '100004');
  }));

test('assignPageRoles returns the settings count and the missing rollback as messages, and writes English text to the record', () =>
  withDir(async (dir) => {
    const driver = fakeDriver([
      indexSettings('', { sitename: 'aaaa', indexpageid: 'i0' }),
      indexSettings('100005', { sitename: 'aaaa', indexpageid: 'i1', extra: 'zz' }),
    ]);
    const r = await assignPageRoles(driver, { index: '100005', confirmed: true, projectid: '100001', recordDir: dir });
    assert.equal(r.otherChanged[0], 'extra');
    assert.equal(r.otherChanged[1].key, 'pageRole.settingsCount');
    assert.deepEqual(r.otherChanged[1].params, { before: 2, after: 3 });
    assert.equal(r.rollback.key, 'pageRole.noPreviousIndex');
    const saved = JSON.parse(readFileSync(r.record, 'utf8'));
    assert.deepEqual(saved.otherChanged, ['extra', '<settings count 2 → 3>']);
  }));
