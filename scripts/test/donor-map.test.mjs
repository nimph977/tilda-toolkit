import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { msg } from '../lib/i18n.mjs';
import { MAP_REASONS, mapDonorPages, matchDonorPages, normalizeAlias, referencePath } from '../donor-map.mjs';

setLogLevel('ERROR');

const site = () => ({
  slug: 'demo',
  projectid: '100001',
  substitutes: {},
  pages: [
    { label: 'HDR', role: 'header', pageid: '200011' },
    { label: 'FTR', role: 'footer', pageid: '200012' },
    { label: 'P00', role: 'content', name: 'index', url: 'https://ref.test/', pageid: '200002' },
    { label: 'P01', role: 'content', name: 'about', url: 'https://ref.test/About/', pageid: '200003' },
    { label: 'P02', role: 'content', name: 'nope', url: 'https://ref.test/nope', pageid: null },
    { label: 'P03', role: 'content', name: 'dup', url: 'https://ref.test/dup', pageid: null },
    { label: 'P04', role: 'content', name: 'gone', url: 'https://ref.test/gone', pageid: null, missing: true },
    { label: 'P05', role: 'content', name: 'nourl', pageid: null },
  ],
});

const donorPages = () => [
  { pageid: '300001', title: 'Header', role: 'header', protected: false },
  { pageid: '300002', title: 'Footer', role: 'footer', protected: false },
  { pageid: '300003', title: 'Main', role: 'index', alias: '', protected: false },
  { pageid: '300004', title: 'About us', alias: '/about', protected: false },
  { pageid: '300005', title: 'Dup A', alias: 'dup', protected: false },
  { pageid: '300006', title: 'Dup B', alias: 'dup/', protected: false },
];

test('referencePath and normalizeAlias bring both sides to one shape', () => {
  assert.equal(referencePath('https://ref.test/'), '');
  assert.equal(referencePath('https://ref.test/about/'), '/about');
  assert.equal(referencePath('https://ref.test/a/b?x=1#h'), '/a/b');
  assert.equal(referencePath(undefined), null);
  assert.equal(referencePath('not a url'), null);
  assert.equal(normalizeAlias('/About/'), 'about');
  assert.equal(normalizeAlias(undefined), '');
});

test('matchDonorPages matches by role, index and alias and names every reason', () => {
  const input = site();
  const before = JSON.stringify(input);
  const r = matchDonorPages(input, donorPages());
  assert.equal(JSON.stringify(input), before, 'исходная карта не мутирует');
  assert.notEqual(r.site, input);
  assert.deepEqual(r.matched.map((m) => [m.label, m.donorPageid, m.by]), [
    ['HDR', '300001', 'role'], ['FTR', '300002', 'role'], ['P00', '300003', 'index'], ['P01', '300004', 'alias'],
  ]);
  assert.deepEqual(r.unmatched, [
    { label: 'P02', code: 'noMatch', reason: msg(MAP_REASONS.noMatch, { path: '/nope' }) },
    { label: 'P03', code: 'ambiguous', reason: msg(MAP_REASONS.ambiguous, { path: '/dup', n: 2 }) },
    { label: 'P04', code: 'missing', reason: msg(MAP_REASONS.missing) },
    { label: 'P05', code: 'noUrl', reason: msg(MAP_REASONS.noUrl) },
  ]);
  const p01 = r.site.pages.find((p) => p.label === 'P01');
  assert.equal(p01.donorTitle, 'About us');
  assert.equal(p01.pageid, '200003', 'pageid тестовой страницы не тронут');
  const byId = matchDonorPages({ pages: [{ label: 'P06', role: 'content', url: 'https://ref.test/page300004.html' }, { label: 'P07', role: 'content', url: 'https://ref.test/page300099.html' }] }, donorPages());
  assert.deepEqual(byId.matched.map((m) => [m.label, m.donorPageid, m.by]), [['P06', '300004', 'pageid']]);
  assert.deepEqual(byId.unmatched[0].reason, msg(MAP_REASONS.noMatch, { path: '/page300099.html' }));
  const noHeader = matchDonorPages(site(), donorPages().filter((p) => p.role !== 'header'));
  assert.deepEqual(noHeader.unmatched.find((u) => u.label === 'HDR').reason, msg(MAP_REASONS.noRole, { role: 'header' }));
});

test('matchDonorPages removes a stale donorPageid when the donor page is gone', () => {
  const marked = matchDonorPages(site(), donorPages()).site;
  const again = matchDonorPages(marked, donorPages().filter((p) => p.pageid !== '300004'));
  const p01 = again.site.pages.find((p) => p.label === 'P01');
  assert.equal(p01.donorPageid, undefined);
  assert.equal(p01.donorTitle, undefined);
  assert.deepEqual(again.unmatched.find((u) => u.label === 'P01').reason, msg(MAP_REASONS.noMatch, { path: '/About' }));
});

test('mapDonorPages reads both files, writes site.json and refuses without the donor list', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-donor-map-'));
  try {
    const baseDir = join(root, 'ref');
    const pagesDir = join(root, 'pages');
    mkdirSync(join(baseDir, 'demo'), { recursive: true });
    writeFileSync(join(baseDir, 'demo', 'site.json'), JSON.stringify(site()));
    assert.throws(() => mapDonorPages({ slug: 'demo', donorProjectId: '100002', baseDir, pagesDir }), (e) => e.code === 'NO_DONOR_PAGES' && e.exitCode === 1);
    assert.throws(() => mapDonorPages({ slug: 'other', donorProjectId: '100002', baseDir, pagesDir }), (e) => e.code === 'NO_SITE');
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, '100002.json'), JSON.stringify({ projectid: '100002', pages: donorPages() }));
    const r = mapDonorPages({ slug: 'demo', donorProjectId: '100002', baseDir, pagesDir });
    assert.equal(r.matched.length, 4);
    assert.match(r.path, /site\.json$/);
    const written = JSON.parse(readFileSync(join(baseDir, 'demo', 'site.json'), 'utf8'));
    assert.equal(written.pages.find((p) => p.label === 'HDR').donorPageid, '300001');
    assert.equal(written.projectid, '100001');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
