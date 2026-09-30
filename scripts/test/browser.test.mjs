import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import {
  BrowserError, LOGIN_HINTS, buildCallExpression, call, isRetryable, isSessionLost, layerErrorCode, retryDelayMs, sessionLostMessage,
  projectSettingsUrl, editorUrl, profileDir, sessionProject, setDaemonWindow, stripCookies, wrapLayer,
  openProject, openProjectSettings,
} from '../lib/browser.mjs';
import { ConfigError } from '../lib/config.mjs';
import { messageText, msg } from '../lib/i18n.mjs';
import { repoRoot } from '../lib/paths.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

test('browser hide without a running holder reports nothing to hide and starts no browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-hide-'));
  try {
    assert.equal(await setDaemonWindow('minimized', { profileDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser transport helpers classify session loss, retries, arguments, and cookies', () => {
  assert.equal(isSessionLost({ url: 'https://tilda.cc/login/' }), true);
  assert.equal(isSessionLost({ body: '<!doctype html>' }), true);
  assert.equal(isSessionLost({ body: '{"ok":true}' }), false);
  assert.equal(isRetryable(new BrowserError('SESSION_LOST', 'missing session')), false);
  assert.equal(isRetryable(new Error('PROTECTED_PAGE 200001')), false);
  assert.equal(isRetryable(new Error('net::ERR_CONNECTION_RESET')), true);
  assert.deepEqual([retryDelayMs(1), retryDelayMs(2), retryDelayMs(10)], [1000, 2000, 15000]);
  assert.equal(buildCallExpression('getZero', ['200002', '7001']), 'async () => window.__tilda.getZero("200002", "7001")');
  assert.throws(() => buildCallExpression('get.zero'), TypeError);
  assert.deepEqual(stripCookies({ headers: { Cookie: 'PHPSESSID=secret', keep: 'yes' } }), { headers: { keep: 'yes' } });
});

test('projectSettingsUrl opens the header and footer tab of the configured project', () => {
  const saved = process.env.TILDA_PROJECT_ID;
  process.env.TILDA_PROJECT_ID = '100001';
  try {
    assert.equal(projectSettingsUrl('100001'), 'https://tilda.ru/projects/settings/?projectid=100001#tab=ss_menu_header');
  } finally {
    if (saved === undefined) delete process.env.TILDA_PROJECT_ID;
    else process.env.TILDA_PROJECT_ID = saved;
  }
});

test('project layer refuses page roles without confirmation and fingerprints settings', async () => {
  const source = readFileSync(new URL('../browser/tilda-project.js', import.meta.url), 'utf8');
  let clicks = 0;
  const select = (value, options) => ({ value, options: options.map((v) => ({ value: v })), dispatchEvent() {} });
  const controls = { headerpageid: select('', ['', '100002']), footerpageid: select('', ['', '100002', '100003']) };
  const context = {
    window: { __tilda: {}, projectid: '100001' },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URLSearchParams,
    TextEncoder,
    crypto: globalThis.crypto,
    Event: class { constructor(type) { this.type = type; } },
    fetch: async () => ({ status: 200, text: async () => JSON.stringify({ csrf: 'secret', project: { sitename: 'Сайт', headerpageid: '', footerpageid: '100003', cfg: { a: 1 } } }) }),
    document: {
      getElementById: (id) => controls[id] ?? null,
      querySelectorAll: () => [{ textContent: 'Сохранить изменения', offsetWidth: 10, click() { clicks += 1; } }],
    },
  };
  vm.runInNewContext(wrapLayer(source), context);
  const api = context.window.__tilda;
  const s = await api.readProjectSettings();
  assert.equal(s.count, 4);
  assert.equal(s.footerpageid, '100003');
  assert.match(s.fingerprints.sitename, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(s).includes('Сайт') && !JSON.stringify(s).includes('secret'), 'значения настроек не выходят из слоя');
  assert.deepEqual([...s.headerOptions], ['', '100002']);
  await assert.rejects(() => api.setPageRoles({ headerpageid: '100002' }), /ROLE_NOT_CONFIRMED/);
  await assert.rejects(() => api.setPageRoles({ headerpageid: '100009', confirm: api.ROLE_CONFIRM }), /NOT_IN_OPTIONS/);
  assert.equal(clicks, 0);
  assert.equal(controls.headerpageid.value, '');
  await api.setPageRoles({ headerpageid: '100002', confirm: api.ROLE_CONFIRM });
  assert.equal(controls.headerpageid.value, '100002');
  assert.equal(clicks, 1);
});

test('browser page layer refuses protected or unconfigured writes before fetch', async () => {
  const source = readFileSync(new URL('../browser/tilda-page.js', import.meta.url), 'utf8');
  let fetches = 0;
  const context = {
    window: { __tilda: {} },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URLSearchParams,
    fetch: async () => { fetches += 1; return { status: 200, text: async () => 'OK' }; },
    document: { createElement: () => ({}) },
  };
  vm.runInNewContext(wrapLayer(source), context);
  const api = context.window.__tilda;
  await assert.rejects(() => api.saveField('200002', '7001', 'title', 'Changed'), /CONFIG_ERROR/);
  api.protectedPages = ['200001'];
  await assert.rejects(() => api.saveField('200001', '7001', 'title', 'Changed'), /PROTECTED_PAGE/);
  assert.equal(fetches, 0);
  await api.saveField('200002', '7001', 'title', 'Changed');
  assert.equal(fetches, 1);
});

function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('donor role builds addresses and profile from its own variables and never from the test ones', () => {
  const donorProfile = join(tmpdir(), 'donor-profile');
  withEnv({ TILDA_PROJECT_ID: '100001', TILDA_DONOR_PROJECT_ID: '100002', TILDA_DONOR_BROWSER_PROFILE: donorProfile }, () => {
    assert.match(editorUrl('200002', undefined, 'donor'), /projectid=100002$/);
    assert.match(editorUrl('200002'), /projectid=100001$/);
    assert.throws(() => editorUrl('200002', '100001', 'donor'), ConfigError);
    assert.equal(profileDir('donor'), resolve(donorProfile));
    assert.throws(() => profileDir('other'), ConfigError);
  });
  withEnv({ TILDA_DONOR_BROWSER_PROFILE: join(repoRoot(), '.browser-profile-donor') }, () => {
    assert.throws(() => profileDir('donor'), (e) => e instanceof ConfigError && e.variable === 'TILDA_DONOR_BROWSER_PROFILE');
  });
  withEnv({ TILDA_DONOR_BROWSER_PROFILE: undefined }, () => {
    assert.throws(() => profileDir('donor'), ConfigError);
  });
  assert.equal(isRetryable(new Error('WRITE_NOT_ALLOWED 200002')), false);
  assert.equal(sessionProject('test', {}), null);
  assert.equal(sessionProject('test', { TILDA_PROJECT_ID: '100001' }), '100001');
  assert.equal(sessionProject('donor', { TILDA_DONOR_PROJECT_ID: '100002' }), '100002');
  assert.throws(() => sessionProject('donor', { TILDA_DONOR_PROJECT_ID: 'x' }), ConfigError);
});

test('test profile comes from TILDA_BROWSER_PROFILE or the site folder and never from the repo root', () => {
  const site = mkdtempSync(join(tmpdir(), 'tilda-profile-'));
  try {
    withEnv({ TILDA_BROWSER_PROFILE: undefined, TILDA_SITE_DIR: undefined }, () => {
      assert.throws(() => profileDir('test'), ConfigError);
    });
    withEnv({ TILDA_BROWSER_PROFILE: undefined, TILDA_SITE_DIR: site }, () => {
      assert.equal(profileDir('test'), join(resolve(site), '.browser-profile'));
    });
    withEnv({ TILDA_BROWSER_PROFILE: join(repoRoot(), '.browser-profile'), TILDA_SITE_DIR: site }, () => {
      assert.throws(() => profileDir('test'), (e) => e instanceof ConfigError && e.variable === 'TILDA_BROWSER_PROFILE');
    });
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('browser hide for the donor holder without a running holder starts no browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-donor-hide-'));
  try {
    const result = await withEnv({ TILDA_DONOR_BROWSER_PROFILE: dir }, () => setDaemonWindow('minimized', { role: 'donor' }));
    assert.equal(result, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('page and zero layers refuse writes outside the allow-list before fetch', async () => {
  let fetches = 0;
  const context = {
    window: { __tilda: {} },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URLSearchParams,
    fetch: async () => { fetches += 1; return { status: 200, text: async () => 'OK' }; },
    document: { createElement: () => ({}), querySelectorAll: () => [] },
  };
  vm.runInNewContext(wrapLayer(readFileSync(new URL('../browser/tilda-zero.js', import.meta.url), 'utf8')), context);
  vm.runInNewContext(wrapLayer(readFileSync(new URL('../browser/tilda-page.js', import.meta.url), 'utf8')), context);
  const api = context.window.__tilda;
  assert.equal(api.writablePages, null);
  api.protectedPages = ['200001'];
  api.writablePages = [];
  assert.throws(() => api.assertWritable('200002', 'x'), /WRITE_NOT_ALLOWED 200002/);
  await assert.rejects(() => api.saveField('200002', '7001', 'title', 'Changed'), /WRITE_NOT_ALLOWED/);
  await assert.rejects(() => api.saveZero('200002', '7001', { 1: { elem_id: 'e1' } }), /WRITE_NOT_ALLOWED/);
  assert.equal(fetches, 0);
  api.writablePages = ['200002', '200001'];
  assert.doesNotThrow(() => api.assertWritable('200002', 'x'));
  assert.throws(() => api.assertWritable('200001', 'x'), /PROTECTED_PAGE/, 'защищённая страница побеждает allow-список');
  await api.saveField('200002', '7001', 'title', 'Changed');
  assert.equal(fetches, 1);
});

test('project layer refuses every project-level write in a session with an allow-list', async () => {
  const source = readFileSync(new URL('../browser/tilda-project.js', import.meta.url), 'utf8');
  let fetches = 0;
  const context = {
    window: { __tilda: {}, projectid: '100001' },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URLSearchParams,
    getCSRF: () => 'secret',
    fetch: async () => { fetches += 1; return { status: 200, text: async () => 'OK' }; },
    document: { getElementById: () => null, querySelectorAll: () => [] },
  };
  vm.runInNewContext(wrapLayer(source), context);
  const api = context.window.__tilda;
  api.writablePages = [];
  await assert.rejects(() => api.createPage('100001'), /WRITE_NOT_ALLOWED project \(createPage\)/);
  await assert.rejects(() => api.duplicatePage('200002'), /WRITE_NOT_ALLOWED project/);
  await assert.rejects(() => api.publishPage('200002', api.PUBLISH_CONFIRM), /WRITE_NOT_ALLOWED project/);
  await assert.rejects(() => api.setPageRoles({ headerpageid: '200002', confirm: api.ROLE_CONFIRM }), /WRITE_NOT_ALLOWED project/);
  assert.throws(() => api.clickSaveSettings(), /WRITE_NOT_ALLOWED project/);
  assert.equal(fetches, 0);
  api.writablePages = null;
  await api.createPage('100001');
  assert.equal(fetches, 1);
});

/** Сессия, чья страница после перехода оказывается на странице входа Тильды. */
const lostSession = (role) => {
  let current = 'about:blank';
  return { role, layers: new Set(), page: { goto: async (u) => { current = /^https:/.test(u) ? 'https://tilda.ru/login/' : u; }, url: () => current } };
};

test('a lost donor session names the donor holder login, a lost test session does not', async () => {
  const saved = { t: process.env.TILDA_PROJECT_ID, d: process.env.TILDA_DONOR_PROJECT_ID };
  process.env.TILDA_PROJECT_ID = '100001';
  process.env.TILDA_DONOR_PROJECT_ID = '100002';
  try {
    for (const open of [openProject, openProjectSettings]) {
      await assert.rejects(open(lostSession('donor')), (e) => e.code === 'SESSION_LOST' && /session --donor/.test(e.message), `${open.name}: донор`);
      await assert.rejects(open(lostSession('test')), (e) => e.code === 'SESSION_LOST' && !/--donor/.test(e.message) && /session/.test(e.message), `${open.name}: тестовый`);
    }
  } finally {
    for (const [k, v] of [['TILDA_PROJECT_ID', saved.t], ['TILDA_DONOR_PROJECT_ID', saved.d]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('layerErrorCode takes the layer code from the start of a page error', () => {
  assert.deepEqual(layerErrorCode('SAVE_FAILED: x'), { code: 'SAVE_FAILED', detail: 'x' });
  assert.deepEqual(layerErrorCode('page.evaluate: Error: SESSION_LOST without data'), { code: 'SESSION_LOST', detail: 'without data' });
  assert.deepEqual(layerErrorCode('WRONG_PAGE_SETTINGS 123 instead of 456'), { code: 'WRONG_PAGE_SETTINGS', detail: '123 instead of 456' });
  assert.deepEqual(layerErrorCode('NO_API'), { code: 'NO_API', detail: '' });
  assert.equal(layerErrorCode('plain text'), null);
  assert.equal(layerErrorCode('Error: ab'), null);
});

test('layerErrorCode drops the Playwright stack from the detail', () => {
  const parsed = layerErrorCode('page.evaluate: Error: SAVE_FAILED: no response\n    at eval (eval at evaluate)\n    at <anonymous>:3:1');
  assert.deepEqual(parsed, { code: 'SAVE_FAILED', detail: 'no response' });
});

test('BrowserError takes a Message: English text in message, key and params next to it', () => {
  const error = new BrowserError('CALL_FAILED', msg('browser.lib.wrongProject', { onPage: '100002', wanted: '100001' }));
  assert.equal(error.code, 'CALL_FAILED');
  assert.equal(error.key, 'browser.lib.wrongProject');
  assert.equal(error.message, 'project 100002 is open instead of 100001');
  assert.equal(new BrowserError('TIMEOUT', 'plain').key, undefined);
});

test('session lost message names the holder to sign in to, by role', () => {
  assert.match(messageText(sessionLostMessage('donor')), /session --donor/);
  assert.match(messageText(sessionLostMessage()), /test holder: session/);
  assert.equal(sessionLostMessage('donor').key, 'browser.lib.sessionLostRole');
  assert.equal(LOGIN_HINTS.test.key, 'browser.lib.loginHintTest');
});

/** Страница-заглушка: evaluate бросает заданную ошибку, url — обычная страница проекта. */
const failingPage = (message) => ({ url: () => 'https://tilda.cc/projects/', evaluate: async () => { throw new Error(message); } });

test('call: a layer error becomes CALL_FAILED with the layer code key and layerCode in data', async () => {
  const error = await call(failingPage('page.evaluate: Error: SAVE_FAILED: no response from the server'), 'saveField', [], { attempts: 1 })
    .then(() => null, (e) => e);
  assert.ok(error instanceof BrowserError);
  assert.equal(error.code, 'CALL_FAILED');
  assert.equal(error.key, 'browser.code.SAVE_FAILED');
  assert.deepEqual(error.params, { fn: 'saveField', detail: 'no response from the server' });
  assert.equal(error.data.layerCode, 'SAVE_FAILED');
  assert.match(error.message, /^SAVE_FAILED in saveField: /);
});

test('call: an error without a known layer code gets the general text', async () => {
  const unknown = await call(failingPage('page.evaluate: Error: WEIRD_CODE: x'), 'f', [], { attempts: 1 }).then(() => null, (e) => e);
  assert.equal(unknown.key, 'browser.lib.callFailed');
  const plain = await call(failingPage('boom'), 'f', [], { attempts: 1 }).then(() => null, (e) => e);
  assert.equal(plain.key, 'browser.lib.callFailed');
  assert.equal(plain.message, 'f: boom');
});

test('call: a lost session keeps the SESSION_LOST code and its own message key', async () => {
  const error = await call(failingPage('SESSION_LOST: login page'), 'f', [], { attempts: 1 }).then(() => null, (e) => e);
  assert.equal(error.code, 'SESSION_LOST');
  assert.equal(error.key, 'browser.lib.sessionLost');
});
