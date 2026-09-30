import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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

/** `check` — ключ словаря (строка) или регулярное выражение по английскому `message`. */
const isConfigError = (variable, check) => (e) =>
  e.code === 'CONFIG_ERROR' && e.exitCode === 2 && e.variable === variable
  && (!check || (typeof check === 'string' ? e.key === check : check.test(e.message)));

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
    isConfigError('TILDA_BASELINE_DIR', 'paths.insideRepo'),
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

test('isInside: каталог, имя которого начинается с двух точек, лежит внутри, а не выше', () => {
  assert.equal(isInside('/r/..data', '/r', 'linux'), true);
  assert.equal(isInside('C:\\r\\..data\\x', 'C:\\r', 'win32'), true);
  assert.equal(isInside('/r/..', '/r', 'linux'), false);
  assert.equal(isInside('/r/../x', '/r', 'linux'), false);
  assert.equal(isInside('C:\\r\\..\\x', 'C:\\r', 'win32'), false);
});

test('assertOutsideRepo: ярлык (junction/symlink) внутрь репозитория не обходит проверку', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tilda-link-'));
  try {
    const repo = join(tmp, 'repo');
    const inner = join(repo, 'inner');
    const outside = join(tmp, 'outside');
    mkdirSync(inner, { recursive: true });
    mkdirSync(outside);
    const link = join(outside, 'link');
    symlinkSync(inner, link, 'junction');
    assert.throws(() => assertOutsideRepo(link, 'V', { root: repo }), isConfigError('V', 'paths.insideRepo'));
    // ещё не созданная подпапка за ярлыком тоже считается внутри
    assert.throws(() => assertOutsideRepo(join(link, 'site-baseline'), 'V', { root: repo }), isConfigError('V'));
    // обычная папка вне репозитория проходит
    assert.equal(assertOutsideRepo(outside, 'V', { root: repo }), outside);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
