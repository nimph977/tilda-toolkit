import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { setLogLevel } from '../lib/log.mjs';
import { wrapLayer } from '../lib/browser.mjs';
import { COPY_REASONS, DonorCopyError, composition, copyDonorPage, copyPlan, orderMatches, sameComposition } from '../donor-copy.mjs';

setLogLevel('ERROR');

// --- Слой tilda-donor.js в vm ---

function donorLayer({ fetchText = 'OK', writable = null, protectedPages = [] } = {}) {
  const calls = [];
  const context = {
    window: { __tilda: {
      protectedPages,
      writablePages: writable,
      listRecords: () => [],
      assertWritable: (pageid, fn) => {
        if (Array.isArray(context.window.__tilda.writablePages) && !context.window.__tilda.writablePages.includes(String(pageid))) throw new Error(`WRITE_NOT_ALLOWED ${pageid}`);
      },
    } },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URLSearchParams,
    fetch: async (url, opts) => { calls.push({ url, body: opts.body }); return { status: 200, text: async () => (typeof fetchText === 'function' ? fetchText() : fetchText) }; },
  };
  vm.runInNewContext(wrapLayer(readFileSync(new URL('../browser/tilda-donor.js', import.meta.url), 'utf8')), context);
  return { api: context.window.__tilda, calls };
}

const pastedHtml = [
  '<div id="rec9000000000001" class="record" recordid="9000000000001" data-record-type="770" off="n"><div class="r">…</div></div>',
  '<div id="rec9000000000002" class="record" recordid="9000000000002" data-record-type="396" off="y"><div class="r">…</div></div>',
  '<div id="rec9000000000003" class="record" recordid="9000000000003" data-record-type="464"><div class="r">…</div></div>',
].join('\n');

test('donor layer parses pasted records in order and treats a missing off flag as visible', () => {
  const { api } = donorLayer();
  // Объекты из vm-контекста имеют чужой прототип — сравниваем как простые данные.
  assert.deepEqual(JSON.parse(JSON.stringify(api.parsePastedHtml(pastedHtml))), [
    { recordid: '9000000000001', tplid: '770', hidden: 'n' },
    { recordid: '9000000000002', tplid: '396', hidden: 'y' },
    { recordid: '9000000000003', tplid: '464', hidden: 'n' },
  ]);
  assert.equal(api.parsePastedHtml('').length, 0);
});

test('donor layer copies selects as an indexed array and refuses empty or failed copies', async () => {
  const { api, calls } = donorLayer();
  await assert.rejects(() => api.copySelectedToBuffer('200002', []), /COPY_NO_RECORDS/);
  assert.equal(calls.length, 0);
  const r = await api.copySelectedToBuffer('200002', ['9000000000001', '9000000000002']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { pageid: '200002', count: 2 });
  assert.equal(calls[0].body, 'comm=copyselectedrecords_tobuf&pageid=200002&selects%5B0%5D=9000000000001&selects%5B1%5D=9000000000002');
  const bad = donorLayer({ fetchText: 'ERR' });
  await assert.rejects(() => bad.api.copySelectedToBuffer('200002', ['1']), /COPY_TO_BUF_FAILED/);
});

test('donor layer pastes only into an allow-listed page and parses an array answer', async () => {
  const locked = donorLayer({ writable: [] });
  await assert.rejects(() => locked.api.pasteFromBuffer('200003'), /WRITE_NOT_ALLOWED 200003/);
  assert.equal(locked.calls.length, 0);
  const answer = JSON.stringify([{ html: pastedHtml.split('\n')[0], csslibs: [] }, { html: pastedHtml.split('\n').slice(1).join(''), csslibs: [] }]);
  const open = donorLayer({ writable: ['200003'], fetchText: answer });
  const r = await open.api.pasteFromBuffer('200003');
  assert.equal(r.records.length, 3);
  assert.equal(open.calls[0].body, 'comm=pasterecord_frombuf&pageid=200003&recordid=&with_code=yes');
  const failed = donorLayer({ writable: ['200003'], fetchText: JSON.stringify({ error: 'nope' }) });
  await assert.rejects(() => failed.api.pasteFromBuffer('200003'), /PASTE_FAILED 200003: nope/);
  const empty = donorLayer({ writable: ['200003'], fetchText: JSON.stringify([{ html: '' }]) });
  await assert.rejects(() => empty.api.pasteFromBuffer('200003'), /в ответе нет записей/);
});

// --- Чистые функции ---

const src = () => [
  { recordid: '9000000000001', tplid: '770', hidden: false },
  { recordid: '9000000000002', tplid: '396', hidden: true },
  { recordid: '9000000000003', tplid: '464', hidden: false },
];

test('composition, sameComposition and orderMatches compare pages as sequences', () => {
  assert.deepEqual(composition([{ recordid: 1, tplid: 770, hidden: 'y' }]), [{ recordid: '1', tplid: '770', hidden: true }]);
  assert.deepEqual(sameComposition(src(), src()), { equal: true, added: [], removed: [], reordered: false });
  const removed = sameComposition(src(), src().slice(0, 2));
  assert.deepEqual([removed.equal, removed.removed], [false, ['9000000000003']]);
  const swapped = sameComposition(src(), [src()[1], src()[0], src()[2]]);
  assert.deepEqual([swapped.equal, swapped.reordered], [false, true]);
  const target = src().map((r, i) => ({ ...r, recordid: `9100000000000${i}` }));
  assert.equal(orderMatches(src(), target).equal, true);
  assert.equal(orderMatches(src(), target.slice(0, 2)).equal, false);
  const hiddenDiff = orderMatches(src(), target.map((r, i) => (i === 1 ? { ...r, hidden: false } : r)));
  assert.deepEqual([hiddenDiff.equal, hiddenDiff.hiddenMismatch], [false, [1]]);
  assert.deepEqual(copyPlan({ source: src(), target: [], replace: false }).steps[0], 'inventory-target');
  assert.ok(copyPlan({ source: src(), target: src(), replace: true }).steps.includes('replace-delete'));
});

// --- Оркестратор на поддельных драйверах ---

function fakeDrivers({ targetBefore = [], donorSequence, pasted } = {}) {
  const calls = [];
  const donorLists = donorSequence ?? [src(), src(), src()];
  let donorIdx = 0;
  let targetList = targetBefore;
  const pastedRecords = pasted ?? src().map((r, i) => ({ recordid: `9100000000000${i}`, tplid: r.tplid, hidden: r.hidden ? 'y' : 'n' }));
  const test = {
    openEditor: async (p) => { calls.push(['test.openEditor', p]); },
    setWritable: async () => { calls.push(['test.setWritable']); },
    call: async (fn, args = []) => {
      calls.push([`test.${fn}`, ...args]);
      if (fn === 'listRecords') return targetList;
      if (fn === 'readRecordSnapshot') return { record: { id: args[1] } };
      if (fn === 'deleteRecord') { targetList = targetList.filter((r) => r.recordid !== args[1]); return 'OK'; }
      throw new Error(`unexpected ${fn}`);
    },
  };
  const donor = {
    openEditor: async (p) => { calls.push(['donor.openEditor', p]); },
    setWritable: async (l) => { calls.push(['donor.setWritable', ...l]); },
    call: async (fn, args = []) => {
      calls.push([`donor.${fn}`, ...(fn === 'copySelectedToBuffer' ? [args[0], args[1].length] : args)]);
      if (fn === 'listRecords') return donorLists[Math.min(donorIdx++, donorLists.length - 1)];
      if (fn === 'copySelectedToBuffer') return { pageid: args[0], count: args[1].length };
      if (fn === 'pasteFromBuffer') { targetList = pastedRecords.map((r) => ({ ...r, hidden: r.hidden === 'y' })); return { records: pastedRecords, htmlBytes: 100 }; }
      throw new Error(`unexpected ${fn}`);
    },
  };
  return { test, donor, calls };
}

test('copyDonorPage runs the documented call sequence and writes a transfer record', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-transfer-'));
  try {
    const d = fakeDrivers();
    const r = await copyDonorPage(d, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13', now: new Date('2026-09-24T10:00:00Z') });
    assert.equal(r.ok, true);
    assert.deepEqual(d.calls.map((c) => c[0]), [
      'test.openEditor', 'test.listRecords', 'donor.openEditor', 'donor.listRecords', 'donor.copySelectedToBuffer',
      'donor.openEditor', 'donor.listRecords', 'donor.setWritable', 'donor.pasteFromBuffer', 'donor.setWritable',
      'donor.openEditor', 'donor.listRecords', 'test.openEditor', 'test.listRecords',
    ]);
    assert.deepEqual(d.calls.find((c) => c[0] === 'donor.setWritable'), ['donor.setWritable', '200003']);
    assert.deepEqual(d.calls.filter((c) => c[0] === 'donor.setWritable')[1], ['donor.setWritable']);
    const files = readdirSync(join(baseDir, 'transfer', '200003'));
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(join(baseDir, 'transfer', '200003', files[0]), 'utf8'));
    assert.deepEqual([record.label, record.source.pageid, record.target.pageid, record.pasted.length, record.verify.orderMatches], ['P13', '200002', '200003', 3, true]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('copyDonorPage refuses a non-empty target without --replace and a protected target before any browser call', async () => {
  const d = fakeDrivers({ targetBefore: [{ recordid: '1', tplid: '770', hidden: false }] });
  await assert.rejects(() => copyDonorPage(d, { sourcePageid: '200002', targetPageid: '200003' }), (e) => e instanceof DonorCopyError && e.code === 'TARGET_NOT_EMPTY' && e.message === COPY_REASONS.targetNotEmpty(1));
  assert.ok(!d.calls.some((c) => c[0].startsWith('donor.')));
  const p = fakeDrivers();
  await assert.rejects(() => copyDonorPage(p, { sourcePageid: '200002', targetPageid: '200001', protectedPages: ['200001'] }), (e) => e.code === 'PROTECTED_TARGET');
  assert.equal(p.calls.length, 0);
});

test('copyDonorPage --replace snapshots and deletes target blocks before copying', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-transfer-'));
  try {
    const before = [{ recordid: '8000000000001', tplid: '770', hidden: false }, { recordid: '8000000000002', tplid: '464', hidden: false }];
    const d = fakeDrivers({ targetBefore: before });
    const r = await copyDonorPage(d, { sourcePageid: '200002', targetPageid: '200003', replace: true, baseDir });
    assert.equal(r.replaced, 2);
    const names = d.calls.map((c) => c[0]);
    assert.equal(names.filter((n) => n === 'test.readRecordSnapshot').length, 2);
    assert.equal(names.filter((n) => n === 'test.deleteRecord').length, 2);
    assert.ok(names.lastIndexOf('test.deleteRecord') < names.indexOf('donor.copySelectedToBuffer'));
    assert.ok(existsSync(join(baseDir, 'records', '200003')) || readdirSync(baseDir).length > 0, 'снимки записаны в baseDir');
    const zero = fakeDrivers({ targetBefore: [{ recordid: '1', tplid: '396', hidden: false }] });
    await assert.rejects(() => copyDonorPage(zero, { sourcePageid: '200002', targetPageid: '200003', replace: true, baseDir }), (e) => e.code === 'ZERO_ON_TARGET');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('copyDonorPage stops before pasting when the donor page changed and never pastes in dry-run', async () => {
  const changed = fakeDrivers({ donorSequence: [src(), src().slice(0, 2)] });
  await assert.rejects(() => copyDonorPage(changed, { sourcePageid: '200002', targetPageid: '200003' }), (e) => e.code === 'DONOR_CHANGED' && e.stage === 'after-copy' && e.removed.length === 1);
  assert.ok(!changed.calls.some((c) => c[0] === 'donor.pasteFromBuffer'));
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-transfer-'));
  try {
    const dry = fakeDrivers();
    const r = await copyDonorPage(dry, { sourcePageid: '200002', targetPageid: '200003', dryRun: true, baseDir });
    assert.deepEqual([r.dryRun, r.blocks, r.record], [true, 3, null]);
    assert.ok(!dry.calls.some((c) => c[0] === 'donor.copySelectedToBuffer' || c[0] === 'donor.pasteFromBuffer'));
    assert.equal(existsSync(join(baseDir, 'transfer')), false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('copyDonorPage reports an order mismatch with exit code 1 instead of throwing', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-transfer-'));
  try {
    const pasted = [{ recordid: '9100000000000', tplid: '770', hidden: 'n' }, { recordid: '9100000000001', tplid: '464', hidden: 'n' }];
    const d = fakeDrivers({ pasted });
    const r = await copyDonorPage(d, { sourcePageid: '200002', targetPageid: '200003', baseDir });
    assert.equal(r.ok, false);
    assert.equal(r.verify.orderMatches, false);
    assert.equal(r.pasted, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('copyDonorPage writes the label title only onto a Blank page', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-transfer-'));
  try {
    const blank = fakeDrivers();
    blank.test.editorState = async () => ({ title: 'Tilda: Blank page' });
    blank.test.setTitle = async (p, t) => { blank.calls.push(['test.setTitle', p, t]); };
    const r = await copyDonorPage(blank, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13', donorTitle: 'Контакты' });
    assert.equal(r.title, 'записан');
    assert.deepEqual(blank.calls.at(-1), ['test.setTitle', '200003', 'P13 Контакты']);
    const named = fakeDrivers();
    named.test.editorState = async () => ({ title: 'Моя страница' });
    named.test.setTitle = async () => { throw new Error('must not be called'); };
    const r2 = await copyDonorPage(named, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13' });
    assert.equal(r2.title, 'оставлен');
    const failing = fakeDrivers();
    failing.test.editorState = async () => ({ title: 'Blank page' });
    failing.test.setTitle = async () => { throw new Error('TITLE_NOT_SAVED'); };
    const r3 = await copyDonorPage(failing, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13' });
    assert.match(r3.title, /не записан/);
    assert.equal(r3.ok, true, 'ошибка заголовка не отменяет перенос');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('copyDonorPage sets the donor alias only on a target without an alias', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-transfer-'));
  try {
    const empty = fakeDrivers();
    empty.test.pageAlias = async () => '';
    empty.test.setAlias = async (p, a) => { empty.calls.push(['test.setAlias', p, a]); };
    const r = await copyDonorPage(empty, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13', alias: 'contacts' });
    assert.equal(r.alias, 'записан');
    assert.deepEqual(empty.calls.at(-1), ['test.setAlias', '200003', 'contacts']);
    const named = fakeDrivers();
    named.test.pageAlias = async () => 'my-page';
    named.test.setAlias = async () => { throw new Error('must not be called'); };
    assert.equal((await copyDonorPage(named, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13', alias: 'contacts' })).alias, 'оставлен');
    const taken = fakeDrivers();
    taken.test.pageAlias = async () => '';
    taken.test.setAlias = async () => { throw Object.assign(new Error('адрес занят'), { code: 'ALIAS_TAKEN' }); };
    const r3 = await copyDonorPage(taken, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'P13', alias: 'contacts' });
    assert.match(r3.alias, /не записан/);
    assert.equal(r3.ok, true, 'занятый адрес не отменяет перенос');
    const noAlias = fakeDrivers();
    noAlias.test.pageAlias = async () => { throw new Error('must not be called'); };
    assert.equal((await copyDonorPage(noAlias, { sourcePageid: '200002', targetPageid: '200003', baseDir, label: 'HDR' })).alias, null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
