import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFileToLoad } from '../lib/paths.mjs';

test('envFileToLoad points at the repo .env only when nothing is configured and autoload is on', () => {
  assert.match(envFileToLoad({ env: {}, root: '/r', exists: () => true }), /\.env$/);
  assert.equal(envFileToLoad({ env: { TILDA_PROJECT_ID: '100001' }, root: '/r', exists: () => true }), null);
  assert.equal(envFileToLoad({ env: { TILDA_DONOR_PROJECT_ID: '100002' }, root: '/r', exists: () => true }), null);
  assert.equal(envFileToLoad({ env: { TILDA_ENV_AUTOLOAD: '0' }, root: '/r', exists: () => true }), null);
  assert.equal(envFileToLoad({ env: {}, root: '/r', exists: () => false }), null);
});
