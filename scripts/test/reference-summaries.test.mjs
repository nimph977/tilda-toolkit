import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msg } from '../lib/i18n.mjs';
import { formatSummary } from '../tilda.mjs';
import { AUDIT_KINDS, auditKindMessage } from '../reference-site.mjs';

test('catalog summary: status is a code, statusText is translated', () => {
  const summary = { status: msg('cli.catalog.status.list', { templates: 3, unavailable: 1 }), dir: 'catalog' };
  const en = JSON.parse(formatSummary(summary, true, 'en'));
  assert.equal(en.status, 'list');
  assert.equal(en.statusText, 'catalog: templates 3, unavailable 1');
  const ru = JSON.parse(formatSummary(summary, true, 'ru'));
  assert.equal(ru.status, 'list');
  assert.equal(ru.statusText, 'каталог: шаблонов 3, недоступных 1');
});

test('reference fetch summary nests the sitemap note and the next step', () => {
  const summary = {
    status: msg('cli.reference.status.fetched', { slug: 'demo', pages: 4, fetched: 3, skipped: 1, failed: 0, pending: 2, sitemap: msg('cli.reference.sitemap.unavailable', { status: 404 }) }),
    next: msg('cli.reference.next.repeatFetch'),
  };
  const text = formatSummary(summary, false, 'en');
  assert.match(text, /status: snapshot demo: pages 4, fetched 3, skipped 1, errors 0, queued 2, sitemap: unavailable \(HTTP 404\)/);
  assert.doesNotMatch(text, /[А-Яа-я]/);
  assert.match(formatSummary(summary, false, 'ru'), /слепок demo: страниц 4/);
});

test('reference plan summary without a label, links and substitutions', () => {
  const status = msg('cli.reference.status.planWritten', { label: '', ops: 5, blocks: 6, zone: 'all', links: '', subs: '', noStyles: '' });
  assert.equal(JSON.parse(formatSummary({ status }, true, 'en')).statusText, 'plan: operations 5 of 6 blocks of zone all; written');
  assert.equal(JSON.parse(formatSummary({ status }, true, 'ru')).statusText, 'план: операций 5 из 6 блоков зоны all; записан');
});

test('skipped reasons of catalog and calibrate are translated in the summary', () => {
  const summary = { status: msg('cli.catalog.status.captured', { captured: 0, unavailable: 0, skipped: 1, failed: 0 }), skipped: [{ tplid: '796', reason: msg('catalog.reason.alreadyCaptured') }] };
  assert.equal(JSON.parse(formatSummary(summary, true, 'en')).skipped[0].reason, 'already captured');
  assert.equal(JSON.parse(formatSummary(summary, true, 'ru')).skipped[0].reason, 'уже снят');
});

test('link audit kinds are codes with a message each', () => {
  for (const kind of Object.values(AUDIT_KINDS)) {
    const text = formatSummary({ kind: auditKindMessage(kind) }, false, 'en');
    assert.ok(!/[А-Яа-я]/.test(text), kind);
    assert.ok(!text.includes('referenceSite.auditKind'), kind);
  }
  assert.equal(auditKindMessage('other'), 'other');
});
