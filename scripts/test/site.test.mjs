import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applySite, cliHint, resolveSiteDir, siteEnvChanges } from '../lib/site.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

const isConfigError = (variable, text) => (e) =>
  e.code === 'CONFIG_ERROR' && e.exitCode === 2 && e.variable === variable && (!text || text.test(e.message));

/** Временная папка + папка сайта `s1` с `.env`; удаляется в finally. */
function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'tilda-site-'));
  try {
    const site = join(tmp, 's1');
    mkdirSync(site);
    writeFileSync(join(site, '.env'), 'TILDA_PROJECT_ID=100001\n');
    return fn(tmp, site);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('resolveSiteDir: сайт не выбран — null', () => {
  assert.equal(resolveSiteDir({ env: {} }), null);
});

test('resolveSiteDir: относительный флаг считается от cwd', () => {
  withTmp((tmp, site) => {
    assert.equal(resolveSiteDir({ flag: 's1', env: {}, cwd: tmp, root: '/nowhere' }), site);
  });
});

test('resolveSiteDir: флаг и TILDA_SITE_DIR на разные папки — отказ, на одну — путь', () => {
  withTmp((tmp, site) => {
    const other = join(tmp, 's2');
    mkdirSync(other);
    writeFileSync(join(other, '.env'), '');
    assert.throws(
      () => resolveSiteDir({ flag: site, env: { TILDA_SITE_DIR: other }, cwd: tmp, root: '/nowhere' }),
      isConfigError('TILDA_SITE_DIR'),
    );
    assert.equal(resolveSiteDir({ flag: site, env: { TILDA_SITE_DIR: site }, cwd: tmp, root: '/nowhere' }), site);
  });
});

test('resolveSiteDir: нет папки и нет .env — отказ', () => {
  withTmp((tmp, site) => {
    assert.throws(() => resolveSiteDir({ flag: join(tmp, 'нет'), env: {}, cwd: tmp }), isConfigError('TILDA_SITE_DIR', /не найдена/));
    const bare = join(tmp, 'bare');
    mkdirSync(bare);
    assert.throws(() => resolveSiteDir({ flag: bare, env: {}, cwd: tmp, root: '/nowhere' }), isConfigError('TILDA_SITE_DIR', /нет \.env/));
  });
});

test('resolveSiteDir: папка внутри репозитория — отказ раньше проверки .env', () => {
  withTmp((tmp) => {
    const inner = join(tmp, 'inner');
    mkdirSync(inner);
    writeFileSync(join(inner, '.env'), '');
    assert.throws(() => resolveSiteDir({ flag: inner, env: {}, cwd: tmp, root: tmp }), isConfigError('TILDA_SITE_DIR', /внутри репозитория/));
    const bareInner = join(tmp, 'bare-inner');
    mkdirSync(bareInner);
    assert.throws(() => resolveSiteDir({ flag: bareInner, env: {}, cwd: tmp, root: tmp }), isConfigError('TILDA_SITE_DIR', /внутри репозитория/));
  });
});

test('siteEnvChanges: относительные пути от папки сайта, абсолютные и прочее без изменений', () => {
  withTmp((tmp) => {
    const abs = join(tmp, 'shared', 'catalog');
    const { set, kept } = siteEnvChanges({
      siteDir: tmp,
      text: `TILDA_BASELINE_DIR=./b\nTILDA_CATALOG_DIR=${abs}\nTILDA_PROJECT_ID=100001\n`,
      env: {},
    });
    assert.equal(set.TILDA_BASELINE_DIR, join(tmp, 'b'));
    assert.equal(set.TILDA_CATALOG_DIR, abs);
    assert.equal(set.TILDA_PROJECT_ID, '100001');
    assert.deepEqual(kept, []);
  });
});

test('siteEnvChanges: TILDA_SITE_DIR в .env сайта запрещена', () => {
  assert.throws(() => siteEnvChanges({ siteDir: '/s', text: 'TILDA_SITE_DIR=x\n', env: {} }), isConfigError('TILDA_SITE_DIR'));
});

test('siteEnvChanges: конфликт TILDA_* называет переменную и не печатает значения; одинаковое значение не конфликт', () => {
  assert.throws(
    () => siteEnvChanges({ siteDir: '/s', text: 'TILDA_PROJECT_ID=100001\n', env: { TILDA_PROJECT_ID: '100002' } }),
    (e) => isConfigError('TILDA_PROJECT_ID', /TILDA_PROJECT_ID/)(e) && !/100001|100002/.test(e.message),
  );
  const { set } = siteEnvChanges({ siteDir: '/s', text: 'TILDA_PROJECT_ID=100001\n', env: { TILDA_PROJECT_ID: '100001' } });
  assert.equal('TILDA_PROJECT_ID' in set, false);
});

test('siteEnvChanges: не-TILDA переменная окружения главнее файла', () => {
  const { set, kept } = siteEnvChanges({ siteDir: '/s', text: 'LOG_LEVEL=ERROR\n', env: { LOG_LEVEL: 'DEBUG' } });
  assert.deepEqual(kept, ['LOG_LEVEL']);
  assert.equal('LOG_LEVEL' in set, false);
});

test('applySite: ставит TILDA_SITE_DIR и переменные .env сайта в переданное окружение', () => {
  withTmp((tmp, site) => {
    const env = {};
    const result = applySite({ flag: site, env, cwd: tmp, root: '/nowhere' });
    assert.equal(result.siteDir, site);
    assert.equal(env.TILDA_SITE_DIR, site);
    assert.equal(env.TILDA_PROJECT_ID, '100001');
    assert.equal(applySite({ env: {}, cwd: tmp }), null);
  });
});

test('cliHint: команда с --site, если сайт выбран, и без него иначе', () => {
  assert.equal(cliHint('page list', { TILDA_SITE_DIR: 'D:\\Sites\\x' }), 'node scripts/tilda.mjs --site "D:\\Sites\\x" page list');
  assert.equal(cliHint('page list', {}), 'node scripts/tilda.mjs page list');
});

test('resolve используется для сравнения путей одной папки', () => {
  withTmp((tmp, site) => {
    assert.equal(resolveSiteDir({ flag: `${site}${process.platform === 'win32' ? '\\' : '/'}.`, env: {}, cwd: tmp, root: '/nowhere' }), resolve(site));
  });
});

test('siteEnvChanges: идентифицирующая переменная только в окружении, а в .env сайта её нет — отказ без значения', () => {
  for (const key of ['TILDA_PROJECT_ID', 'TILDA_PROTECTED_PAGES', 'TILDA_DONOR_PROJECT_ID']) {
    assert.throws(
      () => siteEnvChanges({ siteDir: '/s', text: 'TILDA_CATALOG_DIR=/c\n', env: { [key]: '100001' } }),
      (e) => isConfigError(key, /только в окружении/)(e) && !/100001/.test(e.message),
      key,
    );
  }
});

test('siteEnvChanges: пустое значение в окружении тоже считается заданным', () => {
  assert.throws(
    () => siteEnvChanges({ siteDir: '/s', text: 'TILDA_PROJECT_ID=100001\n', env: { TILDA_PROTECTED_PAGES: '' } }),
    isConfigError('TILDA_PROTECTED_PAGES'),
  );
});

test('siteEnvChanges: те же идентификаторы и в окружении, и в .env с равными значениями — не отказ', () => {
  const { inherited } = siteEnvChanges({
    siteDir: '/s',
    text: 'TILDA_PROJECT_ID=100001\nTILDA_PROTECTED_PAGES=200001\n',
    env: { TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '200001' },
  });
  assert.deepEqual(inherited, []);
});

test('siteEnvChanges: прочие TILDA_* из окружения, которых нет в .env, — в inherited; отладочные и сайт не считаются', () => {
  const { inherited } = siteEnvChanges({
    siteDir: '/s',
    text: 'TILDA_PROJECT_ID=100001\nTILDA_PROTECTED_PAGES=\n',
    env: { TILDA_DEFAULT_PAGE: '200002', TILDA_BROWSER_DAEMON: '0', TILDA_BROWSER_VISIBLE: '1', TILDA_SITE_DIR: '/s', LOG_LEVEL: 'DEBUG', PATH: 'x' },
  });
  assert.deepEqual(inherited, ['TILDA_DEFAULT_PAGE']);
});

test('applySite: чужой TILDA_PROJECT_ID из оболочки не подхватывается сайтом без этой строки', () => {
  withTmp((tmp, site) => {
    writeFileSync(join(site, '.env'), 'TILDA_CATALOG_DIR=/c\n');
    const env = { TILDA_PROJECT_ID: '100002' };
    assert.throws(() => applySite({ flag: site, env, cwd: tmp, root: '/nowhere' }), isConfigError('TILDA_PROJECT_ID'));
    assert.equal(env.TILDA_SITE_DIR, undefined, 'окружение не меняется при отказе');
  });
});
