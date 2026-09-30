import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PageOpError, PUBLISH_CONFIRM, createPage, deletePageInstructions, duplicatePage, parseNewPageResponse,
  parsePublishResponse, publishPage,
} from '../page-ops.mjs';
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

test('page operation response parsers distinguish created pages and publish failures', () => {
  assert.deepEqual(parseNewPageResponse(' 300003\n'), { pageid: '300003' });
  assert.throws(() => parseNewPageResponse('you created maximum pages'), (error) => error instanceof PageOpError && error.code === 'PAGE_LIMIT');
  assert.throws(() => parseNewPageResponse('{"error":"no"}'), (error) => error.code === 'PAGE_CREATE_FAILED');
  assert.deepEqual(parsePublishResponse('{"link":"https://example.test/p","wslink":"https://example.tilda.ws/p"}').link, 'https://example.test/p');
  assert.throws(() => parsePublishResponse('manual restriction for publishing'), (error) => error.code === 'PUBLISH_BANNED');
  assert.throws(() => parsePublishResponse('{"error":"no"}'), (error) => error.code === 'PUBLISH_FAILED');
});

test('page create/duplicate use a fake driver and publish refuses before transport', async () => {
  const originalProject = process.env.TILDA_PROJECT_ID;
  process.env.TILDA_PROJECT_ID = '100001';
  const driver = fakeDriver({
    duplicatePage: { text: '300003' },
    createPage: { text: '300004' },
    publishPage: { text: '{"link":"https://example.test/p","wslink":"https://example.tilda.ws/p"}' },
  });
  try {
    const duplicate = await duplicatePage(driver, '200002');
    const created = await createPage(driver, { projectid: '100001', examplepageid: '1231' });
    assert.deepEqual([duplicate.source, duplicate.pageid, created.projectid, created.pageid], ['200002', '300003', '100001', '300004']);

    await assert.rejects(() => publishPage(driver, '200002'), (error) => error.code === 'PUBLISH_NOT_CONFIRMED');
    assert.equal(driver.calls.length, 2);
    const published = await publishPage(driver, '200002', { confirmed: true });
    assert.equal(published.pageid, '200002');
    assert.deepEqual(driver.calls.at(-1), { name: 'publishPage', args: ['200002', PUBLISH_CONFIRM] });
  } finally {
    if (originalProject === undefined) delete process.env.TILDA_PROJECT_ID;
    else process.env.TILDA_PROJECT_ID = originalProject;
  }
});

test('pageTitleFor builds the cabinet title from the label and setPageTitle guards before the driver', async () => {
  const { pageTitleFor, setPageTitle, TITLE_MAX } = await import('../page-ops.mjs');
  assert.equal(pageTitleFor({ label: 'P13', donorTitle: 'Контакты' }), 'P13 Контакты');
  assert.equal(pageTitleFor({ label: 'P01', name: 'about' }), 'P01 about');
  assert.equal(pageTitleFor({ label: 'HDR', role: 'header' }), 'HDR шапка');
  assert.equal(pageTitleFor({ label: 'FTR', role: 'footer' }), 'FTR подвал');
  assert.equal(pageTitleFor({ label: 'P02', donorTitle: 'x'.repeat(300) }).length, TITLE_MAX);
  const calls = [];
  const driver = { callWithResponse: async (name, args, opts) => { calls.push({ name, args, opts }); return { status: 200, text: calls.length > 1 ? 'Wrong' : 'OK' }; } };
  await assert.rejects(() => setPageTitle(driver, '200001', 'x', { protectedIds: ['200001'] }), (e) => e instanceof PageOpError && e.code === 'PROTECTED_PAGE' && e.key === 'pageOps.protectedPage' && e.params.id === '200001');
  await assert.rejects(() => setPageTitle(driver, '200002', '  ', {}), (e) => e.code === 'TITLE_EMPTY');
  assert.equal(calls.length, 0);
  assert.deepEqual(await setPageTitle(driver, '200002', 'P13 Контакты'), { pageid: '200002', title: 'P13 Контакты' });
  assert.equal(calls[0].opts.bodyPart, 'comm=savepagesettings');
  await assert.rejects(() => setPageTitle(driver, '200002', 'P13'), (e) => e.code === 'TITLE_NOT_SAVED');
});

test('setPageAlias normalizes the alias, refuses bad or protected input before the driver and parses the answer', async () => {
  const { setPageAlias, normalizePageAlias, ALIAS_RE } = await import('../page-ops.mjs');
  assert.equal(normalizePageAlias(' /About/Team/ '), 'about/team');
  assert.ok(ALIAS_RE.test('pks-sport') && ALIAS_RE.test('blog/post_1'));
  assert.ok(!ALIAS_RE.test('компания') && !ALIAS_RE.test('a//b') && !ALIAS_RE.test(''));
  const answers = ['OK', '<p>Указанный адрес страницы уже занят</p>', 'Wrong'];
  const calls = [];
  const driver = { callWithResponse: async (name, args, opts) => { calls.push({ name, args, opts }); return { status: 200, text: answers[calls.length - 1] }; } };
  await assert.rejects(() => setPageAlias(driver, '200002', 'компания'), (e) => e instanceof PageOpError && e.code === 'ALIAS_INVALID');
  await assert.rejects(() => setPageAlias(driver, '200002', '  '), (e) => e.code === 'ALIAS_INVALID');
  await assert.rejects(() => setPageAlias(driver, '200001', 'about', { protectedIds: ['200001'] }), (e) => e.code === 'PROTECTED_PAGE');
  assert.equal(calls.length, 0);
  assert.deepEqual(await setPageAlias(driver, '200002', '/About'), { pageid: '200002', alias: 'about' });
  assert.deepEqual(calls[0].args, ['200002', 'about']);
  assert.equal(calls[0].name, 'setPageAlias');
  assert.equal(calls[0].opts.bodyPart, 'comm=savepagesettings');
  await assert.rejects(() => setPageAlias(driver, '200003', 'about'), (e) => e.code === 'ALIAS_TAKEN');
  await assert.rejects(() => setPageAlias(driver, '200003', 'about'), (e) => e.code === 'ALIAS_NOT_SAVED');
});

test('deletePageInstructions returns the steps for a human as messages', () => {
  const before = process.env.TILDA_PROJECT_ID;
  process.env.TILDA_PROJECT_ID = '100001';
  let steps;
  try {
    steps = deletePageInstructions('200002');
  } finally {
    if (before === undefined) delete process.env.TILDA_PROJECT_ID;
    else process.env.TILDA_PROJECT_ID = before;
  }
  assert.deepEqual(steps.map((s) => s.key), ['pageOps.deleteStepIntro', 'pageOps.deleteStepList', 'pageOps.deleteStepFind', 'pageOps.deleteStepMenu', 'pageOps.deleteStepCheck']);
  assert.equal(steps[0].params.id, '200002');
  assert.match(steps[1].params.url, /projectid=100001$/);
  assert.match(steps[2].params.editorUrl, /200002/);
});
