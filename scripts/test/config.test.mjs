import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError, parseNumericId, getProjectId, getDefaultPage, getProtectedPages, resolveProjectId,
  requireOnlineConfig, PROJECT_ROLES, assertRole, getProjectIdFor, resolveProjectIdFor,
  getDonorProfile, requireDonorConfig,
} from '../lib/config.mjs';

const configured = {
  TILDA_PROJECT_ID: '100001',
  TILDA_DEFAULT_PAGE: '200002',
  TILDA_PROTECTED_PAGES: '200001, 200003',
};

function configError(fn) {
  assert.throws(fn, (error) => error instanceof ConfigError
    && error.code === 'CONFIG_ERROR' && error.exitCode === 2);
}

test('configuration accepts explicit synthetic ids and an explicitly empty protection list', () => {
  assert.equal(parseNumericId('100001', 'TILDA_PROJECT_ID'), '100001');
  assert.equal(getProjectId(configured), '100001');
  assert.equal(getDefaultPage(configured), '200002');
  assert.deepEqual(getProtectedPages(configured), ['200001', '200003']);
  assert.deepEqual(getProtectedPages({ ...configured, TILDA_PROTECTED_PAGES: '' }), []);
  assert.deepEqual(requireOnlineConfig({ env: configured, requireDefaultPage: true }), {
    projectId: '100001', defaultPage: '200002', protectedPages: ['200001', '200003'],
  });
});

test('configuration refuses missing and malformed online settings without a live site', () => {
  configError(() => getProjectId({ TILDA_PROTECTED_PAGES: '' }));
  configError(() => getProjectId({ ...configured, TILDA_PROJECT_ID: 'project-a' }));
  configError(() => getDefaultPage({ ...configured, TILDA_DEFAULT_PAGE: 'page-a' }));
  assert.equal(getDefaultPage({ TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '' }), undefined);
  configError(() => getProtectedPages({ TILDA_PROJECT_ID: '100001' }));
  configError(() => getProtectedPages({ ...configured, TILDA_PROTECTED_PAGES: '200001, no-id' }));
  configError(() => requireOnlineConfig({ env: { TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '' }, requireDefaultPage: true }));
});

test('project override cannot silently select another project than the configured one', () => {
  assert.equal(resolveProjectId('100001', configured), '100001');
  configError(() => resolveProjectId('100002', configured));
});

test('project roles read their own variables and refuse unknown roles', () => {
  assert.deepEqual(Object.keys(PROJECT_ROLES), ['test', 'donor']);
  assert.equal(assertRole('donor'), 'donor');
  configError(() => assertRole('other'));
  assert.equal(getProjectIdFor('test', configured), '100001');
  assert.equal(getProjectIdFor('donor', { TILDA_DONOR_PROJECT_ID: '100002' }), '100002');
  configError(() => getProjectIdFor('donor', configured));
});

test('project override is checked against the variable of the requested role', () => {
  const env = { ...configured, TILDA_DONOR_PROJECT_ID: '100002' };
  assert.equal(resolveProjectIdFor('donor', '100002', env), '100002');
  assert.equal(resolveProjectIdFor('donor', undefined, env), '100002');
  assert.equal(resolveProjectIdFor('test', '100001', env), '100001');
  assert.throws(() => resolveProjectIdFor('donor', '100001', env), (error) => error instanceof ConfigError
    && error.variable === 'TILDA_DONOR_PROJECT_ID' && /TILDA_DONOR_PROJECT_ID/.test(error.message));
});

test('donor configuration requires id and profile and never equals the test project', () => {
  assert.deepEqual(
    requireDonorConfig({ env: { TILDA_DONOR_PROJECT_ID: '100002', TILDA_DONOR_BROWSER_PROFILE: 'C:/tmp/donor' } }),
    { donorProjectId: '100002', donorProfile: 'C:/tmp/donor' },
  );
  assert.equal(getDonorProfile({ TILDA_DONOR_BROWSER_PROFILE: '  C:/tmp/donor ' }), 'C:/tmp/donor');
  assert.throws(() => getDonorProfile({}), (error) => error instanceof ConfigError
    && error.variable === 'TILDA_DONOR_BROWSER_PROFILE');
  assert.throws(() => requireDonorConfig({ env: { TILDA_DONOR_PROJECT_ID: '100002' } }), (error) => error instanceof ConfigError
    && error.variable === 'TILDA_DONOR_BROWSER_PROFILE');
  configError(() => requireDonorConfig({ env: {
    TILDA_PROJECT_ID: '100001', TILDA_DONOR_PROJECT_ID: '100001', TILDA_DONOR_BROWSER_PROFILE: 'C:/tmp/donor',
  } }));
});

test('donor configuration with the test project needs online settings and a different profile', () => {
  const env = { ...configured, TILDA_DONOR_PROJECT_ID: '100002', TILDA_DONOR_BROWSER_PROFILE: 'C:/tmp/p' };
  configError(() => requireDonorConfig({ env, withTest: true, testProfile: 'C:/tmp/p' }));
  configError(() => requireDonorConfig({ env, withTest: true, testProfile: 'C:/tmp/p/' }));
  const full = requireDonorConfig({ env, withTest: true, testProfile: 'C:/tmp/q' });
  assert.equal(full.projectId, '100001');
  assert.equal(full.donorProjectId, '100002');
  assert.deepEqual(full.protectedPages, ['200001', '200003']);
  configError(() => requireDonorConfig({
    env: { TILDA_DONOR_PROJECT_ID: '100002', TILDA_DONOR_BROWSER_PROFILE: 'C:/tmp/p' }, withTest: true, testProfile: 'C:/tmp/q',
  }));
});

test('requireDonorConfig without the donor profile still needs a distinct donor project id', () => {
  const env = { TILDA_PROJECT_ID: '100001', TILDA_DONOR_PROJECT_ID: '100002', TILDA_PROTECTED_PAGES: '' };
  const r = requireDonorConfig({ env, withTest: true, testProfile: 'C:/tmp/p', withProfile: false });
  assert.equal(r.donorProjectId, '100002');
  assert.equal(r.donorProfile, null);
  assert.equal(r.projectId, '100001');
  configError(() => requireDonorConfig({ env: { ...env, TILDA_DONOR_PROJECT_ID: '100001' }, withTest: true, withProfile: false }));
  configError(() => requireDonorConfig({ env: { TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '' }, withTest: true, withProfile: false }));
  configError(() => requireDonorConfig({ env: { TILDA_PROJECT_ID: '100001', TILDA_DONOR_PROJECT_ID: '100002' }, withTest: true, withProfile: false }));
  assert.throws(() => requireDonorConfig({ env, withTest: true }), (e) => e instanceof ConfigError && /TILDA_DONOR_BROWSER_PROFILE/.test(e.message), 'по умолчанию профиль обязателен');
});

test('configuration errors carry a dictionary key and parameters next to the English message', () => {
  assert.throws(() => parseNumericId('abc', 'TILDA_PROJECT_ID'), (e) => e.key === 'config.idNotNumeric'
    && e.params.name === 'TILDA_PROJECT_ID' && e.message === 'TILDA_PROJECT_ID must be a positive numeric ID, got "abc"');
  assert.throws(() => assertRole('other'), (e) => e.key === 'config.unknownRole' && e.params.role === 'other');
});
