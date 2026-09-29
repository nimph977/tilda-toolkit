import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { ALIAS_REASONS, MAX_FAILURES_IN_ROW, assignDonorAliases, donorAliasFor, byPageid, planAliases } from '../donor-aliases.mjs';

setLogLevel('ERROR');

// Синтетика: тестовый проект 100001 (страницы 2000xx), донор 100002 (страницы 3000xx).
const site = () => ({
  slug: 'demo',
  projectid: '100001',
  pages: [
    { label: 'HDR', role: 'header', pageid: '200001', donorPageid: '300001' },
    { label: 'FTR', role: 'footer', pageid: '200002', donorPageid: '300002' },
    { label: 'P00', role: 'content', pageid: '200003', donorPageid: '300003' },
    { label: 'P01', role: 'content', pageid: '200004', donorPageid: '300004' },
    { label: 'P02', role: 'content', pageid: '200005', donorPageid: '300005' },
    { label: 'P03', role: 'content', pageid: '200006', donorPageid: '300006' },
    { label: 'P04', role: 'content', pageid: '200007', donorPageid: '300007' },
    { label: 'P05', role: 'content', pageid: '200008', donorPageid: '300004' },
    { label: 'P06', role: 'content', donorPageid: '300008' },
    { label: 'P07', role: 'content', pageid: '200010' },
  ],
});
const donorPages = () => [
  { pageid: '300001', role: 'header' },
  { pageid: '300002', role: 'footer' },
  { pageid: '300003', role: 'index', alias: 'home' },
  { pageid: '300004', alias: '/About/' },
  { pageid: '300005', alias: 'blog' },
  { pageid: '300006' },
  { pageid: '300007', alias: 'contacts' },
  { pageid: '300008', alias: 'prices' },
];
const testPages = () => [
  { pageid: '200001' }, { pageid: '200002' }, { pageid: '200003' },
  { pageid: '200004' },
  { pageid: '200005', alias: 'blog' },
  { pageid: '200006' },
  { pageid: '200007' },
  { pageid: '200008' },
  { pageid: '200099', alias: 'contacts' },
];

test('donorAliasFor skips header, footer and the index page and normalizes the donor alias', () => {
  const byId = byPageid(donorPages());
  assert.deepEqual(donorAliasFor({ role: 'header', donorPageid: '300001' }, byId), { reason: ALIAS_REASONS.role('header') });
  assert.deepEqual(donorAliasFor({ role: 'content', donorPageid: '300003' }, byId), { reason: ALIAS_REASONS.role('index') });
  assert.deepEqual(donorAliasFor({ role: 'content', donorPageid: '300004' }, byId), { alias: 'about' });
  assert.deepEqual(donorAliasFor({ role: 'content', donorPageid: '300006' }, byId), { reason: ALIAS_REASONS.noDonorAlias });
  assert.deepEqual(donorAliasFor({ role: 'content' }, byId), { reason: ALIAS_REASONS.noDonorPage });
  assert.deepEqual(donorAliasFor({ role: 'content', donorPageid: '399999' }, byId), { reason: ALIAS_REASONS.notInDonorList });
});

test('planAliases names every skipped label with its reason and never takes an alias from another page', () => {
  const { todo, skipped } = planAliases(site(), donorPages(), testPages());
  assert.deepEqual(todo, [{ label: 'P01', pageid: '200004', alias: 'about' }]);
  const reasons = Object.fromEntries(skipped.map((s) => [s.label, s.reason]));
  assert.equal(reasons.HDR, ALIAS_REASONS.role('header'));
  assert.equal(reasons.FTR, ALIAS_REASONS.role('footer'));
  assert.equal(reasons.P00, ALIAS_REASONS.role('index'));
  assert.equal(reasons.P02, ALIAS_REASONS.same);
  assert.equal(reasons.P03, ALIAS_REASONS.noDonorAlias);
  assert.equal(reasons.P04, ALIAS_REASONS.taken('200099'));
  assert.equal(reasons.P05, ALIAS_REASONS.duplicate('P01'));
  assert.equal(reasons.P06, ALIAS_REASONS.noTestPage);
  assert.equal(reasons.P07, ALIAS_REASONS.noDonorPage);
  assert.equal(todo.length + skipped.length, site().pages.length, 'каждая метка либо в плане, либо с причиной');
});

test('planAliases skips protected pages and pages missing from the page list', () => {
  const pages = testPages().map((p) => (p.pageid === '200004' ? { ...p, protected: true } : p));
  const r = planAliases(site(), donorPages(), pages);
  assert.equal(r.skipped.find((s) => s.label === 'P01').reason, ALIAS_REASONS.protected);
  const r2 = planAliases(site(), donorPages(), testPages().filter((p) => p.pageid !== '200004'));
  assert.equal(r2.skipped.find((s) => s.label === 'P01').reason, ALIAS_REASONS.notInPageList);
});

function files(root, { withTest = true } = {}) {
  const baseDir = join(root, 'ref');
  const pagesDir = join(root, 'pages');
  mkdirSync(join(baseDir, 'demo'), { recursive: true });
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(baseDir, 'demo', 'site.json'), JSON.stringify(site()));
  writeFileSync(join(pagesDir, '100002.json'), JSON.stringify({ projectid: '100002', pages: donorPages().concat([{ pageid: '300009', alias: 'faq' }, { pageid: '300010', alias: 'news' }, { pageid: '300011', alias: 'team' }]) }));
  const extra = [{ pageid: '200011' }, { pageid: '200012' }, { pageid: '200013' }];
  if (withTest) writeFileSync(join(pagesDir, '100001.json'), JSON.stringify({ projectid: '100001', pages: testPages().concat(extra) }));
  return { baseDir, pagesDir };
}

test('assignDonorAliases: dry-run never calls the driver, a missing page list is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-donor-aliases-'));
  try {
    const noTest = files(root, { withTest: false });
    await assert.rejects(() => assignDonorAliases({}, { slug: 'demo', donorProjectId: '100002', testProjectId: '100001', ...noTest }), (e) => e.code === 'NO_PAGE_LIST' && e.exitCode === 1);
    const paths = files(root);
    const driver = { callWithResponse: async () => { throw new Error('must not be called'); } };
    const r = await assignDonorAliases(driver, { slug: 'demo', donorProjectId: '100002', testProjectId: '100001', dryRun: true, ...paths });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.todo.map((t) => t.label), ['P01']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignDonorAliases writes aliases one by one and stops after three refusals in a row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-donor-aliases-'));
  try {
    const paths = files(root);
    const extraSite = site();
    extraSite.pages.push(
      { label: 'P08', role: 'content', pageid: '200011', donorPageid: '300009' },
      { label: 'P09', role: 'content', pageid: '200012', donorPageid: '300010' },
      { label: 'P10', role: 'content', pageid: '200013', donorPageid: '300011' },
    );
    writeFileSync(join(paths.baseDir, 'demo', 'site.json'), JSON.stringify(extraSite));
    const calls = [];
    const ok = { callWithResponse: async (fn, args, opts) => { calls.push({ fn, args, opts }); return { status: 200, text: 'OK' }; } };
    const sleeps = [];
    const r = await assignDonorAliases(ok, { slug: 'demo', donorProjectId: '100002', testProjectId: '100001', sleep: async (ms) => sleeps.push(ms), ...paths });
    assert.deepEqual(r.assigned.map((a) => a.label), ['P01', 'P08', 'P09', 'P10']);
    assert.deepEqual(calls.map((c) => c.args), [['200004', 'about'], ['200011', 'faq'], ['200012', 'news'], ['200013', 'team']]);
    assert.equal(calls[0].fn, 'setPageAlias');
    assert.equal(sleeps.length, 3, 'пауза между страницами, не после последней');

    const taken = { callWithResponse: async () => ({ status: 200, text: '<p>Указанный адрес страницы уже занят</p>' }) };
    const r2 = await assignDonorAliases(taken, { slug: 'demo', donorProjectId: '100002', testProjectId: '100001', sleep: async () => {}, ...paths });
    assert.equal(r2.stopped, true);
    assert.equal(r2.failed.length, MAX_FAILURES_IN_ROW);
    assert.ok(r2.failed.every((f) => f.code === 'ALIAS_TAKEN'));
    assert.equal(r2.assigned.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
