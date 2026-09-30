import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../lib/config.mjs';
import { SkillInstallError } from '../lib/skill-install.mjs';
import { SetupError, planEnvUpdate, planLangUpdate, prepareSite, renderSiteEnv, runSetup, writeSite } from '../setup.mjs';

const TEMPLATE = [
  '# comment TILDA_PROJECT_ID=1',
  'TILDA_PROJECT_ID=100001',
  'TILDA_PROTECTED_PAGES=200001',
  'TILDA_DEFAULT_PAGE=200001',
  '# TILDA_DONOR_PROJECT_ID=100002',
  'TILDA_SITE_DIR=./x',
  'LOG_LEVEL=INFO',
  'TILDA_LANG=',
  '',
].join('\n');

function tempDir(t, prefix = 'setup-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('renderSiteEnv sets the project id, clears identity keys and drops TILDA_SITE_DIR', () => {
  const text = renderSiteEnv(TEMPLATE, { projectId: '1000000000001' });
  assert.equal(text, [
    '# comment TILDA_PROJECT_ID=1',
    'TILDA_PROJECT_ID=1000000000001',
    'TILDA_PROTECTED_PAGES=',
    'TILDA_DEFAULT_PAGE=',
    '# TILDA_DONOR_PROJECT_ID=100002',
    'LOG_LEVEL=INFO',
    'TILDA_LANG=',
    '',
  ].join('\n'));
});

test('renderSiteEnv leaves the project id empty without a flag', () => {
  assert.match(renderSiteEnv(TEMPLATE), /^TILDA_PROJECT_ID=$/m);
});

test('renderSiteEnv appends the keys a template lacks and ends with one newline', () => {
  const text = renderSiteEnv('# only a comment\n\n\n');
  assert.equal(text, '# only a comment\nTILDA_PROJECT_ID=\nTILDA_PROTECTED_PAGES=\nTILDA_LANG=\n');
});

test('renderSiteEnv writes the language into TILDA_LANG, replacing the template line or adding one', () => {
  assert.match(renderSiteEnv(TEMPLATE, { lang: 'ru' }), /^TILDA_LANG=ru$/m);
  assert.equal(renderSiteEnv(TEMPLATE, { lang: 'ru' }).match(/TILDA_LANG/g).length, 1);
  const without = renderSiteEnv('LOG_LEVEL=INFO\n', { lang: 'en' });
  assert.equal(without, 'LOG_LEVEL=INFO\nTILDA_PROJECT_ID=\nTILDA_PROTECTED_PAGES=\nTILDA_LANG=en\n');
});

test('renderSiteEnv keeps CRLF line endings without mixing', () => {
  const text = renderSiteEnv(TEMPLATE.replace(/\n/g, '\r\n'), { projectId: '1000000000001' });
  assert.ok(text.endsWith('TILDA_LANG=\r\n'));
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /[\r\n]/, 'все переводы строки должны быть CRLF');
});

test('planEnvUpdate covers kept, unchanged, filled and conflict', () => {
  assert.deepEqual(planEnvUpdate('TILDA_PROJECT_ID=1000000000001\n'), { action: 'kept' });
  assert.deepEqual(planEnvUpdate('TILDA_PROJECT_ID=1000000000001\n', { projectId: '1000000000001' }), { action: 'unchanged' });

  const empty = planEnvUpdate('LOG_LEVEL=INFO\nTILDA_PROJECT_ID=\nTILDA_PROTECTED_PAGES=\n', { projectId: '1000000000001' });
  assert.equal(empty.action, 'filled');
  assert.equal(empty.text, 'LOG_LEVEL=INFO\nTILDA_PROJECT_ID=1000000000001\nTILDA_PROTECTED_PAGES=\n');

  const absent = planEnvUpdate('LOG_LEVEL=INFO\r\n', { projectId: '1000000000001' });
  assert.equal(absent.action, 'filled');
  assert.equal(absent.text, 'LOG_LEVEL=INFO\r\nTILDA_PROJECT_ID=1000000000001\r\n');

  assert.deepEqual(
    planEnvUpdate('TILDA_PROJECT_ID=1000000000001\n', { projectId: '1000000000002' }),
    { action: 'conflict', current: '1000000000001' },
  );
});

test('planLangUpdate covers kept, unchanged, filled, added and replaced without ever refusing', () => {
  assert.deepEqual(planLangUpdate('TILDA_LANG=ru\n'), { action: 'kept' });
  assert.deepEqual(planLangUpdate('TILDA_LANG=ru\n', { lang: 'ru' }), { action: 'unchanged' });

  const filled = planLangUpdate('LOG_LEVEL=INFO\nTILDA_LANG=\n', { lang: 'en' });
  assert.equal(filled.action, 'filled');
  assert.equal(filled.text, 'LOG_LEVEL=INFO\nTILDA_LANG=en\n');

  const added = planLangUpdate('LOG_LEVEL=INFO\r\n# TILDA_LANG=ru\r\n', { lang: 'ru' });
  assert.equal(added.action, 'added');
  assert.equal(added.text, 'LOG_LEVEL=INFO\r\n# TILDA_LANG=ru\r\nTILDA_LANG=ru\r\n');

  const replaced = planLangUpdate('TILDA_LANG=en\nLOG_LEVEL=INFO\n', { lang: 'ru' });
  assert.equal(replaced.action, 'replaced');
  assert.equal(replaced.previous, 'en');
  assert.equal(replaced.text, 'TILDA_LANG=ru\nLOG_LEVEL=INFO\n');
});

test('prepareSite refuses folders inside the repository and files', (t) => {
  const root = tempDir(t, 'setup-repo-');
  const outside = tempDir(t, 'setup-out-');

  mkdirSync(join(root, 'data'));
  assert.throws(() => prepareSite({ siteArg: join(root, 'data'), root }), ConfigError);
  assert.throws(() => prepareSite({ siteArg: join(root, '..data'), root }), ConfigError);

  const link = join(outside, 'site');
  symlinkSync(join(root, 'data'), link, 'junction');
  assert.throws(() => prepareSite({ siteArg: link, root }), ConfigError);

  const file = join(outside, 'file.txt');
  writeFileSync(file, 'x');
  assert.throws(() => prepareSite({ siteArg: file, root }), SetupError);

  const fresh = prepareSite({ siteArg: join(outside, 'new-site'), root });
  assert.equal(fresh.exists, false);
  assert.equal(fresh.envExists, false);
});

/** Временный корень репозитория: скилл, шаблон `.env` и файл, на который скилл ссылается. */
function makeRoot(t) {
  const root = tempDir(t, 'setup-repo-');
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('skills/tilda-manager/SKILL.md', '[a](../../docs/cli.md)\n');
  put('docs/cli.md', '# cli\n');
  put('.env.example', TEMPLATE);
  return root;
}

test('writeSite creates the folder and .env, then keeps them and fills an empty project id', (t) => {
  const root = makeRoot(t);
  const dir = join(tempDir(t, 'setup-out-'), 'site');

  assert.deepEqual(writeSite({ dir, projectId: '1000000000001', root }), { dir, folder: 'created', env: 'created' });
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TILDA_PROJECT_ID=1000000000001$/m);
  assert.deepEqual(writeSite({ dir, root }), { dir, folder: 'existing', env: 'kept' });

  writeFileSync(join(dir, '.env'), 'TILDA_PROJECT_ID=\nTILDA_PROTECTED_PAGES=\n');
  assert.equal(writeSite({ dir, projectId: '1000000000001', root }).env, 'filled');
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TILDA_PROJECT_ID=1000000000001$/m);
});

test('runSetup creates the site and both skill copies, and a repeat changes nothing', async (t) => {
  const root = makeRoot(t);
  const dir = join(tempDir(t, 'setup-out-'), 'site');
  const args = { site: dir, project: '1000000000001', agent: 'all', env: {}, cwd: root, root };

  const first = await runSetup(args);
  assert.equal(first.status.key, 'setup.status.done');
  assert.deepEqual(first.site, { dir, folder: 'created', env: 'created' });
  assert.deepEqual(first.skills.map((s) => s.action), ['installed', 'installed']);
  assert.match(first.next, /doctor/);
  assert.ok(first.note);
  assert.equal(existsSync(join(root, '.claude', 'skills', 'tilda-manager', 'SKILL.md')), true);
  assert.equal(existsSync(join(root, '.agents', 'skills', 'tilda-manager', 'SKILL.md')), true);

  const second = await runSetup(args);
  assert.equal(second.site.env, 'unchanged');
  assert.deepEqual(second.skills.map((s) => s.action), ['unchanged', 'unchanged']);
});

test('runSetup --lang writes TILDA_LANG into a new .env and replaces another language later without refusing', async (t) => {
  const root = makeRoot(t);
  const dir = join(tempDir(t, 'setup-out-'), 'site');
  const args = { site: dir, project: '1000000000001', env: {}, cwd: root, root };

  const first = await runSetup({ ...args, lang: 'ru' });
  assert.deepEqual(first.site.lang, { action: 'filled', value: 'ru' });
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TILDA_LANG=ru$/m);

  const same = await runSetup({ ...args, lang: 'ru' });
  assert.deepEqual(same.site.lang, { action: 'unchanged', value: 'ru' });

  const second = await runSetup({ ...args, lang: 'en' });
  assert.deepEqual(second.site.lang, { action: 'replaced', value: 'en', previous: 'ru' });
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TILDA_LANG=en$/m);

  const kept = await runSetup(args);
  assert.equal(kept.site.lang, undefined);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TILDA_LANG=en$/m);
});

test('runSetup --lang without --site writes no files and refuses other languages', async (t) => {
  const root = makeRoot(t);
  const result = await runSetup({ agent: 'claude', lang: 'ru', env: {}, cwd: root, root });
  assert.equal(result.site, undefined);
  await assert.rejects(runSetup({ agent: 'claude', lang: 'de', env: {}, cwd: root, root }), (error) => error instanceof ConfigError && error.key === 'i18n.badFlag');
});

test('runSetup refuses a different project id and leaves .env untouched', async (t) => {
  const root = makeRoot(t);
  const dir = join(tempDir(t, 'setup-out-'), 'site');
  await runSetup({ site: dir, project: '1000000000001', env: {}, cwd: root, root });
  const before = readFileSync(join(dir, '.env'), 'utf8');

  await assert.rejects(
    runSetup({ site: dir, project: '1000000000002', env: {}, cwd: root, root }),
    (error) => error instanceof SetupError && error.exitCode === 1,
  );
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), before);
});

test('runSetup refuses before any write when a skill target is foreign', async (t) => {
  const root = makeRoot(t);
  const foreign = join(root, '.claude', 'skills', 'tilda-manager');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'mine.txt'), 'mine');
  const dir = join(tempDir(t, 'setup-out-'), 'site');

  await assert.rejects(
    runSetup({ site: dir, project: '1000000000001', agent: 'all', env: {}, cwd: root, root }),
    (error) => error instanceof SkillInstallError && error.code === 'SKILL_TARGET_FOREIGN',
  );
  assert.equal(existsSync(dir), false, 'папка сайта не должна появиться');
  assert.equal(existsSync(join(root, '.agents')), false);
});

test('runSetup rejects TILDA_SITE_DIR that points elsewhere and ignores TILDA_PROJECT_ID from the environment', async (t) => {
  const root = makeRoot(t);
  const out = tempDir(t, 'setup-out-');
  const dir = join(out, 'site');

  await assert.rejects(
    runSetup({ site: dir, env: { TILDA_SITE_DIR: join(out, 'other') }, cwd: root, root }),
    (error) => error instanceof ConfigError && error.exitCode === 2,
  );
  assert.equal(existsSync(dir), false);

  await runSetup({ site: dir, env: { TILDA_PROJECT_ID: '1000000000009' }, cwd: root, root });
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^TILDA_PROJECT_ID=$/m);
});

test('runSetup validates its own arguments', async (t) => {
  const root = makeRoot(t);
  const base = { env: {}, cwd: root, root };
  await assert.rejects(runSetup({ ...base }), ConfigError);
  await assert.rejects(runSetup({ ...base, project: '1000000000001', agent: 'claude' }), ConfigError);
  await assert.rejects(runSetup({ ...base, agent: 'vim' }), ConfigError);
  await assert.rejects(runSetup({ ...base, site: join(tempDir(t, 'setup-out-'), 's'), project: 'abc' }), ConfigError);
});
