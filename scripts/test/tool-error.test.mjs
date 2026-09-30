import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../lib/tool-error.mjs';
import { msg } from '../lib/i18n.mjs';

test('ToolError keeps the code at the start of the English message', () => {
  const error = new ToolError('PLAN_INVALID', 'bad plan');
  assert.equal(error.message, 'PLAN_INVALID: bad plan');
  assert.equal(error.code, 'PLAN_INVALID');
  assert.equal(error.name, 'ToolError');
  assert.equal(error.exitCode, 1);
  assert.equal(error.key, undefined);
});

test('ToolError does not repeat a code the text already starts with', () => {
  assert.equal(new ToolError('SAVE_FAILED', 'SAVE_FAILED in fn: x').message, 'SAVE_FAILED in fn: x');
});

test('ToolError takes a Message and copies data fields onto the error', () => {
  const error = new ToolError('BAD_ARGUMENT', msg('browser.lib.unknownTab', { tab: 'x' }), { pageid: '100001' });
  assert.equal(error.message, 'BAD_ARGUMENT: unknown settings tab: x');
  assert.equal(error.key, 'browser.lib.unknownTab');
  assert.deepEqual(error.params, { tab: 'x' });
  assert.equal(error.pageid, '100001');
});
