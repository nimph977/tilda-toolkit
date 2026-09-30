import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { msg, t } from '../lib/i18n.mjs';
import { AUDIT_KINDS } from '../reference-site.mjs';
import {
  CHECK_REASONS, MANUAL_CHECKS, MAX_FAILURES_IN_ROW, SECTION_END, SECTION_START,
  checkLabel, checkReasonMessage, indexPageCheck, mapCompleteness, renderChecksSection, runDonorCheck, selectLabels, writeChecksSection,
} from '../donor-check.mjs';

setLogLevel('ERROR');

// Синтетические страницы донора 300001–300009 и копии 200001–200009; домен донора ref.test.
const site = { pages: [
  { label: 'HDR', role: 'header', pageid: '200009', donorPageid: '300009' },
  { label: 'P00', role: 'content', pageid: '200001', donorPageid: '300001' },
  { label: 'P01', role: 'content', pageid: '200004', donorPageid: '300004' },
  { label: 'P02', role: 'content', pageid: '200006', donorPageid: '300004' },
  { label: 'P03', role: 'content', pageid: null, donorPageid: '300005' },
] };
const donorPages = [{ pageid: '300001', role: 'index' }, { pageid: '300004', alias: 'about' }, { pageid: '300005' }, { pageid: '300008', role: '404' }, { pageid: '300009', role: 'header' }];
const testPages = [{ pageid: '200001', role: 'index' }, { pageid: '200004', alias: 'about' }, { pageid: '200009', role: 'header' }];

test('mapCompleteness names donor pages without a label; a missing 404 page is not a violation', () => {
  assert.deepEqual(mapCompleteness(site, donorPages), { donorPages: 5, mapped: 4, missing: [{ pageid: '300008', role: '404' }], ok: true });
  const r = mapCompleteness(site, [...donorPages, { pageid: '300007' }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.at(-1), { pageid: '300007', role: null });
});

test('indexPageCheck compares the project index page with the label of the donor index page', () => {
  assert.deepEqual(indexPageCheck(site, testPages, donorPages), { ok: true, expected: '200001', actual: '200001', label: 'P00', fix: null });
  const other = indexPageCheck(site, [{ pageid: '200004', role: 'index' }], donorPages);
  assert.deepEqual([other.ok, other.actual, other.fix], [false, '200004', 'page role --index 200001 --confirm']);
  assert.equal(indexPageCheck(site, [], donorPages).fix, 'page role --index 200001 --confirm', 'главная не назначена');
  const noPair = indexPageCheck(site, testPages, [{ pageid: '300099', role: 'index' }]);
  assert.deepEqual([noPair.ok, noPair.fix], [false, null], 'у главной донора нет метки — команды нет');
});

test('renderChecksSection gives the page role --index command when the index page is wrong', () => {
  const md = renderChecksSection({ at: '2026-09-24T10:00:00.000Z', labels: [], skipped: [], index: indexPageCheck(site, [{ pageid: '200004', role: 'index' }], donorPages) }, 'ru');
  assert.match(md, /`node scripts\/tilda\.mjs page role --index 200001 --confirm`, затем `page list` и повторный `donor check`/);
  assert.doesNotMatch(md, /вручную в настройках сайта/);
  const noPair = renderChecksSection({ at: '2026-09-24T10:00:00.000Z', labels: [], skipped: [], index: indexPageCheck(site, testPages, [{ pageid: '300099', role: 'index' }]) }, 'ru');
  assert.match(noPair, /нет метки со страницей/);
  const en = renderChecksSection({ at: '2026-09-24T10:00:00.000Z', labels: [], skipped: [], index: indexPageCheck(site, [{ pageid: '200004', role: 'index' }], donorPages) }, 'en');
  assert.match(en, /`node scripts\/tilda\.mjs page role --index 200001 --confirm`, then `page list` and a repeated `donor check`/);
});

test('selectLabels skips labels without a page, duplicates and pages never transferred', () => {
  const r = selectLabels(site, { transferred: (id) => id !== '200009' });
  assert.deepEqual(r.todo.map((e) => e.label), ['P00', 'P01']);
  assert.deepEqual(r.skipped.map((s) => [s.label, s.code, s.params]), [
    ['HDR', 'notTransferred', {}],
    ['P02', 'duplicate', { label: 'P01' }],
    ['P03', 'noPageid', {}],
  ]);
  assert.equal(r.skipped[1].reason, 'the same donor page as label P01 — checked there', 'в данных причина — английский текст');
  assert.deepEqual(checkReasonMessage(r.skipped[1]), msg(CHECK_REASONS.duplicate, { label: 'P01' }), 'для итога — Message');
  assert.deepEqual(selectLabels(site, { labels: ['P01', 'P09'], transferred: () => true }).skipped.map((s) => [s.label, s.code]), [['P09', 'unknownLabel']]);
});

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-donor-check-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fakeDriver = () => ({
  listRecords: async () => [{ recordid: '400031', tplid: '131' }, { recordid: '400032', tplid: '770' }],
  pageHtml: async () => ({ url: 'https://tilda.test/page/preview/?pageid=200001', html: '<a href="/page300004.html">d</a><a href="/about">ok</a>' }),
  readRecord: async () => ({ record: { tplid: '131' } }),
});

test('checkLabel reports donor-ID links, an empty HTML block and formmsgurl on the donor domain', () => withDir(async (baselineBase) => {
  const recDir = join(baselineBase, 'records', '200001');
  mkdirSync(recDir, { recursive: true });
  writeFileSync(join(recDir, '400032.json'), JSON.stringify({ record: { recordid: '400032', tplid: '770', formmsgurl: 'https://ref.test/thanks' } }));
  writeFileSync(join(recDir, '400033.json'), JSON.stringify({ record: { recordid: '400033', tplid: '770', formmsgurl: 'https://ref.test/old' } }));
  const r = await checkLabel(fakeDriver(), {
    entry: site.pages[1], referenceHost: 'ref.test', hosts: ['ref.test', 'www.ref.test'],
    knownAliases: ['/about'], knownPageIds: ['200001', '200004'], donorPageIds: ['300004'], baselineBase,
  });
  assert.deepEqual(r.violations, [{ kind: AUDIT_KINDS.donorPage, path: '/page300004.html', count: 1 }]);
  assert.deepEqual(r.htmlBlocks.map((b) => [b.recordid, b.placeholder]), [['400031', true]]);
  assert.deepEqual(r.forms, [{ recordid: '400032', field: 'formmsgurl' }], 'снимок удалённого блока не считается');
}));

test('writeChecksSection replaces the section between markers and keeps the rest of the summary', () => withDir((dir) => {
  const path = join(dir, 'reports', 'transfer-summary.md');
  writeChecksSection(path, `${SECTION_START}\nпервый\n${SECTION_END}`, 'ru');
  assert.match(readFileSync(path, 'utf8'), /^# Сводка переноса/);
  const en = join(dir, 'reports', 'en-summary.md');
  writeChecksSection(en, `${SECTION_START}\nfirst\n${SECTION_END}`, 'en');
  assert.match(readFileSync(en, 'utf8'), /^# Transfer summary/);
  writeFileSync(path, `# Сводка\n\nтекст агента\n\n${SECTION_START}\nпервый\n${SECTION_END}\n\nхвост\n`, 'utf8');
  writeChecksSection(path, `${SECTION_START}\nвторой\n${SECTION_END}`);
  assert.equal(readFileSync(path, 'utf8'), `# Сводка\n\nтекст агента\n\n${SECTION_START}\nвторой\n${SECTION_END}\n\nхвост\n`);
  writeFileSync(path, '# Сводка\n\nбез раздела\n', 'utf8');
  writeChecksSection(path, `${SECTION_START}\nтретий\n${SECTION_END}`);
  assert.equal(readFileSync(path, 'utf8'), `# Сводка\n\nбез раздела\n\n${SECTION_START}\nтретий\n${SECTION_END}\n`);
}));

const FULL_RESULT = () => ({
  at: '2026-09-24T10:00:00.000Z',
  labels: [
    { label: 'P00', total: 3, violations: [{ kind: AUDIT_KINDS.donorPage, path: '/page300004.html', count: 1 }], htmlBlocks: [{ recordid: '400031', placeholder: true, hosts: [], hidden: false }], forms: [{ recordid: '400032', field: 'formmsgurl' }] },
    { label: 'P01', error: 'check failed: SESSION_LOST: x', errorParams: { message: 'SESSION_LOST: x' } },
  ],
  skipped: [{ label: 'P02', code: 'duplicate', params: { label: 'P01' }, reason: 'the same donor page as label P01 — checked there' }],
  map: mapCompleteness(site, donorPages),
  index: indexPageCheck(site, testPages, donorPages),
});

test('renderChecksSection lists labels, violations, HTML blocks, forms, map, index and manual checks', () => {
  const md = renderChecksSection(FULL_RESULT(), 'ru');
  assert.ok(md.startsWith(SECTION_START) && md.endsWith(SECTION_END));
  assert.match(md, /Снято: 2026-09-24T10:00:00\.000Z\./);
  assert.match(md, /<!-- taken-at: 2026-09-24T10:00:00\.000Z -->/);
  assert.match(md, /\| P00 \| 3 \| 1 \| 1 \(с заглушкой 1, с внешними хостами 0\) \| 1 \|/);
  assert.match(md, /\| P01 \| — \| проверка не выполнена: SESSION_LOST: x \|/);
  assert.match(md, /P00: ссылка на страницу донора по ID — donor links: \/page300004\.html ×1/);
  assert.match(md, /P00, блок 400031: заглушка/);
  assert.match(md, /P00, блок 400032: formmsgurl ведёт на домен донора/);
  assert.match(md, /P02: та же страница донора, что у метки P01 — проверяется там/);
  assert.match(md, /300008 \(роль 404\): страница 404 — ручной пункт ниже/);
  assert.match(md, /Главной назначена страница метки P00 — верно/);
  for (const m of MANUAL_CHECKS) assert.ok(md.includes(`- [ ] ${t('ru', m)}`));
});

test('renderChecksSection in English has no Cyrillic and keeps the machine label', () => {
  const md = renderChecksSection(FULL_RESULT(), 'en');
  assert.doesNotMatch(md, /[А-Яа-яЁё]/);
  assert.match(md, /Taken: 2026-09-24T10:00:00\.000Z\./);
  assert.match(md, /<!-- taken-at: 2026-09-24T10:00:00\.000Z -->/);
  assert.match(md, /\| P01 \| — \| check failed: SESSION_LOST: x \|/);
  assert.match(md, /P02: the same donor page as label P01 — checked there/);
  assert.match(md, /300008 \(role 404\): the 404 page — a manual item below/);
  assert.equal(renderChecksSection(FULL_RESULT()), md, 'язык по умолчанию — английский');
  for (const m of MANUAL_CHECKS) assert.ok(md.includes(`- [ ] ${t('en', m)}`));
});

test('runDonorCheck checks labels one by one with a pause, writes checks.json and the summary section', () => withDir(async (dir) => {
  const baseDir = join(dir, 'ref');
  const baselineBase = join(dir, 'baseline');
  for (const id of ['200001', '200004']) mkdirSync(join(baselineBase, 'transfer', id), { recursive: true });
  const sleeps = [];
  const opened = [];
  const openLabel = async (entry, fn) => {
    opened.push(entry.label);
    return fn(fakeDriver());
  };
  const r = await runDonorCheck(openLabel, { slug: 'demo', site, donorPages, testPages, referenceHost: 'ref.test', hosts: ['ref.test'], baseDir, baselineBase, sleep: async (ms) => sleeps.push(ms), now: 'T' });
  assert.deepEqual(opened, ['P00', 'P01']);
  assert.deepEqual(sleeps, [3000]);
  assert.equal(r.linkViolations, 2);
  assert.equal(r.exitCode, 1);
  assert.equal(JSON.parse(readFileSync(r.checksPath, 'utf8')).labels.length, 2);
  assert.match(readFileSync(r.summaryPath, 'utf8'), /## Post-transfer checks \(donor check\)/, 'язык по умолчанию — английский');
  // Повтор на другом языке заменяет раздел между маркерами.
  const again = await runDonorCheck(openLabel, { slug: 'demo', site, donorPages, testPages, referenceHost: 'ref.test', hosts: ['ref.test'], baseDir, baselineBase, sleep: async () => {}, now: 'T2', lang: 'ru' });
  const text = readFileSync(again.summaryPath, 'utf8');
  assert.match(text, /## Проверки после переноса \(donor check\)/);
  assert.doesNotMatch(text, /Post-transfer checks/);
  assert.equal(text.split(SECTION_START).length, 2, 'раздел один');
}));

test('runDonorCheck records a failed label and stops after failures in a row', () => withDir(async (dir) => {
  const baselineBase = join(dir, 'baseline');
  const many = { pages: Array.from({ length: MAX_FAILURES_IN_ROW + 1 }, (_, i) => ({ label: `P0${i}`, role: 'content', pageid: `20000${i + 1}`, donorPageid: `30000${i + 1}` })) };
  for (const p of many.pages) mkdirSync(join(baselineBase, 'transfer', p.pageid), { recursive: true });
  const lost = Object.assign(new Error('session lost'), { code: 'SESSION_LOST' });
  const r = await runDonorCheck(async () => { throw lost; }, { slug: 'demo', site: many, donorPages: [], testPages: [], hosts: [], baseDir: join(dir, 'ref'), baselineBase, sleep: async () => {} });
  assert.equal(r.failed, MAX_FAILURES_IN_ROW);
  assert.equal(r.stopped, true);
  assert.deepEqual(r.skipped.at(-1).code, 'stopped');
  assert.deepEqual(r.skipped.at(-1).params, { n: MAX_FAILURES_IN_ROW });
  assert.equal(r.skipped.at(-1).label, `P0${MAX_FAILURES_IN_ROW}`);
  assert.match(r.labels[0].error, /SESSION_LOST: session lost/);
  assert.deepEqual(r.labels[0].errorParams, { message: 'SESSION_LOST: session lost' });
  assert.equal(r.exitCode, 1);
}));
