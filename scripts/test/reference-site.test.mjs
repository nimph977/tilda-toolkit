import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { assignLabels, newSite, readSite, writeSite } from '../lib/reference-store.mjs';
import { auditLinks, auditPage, AUDIT_KINDS, createSitePages, SITE_CREATE_GUARD } from '../reference-site.mjs';

setLogLevel('ERROR');

const PROJECT = '100000';

/** Фейковый драйвер: ответы createPage по очереди; значение Error — бросить. */
function fakeDriver(answers, { titleAnswer = 'OK' } = {}) {
  const calls = [];
  const titles = [];
  const queue = [...answers];
  return {
    calls,
    titles,
    call: async (name, args) => {
      calls.push({ name, args });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { text: next };
    },
    callWithResponse: async (name, args) => {
      titles.push({ name, args });
      if (titleAnswer instanceof Error) throw titleAnswer;
      return { result: { submitted: true }, status: 200, text: titleAnswer };
    },
  };
}

function sleeper() {
  const calls = [];
  return { calls, sleep: async (ms) => calls.push(ms) };
}

async function withSite(pages, fn, { projectid = null } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-site-'));
  // createPage сверяет projectid с TILDA_PROJECT_ID.
  const savedProject = process.env.TILDA_PROJECT_ID;
  process.env.TILDA_PROJECT_ID = PROJECT;
  try {
    const site = newSite('demo');
    site.projectid = projectid;
    assignLabels(site, { pages: pages.map((name) => ({ name, url: `https://ref.test/${name}`, status: 'ok' })) });
    writeSite('demo', site, { baseDir });
    await fn(baseDir);
  } finally {
    if (savedProject === undefined) delete process.env.TILDA_PROJECT_ID;
    else process.env.TILDA_PROJECT_ID = savedProject;
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test('createSitePages creates missing pages one by one and records pageid', () =>
  withSite(['index', 'about', 'blog'], async (baseDir) => {
    const driver = fakeDriver(['100001', '100002', '100003']);
    const s = sleeper();
    const r = await createSitePages(driver, { slug: 'demo', projectid: PROJECT, delayMs: 5, sleep: s.sleep, baseDir });
    assert.deepEqual(r.created, ['P00', 'P01', 'P02']);
    assert.deepEqual(r.left, []);
    assert.equal(driver.calls.length, 3);
    assert.ok(driver.calls.every((c) => c.name === 'createPage' && c.args[0] === PROJECT));
    assert.deepEqual(s.calls, [5, 5]);
    const site = readSite('demo', { baseDir });
    assert.equal(site.projectid, PROJECT);
    assert.deepEqual(site.pages.map((p) => p.pageid), ['100001', '100002', '100003']);
    // Заголовок по метке — после каждой созданной страницы.
    assert.deepEqual(driver.titles.map((t) => [t.name, ...t.args]), [['setPageTitle', '100001', 'P00 index'], ['setPageTitle', '100002', 'P01 about'], ['setPageTitle', '100003', 'P02 blog']]);
    assert.deepEqual(r.titleFailed, []);

    const again = fakeDriver([]);
    const r2 = await createSitePages(again, { slug: 'demo', projectid: PROJECT, sleep: s.sleep, baseDir });
    assert.equal(again.calls.length, 0);
    assert.deepEqual(r2.skipped, ['P00', 'P01', 'P02']);
  }));

test('createSitePages keeps created pages when Tilda reports the page limit', () =>
  withSite(['index', 'about', 'blog'], async (baseDir) => {
    const driver = fakeDriver(['100001', 'you created maximum pages']);
    await assert.rejects(
      createSitePages(driver, { slug: 'demo', projectid: PROJECT, sleep: sleeper().sleep, baseDir }),
      (e) => e.code === 'PAGE_LIMIT' && e.left.join() === 'P01,P02' && e.created.join() === 'P00',
    );
    assert.deepEqual(readSite('demo', { baseDir }).pages.map((p) => p.pageid), ['100001', null, null]);
  }));

test('createSitePages refuses a site map of another project without requests', () =>
  withSite(['index'], async (baseDir) => {
    const driver = fakeDriver(['100001']);
    await assert.rejects(createSitePages(driver, { slug: 'demo', projectid: PROJECT, baseDir }), (e) => e.code === 'SITE_PROJECT_MISMATCH' && e.exitCode === 1);
    assert.equal(driver.calls.length, 0);
  }, { projectid: '999999' }));

test('createSitePages refuses more pages than the guard before any request', () =>
  withSite(Array.from({ length: SITE_CREATE_GUARD + 1 }, (_, i) => `p${i}`), async (baseDir) => {
    const driver = fakeDriver([]);
    await assert.rejects(createSitePages(driver, { slug: 'demo', projectid: PROJECT, baseDir }), (e) => e.code === 'SITE_CREATE_GUARD');
    assert.equal(driver.calls.length, 0);
  }));

test('createSitePages does not retry a failed createPage call', () =>
  withSite(['index', 'about'], async (baseDir) => {
    const driver = fakeDriver([new Error('net::ERR_CONNECTION_RESET')]);
    await assert.rejects(createSitePages(driver, { slug: 'demo', projectid: PROJECT, sleep: sleeper().sleep, baseDir }), /ERR_CONNECTION_RESET/);
    assert.equal(driver.calls.filter((c) => c.name === 'createPage').length, 1);
    assert.equal(readSite('demo', { baseDir }).pages[0].pageid, null);
  }));

test('createSitePages needs a site map', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-site-'));
  try {
    await assert.rejects(createSitePages(fakeDriver([]), { slug: 'demo', projectid: PROJECT, baseDir }), (e) => e.code === 'NO_SITE');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- Проверка ссылок собранной страницы ---

const PREVIEW = 'https://tilda.test/page/preview/?pageid=100001';

test('auditLinks reports reference links and pages missing from the project', () => {
  const html = '<a href="https://ref.test/about">a</a><a href="/page100002.html">b</a><a href="/page100009.html">c</a>'
    + '<a href="/page100009.html">c2</a><a href="https://ext.test/">d</a><a href="#top">e</a><img src="https://ref.test/i.png">';
  const r = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100001', '100002'] });
  assert.equal(r.external, 1);
  assert.equal(r.internal, 2);
  assert.deepEqual(r.violations, [
    { kind: AUDIT_KINDS.referenceDomain, path: '/about', count: 1 },
    { kind: AUDIT_KINDS.unknownPage, path: '/page100009.html', count: 1 },
  ]);
});

test('auditLinks checks preview links by pageid', () => {
  const html = '<a href="https://tilda.ru/page/?pageid=100002&projectid=100000">ok</a>'
    + '<a href="https://tilda.ru/page/preview/?pageid=100009&projectid=100000">bad</a>'
    + '<a href="https://tilda.ru/page/?projectid=100000">none</a>';
  const r = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100002'] });
  assert.equal(r.internal, 3);
  assert.deepEqual(r.violations.map((v) => [v.kind, v.path]), [
    [AUDIT_KINDS.unknownPage, 'pageid=100009'],
    [AUDIT_KINDS.previewNoPage, '/page/'],
  ]);
});

test('auditPage writes the audit file of a label and needs the page list', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-audit-'));
  try {
    const site = newSite('demo');
    assignLabels(site, { pages: [{ name: 'index', url: 'https://ref.test/', status: 'ok' }] });
    site.pages[0].pageid = '100001';
    writeSite('demo', site, { baseDir });
    writeFileSync(join(baseDir, 'demo', 'reference.json'), JSON.stringify({ slug: 'demo', url: 'https://ref.test/', pages: [], images: {} }));
    const driver = { pageHtml: async () => ({ url: PREVIEW, html: '<a href="/page100001.html">x</a><a href="https://ref.test/a">y</a>' }) };
    const opts = { slug: 'demo', label: 'P00', projectid: PROJECT, baseDir };
    await assert.rejects(auditPage(driver, { ...opts, pagesFile: join(baseDir, 'none.json') }), (e) => e.code === 'NO_PAGE_LIST');
    const pagesFile = join(baseDir, 'pages.json');
    writeFileSync(pagesFile, JSON.stringify({ projectid: PROJECT, pages: [{ pageid: '100001' }] }));
    const r = await auditPage(driver, { ...opts, pagesFile });
    assert.equal(r.path, join(baseDir, 'demo', 'audit', 'P00.json'));
    const saved = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(saved.label, 'P00');
    assert.equal(saved.violations.length, 1);
    assert.ok(!readFileSync(r.path, 'utf8').includes('ref.test'), 'в файле аудита нет домена референса');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('createSitePages keeps the page when its title cannot be written', () =>
  withSite(['index'], async (baseDir) => {
    const driver = fakeDriver(['100001'], { titleAnswer: 'Wrong' });
    const r = await createSitePages(driver, { slug: 'demo', projectid: PROJECT, sleep: sleeper().sleep, baseDir });
    assert.deepEqual(r.created, ['P00']);
    assert.deepEqual(r.titleFailed, ['P00']);
    assert.equal(readSite('demo', { baseDir }).pages[0].pageid, '100001');
  }));

test('auditLinks with knownAliases reports relative addresses without a page in the project', () => {
  const html = '<a href="/company">a</a><a href="/company">a2</a><a href="/Blog/?x=1#top">b</a><a href="/page100002.html">c</a>'
    + '<a href="/">home</a><a href="https://ref.test/about">d</a><a href="//cdn.test/x">e</a>';
  const before = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100002'], knownAliases: ['blog'] });
  assert.deepEqual(before.violations, [
    { kind: AUDIT_KINDS.noAliasPage, path: '/company', count: 1 },
    { kind: AUDIT_KINDS.referenceDomain, path: '/about', count: 1 },
  ]);
  const after = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100002'], knownAliases: ['/company/', 'blog'] });
  assert.deepEqual(after.violations.map((v) => v.kind), [AUDIT_KINDS.referenceDomain]);
  const preview = auditLinks('<a href="/page/preview/?pageid=100002&projectid=100000">p</a>', { baseUrl: 'https://tilda.ru/page/preview/?pageid=100001', referenceHost: 'ref.test', knownPageIds: ['100002'], knownAliases: [] });
  assert.deepEqual([preview.internal, preview.violations], [1, []], 'ссылка предпросмотра проверяется по pageid, не по адресу');
  const legacy = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100002'] });
  assert.ok(!legacy.violations.some((v) => v.kind === AUDIT_KINDS.noAliasPage), 'без knownAliases прежнее поведение');
});

test('auditLinks names links to donor pages by ID as donorPage', () => {
  const html = '<a href="/page300004.html">d</a><a href="/page100009.html">u</a>';
  const withDonor = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100001'], donorPageIds: ['300004'] });
  assert.deepEqual(withDonor.violations.map((v) => [v.kind, v.path]), [
    [AUDIT_KINDS.donorPage, '/page300004.html'],
    [AUDIT_KINDS.unknownPage, '/page100009.html'],
  ]);
  const without = auditLinks(html, { baseUrl: PREVIEW, referenceHost: 'ref.test', knownPageIds: ['100001'] });
  assert.ok(without.violations.every((v) => v.kind === AUDIT_KINDS.unknownPage));
});
