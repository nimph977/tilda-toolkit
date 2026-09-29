import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { stripHostZoom, resetTildaZoom } from '../lib/browser-profile.mjs';

setLogLevel('ERROR');

test('stripHostZoom removes Tilda hosts and subdomains only and never mutates the input', () => {
  const prefs = { partition: { per_host_zoom_levels: { x: { 'tilda.ru': -1.22, 'example.com': 1 }, y: { 'static.tilda.cc': -0.5, 'tilda.ru.example': 2 } } } };
  const before = JSON.stringify(prefs);
  const r = stripHostZoom(prefs);
  assert.deepEqual(r.removed, ['x/tilda.ru', 'y/static.tilda.cc']);
  assert.deepEqual(r.prefs.partition.per_host_zoom_levels, { x: { 'example.com': 1 }, y: { 'tilda.ru.example': 2 } });
  assert.equal(JSON.stringify(prefs), before);
  assert.deepEqual(stripHostZoom({ a: 1 }), { prefs: { a: 1 }, removed: [] });
  assert.deepEqual(stripHostZoom({ partition: { per_host_zoom_levels: { 'tilda.ru': -1 } } }).removed, ['tilda.ru']);
  assert.deepEqual(stripHostZoom({ partition: { per_host_zoom_levels: { x: { 'tilda.ru': -1 } } } }).prefs.partition.per_host_zoom_levels, {});
});

test('resetTildaZoom rewrites Preferences with a backup once and skips a profile without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-prefs-'));
  try {
    assert.deepEqual(resetTildaZoom(dir), { removed: [], skipped: 'no-preferences' });
    mkdirSync(join(dir, 'Default'));
    const file = join(dir, 'Default', 'Preferences');
    writeFileSync(file, JSON.stringify({ bookmarks: [1], partition: { per_host_zoom_levels: { x: { 'tilda.ru': -1.22, 'example.com': 1 } } } }));
    const r = resetTildaZoom(dir, { now: new Date('2026-09-24T10:00:00Z') });
    assert.deepEqual(r.removed, ['x/tilda.ru']);
    assert.ok(existsSync(r.backup));
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(after.partition.per_host_zoom_levels, { x: { 'example.com': 1 } });
    assert.deepEqual(after.bookmarks, [1]);
    assert.deepEqual(resetTildaZoom(dir), { removed: [] });
    assert.equal(readdirSync(join(dir, 'Default')).filter((f) => f.startsWith('Preferences.bak-')).length, 1);
    writeFileSync(file, '{not json');
    assert.deepEqual(resetTildaZoom(dir), { removed: [], skipped: 'bad-json' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
