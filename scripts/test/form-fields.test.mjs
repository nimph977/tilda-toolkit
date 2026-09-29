import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { assertNotFormField, FORM_CONTENT_FIELDS, FORM_FIELDS, FORM_LOCKED_FIELDS } from '../lib/form-fields.mjs';

setLogLevel('ERROR');

test('FORM_FIELDS keeps its former members split into locked and content fields', () => {
  assert.deepEqual([...FORM_FIELDS].sort(), ['formmsgurl', 'inputs', 'receivers', 'receivers_names']);
  assert.deepEqual([...FORM_LOCKED_FIELDS].sort(), ['inputs', 'receivers', 'receivers_names']);
  assert.deepEqual([...FORM_CONTENT_FIELDS], ['formmsgurl']);
});

test('receivers are rejected even with allowContent', () => {
  for (const name of FORM_LOCKED_FIELDS) {
    assert.throws(() => assertNotFormField(name), /FORM_FIELD_REJECTED/);
    assert.throws(() => assertNotFormField(name, {}, { allowContent: true }), /FORM_FIELD_REJECTED/);
  }
});

test('formmsgurl is rejected without the flag and passes with allowContent', () => {
  assert.throws(() => assertNotFormField('formmsgurl'), /FORM_FIELD_REJECTED/);
  assert.doesNotThrow(() => assertNotFormField('formmsgurl', {}, { allowContent: true }));
  assert.doesNotThrow(() => assertNotFormField('title'));
});
