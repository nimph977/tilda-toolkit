import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertOutsideRepo, baselineDir, catalogRoot, isInside, plansDir, referenceDir, repoRoot, testProfileDir } from '../lib/paths.mjs';

function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'tilda-paths-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isConfigError = (variable, text) => (e) =>
  e.code === 'CONFIG_ERROR' && e.exitCode === 2 && e.variable === variable && (!text || text.test(e.message));

test('явная переменная папки данных берётся как есть', () => {
  withTmp((tmp) => {
    assert.equal(baselineDir({ TILDA_BASELINE_DIR: tmp }), resolve(tmp));
    assert.equal(referenceDir({ TILDA_REFERENCE_DIR: tmp }), resolve(tmp));
    assert.equal(testProfileDir({ TILDA_BROWSER_PROFILE: tmp }), resolve(tmp));
  });
});

test('без явной переменной пути выводятся из папки сайта', () => {
  withTmp((tmp) => {
    const env = { TILDA_SITE_DIR: tmp };
    assert.equal(baselineDir(env), join(resolve(tmp), 'site-baseline'));
    assert.equal(referenceDir(env), join(resolve(tmp), 'site-reference'));
    assert.equal(testProfileDir(env), join(resolve(tmp), '.browser-profile'));
    assert.equal(plansDir(env), join(resolve(tmp), 'plans'));
  });
});

test('без переменной и без сайта пути отказывают кодом настройки', () => {
  assert.throws(() => baselineDir({}), isConfigError('TILDA_BASELINE_DIR', /--site/));
  assert.throws(() => referenceDir({}), isConfigError('TILDA_REFERENCE_DIR', /--site/));
  assert.throws(() => testProfileDir({}), isConfigError('TILDA_BROWSER_PROFILE', /--site/));
  assert.throws(() => plansDir({}), isConfigError('TILDA_SITE_DIR', /--site/));
});

test('пустая переменная равна незаданной', () => {
  assert.throws(() => baselineDir({ TILDA_BASELINE_DIR: '  ' }), isConfigError('TILDA_BASELINE_DIR'));
});

test('явная папка данных внутри репозитория — отказ', () => {
  assert.throws(
    () => baselineDir({ TILDA_BASELINE_DIR: join(repoRoot(), 'site-baseline') }),
    isConfigError('TILDA_BASELINE_DIR', /внутри репозитория/),
  );
  assert.throws(() => testProfileDir({ TILDA_BROWSER_PROFILE: join(repoRoot(), '.browser-profile') }), isConfigError('TILDA_BROWSER_PROFILE'));
});

test('каталог шаблонов — только TILDA_CATALOG_DIR, из папки сайта не выводится', () => {
  withTmp((tmp) => {
    assert.throws(() => catalogRoot({ TILDA_SITE_DIR: tmp }), isConfigError('TILDA_CATALOG_DIR'));
    assert.equal(catalogRoot({ TILDA_CATALOG_DIR: tmp }), resolve(tmp));
    assert.throws(() => catalogRoot({ TILDA_CATALOG_DIR: join(repoRoot(), 'catalog') }), isConfigError('TILDA_CATALOG_DIR'));
  });
});

test('assertOutsideRepo возвращает путь вне корня и бросает внутри', () => {
  assert.equal(assertOutsideRepo('/x/y', 'V', { root: '/r', platform: 'linux' }), '/x/y');
  assert.throws(() => assertOutsideRepo('/r/y', 'V', { root: '/r', platform: 'linux' }), isConfigError('V'));
});

test('isInside: вложенность, равенство, регистр Windows, общий префикс имён', () => {
  assert.equal(isInside('C:\\A\\b', 'c:\\a', 'win32'), true);
  assert.equal(isInside('C:\\A', 'C:\\A', 'win32'), true);
  assert.equal(isInside('C:\\AB', 'C:\\A', 'win32'), false);
  assert.equal(isInside('/a/b', '/a', 'linux'), true);
  assert.equal(isInside('/a', '/a/b', 'linux'), false);
});
