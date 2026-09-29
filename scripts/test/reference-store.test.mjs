import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { referenceDir } from '../lib/paths.mjs';
import {
  assertSlug, assignLabels, ensureDirs, imageFileName, isLabel, newManifest, newSite, normalizeManifest, pageNameFromUrl,
  readManifest, readSite, refPaths, resolveSource, snapshotFile, toSnapshotRelative, upsertPage, writeManifest, writeSite,
} from '../lib/reference-store.mjs';

setLogLevel('ERROR');

test('pageNameFromUrl builds safe page names', () => {
  assert.equal(pageNameFromUrl('https://example.test/'), 'index');
  assert.equal(pageNameFromUrl('https://example.test/about/team?x=1#top'), 'about--team');
  assert.equal(pageNameFromUrl('https://example.test/Услуги/Цены/'), '----');
  assert.equal(pageNameFromUrl('https://example.test/Prices_2024.HTML'), 'prices-2024-html');
  assert.equal(pageNameFromUrl(`https://example.test/${'a'.repeat(100)}`).length, 80);
});

test('assertSlug accepts kebab slugs and rejects the rest', () => {
  assert.equal(assertSlug('demo-1'), 'demo-1');
  for (const bad of ['Demo', 'a/b', '', undefined]) {
    assert.throws(() => assertSlug(bad), (e) => e.code === 'BAD_SLUG' && e.exitCode === 2);
  }
});

test('imageFileName is stable and normalizes extensions', () => {
  const a = imageFileName('https://cdn.test/img/photo.JPG');
  assert.equal(a, imageFileName('https://cdn.test/img/photo.JPG'));
  assert.match(a, /^[0-9a-f]{12}\.jpg$/);
  assert.match(imageFileName('https://cdn.test/img/photo'), /\.bin$/);
  assert.match(imageFileName('https://cdn.test/a.webp?x=1'), /\.webp$/);
});

test('manifest round-trip and upsertPage', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-store-'));
  try {
    const paths = refPaths('demo', { baseDir });
    assert.equal(paths.root, join(baseDir, 'demo'));
    assert.equal(paths.manifest, join(baseDir, 'demo', 'reference.json'));
    assert.equal(readManifest('demo', { baseDir }), null);

    ensureDirs('demo', { baseDir });
    for (const dir of [paths.pages, paths.images, paths.structure]) assert.ok(existsSync(dir));

    const manifest = newManifest({ slug: 'demo', url: 'https://ref.test/' });
    upsertPage(manifest, { name: 'index', url: 'https://ref.test/', status: 403 });
    upsertPage(manifest, { name: 'index', url: 'https://ref.test/', status: 'ok' });
    upsertPage(manifest, { name: 'about', url: 'https://ref.test/about', status: 'ok' });
    assert.equal(manifest.pages.length, 2);
    assert.equal(manifest.pages[0].status, 'ok');

    const written = writeManifest('demo', manifest, { baseDir });
    assert.equal(written, paths.manifest);
    assert.deepEqual(readManifest('demo', { baseDir }), manifest);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('referenceDir honours TILDA_REFERENCE_DIR and refuses to guess without a site', () => {
  const saved = { ref: process.env.TILDA_REFERENCE_DIR, site: process.env.TILDA_SITE_DIR };
  const custom = mkdtempSync(join(tmpdir(), 'ref-dir-'));
  try {
    delete process.env.TILDA_REFERENCE_DIR;
    delete process.env.TILDA_SITE_DIR;
    assert.throws(() => referenceDir(), (e) => e.code === 'CONFIG_ERROR' && e.exitCode === 2);
    process.env.TILDA_REFERENCE_DIR = custom;
    assert.equal(referenceDir(), resolve(custom));
  } finally {
    rmSync(custom, { recursive: true, force: true });
    if (saved.ref === undefined) delete process.env.TILDA_REFERENCE_DIR;
    else process.env.TILDA_REFERENCE_DIR = saved.ref;
    if (saved.site === undefined) delete process.env.TILDA_SITE_DIR;
    else process.env.TILDA_SITE_DIR = saved.site;
  }
});

// --- Карта сайта: метки страниц ---

const okPage = (name) => ({ name, url: `https://ref.test/${name}`, status: 'ok' });
const manifestOf = (...pages) => ({ pages });

test('assignLabels labels ok pages in manifest order and skips failed ones', () => {
  const { site, added } = assignLabels(newSite('x'), manifestOf(okPage('index'), { name: 'secret', url: 'https://ref.test/secret', status: 403 }, okPage('about'), okPage('blog')));
  assert.deepEqual(site.pages.map((p) => [p.label, p.name]), [['P00', 'index'], ['P01', 'about'], ['P02', 'blog']]);
  assert.deepEqual(added, ['P00', 'P01', 'P02']);
  assert.ok(site.pages.every((p) => p.role === 'content' && p.pageid === null));
});

test('assignLabels keeps existing labels and appends new pages', () => {
  const site = newSite('x');
  assignLabels(site, manifestOf(okPage('index'), okPage('about'), okPage('blog')));
  site.pages[1].pageid = '100002';
  const { added } = assignLabels(site, manifestOf(okPage('index'), okPage('new'), okPage('about'), okPage('blog')));
  assert.deepEqual(site.pages.map((p) => [p.label, p.name]), [['P00', 'index'], ['P01', 'about'], ['P02', 'blog'], ['P03', 'new']]);
  assert.equal(site.pages[1].pageid, '100002');
  assert.deepEqual(added, ['P03']);
});

test('assignLabels marks a page gone from the snapshot as missing and never reuses its label', () => {
  const site = newSite('x');
  assignLabels(site, manifestOf(okPage('index'), okPage('about')));
  const { missing } = assignLabels(site, manifestOf(okPage('index')));
  assert.deepEqual(missing, ['P01']);
  assert.equal(resolveSource(site, 'P01').missing, true);
  assignLabels(site, manifestOf(okPage('index'), okPage('blog')));
  assert.equal(resolveSource(site, 'P02').name, 'blog');
  assert.equal(resolveSource(site, 'P01').missing, true);
});

test('assignLabels puts HDR and FTR first', () => {
  const { site } = assignLabels(newSite('x'), manifestOf(okPage('index')), { header: true, footer: true });
  assert.deepEqual(site.pages.map((p) => [p.label, p.role]), [['HDR', 'header'], ['FTR', 'footer'], ['P00', 'content']]);
  assert.equal(resolveSource(site, 'HDR').pageid, null);
  assert.equal(resolveSource(site, 'P99'), null);
});

test('assignLabels widens the label past P99', () => {
  const pages = Array.from({ length: 101 }, (_, i) => okPage(`p${i}`));
  const { site } = assignLabels(newSite('x'), manifestOf(...pages));
  assert.equal(site.pages[99].label, 'P99');
  assert.equal(site.pages[100].label, 'P100');
});

test('isLabel accepts site map labels only', () => {
  for (const s of ['P00', 'P123', 'HDR', 'FTR']) assert.equal(isLabel(s), true, s);
  for (const s of ['P1', 'index', 'page123-html', '', undefined]) assert.equal(isLabel(s), false, String(s));
});

test('readSite and writeSite round-trip', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-site-'));
  try {
    assert.equal(readSite('demo', { baseDir }), null);
    const site = newSite('demo');
    site.substitutes = { 770: '794' };
    assignLabels(site, manifestOf(okPage('index')), { header: true });
    const path = writeSite('demo', site, { baseDir });
    assert.equal(path, refPaths('demo', { baseDir }).site);
    const back = readSite('demo', { baseDir });
    assert.deepEqual(back.pages.map((p) => p.label), ['HDR', 'P00']);
    assert.deepEqual(back.substitutes, { 770: '794' });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- Пути манифеста от папки слепка ---

test('toSnapshotRelative finds the tail after <slug>/<snapshot subfolder>', () => {
  assert.equal(toSnapshotRelative('site-reference/demo/images/a.png', 'demo'), 'images/a.png');
  assert.equal(toSnapshotRelative('..\\..\\Sites\\x\\site-reference\\demo\\pages\\index.html', 'demo'), 'pages/index.html');
  assert.equal(toSnapshotRelative('other/a.png', 'demo'), null);
  assert.equal(toSnapshotRelative('demo/x/demo/images/a.png', 'demo'), 'images/a.png');
});

test('normalizeManifest converts old paths, drops unparsable ones and leaves new manifests alone', () => {
  const old = {
    slug: 'demo',
    pages: [{ name: 'index', file: 'site-reference/demo/pages/index.html', status: 'ok' }, { name: 'b', file: 'zzz/b.html', status: 'ok' }],
    images: { 'https://cdn.test/a.png': 'site-reference/demo/images/a.png', 'https://cdn.test/b.png': 'nowhere/b.png' },
  };
  const r = normalizeManifest(old, 'demo');
  assert.equal(r.converted, 2);
  assert.equal(r.dropped, 2);
  assert.equal(r.manifest.pages[0].file, 'pages/index.html');
  assert.equal(r.manifest.pages[1].file, null);
  assert.equal(r.manifest.images['https://cdn.test/a.png'], 'images/a.png');
  assert.equal('https://cdn.test/b.png' in r.manifest.images, false);
  assert.equal(r.manifest.pathBase, 'snapshot');

  const fresh = { slug: 'demo', pathBase: 'snapshot', pages: [{ name: 'i', file: 'pages/i.html' }], images: { 'https://cdn.test/a.png': 'images/a.png' } };
  const again = normalizeManifest(fresh, 'demo');
  assert.deepEqual([again.converted, again.dropped], [0, 0]);
  assert.equal(again.manifest.images['https://cdn.test/a.png'], 'images/a.png');
});

test('newManifest starts on snapshot-relative paths', () => {
  assert.equal(newManifest({ slug: 'demo', url: 'https://ref.test/' }).pathBase, 'snapshot');
});

test('readManifest converts an old manifest on read', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-store-old-'));
  try {
    ensureDirs('demo', { baseDir });
    const paths = refPaths('demo', { baseDir });
    writeFileSync(paths.manifest, JSON.stringify({ slug: 'demo', pages: [{ name: 'index', file: 'site-reference/demo/pages/index.html', status: 'ok' }], images: { 'https://cdn.test/a.png': 'site-reference/demo/images/a.png' } }), 'utf8');
    const manifest = readManifest('demo', { baseDir });
    assert.equal(manifest.pages[0].file, 'pages/index.html');
    assert.equal(manifest.images['https://cdn.test/a.png'], 'images/a.png');
    assert.equal(snapshotFile(paths, manifest.pages[0].file), join(paths.pages, 'index.html'));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
