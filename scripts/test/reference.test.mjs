import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { refPaths } from '../lib/reference-store.mjs';
import { fetchReference, shotReference, structureReference } from '../reference.mjs';

setLogLevel('ERROR');

const BASE = 'https://ref.test/';
const block = (id, tpl, inner) => `<div id="rec${id}" class="r" data-record-type="${tpl}">${inner}</div>`;

const ROUTES = {
  'https://ref.test/': {
    status: 200,
    html: `<html><head><title>Главная</title></head><body>${block(7001, '796', '<div field="title">Привет</div><img imgfield="img" src="https://cdn.test/a.png"><a href="/about">о нас</a><a href="https://other.test/">чужое</a>')}</body></html>`,
  },
  'https://ref.test/about': {
    status: 200,
    html: `<html><head><title>О нас</title></head><body>${block(7002, '1002', '<div field="text">Текст</div><img src="https://cdn.test/noext">')}</body></html>`,
  },
  'https://ref.test/secret': { status: 403, html: '<html>forbidden</html>' },
  'https://ref.test/stub': { status: 200, html: '<html><body>ddos-guard</body></html>' },
  'https://ref.test/hub': {
    status: 200,
    html: `<html><body>${block(7010, '30', '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>')}</body></html>`,
  },
  'https://ref.test/hub2': {
    status: 200,
    html: `<html><body>${block(7011, '30', '<a href="/missing">m</a>')}</body></html>`,
  },
  'https://ref.test/orphan': { status: 200, html: `<html><body>${block(7015, '30', '<div field="title">Сирота</div>')}</body></html>` },
  'https://ref.test/a': { status: 200, html: `<html><body>${block(7012, '30', '<div field="title">A</div>')}</body></html>` },
  'https://ref.test/b': { status: 200, html: `<html><body>${block(7013, '30', '<div field="title">B</div>')}</body></html>` },
  'https://ref.test/c': { status: 200, html: `<html><body>${block(7014, '30', '<div field="title">C</div>')}</body></html>` },
};

function makeFake({ imageOk = true, sitemap = null } = {}) {
  let current = null;
  const calls = { goto: [], open: [] };
  const page = {
    goto: async (u) => {
      calls.goto.push(u);
      current = u;
      if (u === 'https://ref.test/sitemap.xml') {
        const st = sitemap ? sitemap.status : 404;
        return { status: () => st, ok: () => st === 200, text: async () => (sitemap ? sitemap.xml : ''), body: async () => Buffer.from('') };
      }
      const route = ROUTES[u];
      const status = route ? route.status : (u.startsWith('https://cdn.test/') ? 200 : 404);
      return { status: () => status, ok: () => status === 200, text: async () => (route ? route.html : ''), body: async () => Buffer.from('img') };
    },
    content: async () => ROUTES[current].html,
    request: { get: async () => ({ ok: () => imageOk, status: () => (imageOk ? 200 : 403), body: async () => Buffer.from('png') }) },
    close: async () => {},
  };
  const browser = {
    open: async (opts) => {
      calls.open.push(opts);
      return { context: {} };
    },
    openBackgroundPage: async () => page,
    close: async () => {},
  };
  return { browser, calls };
}

const QUIET = { delayMs: 0, settleMs: 0, imageDelayMs: 0 };

function withTmp(fn) {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-fetch-'));
  return fn(baseDir).finally(() => rmSync(baseDir, { recursive: true, force: true }));
}

test('fetchReference follows internal links and resumes without refetching', () =>
  withTmp(async (baseDir) => {
    const fake = makeFake();
    const r = await fetchReference({ url: BASE, slug: 'demo', follow: true, max: 5, baseDir, ...QUIET }, { browser: fake.browser });
    assert.equal(r.fetched, 2);
    assert.equal(r.failed, 0);
    assert.deepEqual(fake.calls.goto, ['https://ref.test/', 'https://ref.test/about']);
    const paths = refPaths('demo', { baseDir });
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    assert.deepEqual(manifest.pages.map((p) => [p.name, p.status, p.blocks]), [['index', 'ok', 1], ['about', 'ok', 1]]);
    assert.ok(existsSync(join(paths.pages, 'index.html')));
    assert.ok(existsSync(join(paths.structure, 'about.json')));
    assert.equal(manifest.pathBase, 'snapshot');
    assert.equal(manifest.pages[0].file, 'pages/index.html');
    assert.equal(resolve(paths.root, manifest.pages[0].file), join(paths.pages, 'index.html'));

    const again = makeFake();
    const r2 = await fetchReference({ url: BASE, slug: 'demo', follow: true, max: 5, baseDir, ...QUIET }, { browser: again.browser });
    assert.equal(r2.fetched, 0);
    assert.equal(r2.skipped, 2);
    assert.deepEqual(again.calls.goto, []);
  }));

test('fetchReference keeps links beyond --max as pending and fetches them on the next run', () =>
  withTmp(async (baseDir) => {
    const fake = makeFake();
    const r = await fetchReference({ url: 'https://ref.test/hub', slug: 'demo', follow: true, max: 2, baseDir, ...QUIET }, { browser: fake.browser });
    assert.equal(r.fetched, 2);
    assert.equal(r.pending, 2);
    const paths = refPaths('demo', { baseDir });
    let manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    assert.deepEqual(manifest.pages.map((p) => [p.name, p.status]), [['hub', 'ok'], ['a', 'ok'], ['b', 'pending'], ['c', 'pending']]);
    assert.equal(manifest.pages[2].fetchedAt, null);
    assert.equal(manifest.pages[2].file, undefined);

    const again = makeFake();
    const r2 = await fetchReference({ url: 'https://ref.test/hub', slug: 'demo', follow: true, max: 5, baseDir, ...QUIET }, { browser: again.browser });
    assert.equal(r2.fetched, 2);
    assert.equal(r2.pending, 0);
    assert.deepEqual(again.calls.goto, ['https://ref.test/b', 'https://ref.test/c']);
    manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    assert.ok(manifest.pages.every((p) => p.status === 'ok'));
  }));

test('fetchReference does not turn a failed page into pending when the limit is reached', () =>
  withTmp(async (baseDir) => {
    const fake = makeFake();
    await fetchReference({ url: 'https://ref.test/missing', slug: 'demo', max: 1, baseDir, ...QUIET }, { browser: fake.browser });
    const again = makeFake();
    const r = await fetchReference({ url: 'https://ref.test/hub2', slug: 'demo', follow: true, max: 1, baseDir, ...QUIET }, { browser: again.browser });
    assert.equal(r.fetched, 1);
    assert.equal(r.pending, 1);
    assert.deepEqual(again.calls.goto, ['https://ref.test/hub2']);
    const manifest = JSON.parse(readFileSync(refPaths('demo', { baseDir }).manifest, 'utf8'));
    const missing = manifest.pages.find((p) => p.name === 'missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'HTTP 404');
  }));

test('fetchReference --sitemap queues pages without incoming links', () =>
  withTmp(async (baseDir) => {
    const sitemap = { status: 200, xml: '<urlset><url><loc>https://ref.test/</loc></url><url><loc>https://ref.test/orphan</loc></url></urlset>' };
    const fake = makeFake({ sitemap });
    const r = await fetchReference({ url: BASE, slug: 'demo', follow: true, sitemap: true, max: 5, baseDir, ...QUIET }, { browser: fake.browser });
    assert.deepEqual(r.sitemap, { status: 200, found: 2, nested: 0 });
    assert.equal(fake.calls.goto[0], 'https://ref.test/sitemap.xml');
    const manifest = JSON.parse(readFileSync(refPaths('demo', { baseDir }).manifest, 'utf8'));
    assert.equal(manifest.pages.find((p) => p.name === 'orphan')?.status, 'ok');

    await withTmp(async (other) => {
      const plain = makeFake({ sitemap });
      const r2 = await fetchReference({ url: BASE, slug: 'demo', follow: true, max: 5, baseDir: other, ...QUIET }, { browser: plain.browser });
      assert.equal(r2.sitemap, undefined);
      assert.ok(!plain.calls.goto.includes('https://ref.test/orphan'));
      assert.ok(!plain.calls.goto.includes('https://ref.test/sitemap.xml'));
    });
  }));

test('fetchReference --sitemap continues when sitemap.xml is missing', () =>
  withTmp(async (baseDir) => {
    const fake = makeFake();
    const r = await fetchReference({ url: BASE, slug: 'demo', sitemap: true, max: 5, baseDir, ...QUIET }, { browser: fake.browser });
    assert.equal(r.sitemap.status, 404);
    assert.equal(r.fetched, 1);
  }));

test('fetchReference records failed and empty pages and keeps going', () =>
  withTmp(async (baseDir) => {
    const fake = makeFake();
    const r = await fetchReference({ url: 'https://ref.test/secret', slug: 'demo', baseDir, ...QUIET }, { browser: fake.browser });
    assert.equal(r.failed, 1);
    let manifest = JSON.parse(readFileSync(refPaths('demo', { baseDir }).manifest, 'utf8'));
    assert.equal(manifest.pages[0].status, 403);
    assert.equal(manifest.pages[0].error, 'HTTP 403');

    const r2 = await fetchReference({ url: 'https://ref.test/stub', slug: 'demo', baseDir, ...QUIET }, { browser: makeFake().browser });
    assert.equal(r2.failed, 2); // 403-страница повторяется при каждом запуске
    manifest = JSON.parse(readFileSync(refPaths('demo', { baseDir }).manifest, 'utf8'));
    const stub = manifest.pages.find((p) => p.name === 'stub');
    assert.equal(stub.status, 'empty');
    const paths = refPaths('demo', { baseDir });
    assert.ok(existsSync(join(paths.pages, 'stub.html')));
    assert.ok(!existsSync(join(paths.structure, 'stub.json')));
  }));

test('fetchReference downloads images with known extensions only', () =>
  withTmp(async (baseDir) => {
    const r = await fetchReference({ url: BASE, slug: 'demo', follow: true, max: 5, images: true, baseDir, ...QUIET }, { browser: makeFake().browser });
    assert.equal(r.images, 1);
    assert.equal(r.imagesFailed, 1);
    const manifest = JSON.parse(readFileSync(refPaths('demo', { baseDir }).manifest, 'utf8'));
    const rel = manifest.images['https://cdn.test/a.png'];
    assert.match(rel, /^images\/[0-9a-f]{12}\.png$/);
    assert.ok(existsSync(resolve(refPaths('demo', { baseDir }).root, rel)));
    assert.equal(manifest.images['https://cdn.test/noext'], undefined);
  }));

test('fetchReference falls back to goto when request.get is refused', () =>
  withTmp(async (baseDir) => {
    const r = await fetchReference({ url: BASE, slug: 'demo', images: true, baseDir, ...QUIET }, { browser: makeFake({ imageOk: false }).browser });
    assert.equal(r.images, 1);
    const manifest = JSON.parse(readFileSync(refPaths('demo', { baseDir }).manifest, 'utf8'));
    assert.equal(readFileSync(resolve(refPaths('demo', { baseDir }).root, manifest.images['https://cdn.test/a.png']), 'utf8'), 'img');
  }));

test('structureReference rebuilds structure from saved HTML', () =>
  withTmp(async (baseDir) => {
    await fetchReference({ url: BASE, slug: 'demo', baseDir, ...QUIET }, { browser: makeFake().browser });
    const file = join(refPaths('demo', { baseDir }).structure, 'index.json');
    writeFileSync(file, '{broken', 'utf8');
    const r = await structureReference({ slug: 'demo', baseDir });
    assert.equal(r.pages, 1);
    assert.deepEqual(r.tplids, ['796']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).title, 'Главная');
    await assert.rejects(structureReference({ slug: 'nope', baseDir }), (e) => e.code === 'NO_MANIFEST' && e.exitCode === 1);
  }));

test('fetchReference does not need TILDA_PROTECTED_PAGES', () =>
  withTmp(async (baseDir) => {
    const saved = process.env.TILDA_PROTECTED_PAGES;
    delete process.env.TILDA_PROTECTED_PAGES;
    try {
      const fake = makeFake();
      await fetchReference({ url: BASE, slug: 'demo', baseDir, ...QUIET }, { browser: fake.browser });
      assert.deepEqual(fake.calls.open, [{ protectedPages: [] }]);
    } finally {
      if (saved === undefined) delete process.env.TILDA_PROTECTED_PAGES;
      else process.env.TILDA_PROTECTED_PAGES = saved;
    }
  }));

test('fetchReference rejects non-http urls and bad slugs', async () => {
  await assert.rejects(fetchReference({ url: 'ftp://x', slug: 'demo' }, { browser: makeFake().browser }), (e) => e.code === 'BAD_URL' && e.exitCode === 2);
  await assert.rejects(fetchReference({ url: BASE, slug: 'Bad Slug' }, { browser: makeFake().browser }), (e) => e.code === 'BAD_SLUG');
});

// --- Снимок референса по метке ---

function shotFake({ status = 200 } = {}) {
  const calls = { goto: [], shots: [], closed: 0 };
  let viewport = 1440;
  const page = {
    setViewportSize: async (v) => { viewport = v.width; },
    goto: async (url) => {
      calls.goto.push(url);
      return { status: () => status };
    },
    waitForTimeout: async () => {},
    addStyleTag: async () => {},
    evaluate: async (fn) => (String(fn).includes('t-rec') ? { records: 5, height: 1200, width: viewport, dpr: 1 } : 0),
    screenshot: async ({ path }) => calls.shots.push(path),
    url: () => 'https://ref.test/',
    close: async () => { calls.closed += 1; },
  };
  const browser = { open: async () => ({ context: {} }), openBackgroundPage: async () => page, close: async () => {} };
  return { browser, calls };
}

function writeSiteMap(baseDir) {
  const root = refPaths('demo', { baseDir }).root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'site.json'), JSON.stringify({ slug: 'demo', substitutes: {}, pages: [
    { label: 'HDR', role: 'header', pageid: null },
    { label: 'P00', role: 'content', name: 'index', url: 'https://ref.test/', pageid: null },
  ] }));
}

test('shotReference shoots a labelled page into shots/<label> without exposing its address', () =>
  withTmp(async (baseDir) => {
    writeSiteMap(baseDir);
    const fake = shotFake();
    const r = await shotReference({ slug: 'demo', source: 'P00', widths: [1440, 320], baseDir, settleMs: 0 }, { browser: fake.browser });
    assert.equal(r.label, 'P00');
    assert.equal(r.files, 2);
    assert.equal(r.dir, join(refPaths('demo', { baseDir }).root, 'shots', 'P00'));
    assert.ok(fake.calls.shots.every((p) => p.startsWith(r.dir)));
    assert.deepEqual(fake.calls.goto, ['https://ref.test/', 'https://ref.test/']);
    assert.ok(!JSON.stringify(r).includes('ref.test'));
    assert.equal(fake.calls.closed, 1);
  }));

test('shotReference refuses page names, header labels and unavailable pages', () =>
  withTmp(async (baseDir) => {
    writeSiteMap(baseDir);
    await assert.rejects(shotReference({ slug: 'demo', source: 'index', baseDir }, { browser: shotFake().browser }), (e) => e.code === 'LABEL_REQUIRED' && e.exitCode === 2);
    await assert.rejects(shotReference({ slug: 'demo', source: 'HDR', baseDir }, { browser: shotFake().browser }), (e) => e.code === 'NO_REFERENCE_URL');
    const gone = shotFake({ status: 404 });
    await assert.rejects(shotReference({ slug: 'demo', source: 'P00', widths: [1440], baseDir, settleMs: 0 }, { browser: gone.browser }), (e) => e.code === 'REFERENCE_UNAVAILABLE' && e.exitCode === 1);
    assert.equal(gone.calls.shots.length, 0);
  }));
