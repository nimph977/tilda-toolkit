import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DoctorUsageError, checkChrome, checkDependencies, checkGit, checkNode, checkSite, checkSkill,
  chromeCandidates, formatReport, parseDoctorArgs, renderReport, runDoctor, siteFixFor,
} from '../doctor.mjs';
import { getProjectId, getProtectedPages } from '../lib/config.mjs';
import { messageText, msg } from '../lib/i18n.mjs';
import { resolveSiteDir, siteEnvChanges } from '../lib/site.mjs';
import { ROOT } from './product-files.mjs';

const DEPS = { resolveSiteDir, siteEnvChanges, getProjectId, getProtectedPages };

/** Английский текст поля пункта: `Message` переводится, строка (команда, путь) остаётся как есть. */
const en = (value) => (typeof value === 'string' ? value : messageText(value));

/** Временная папка, которая удаляется в конце теста. */
function tempDir(t, prefix = 'doctor-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('checkNode accepts 24 and newer and refuses older versions with a platform command', () => {
  assert.equal(checkNode({ version: '24.0.0', platform: 'linux' }).status, 'ok');
  assert.equal(checkNode({ version: '26.1.0', platform: 'linux' }).status, 'ok');
  const old = checkNode({ version: '22.11.0', platform: 'win32' });
  assert.equal(old.status, 'fail');
  assert.match(en(old.message), /v22\.11\.0/);
  assert.match(old.fix, /^winget install /);
});

test('checkDependencies compares the installed playwright-core with package.json', (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'playwright-core': '1.63.0' } }));

  const missing = checkDependencies({ root });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.fix, 'npm ci');

  const pkg = join(root, 'node_modules', 'playwright-core');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.62.0' }));
  const wrong = checkDependencies({ root });
  assert.equal(wrong.status, 'fail');
  assert.equal(wrong.message.key, 'doctor.dependencies.wrongVersion');
  assert.match(en(wrong.message), /1\.62\.0 instead of 1\.63\.0/);
  assert.equal(wrong.fix, 'npm ci');

  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.63.0' }));
  assert.equal(checkDependencies({ root }).status, 'ok');
});

test('checkDependencies turns a broken package.json into a failed check', (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, 'package.json'), '{ not json');
  const result = checkDependencies({ root });
  assert.equal(result.status, 'fail');
  assert.equal(result.message.key, 'doctor.guard.failed');
  assert.match(en(result.message), /^check failed to run: /);
});

test('chromeCandidates follows the Playwright order and ignores key case', () => {
  const env = { LOCALAPPDATA: 'L:\\x', ProgramFiles: 'P:\\y', HOMEDRIVE: 'C:' };
  const suffix = '\\Google\\Chrome\\Application\\chrome.exe';
  assert.deepEqual(chromeCandidates({ platform: 'win32', env }), [
    `L:\\x${suffix}`,
    `P:\\y${suffix}`,
    `C:\\Program Files${suffix}`,
    `C:\\Program Files (x86)${suffix}`,
  ]);
  assert.deepEqual(chromeCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'L:\\x' } }), [`L:\\x${suffix}`]);
  assert.deepEqual(chromeCandidates({ platform: 'linux', env: {} }), ['/opt/google/chrome/chrome']);
  assert.deepEqual(chromeCandidates({ platform: 'darwin', env: {} }), ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  assert.deepEqual(chromeCandidates({ platform: 'aix', env: {} }), []);
});

test('checkChrome takes the first existing candidate and lists the checked paths otherwise', () => {
  const env = { LOCALAPPDATA: 'L:\\x', PROGRAMFILES: 'P:\\y' };
  const second = chromeCandidates({ platform: 'win32', env })[1];
  const found = checkChrome({ platform: 'win32', env, exists: (path) => path === second });
  assert.equal(found.status, 'ok');
  assert.equal(found.detail, second);

  const none = checkChrome({ platform: 'win32', env, exists: () => false });
  assert.equal(none.status, 'fail');
  assert.match(en(none.detail), /L:\\x.*; P:\\y/);
  assert.match(none.fix, /winget install/);

  assert.equal(checkChrome({ platform: 'aix', env: {}, exists: () => true }).status, 'fail');
});

test('checkGit is never worse than a warning', () => {
  const ok = checkGit({ run: () => ({ status: 0, stdout: 'git version 2.53.0\n' }), platform: 'linux' });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.detail, 'git version 2.53.0');
  const absent = checkGit({ run: () => ({ error: new Error('ENOENT') }), platform: 'linux' });
  assert.equal(absent.status, 'warn');
  assert.equal(absent.fix, 'sudo apt-get install git');
  assert.equal(checkGit({ run: () => ({ status: 1, stdout: '' }), platform: 'darwin' }).status, 'warn');
});

test('static imports of scripts/doctor.mjs are node: modules and the translation module only', () => {
  const text = readFileSync(join(ROOT, 'scripts', 'doctor.mjs'), 'utf8');
  const specifiers = [...text.matchAll(/^import .* from '(.+)'/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  assert.ok(specifiers.includes('./lib/i18n.mjs'));
  assert.deepEqual(specifiers.filter((name) => !name.startsWith('node:') && name !== './lib/i18n.mjs'), []);
});

/** Папка сайта вне «репозитория» `root` с заданным содержимым `.env`. */
function makeSite(t, envText) {
  const dir = tempDir(t, 'doctor-site-');
  if (envText !== undefined) writeFileSync(join(dir, '.env'), envText);
  return dir;
}

const PROJECT = 'TILDA_PROJECT_ID=1000000000001\n';
const PROTECTED = 'TILDA_PROTECTED_PAGES=1000000000002\n';

function siteCheck(t, { flag, env = {}, root } = {}) {
  const repo = root ?? tempDir(t, 'doctor-repo-');
  return checkSite({ flag, env, cwd: repo, root: repo, deps: DEPS });
}

test('checkSite skips when no site is chosen and points to setup', (t) => {
  const result = siteCheck(t);
  assert.equal(result.status, 'skip');
  assert.match(en(result.fix), /setup/);
});

test('checkSite fails for a missing folder, a folder in the repository and a missing .env', (t) => {
  const repo = tempDir(t, 'doctor-repo-');
  const missing = siteCheck(t, { flag: join(repo, '..', 'no-such-site-folder'), root: repo });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.message.key, 'site.notFound');
  assert.match(en(missing.fix), /setup/);

  const inside = join(repo, 'data');
  mkdirSync(inside);
  writeFileSync(join(inside, '.env'), PROJECT + PROTECTED);
  const insideResult = siteCheck(t, { flag: inside, root: repo });
  assert.equal(insideResult.status, 'fail');
  assert.equal(insideResult.message.key, 'paths.insideRepo');
  assert.equal(insideResult.fix.key, 'doctor.site.fixOutsideRepo');

  const twin = join(repo, '..data');
  mkdirSync(twin);
  writeFileSync(join(twin, '.env'), PROJECT + PROTECTED);
  assert.equal(siteCheck(t, { flag: twin, root: repo }).status, 'fail');

  const outside = makeSite(t);
  const noEnv = siteCheck(t, { flag: outside, root: repo });
  assert.equal(noEnv.status, 'fail');
  assert.equal(noEnv.message.key, 'site.noEnv');
  assert.match(en(noEnv.fix), /setup/);
});

test('siteFixFor picks the hint by the error key, not by its text', () => {
  const target = '/some site';
  assert.match(en(siteFixFor({ key: 'site.notFound' }, target)), /setup --site "\/some site"/);
  assert.match(en(siteFixFor({ key: 'site.noEnv' }, target)), /setup --site/);
  assert.equal(siteFixFor({ key: 'paths.insideRepo' }, target).key, 'doctor.site.fixOutsideRepo');
  assert.equal(siteFixFor({ key: 'site.dirsDiffer' }, target).key, 'doctor.site.fixOneDir');
  assert.equal(siteFixFor({ message: 'папка сайта не найдена' }, target).key, 'doctor.site.fixOneDir');
  assert.equal(siteFixFor(new Error('anything'), target).key, 'doctor.site.fixOneDir');
});

test('checkSite fails for a link outside the repository that points inside it', (t) => {
  const repo = tempDir(t, 'doctor-repo-');
  const inside = join(repo, 'data');
  mkdirSync(inside);
  writeFileSync(join(inside, '.env'), PROJECT + PROTECTED);
  const holder = tempDir(t, 'doctor-link-');
  const link = join(holder, 'site');
  symlinkSync(inside, link, 'junction');
  assert.equal(siteCheck(t, { flag: link, root: repo }).status, 'fail');
});

test('checkSite validates the project id and the protected pages list', (t) => {
  const emptyProject = siteCheck(t, { flag: makeSite(t, 'TILDA_PROJECT_ID=\nTILDA_PROTECTED_PAGES=\n') });
  assert.equal(emptyProject.status, 'fail');
  assert.match(en(emptyProject.message), /TILDA_PROJECT_ID/);

  const noKey = siteCheck(t, { flag: makeSite(t, PROJECT) });
  assert.equal(noKey.status, 'fail');
  assert.match(en(noKey.message), /TILDA_PROTECTED_PAGES/);

  const badKey = siteCheck(t, { flag: makeSite(t, `${PROJECT}TILDA_PROTECTED_PAGES=abc\n`) });
  assert.equal(badKey.status, 'fail');
  assert.doesNotMatch(JSON.stringify(badKey), /abc/);

  const empty = siteCheck(t, { flag: makeSite(t, `${PROJECT}TILDA_PROTECTED_PAGES=\n`) });
  assert.equal(empty.status, 'warn');
  assert.equal(empty.fix.key, 'doctor.site.fixProtectedEmpty');

  const good = siteCheck(t, { flag: makeSite(t, PROJECT + PROTECTED) });
  assert.equal(good.status, 'ok');
  assert.match(en(good.detail), /protected pages: 1/);
  assert.doesNotMatch(JSON.stringify(good), /1000000000001|1000000000002/);
});

test('checkSite follows the priority of siteEnvChanges for the environment and the file', (t) => {
  const conflict = siteCheck(t, {
    flag: makeSite(t, PROJECT + PROTECTED),
    env: { TILDA_PROJECT_ID: '1000000000003' },
  });
  assert.equal(conflict.status, 'fail');
  assert.doesNotMatch(JSON.stringify(conflict), /1000000000003|1000000000001/);

  const envOnly = siteCheck(t, {
    flag: makeSite(t, `TILDA_PROTECTED_PAGES=\n`),
    env: { TILDA_PROJECT_ID: '1000000000003' },
  });
  assert.equal(envOnly.status, 'fail');

  const logLevel = siteCheck(t, {
    flag: makeSite(t, `${PROJECT}${PROTECTED}LOG_LEVEL=DEBUG\n`),
    env: { LOG_LEVEL: 'INFO' },
  });
  assert.equal(logLevel.status, 'ok');

  const inherited = siteCheck(t, {
    flag: makeSite(t, PROJECT + PROTECTED),
    env: { TILDA_BASELINE_DIR: join(tmpdir(), 'doctor-baseline') },
  });
  assert.equal(inherited.status, 'ok');

  const differentPath = siteCheck(t, {
    flag: makeSite(t, `${PROJECT}${PROTECTED}TILDA_BASELINE_DIR=./data\n`),
    env: { TILDA_BASELINE_DIR: join(tmpdir(), 'doctor-other') },
  });
  assert.equal(differentPath.status, 'fail');
});

test('checkSite does not touch process.env or the environment it was given', (t) => {
  const before = JSON.stringify(process.env);
  const env = { TILDA_PROJECT_ID: '1000000000001', LOG_LEVEL: 'INFO' };
  const snapshot = { ...env };
  siteCheck(t, { flag: makeSite(t, `${PROJECT}${PROTECTED}TILDA_BASELINE_DIR=./b\nLOG_LEVEL=DEBUG\n`), env });
  assert.deepEqual(env, snapshot);
  assert.equal(JSON.stringify(process.env), before);
});

test('checkSkill reports missing, current and stale copies', () => {
  const inspectWith = (states) => ({ agent }) => ({ agent, path: `${agent}/skill`, state: states[agent] });

  const none = checkSkill({ inspect: inspectWith({ claude: 'missing', codex: 'missing' }) });
  assert.equal(none.status, 'warn');
  assert.match(none.fix, /--agent claude/);
  assert.match(en(none.detail), /--agent codex/);

  const one = checkSkill({ inspect: inspectWith({ claude: 'current', codex: 'missing' }) });
  assert.equal(one.status, 'ok');
  assert.equal(one.detail, 'claude/skill');

  const stale = checkSkill({ inspect: inspectWith({ claude: 'current', codex: 'stale' }) });
  assert.equal(stale.status, 'warn');
  assert.match(en(stale.message), /codex\/skill/);
  assert.match(stale.fix, /--agent codex/);

  const foreign = checkSkill({ inspect: inspectWith({ claude: 'foreign', codex: 'current' }) });
  assert.equal(foreign.status, 'warn');
  assert.equal(foreign.message.key, 'doctor.skill.foreign');
});

/** Корень с package.json и установленным playwright-core нужной версии. */
function makeRepo(t) {
  const root = tempDir(t, 'doctor-repo-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'playwright-core': '1.63.0' } }));
  const pkg = join(root, 'node_modules', 'playwright-core');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '1.63.0' }));
  return root;
}

const currentSkill = ({ agent }) => ({ agent, path: `${agent}/skill`, state: 'current' });
const CHROME_PATH = '/opt/google/chrome/chrome';

test('runDoctor: a single fail makes the report fail, warnings do not', async (t) => {
  const root = makeRepo(t);
  const base = {
    env: {},
    cwd: root,
    platform: 'linux',
    root,
    nodeVersion: '24.17.0',
    run: () => ({ status: 0, stdout: 'git version 2.53.0' }),
    inspect: currentSkill,
  };
  const withChrome = (path) => path === CHROME_PATH || existsSync(path);

  const good = await runDoctor({ ...base, exists: withChrome });
  assert.equal(good.status, 'ok');
  assert.deepEqual(good.checks.map((check) => check.id), ['node', 'dependencies', 'chrome', 'git', 'repo-env', 'site', 'skill']);
  assert.equal(good.checks.find((check) => check.id === 'site').status, 'skip');

  const noChrome = await runDoctor({ ...base, exists: (path) => path !== CHROME_PATH && existsSync(path) });
  assert.equal(noChrome.status, 'fail');
  assert.equal(noChrome.checks.find((check) => check.id === 'chrome').status, 'fail');

  const onlyWarnings = await runDoctor({
    ...base,
    exists: withChrome,
    run: () => ({ error: new Error('ENOENT') }),
    inspect: ({ agent }) => ({ agent, path: `${agent}/skill`, state: 'missing' }),
  });
  assert.equal(onlyWarnings.status, 'ok');
  assert.deepEqual(onlyWarnings.checks.filter((check) => check.status === 'warn').map((check) => check.id), ['git', 'skill']);
});

test('runDoctor: an old Node skips every other check', async () => {
  const report = await runDoctor({ nodeVersion: '22.11.0', platform: 'linux' });
  assert.equal(report.status, 'fail');
  assert.equal(report.checks.length, 7);
  assert.deepEqual(report.checks.slice(1).map((check) => check.status), Array(6).fill('skip'));
});

const SAMPLE_REPORT = {
  status: 'fail',
  checks: [
    { id: 'node', status: 'ok', message: msg('doctor.node.ok', { min: 24 }), detail: 'v24.17.0' },
    { id: 'chrome', status: 'fail', message: msg('doctor.chrome.missing'), fix: 'winget install --id Google.Chrome -e' },
  ],
};

test('formatReport prints a summary line and an arrow line for checks with a fix', () => {
  const lines = formatReport(SAMPLE_REPORT, 'en').split('\n');
  assert.equal(lines[0], 'ok    node          Node.js 24 or newer (v24.17.0)');
  assert.equal(lines[1], 'FAIL  chrome        Google Chrome not found');
  assert.equal(lines[2], '      → winget install --id Google.Chrome -e');
  assert.equal(lines.at(-1), 'result: failures: 1');
  assert.equal(formatReport({ status: 'ok', checks: [] }, 'en'), 'result: ok');
});

test('formatReport translates the same report into Russian', () => {
  const lines = formatReport(SAMPLE_REPORT, 'ru').split('\n');
  assert.equal(lines[0], 'ok    node          Node.js 24 или новее (v24.17.0)');
  assert.equal(lines[1], 'FAIL  chrome        Google Chrome не найден');
  assert.equal(lines.at(-1), 'итог: провалов: 1');
});

test('formatReport takes English by default and passes plain strings through', () => {
  const plain = { status: 'ok', checks: [{ id: 'node', status: 'ok', message: 'already a string' }] };
  assert.equal(formatReport(plain).split('\n')[0], 'ok    node          already a string');
});

test('renderReport keeps ids and statuses, adds the message key and renders errors by their key', () => {
  const error = Object.assign(new Error('site folder not found: /x'), { key: 'site.notFound', params: { dir: '/x' } });
  const report = {
    status: 'fail',
    checks: [{ id: 'site', status: 'fail', message: error, fix: msg('doctor.site.fixOneDir') }, SAMPLE_REPORT.checks[0]],
  };
  const en1 = renderReport(report, 'en');
  assert.deepEqual(en1.checks.map((c) => [c.id, c.status, c.key]), [['site', 'fail', 'site.notFound'], ['node', 'ok', 'doctor.node.ok']]);
  assert.equal(en1.checks[0].message, 'site folder not found: /x');
  const ru1 = renderReport(report, 'ru');
  assert.equal(ru1.checks[0].message, 'папка сайта не найдена: /x');
  assert.equal(ru1.checks[1].detail, 'v24.17.0');
  assert.equal(ru1.checks[0].key, en1.checks[0].key);
});

test('parseDoctorArgs accepts --site, --site=, --json and rejects the rest', () => {
  assert.deepEqual(parseDoctorArgs(['--site', 'x', '--json']), { site: 'x', json: true, help: false });
  assert.equal(parseDoctorArgs(['--site=x']).site, 'x');
  assert.equal(parseDoctorArgs(['-h']).help, true);
  for (const argv of [['--bogus'], ['--site'], ['--site='], ['extra']]) {
    assert.throws(() => parseDoctorArgs(argv), (error) => error instanceof DoctorUsageError && error.exitCode === 2, argv.join(' '));
  }
});

test('parseDoctorArgs accepts --lang and refuses other languages', () => {
  assert.equal(parseDoctorArgs(['--lang', 'ru']).lang, 'ru');
  assert.equal(parseDoctorArgs(['--lang=EN']).lang, 'en');
  assert.throws(() => parseDoctorArgs(['--lang=de']), (error) => error instanceof DoctorUsageError && error.key === 'i18n.badFlag');
  assert.throws(() => parseDoctorArgs(['--lang']), (error) => error.key === 'doctor.args.langValue');
});
