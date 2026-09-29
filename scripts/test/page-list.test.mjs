import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PageListError, listPages, normalizePages, parsePagesResponse } from '../page-list.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

function fakeDriver(answers) {
  const calls = [];
  return {
    calls,
    call: async (name, args) => {
      calls.push({ name, args });
      return answers[name];
    },
  };
}

const project = { id: '100001', indexpageid: '200002', headerpageid: '0', footerpageid: '0', page404id: '0', pages_count: 2 };
const answer = (pages, extra = {}) => JSON.stringify({ csrf: 'secret-token', useruploadkey: 'secret-key', project, pages, ...extra });

test('parsePagesResponse takes pages from the cabinet answer and rejects unrecognised answers', () => {
  const ok = parsePagesResponse(answer([{ id: '200002', title: 'A' }, { id: '200003', title: 'B' }]));
  assert.equal(ok.raw.length, 2);
  assert.equal(ok.project.id, '100001');
  assert.equal(ok.emptyMarker, false);
  assert.equal(parsePagesResponse(JSON.stringify({ project, pages: { 0: { id: '200002', title: 'A' } } })).raw.length, 1);
  assert.throws(() => parsePagesResponse('oops'), (e) => e instanceof PageListError && e.code === 'PAGES_BAD_JSON' && e.exitCode === 1);
  assert.throws(() => parsePagesResponse(JSON.stringify({ project })), (e) => e instanceof PageListError && e.code === 'PAGES_PARSE_FAILED');
  assert.throws(() => parsePagesResponse('null'), (e) => e instanceof PageListError && e.code === 'PAGES_PARSE_FAILED');
});

test('parsePagesResponse tells an empty project from an unrecognised answer', () => {
  const byCount = parsePagesResponse(JSON.stringify({ project: { ...project, pages_count: 0 }, pages: [] }));
  assert.deepEqual([byCount.raw.length, byCount.emptyMarker], [0, true]);
  const byMarker = parsePagesResponse(JSON.stringify({ project: { id: '100001' }, pages: '' }), { emptyMarker: true });
  assert.deepEqual([byMarker.raw.length, byMarker.emptyMarker], [0, true]);
  assert.throws(() => parsePagesResponse(JSON.stringify({ project: { id: '100001' }, pages: [] })), (e) => e.code === 'PAGES_PARSE_FAILED');
});

test('parsePagesResponse error message does not carry service keys of the answer', () => {
  const broken = `${answer([{ id: '200002', title: 'A' }]).slice(0, 60)}`;
  assert.throws(() => parsePagesResponse(broken), (e) => e.code === 'PAGES_BAD_JSON' && !/secret-token|secret-key/.test(e.message));
});

test('normalizePages marks protected pages, keeps source order and counts every skip reason', () => {
  const raw = [
    { id: '200003', projectid: '100001', title: 'B', published: '', alias: '', folderid: '0' },
    { id: '200002', projectid: '100001', title: ' A ', published: '170000', alias: 'about', folderid: '12' },
    { id: '200004', projectid: '100001', title: 'C' },
    { id: '', projectid: '100001', title: 'no id' },
    { id: '200005', projectid: '100001', title: '   ' },
    { id: '200003', projectid: '100001', title: 'B again' },
    { id: '200006', projectid: '100009', title: 'other' },
  ];
  const { pages, skipped } = normalizePages(raw, { protectedIds: ['200002'], project: parsePagesResponse(answer([{ id: '200002', title: 'A' }])).project });
  assert.deepEqual(pages.map((p) => p.pageid), ['200003', '200002', '200004']);
  assert.deepEqual(pages.map((p) => p.protected), [false, true, false]);
  assert.deepEqual(skipped, [
    { reason: 'no-pageid', count: 1 },
    { reason: 'other-project', count: 1 },
    { reason: 'no-title', count: 1 },
    { reason: 'duplicate', count: 1 },
  ]);
  const [b, a, c] = pages;
  assert.equal(a.title, 'A');
  assert.deepEqual([a.alias, a.published, a.folder, a.role], ['about', true, '12', 'index']);
  assert.equal(Object.hasOwn(b, 'alias'), false);
  assert.equal(Object.hasOwn(b, 'folder'), false);
  assert.equal(b.published, false);
  assert.equal(Object.hasOwn(c, 'published'), false);
  assert.equal(Object.hasOwn(c, 'role'), false);
});

test('normalizePages without project data keeps every page and reports nothing skipped', () => {
  const { pages, skipped } = normalizePages([{ id: '200002', projectid: '100009', title: 'A' }]);
  assert.deepEqual(pages, [{ pageid: '200002', title: 'A', protected: false }]);
  assert.deepEqual(skipped, []);
});

test('listPages calls the layer once with the project id and returns normalised pages', async () => {
  const driver = fakeDriver({ listPages: { source: 'api', status: 200, text: answer([{ id: '200002', projectid: '100001', title: 'A' }, { id: '', title: 'broken' }]), emptyMarker: false } });
  const r = await listPages(driver, { projectid: '100001', protectedIds: ['200002'] });
  assert.deepEqual(driver.calls, [{ name: 'listPages', args: ['100001'] }]);
  assert.equal(r.source, 'api');
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].protected, true);
  assert.deepEqual(r.skipped, [{ reason: 'no-pageid', count: 1 }]);
  assert.equal(r.emptyMarker, false);
  assert.equal(JSON.stringify(r).includes('secret'), false, 'service keys of the answer must not leak into the result');
});

test('listPages rejects an unknown layer answer instead of reporting an empty project', async () => {
  const driver = fakeDriver({ listPages: { source: 'dom', html: '<div></div>', emptyMarker: false } });
  await assert.rejects(listPages(driver, { projectid: '100001' }), (e) => e instanceof PageListError && e.code === 'PAGES_PARSE_FAILED');
});
