import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { captureWidths, chunks, parseWidths, scaleMismatch } from '../shot.mjs';

setLogLevel('ERROR');

/** Фейковая страница Playwright: высота 7000, 3 блока; screenshot только запоминает путь. */
function fakePage({ status = 200, zoom = 1 } = {}) {
  const calls = { goto: [], shots: [], viewport: [] };
  let viewport = 1440;
  const page = {
    calls,
    setViewportSize: async (v) => { viewport = v.width; calls.viewport.push(v.width); },
    goto: async (url, opts) => {
      calls.goto.push({ url, opts });
      return { status: () => status };
    },
    waitForTimeout: async () => {},
    addStyleTag: async () => {},
    // Масштаб < 1 расширяет окно в CSS px и снижает devicePixelRatio — как в профиле с Ctrl+-.
    evaluate: async (fn) => (String(fn).includes('t-rec') ? { records: 3, height: 7000, width: Math.round(viewport / zoom), dpr: zoom } : 2),
    screenshot: async ({ path }) => calls.shots.push(path),
    url: () => 'https://ref.test/',
  };
  return page;
}

test('captureWidths shoots every width in chunks without a referer when none is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  try {
    const page = fakePage();
    const r = await captureWidths(page, { url: 'https://ref.test/', widths: [1440, 320], outDir: dir, stamp: '2026-09-23T00:00:00.000Z', settleMs: 0, animSettleMs: 0 });
    assert.equal(r.files.length, 4);
    assert.deepEqual(r.widths.map((w) => [w.width, w.records, w.files.length]), [[1440, 3, 2], [320, 3, 2]]);
    assert.ok(page.calls.shots[0].endsWith('2026-09-23T00-00-00-000Z-1440-1.jpg'));
    assert.ok(page.calls.goto.every((g) => !('referer' in g.opts)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('captureWidths passes the referer and can require a 200 answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  try {
    const page = fakePage();
    await captureWidths(page, { url: 'https://tilda.test/page/preview/', referer: 'https://tilda.test/page/', widths: [1440], outDir: dir, settleMs: 0, animSettleMs: 0 });
    assert.equal(page.calls.goto[0].opts.referer, 'https://tilda.test/page/');
    const missing = fakePage({ status: 404 });
    await assert.rejects(captureWidths(missing, { url: 'https://ref.test/x', widths: [1440], outDir: dir, requireOk: true }), (e) => e.code === 'NAV_FAILED' && e.status === 404);
    assert.equal(missing.calls.shots.length, 0);
    const zoomed = fakePage({ zoom: 0.8 });
    await assert.rejects(captureWidths(zoomed, { url: 'https://ref.test/x', widths: [1440], outDir: dir, settleMs: 0, animSettleMs: 0 }), (e) => e.code === 'SHOT_SCALED' && e.exitCode === 1 && /browser stop/.test(e.message));
    assert.equal(zoomed.calls.shots.length, 0, 'кадр в чужом масштабе не снимается');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chunks and parseWidths', () => {
  assert.deepEqual(chunks(7000), [{ y: 0, height: 6000 }, { y: 6000, height: 1000 }]);
  assert.deepEqual(parseWidths('1440,320'), [1440, 320]);
  assert.deepEqual(parseWidths(undefined), [1440, 320]);
  assert.throws(() => parseWidths('10'), /BAD_WIDTHS/);
});

test('scaleMismatch accepts a scrollbar-wide viewport at scale 100% and refuses a zoomed frame', () => {
  assert.equal(scaleMismatch({ width: 1440, innerWidth: 1440, dpr: 1 }), null);
  assert.equal(scaleMismatch({ width: 1440, innerWidth: 1425, dpr: 1 }), null);
  const zoomed = scaleMismatch({ width: 1440, innerWidth: 1800, dpr: 0.8 });
  assert.match(zoomed, /1800/);
  assert.match(zoomed, /0\.8/);
  assert.match(scaleMismatch({ width: 320, innerWidth: 400, dpr: 0.8 }), /400/);
});
