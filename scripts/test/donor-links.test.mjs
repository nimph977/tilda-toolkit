import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { encodeList } from '../list-model.mjs';
import { LINK_REWRITE_REASONS, buildLinkRewritePlan, donorHosts, donorPageLinks, knownPathsFrom, rewriteDonorHref, rewriteHrefsInHtml } from '../donor-links.mjs';

setLogLevel('ERROR');

// Синтетический домен донора ref.test; страницы копии: /about, /blog.
const ctx = { hosts: donorHosts('https://ref.test/'), knownPaths: knownPathsFrom([{ alias: 'about' }, { alias: '/Blog/' }, {}]) };

test('donorHosts and knownPathsFrom', () => {
  assert.deepEqual(donorHosts('https://www.ref.test/page'), ['ref.test', 'www.ref.test']);
  assert.deepEqual([...ctx.knownPaths].sort(), ['/', '/about', '/blog']);
});

test('rewriteDonorHref rewrites donor links to known pages and leaves the rest with a reason', () => {
  assert.deepEqual(rewriteDonorHref('https://ref.test', ctx), { value: '/', changed: true, donor: true });
  assert.equal(rewriteDonorHref('https://ref.test/about#rec1', ctx).value, '/about#rec1');
  assert.equal(rewriteDonorHref('https://www.ref.test/Blog/?utm=1', ctx).value, '/Blog/?utm=1');
  assert.equal(rewriteDonorHref('//ref.test/about', ctx).value, '/about');
  assert.equal(rewriteDonorHref('https://ref.test/#popup:form', ctx).value, '/#popup:form');
  const missing = rewriteDonorHref('https://ref.test/oshibka', ctx);
  assert.deepEqual(missing, { value: 'https://ref.test/oshibka', changed: false, donor: true, reason: LINK_REWRITE_REASONS.noPage('/oshibka') });
  for (const href of ['tel:+70000000000', 'mailto:info@ref.test', '#rec1', '/about', 'https://other.test/about']) {
    const r = rewriteDonorHref(href, ctx);
    assert.equal(r.changed, false, href);
    assert.equal(r.donor, false, href);
    assert.equal(r.value, href);
  }
});

test('rewriteHrefsInHtml changes only href values, including the encoded form', () => {
  const html = '<a href="https://ref.test/about" style="color:#000">https://ref.test/about</a> <a href=\'https://ref.test/x\'>x</a> <a href="mailto:a@ref.test">a@ref.test</a>';
  const r = rewriteHrefsInHtml(html, ctx);
  assert.equal(r.changed, 1);
  assert.equal(r.value, '<a href="/about" style="color:#000">https://ref.test/about</a> <a href=\'https://ref.test/x\'>x</a> <a href="mailto:a@ref.test">a@ref.test</a>');
  assert.deepEqual(r.reasons, [{ href: 'https://ref.test/x', reason: LINK_REWRITE_REASONS.noPage('/x') }]);
  const encoded = rewriteHrefsInHtml('&lt;a href=&quot;https://ref.test/blog&quot;&gt;Блог&lt;/a&gt;', ctx);
  assert.equal(encoded.value, '&lt;a href=&quot;/blog&quot;&gt;Блог&lt;/a&gt;');
  assert.equal(encoded.changed, 1);
});

test('buildLinkRewritePlan builds field, set and listSet operations and names form fields', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-links-'));
  try {
    const recDir = join(baseDir, 'records', '200001');
    const zeroDir = join(baseDir, 'zero', '200001');
    mkdirSync(recDir, { recursive: true });
    mkdirSync(zeroDir, { recursive: true });
    writeFileSync(join(recDir, '400001.json'), JSON.stringify({ record: {
      recordid: '400001', tplid: '770',
      link: 'https://ref.test',
      buttonlink: 'https://ref.test/missing',
      descr: '&lt;a href=&quot;https://ref.test/about&quot;&gt;О нас&lt;/a&gt; &lt;a href=&quot;mailto:info@ref.test&quot;&gt;info@ref.test&lt;/a&gt;',
      formmsgurl: 'https://ref.test/thank-you',
    } }));
    writeFileSync(join(recDir, '400002.json'), JSON.stringify({ record: {
      recordid: '400002', tplid: '686',
      list: encodeList([{ lid: '1001', li_title: 'Блог', li_link: 'https://www.ref.test/blog' }, { lid: '1002', li_title: 'Другое', li_link: 'https://other.test/' }]),
    } }));
    writeFileSync(join(zeroDir, '400003.json'), JSON.stringify({ 1: { elem_id: '1700000000001', elem_type: 'text', text: 'Пишите: project@ref.test' }, 2: { elem_id: '1700000000002', elem_type: 'button', link: 'https://ref.test/about' } }));
    const r = buildLinkRewritePlan('200001', { ...ctx, baseDir });
    assert.equal(r.plan.page, '200001');
    assert.equal(r.changed, 4);
    const ops = r.plan.ops;
    assert.deepEqual(ops.find((o) => o.field?.name === 'link'), { block: { recordid: '400001' }, field: { name: 'link', value: '/' } });
    assert.equal(ops.find((o) => o.field?.name === 'descr').field.value, '<a href="/about">О нас</a> <a href="mailto:info@ref.test">info@ref.test</a>');
    assert.ok(!ops.some((o) => o.field?.name === 'buttonlink'), 'путь без страницы в копии не переписывается');
    assert.deepEqual(ops.find((o) => o.elem), { block: { recordid: '400003' }, elem: { elem_id: '1700000000002' }, set: { link: '/about' } });
    assert.deepEqual(ops.find((o) => o.listSet).listSet.set, [{ lid: '1001', fields: { li_link: '/blog' } }]);
    assert.deepEqual(r.unchanged, [{ recordid: '400001', field: 'buttonlink', reason: LINK_REWRITE_REASONS.noPage('/missing') }]);
    assert.deepEqual(r.skippedForm, [{ recordid: '400001', field: 'formmsgurl', reason: LINK_REWRITE_REASONS.form('formmsgurl') }]);
    assert.ok(!ops.some((o) => o.set?.text), 'почта в видимом тексте не меняется');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildLinkRewritePlan ignores snapshots of deleted blocks', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-links-'));
  try {
    const recDir = join(baseDir, 'records', '200001');
    mkdirSync(recDir, { recursive: true });
    for (const id of ['400011', '400012']) {
      writeFileSync(join(recDir, `${id}.json`), JSON.stringify({ record: { recordid: id, tplid: '770', link: 'https://ref.test/about' } }));
    }
    writeFileSync(join(recDir, '_inventory.json'), JSON.stringify([{ order: 1, recordid: '400012', tplid: '770' }]));
    const r = buildLinkRewritePlan('200001', { ...ctx, baseDir });
    assert.deepEqual(r.plan.ops.map((o) => o.block.recordid), ['400012'], 'блок из корзины не адресуется');
    assert.equal(r.skippedStale, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// Синтетические страницы донора 300001–300009 и копии 200001–200009.
const site = { pages: [
  { label: 'HDR', role: 'header', pageid: '200009', donorPageid: '300009' },
  { label: 'P00', pageid: '200001', donorPageid: '300001' },
  { label: 'P01', pageid: '200004', donorPageid: '300004' },
  { label: 'P02', pageid: '200005', donorPageid: '300005' },
  { label: 'P03', pageid: '200006', donorPageid: '300004' },
  { label: 'P04', pageid: null, donorPageid: '300007' },
] };
const donorPages = [{ pageid: '300001', role: 'index', alias: 'home' }, { pageid: '300004', alias: 'about' }, { pageid: '300005' }, { pageid: '300009', role: 'header' }];
const testPages = [{ pageid: '200001' }, { pageid: '200004', alias: '/About/' }, { pageid: '200005' }, { pageid: '200006', alias: 'copy' }];

test('donorPageLinks maps donor page IDs to copy paths', () => {
  const links = donorPageLinks(site, testPages, donorPages);
  assert.deepEqual([...links], [['300001', '/'], ['300004', '/about'], ['300005', '/page200005.html']], 'шапка, дубль и метка без pageid не входят');
});

test('rewriteDonorHref rewrites donor page links by ID', () => {
  const idCtx = { ...ctx, donorLinks: donorPageLinks(site, testPages, donorPages) };
  assert.deepEqual(rewriteDonorHref('/page300004.html#rec1', idCtx), { value: '/about#rec1', changed: true, donor: true });
  assert.deepEqual(rewriteDonorHref('https://ref.test/page300005.html?x=1', idCtx), { value: '/page200005.html?x=1', changed: true, donor: true });
  assert.deepEqual(rewriteDonorHref('/page200002.html', idCtx), { value: '/page200002.html', changed: false, donor: false }, 'ID копии не трогается');
  assert.deepEqual(rewriteDonorHref('/page300008.html', idCtx), { value: '/page300008.html', changed: false, donor: false });
  assert.equal(rewriteDonorHref('https://ref.test/page300008.html', idCtx).reason, LINK_REWRITE_REASONS.noPage('/page300008.html'), 'ID донора без пары на домене донора — noPage');
  assert.deepEqual(rewriteDonorHref('http://demo.tilda.ws/page300004.html', idCtx), { value: '/about', changed: true, donor: true }, 'технический поддомен донора');
  assert.equal(rewriteDonorHref('http://demo.tilda.ws/about', idCtx).changed, false, 'на поддомене — только ссылки по ID');
  assert.equal(rewriteDonorHref('https://other.test/page300004.html', idCtx).reason, LINK_REWRITE_REASONS.otherHost);
});

test('buildLinkRewritePlan merges domain and donor-ID links of one field into one operation', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-links-'));
  try {
    const recDir = join(baseDir, 'records', '200001');
    mkdirSync(recDir, { recursive: true });
    writeFileSync(join(recDir, '400021.json'), JSON.stringify({ record: {
      recordid: '400021', tplid: '770',
      descr: '<a href="https://ref.test/about">a</a> <a href="/page300005.html">b</a>',
      link: '/page300004.html',
    } }));
    const r = buildLinkRewritePlan('200001', { ...ctx, baseDir, donorLinks: donorPageLinks(site, testPages, donorPages) });
    assert.equal(r.changed, 3);
    assert.deepEqual(r.plan.ops.map((o) => o.field.name).sort(), ['descr', 'link'], 'одно поле — одна операция');
    assert.equal(r.plan.ops.find((o) => o.field.name === 'descr').field.value, '<a href="/about">a</a> <a href="/page200005.html">b</a>');
    assert.equal(r.plan.ops.find((o) => o.field.name === 'link').field.value, '/about');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
