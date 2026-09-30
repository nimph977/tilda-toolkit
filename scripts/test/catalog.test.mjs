import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { buildCatalogEntry, captureCatalog, catalogPath, listCatalog, tplidsFromStructure } from '../catalog.mjs';

setLogLevel('ERROR');

const SNAPSHOT = {
  record: { title: 'A &amp; B', text: '', list: '[{"lid":"1","li_title":"x","li_descr":"y"}]', pageid: '200002', recordid: '7001', tplid: '702' },
  tpl: { id: '702' },
  tabs: { content: ['title', 'text', 'list'], settings: ['bgcolor'] },
};

test('tplidsFromStructure dedups, keeps order, drops Zero Block and unknown', () => {
  const structure = { blocks: [{ tplid: '796' }, { tplid: '396' }, { tplid: '702' }, { tplid: '796' }, { tplid: undefined }, { tplid: '?' }, { tplid: 30 }] };
  assert.deepEqual(tplidsFromStructure(structure), ['796', '702', '30']);
  assert.deepEqual(tplidsFromStructure({}), []);
});

test('buildCatalogEntry decodes defaults and extracts card keys', () => {
  const entry = buildCatalogEntry({ tplid: 702, snapshot: SNAPSHOT, capturedAt: 'T' });
  assert.equal(entry.tplid, '702');
  assert.equal(entry.available, true);
  assert.equal(entry.defaults.title, 'A & B');
  assert.ok(!('text' in entry.defaults));
  assert.ok(!('pageid' in entry.defaults) && !('recordid' in entry.defaults));
  assert.deepEqual(entry.cardKeys, ['li_title', 'li_descr']);
  assert.deepEqual(entry.tabs, SNAPSHOT.tabs);
  assert.equal('tplFields' in entry, false, 'без tpl.fields поле не появляется');
});

test('buildCatalogEntry keeps the full template field list from tpl.fields', () => {
  const snapshot = { ...SNAPSHOT, tpl: { fields: 'title,buttontitle,buttonlink,|gg15|,rutubeid,|ggc|' } };
  const entry = buildCatalogEntry({ tplid: 213, snapshot, capturedAt: 'T' });
  assert.deepEqual(entry.tplFields, ['title', 'buttontitle', 'buttonlink', 'rutubeid']);
});

function makeDriver() {
  const calls = [];
  const driver = {
    call: async (fn, args, opts) => {
      calls.push({ fn, args, opts });
      const tplid = args[1];
      if (fn === 'addRecord') {
        if (tplid === '835') throw new Error('{"error":"You do not have access to this block"}');
        return { recordid: tplid === '999' ? '7999' : '7002', tplid };
      }
      if (fn === 'readRecordSnapshot') {
        if (args[1] === '7999') throw new Error('boom');
        return SNAPSHOT;
      }
      if (fn === 'deleteRecord') return 'OK';
      throw new Error(`unexpected ${fn}`);
    },
  };
  return { driver, calls };
}

test('captureCatalog writes entries, marks unavailable, isolates failures and resumes', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'catalog-'));
  try {
    assert.deepEqual(listCatalog({ baseDir }), []);
    let sleeps = 0;
    const { driver, calls } = makeDriver();
    const r = await captureCatalog(driver, { pageid: '200002', tplids: ['796', '835', '999', '396'], delayMs: 0, sleep: async () => { sleeps += 1; } }, { baseDir });

    assert.deepEqual(r.captured.map((c) => c.tplid), ['796']);
    assert.deepEqual(r.unavailable, [{ tplid: '835' }]);
    assert.deepEqual(r.failed.map((f) => f.tplid), ['999']);
    assert.deepEqual(r.skipped.map((s) => [s.tplid, s.reason.key]), [['396', 'catalog.reason.zeroBlock']]);
    assert.ok(sleeps > 0);

    assert.equal(JSON.parse(readFileSync(catalogPath('796', { baseDir }), 'utf8')).available, true);
    assert.equal(JSON.parse(readFileSync(catalogPath('835', { baseDir }), 'utf8')).available, false);
    assert.ok(!existsSync(catalogPath('999', { baseDir })));

    const adds = calls.filter((c) => c.fn === 'addRecord');
    assert.ok(adds.every((c) => c.opts.attempts === 1));
    const deletes = calls.filter((c) => c.fn === 'deleteRecord').map((c) => c.args[1]);
    assert.deepEqual(deletes, ['7002', '7999']);

    const rows = listCatalog({ baseDir });
    assert.deepEqual(rows.map((x) => [x.tplid, x.available, x.fields]), [['796', true, 4], ['835', false, 0]]);

    const again = await captureCatalog(makeDriver().driver, { pageid: '200002', tplids: ['796', '835'], delayMs: 0, sleep: async () => {} }, { baseDir });
    assert.deepEqual(again.skipped.map((s) => [s.tplid, s.reason.key]), [['796', 'catalog.reason.alreadyCaptured'], ['835', 'catalog.reason.alreadyCaptured']]);
    assert.equal(again.captured.length, 0);

    const forced = await captureCatalog(makeDriver().driver, { pageid: '200002', tplids: ['796'], delayMs: 0, force: true, sleep: async () => {} }, { baseDir });
    assert.deepEqual(forced.captured.map((c) => c.tplid), ['796']);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
