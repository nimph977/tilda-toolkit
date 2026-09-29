import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLogLevel } from '../lib/log.mjs';
import { buildLinkIndex, LINK_REASONS, pageKey, rewriteReferenceUrl } from '../lib/reference-links.mjs';

setLogLevel('ERROR');

const site = {
  pages: [
    { label: 'HDR', role: 'header', pageid: '100009' },
    { label: 'P00', role: 'content', name: 'index', url: 'https://ref.test/', pageid: '100001' },
    { label: 'P01', role: 'content', name: 'catalog', url: 'https://ref.test/catalog', pageid: '100004' },
    { label: 'P02', role: 'content', name: 'about', url: 'https://ref.test/about', pageid: '100002' },
    { label: 'P03', role: 'content', name: 'page123-html', url: 'https://ref.test/page123.html', pageid: '100003' },
    { label: 'P04', role: 'content', name: 'draft', url: 'https://ref.test/draft', pageid: null },
    { label: 'P05', role: 'content', name: 'o-nas', url: 'https://ref.test/%D0%BE-%D0%BD%D0%B0%D1%81', pageid: '100005' },
  ],
};
const ctx = { origin: 'https://ref.test', pageUrl: 'https://ref.test/catalog/', index: buildLinkIndex(site) };
const rw = (href) => rewriteReferenceUrl(href, ctx);

test('rewriteReferenceUrl leaves external, hash and service links alone', () => {
  assert.deepEqual(rw('https://ext.test/about'), { value: 'https://ext.test/about', changed: false });
  assert.deepEqual(rw('#top'), { value: '#top', changed: false });
  assert.deepEqual(rw('tel:+70000000000'), { value: 'tel:+70000000000', changed: false });
  assert.deepEqual(rw(''), { value: '', changed: false });
  assert.deepEqual(rw(undefined), { value: undefined, changed: false });
});

test('rewriteReferenceUrl turns an anchor of the same page back into a hash', () => {
  assert.deepEqual(rw('https://ref.test/catalog#prodpopup'), { value: '#prodpopup', changed: true });
  assert.deepEqual(rw('https://ref.test/catalog/#popup:form'), { value: '#popup:form', changed: true });
});

test('rewriteReferenceUrl maps reference pages to /page<pageid>.html', () => {
  assert.deepEqual(rw('https://ref.test/about/'), { value: '/page100002.html', changed: true });
  assert.deepEqual(rw('https://ref.test/about?x=1#f'), { value: '/page100002.html#f', changed: true });
  assert.deepEqual(rw('https://ref.test/page123.html'), { value: '/page100003.html', changed: true });
  assert.deepEqual(rw('https://ref.test/'), { value: '/page100001.html', changed: true });
  assert.deepEqual(rw('https://ref.test/о-нас'), { value: '/page100005.html', changed: true });
});

test('rewriteReferenceUrl explains what it could not rewrite without the domain', () => {
  assert.deepEqual(rw('https://ref.test/nope'), { value: 'https://ref.test/nope', changed: false, reason: LINK_REASONS.unknownPage, text: '/nope' });
  assert.deepEqual(rw('https://ref.test/draft'), { value: 'https://ref.test/draft', changed: false, reason: LINK_REASONS.notCreated('P04'), text: '/draft' });
  assert.deepEqual(rw('https://ref.test/doc.pdf'), { value: 'https://ref.test/doc.pdf', changed: false, reason: LINK_REASONS.file, text: '/doc.pdf' });
  assert.match(LINK_REASONS.notCreated('P04'), /P04/);
});

test('pageKey normalizes root, trailing slash, case of host and encoding', () => {
  assert.equal(pageKey('https://ref.test'), pageKey('https://ref.test/'));
  assert.equal(pageKey('https://REF.test/about/'), pageKey('https://ref.test/about'));
  assert.equal(pageKey('https://ref.test/%D0%BE-%D0%BD%D0%B0%D1%81'), pageKey('https://ref.test/о-нас'));
  assert.equal(pageKey('https://ref.test/a?x=1#y'), 'https://ref.test/a');
});

test('buildLinkIndex skips entries without url', () => {
  const index = buildLinkIndex(site);
  assert.equal(index.size, 6);
  assert.deepEqual(index.get('https://ref.test/about'), { label: 'P02', pageid: '100002' });
});

test('reference-links imports nothing outside scripts/lib', () => {
  const src = readFileSync(new URL('../lib/reference-links.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.every((p) => p.startsWith('./')), imports.join(', '));
});
