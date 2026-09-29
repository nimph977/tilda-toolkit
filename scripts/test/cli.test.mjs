import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseCli, usage, UsageError } from '../tilda.mjs';

const cli = fileURLToPath(new URL('../tilda.mjs', import.meta.url));
const repoDir = fileURLToPath(new URL('../..', import.meta.url));

// Тесты не зависят от сайта, выбранного на машине: дочерние процессы наследуют это окружение.
for (const k of ['TILDA_SITE_DIR', 'TILDA_BASELINE_DIR', 'TILDA_CATALOG_DIR']) delete process.env[k];

function run(args, profile) {
  const env = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: profile };
  delete env.TILDA_PROJECT_ID;
  delete env.TILDA_DEFAULT_PAGE;
  delete env.TILDA_PROTECTED_PAGES;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}

test('page role without --confirm refuses before the browser starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-role-'));
  const profile = join(root, 'profile');
  try {
    const env = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: profile, TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '' };
    delete env.TILDA_DEFAULT_PAGE;
    const result = spawnSync(process.execPath, [cli, 'page', 'role', '--header', '100001'], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /--confirm/);
    assert.equal(existsSync(profile), false, 'отказ должен быть до запуска браузера');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI rejects missing online configuration before it can create a browser profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-test-'));
  const profile = join(root, 'profile');
  try {
    for (const args of [['page', 'create'], ['page', 'list'], ['session'], ['apply', '--plan', 'missing.json'], ['reference', 'pages', '--slug', 'x', '--create'], ['reference', 'audit', '--slug', 'x', '--source', 'P00']]) {
      const result = run(args, profile);
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout + result.stderr, /CONFIG_ERROR|TILDA_PROJECT_ID/);
      assert.equal(existsSync(profile), false, 'configuration failure must precede browser startup');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCli validates reference actions and flags', () => {
  assert.throws(() => parseCli(['reference']), UsageError);
  assert.throws(() => parseCli(['reference', 'fetch', '--slug', 'demo']), /--url/);
  assert.throws(() => parseCli(['reference', 'fetch', '--url', 'https://ref.test/']), /--slug/);
  assert.throws(() => parseCli(['reference', 'plan', '--slug', 'demo']), /--source/);
  assert.throws(() => parseCli(['reference', 'plan', '--slug', 'demo', '--source', 'index']), /--page/);
  assert.equal(parseCli(['reference', 'plan', '--slug', 'demo', '--source', 'index', '--page', '200002']).positionals[0], 'plan');
  assert.throws(() => parseCli(['reference', 'structure', '--slug', 'demo', '--max', 'x']), /--max/);
  const ok = parseCli(['reference', 'fetch', '--slug', 'demo', '--url', 'https://ref.test/', '--follow', '--max', '5']);
  assert.equal(ok.cmd, 'reference');
  assert.deepEqual(ok.positionals, ['fetch']);
  assert.equal(ok.values.follow, true);
  assert.equal(ok.values.max, '5');
  assert.equal(ok.values.sitemap, false);
  assert.deepEqual(parseCli(['reference', 'pages', '--slug', 'x']).positionals, ['pages']);
  assert.equal(parseCli(['reference', 'plan', '--slug', 'x', '--source', 'P07']).values.source, 'P07');
  assert.deepEqual(parseCli(['reference', 'shot', '--slug', 'x', '--source', 'P00']).positionals, ['shot']);
  assert.throws(() => parseCli(['reference', 'shot', '--slug', 'x', '--source', 'index']), /метка карты сайта/);
  assert.deepEqual(parseCli(['reference', 'audit', '--slug', 'x', '--source', 'P00']).positionals, ['audit']);
  assert.throws(() => parseCli(['reference', 'plan', '--slug', 'x', '--source', 'index']), /--page/);
  assert.throws(() => parseCli(['reference', 'plan', '--slug', 'x', '--source', 'P07', '--zone', 'content']), /ролью метки/);
  assert.throws(() => parseCli(['reference', 'plan', '--slug', 'x', '--source', 'index', '--page', '200002', '--zone', 'bad']), /--zone/);
  assert.equal(parseCli(['reference', 'plan', '--slug', 'x', '--source', 'index', '--page', '200002', '--zone', 'content']).values.zone, 'content');
  assert.equal(parseCli(['reference', 'fetch', '--slug', 'x', '--url', 'https://ref.test/', '--sitemap']).values.sitemap, true);

  // Оформление переносится по умолчанию; --no-styles его отключает.
  assert.equal(parseCli(['reference', 'plan', '--slug', 'demo', '--source', 'index', '--page', '200002']).values.styles, true);
  assert.equal(parseCli(['reference', 'plan', '--slug', 'demo', '--source', 'index', '--page', '200002', '--no-styles']).values.styles, false);
  assert.equal(parseCli(['reference', 'plan', '--slug', 'demo', '--source', 'index', '--page', '200002', '--styles']).values.styles, true);

  // Замена шаблона: пары можно повторять и перечислять через запятую; невалидная пара — отказ до сети.
  const base = ['reference', 'plan', '--slug', 'demo', '--source', 'index', '--page', '200002'];
  assert.deepEqual(parseCli([...base, '--substitute', '770=228']).values.substitute, ['770=228']);
  assert.deepEqual(parseCli([...base, '--substitute', '770=228,835=580']).values.substitute, ['770=228,835=580']);
  assert.deepEqual(parseCli([...base, '--substitute', '770=228', '--substitute', '835=580']).values.substitute, ['770=228', '835=580']);
  assert.throws(() => parseCli([...base, '--substitute', 'abc']), UsageError);
  assert.throws(() => parseCli([...base, '--substitute', '770']), UsageError);
});

test('parseCli accepts page list without --page and keeps --page mandatory for publish', () => {
  const list = parseCli(['page', 'list']);
  assert.equal(list.cmd, 'page');
  assert.deepEqual(list.positionals, ['list']);
  assert.equal(list.values.page, undefined);
  assert.equal(parseCli(['page', 'list', '--json', '--out', 'pages.json']).values.out, 'pages.json');
  assert.throws(() => parseCli(['page', 'lists']), UsageError);
  assert.throws(() => parseCli(['page', 'publish']), UsageError);
});

test('parseCli accepts browser show|hide and rejects unknown browser actions', () => {
  assert.equal(parseCli(['browser', 'show']).positionals[0], 'show');
  assert.equal(parseCli(['browser', 'hide']).positionals[0], 'hide');
  assert.throws(() => parseCli(['browser', 'peek']), /show\|hide/);
  assert.throws(() => parseCli(['browser']), UsageError);
});

test('parseCli validates catalog actions', () => {
  assert.throws(() => parseCli(['catalog']), UsageError);
  assert.throws(() => parseCli(['catalog', 'capture', '--slug', 'demo']), /--page/);
  assert.throws(() => parseCli(['catalog', 'capture', '--page', '200002']), /--slug|--tplid/);
  assert.throws(() => parseCli(['catalog', 'capture', '--page', '200002', '--tplid', '796,x']), /--tplid/);
  assert.equal(parseCli(['catalog', 'capture', '--page', '100001', '--tplid', '30', '--force']).values.force, true);
  assert.equal(parseCli(['page', 'role', '--header', '100001']).values.header, '100001');
  assert.equal(parseCli(['page', 'role', '--footer', 'none']).values.footer, 'none');
  assert.throws(() => parseCli(['page', 'role']), /--header/);
  assert.throws(() => parseCli(['page', 'role', '--header', 'abc']), /--header/);
  const index = parseCli(['page', 'role', '--index', '100001', '--confirm']).values;
  assert.equal(index.index, '100001');
  assert.equal(index.confirm, true);
  assert.throws(() => parseCli(['page', 'role', '--index', 'none']), /--index ждёт pageid/);
  assert.throws(() => parseCli(['page', 'role', '--index', '100001', '--header', '100002']), /отдельно от --header/);
  const capture = parseCli(['catalog', 'capture', '--page', '200002', '--tplid', '796,702']);
  assert.deepEqual([capture.cmd, capture.positionals[0], capture.values.tplid], ['catalog', 'capture', '796,702']);
  const list = parseCli(['catalog', 'list']);
  assert.deepEqual([list.cmd, list.positionals], ['catalog', ['list']]);
});

test('reference structure runs without online configuration and reports a missing snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-ref-'));
  try {
    const env = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_REFERENCE_DIR: root };
    delete env.TILDA_PROJECT_ID;
    delete env.TILDA_DEFAULT_PAGE;
    delete env.TILDA_PROTECTED_PAGES;
    const result = spawnSync(process.execPath, [cli, 'reference', 'structure', '--slug', 'missing'], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /NO_MANIFEST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCli accepts --donor only for browser and session and refuses --page with session --donor', () => {
  assert.equal(parseCli(['browser', 'status', '--donor']).values.donor, true);
  assert.equal(parseCli(['session', '--donor']).values.donor, true);
  assert.equal(parseCli(['session']).values.donor, false);
  assert.throws(() => parseCli(['inventory', '--donor']), /--donor/);
  assert.throws(() => parseCli(['session', '--donor', '--page', '200002']), /session --donor/);
});

test('donor commands refuse missing or clashing donor configuration before creating a profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-donor-'));
  const donorProfile = join(root, 'donor');
  const testProfile = join(root, 'test');
  try {
    for (const args of [['browser', '--donor', 'status'], ['session', '--donor']]) {
      const env = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: testProfile };
      for (const k of ['TILDA_PROJECT_ID', 'TILDA_DEFAULT_PAGE', 'TILDA_PROTECTED_PAGES', 'TILDA_DONOR_PROJECT_ID', 'TILDA_DONOR_BROWSER_PROFILE']) delete env[k];
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
      assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout + result.stderr, /TILDA_DONOR_PROJECT_ID|CONFIG_ERROR/);
    }
    const env = {
      ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: testProfile, TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '',
      TILDA_DONOR_PROJECT_ID: '100001', TILDA_DONOR_BROWSER_PROFILE: donorProfile,
    };
    const clash = spawnSync(process.execPath, [cli, 'browser', '--donor', 'status'], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(clash.status, 2, `${clash.stdout}\n${clash.stderr}`);
    assert.match(clash.stdout + clash.stderr, /must differ/);
    assert.equal(existsSync(donorProfile), false, 'отказ конфигурации должен быть до создания каталога профиля донора');
    assert.equal(existsSync(testProfile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCli validates donor actions and refuses the --donor flag for the donor command', () => {
  assert.deepEqual(parseCli(['donor', 'pages']).positionals, ['pages']);
  assert.equal(parseCli(['donor', 'map', '--slug', 'demo']).values.slug, 'demo');
  assert.throws(() => parseCli(['donor']), UsageError);
  assert.throws(() => parseCli(['donor', 'list']), /pages\|map/);
  assert.throws(() => parseCli(['donor', 'map']), /--slug/);
  assert.throws(() => parseCli(['donor', 'pages', '--donor']), /роль задаёт сама команда/);
});

test('donor pages refuses missing donor configuration before creating a profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-donor-pages-'));
  const donorProfile = join(root, 'donor');
  try {
    const env = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: join(root, 'test'), TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '' };
    for (const k of ['TILDA_DEFAULT_PAGE', 'TILDA_DONOR_PROJECT_ID', 'TILDA_DONOR_BROWSER_PROFILE']) delete env[k];
    const result = spawnSync(process.execPath, [cli, 'donor', 'pages'], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /TILDA_DONOR_PROJECT_ID|CONFIG_ERROR/);
    assert.equal(existsSync(donorProfile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCli validates donor copy flags', () => {
  assert.equal(parseCli(['donor', 'copy', '--slug', 'demo', '--source', 'P13']).values.source, 'P13');
  assert.equal(parseCli(['donor', 'copy', '--slug', 'demo', '--source', 'P13', '--dry-run'])['values']['dry-run'], true);
  assert.equal(parseCli(['donor', 'copy', '--slug', 'demo', '--from', '200002', '--to', '200003', '--replace']).values.replace, true);
  assert.throws(() => parseCli(['donor', 'copy', '--source', 'P13']), /--slug/);
  assert.throws(() => parseCli(['donor', 'copy', '--slug', 'demo', '--source', 'index']), /метк/);
  assert.throws(() => parseCli(['donor', 'copy', '--slug', 'demo']), /--source/);
  assert.throws(() => parseCli(['donor', 'copy', '--slug', 'demo', '--from', '200002', '--to', '200002']), /совпадают/);
  assert.throws(() => parseCli(['donor', 'copy', '--slug', 'demo', '--from', '200002']), /--to/);
  assert.throws(() => parseCli(['donor', 'copy', '--slug', 'demo', '--from', 'x', '--to', '200003']), /--from/);
});

test('donor copy refuses missing configuration and a missing site map before creating profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-donor-copy-'));
  const donorProfile = join(root, 'donor');
  const testProfile = join(root, 'test');
  try {
    const base = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: testProfile, TILDA_REFERENCE_DIR: join(root, 'ref') };
    for (const k of ['TILDA_PROJECT_ID', 'TILDA_DEFAULT_PAGE', 'TILDA_PROTECTED_PAGES', 'TILDA_DONOR_PROJECT_ID', 'TILDA_DONOR_BROWSER_PROFILE']) delete base[k];
    const noConfig = spawnSync(process.execPath, [cli, 'donor', 'copy', '--slug', 'x', '--source', 'P00'], { encoding: 'utf8', env: base, timeout: 10_000 });
    assert.equal(noConfig.status, 2, `${noConfig.stdout}\n${noConfig.stderr}`);
    const env = { ...base, TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '', TILDA_DONOR_PROJECT_ID: '100002', TILDA_DONOR_BROWSER_PROFILE: donorProfile };
    const noSite = spawnSync(process.execPath, [cli, 'donor', 'copy', '--slug', 'x', '--source', 'P00'], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(noSite.status, 1, `${noSite.stdout}\n${noSite.stderr}`);
    assert.match(noSite.stdout, /нет в site\.json/);
    assert.equal(existsSync(donorProfile), false);
    assert.equal(existsSync(testProfile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('donor style --apply without --confirm refuses before any browser starts', () => {
  assert.throws(() => parseCli(['donor', 'style']), /--slug/);
  assert.equal(parseCli(['donor', 'style', '--slug', 'demo', '--apply', '--confirm']).values.apply, true);
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-donor-style-'));
  const donorProfile = join(root, 'donor');
  const testProfile = join(root, 'test');
  try {
    const env = { ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: testProfile, TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '', TILDA_DONOR_PROJECT_ID: '100002', TILDA_DONOR_BROWSER_PROFILE: donorProfile };
    delete env.TILDA_DEFAULT_PAGE;
    const result = spawnSync(process.execPath, [cli, 'donor', 'style', '--slug', 'x', '--apply'], { encoding: 'utf8', env, timeout: 10_000 });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /--confirm/);
    assert.equal(existsSync(donorProfile), false);
    assert.equal(existsSync(testProfile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCli requires an explicit page and a title for page title', () => {
  assert.equal(parseCli(['page', 'title', '--page', '200002', '--title', 'x']).values.title, 'x');
  assert.throws(() => parseCli(['page', 'title', '--page', '200002']), /--title/);
  assert.throws(() => parseCli(['page', 'title', '--title', 'x']), /--page/);
});

test('parseCli validates donor verify flags', () => {
  assert.equal(parseCli(['donor', 'verify', '--slug', 'x', '--source', 'P00']).values.source, 'P00');
  assert.equal(parseCli(['donor', 'verify', '--slug', 'x', '--source', 'P00', '--width', '1440,x']).values.width, '1440,x');
  assert.throws(() => parseCli(['donor', 'verify', '--source', 'P00']), /--slug/);
  assert.throws(() => parseCli(['donor', 'verify', '--slug', 'x', '--source', 'index']), UsageError);
  assert.throws(() => parseCli(['donor', 'verify', '--slug', 'x']), /--source/);
});

test('parseCli validates donor aliases flags', () => {
  assert.equal(parseCli(['donor', 'aliases', '--slug', 'x']).values.slug, 'x');
  assert.equal(parseCli(['donor', 'aliases', '--slug', 'x', '--dry-run'])['values']['dry-run'], true);
  assert.throws(() => parseCli(['donor', 'aliases']), /--slug/);
});

test('parseCli validates donor links flags', () => {
  const r = parseCli(['donor', 'links', '--slug', 'x', '--source', 'HDR', '--dry-run']);
  assert.equal(r.values.source, 'HDR');
  assert.equal(r.values['dry-run'], true);
  assert.throws(() => parseCli(['donor', 'links', '--slug', 'x']), /--source/);
  assert.throws(() => parseCli(['donor', 'links', '--source', 'HDR']), /--slug/);
});

test('parseCli validates donor check flags', () => {
  assert.equal(parseCli(['donor', 'check', '--slug', 'x']).values.slug, 'x');
  assert.equal(parseCli(['donor', 'check', '--slug', 'x', '--source', 'P01,P02']).values.source, 'P01,P02');
  assert.throws(() => parseCli(['donor', 'check']), /--slug/);
  assert.throws(() => parseCli(['donor', 'check', '--slug', 'x', '--source', 'P01,index']), /через запятую/);
});

test('donor aliases, links and check need the donor project id but not the donor browser profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-donor-offline-'));
  const testProfile = join(root, 'test');
  const runs = [['donor', 'aliases', '--slug', 'demo', '--dry-run'], ['donor', 'links', '--slug', 'demo', '--source', 'P01', '--dry-run'], ['donor', 'check', '--slug', 'demo']];
  const base = {
    ...process.env, LOG_LEVEL: 'ERROR', TILDA_BROWSER_PROFILE: testProfile, TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '',
    TILDA_REFERENCE_DIR: join(root, 'ref'), TILDA_BASELINE_DIR: join(root, 'baseline'),
  };
  try {
    for (const args of runs) {
      const env = { ...base, TILDA_DONOR_PROJECT_ID: '100002' };
      for (const k of ['TILDA_DEFAULT_PAGE', 'TILDA_DONOR_BROWSER_PROFILE']) delete env[k];
      const ok = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
      assert.doesNotMatch(ok.stdout + ok.stderr, /TILDA_DONOR_BROWSER_PROFILE/, `${args.join(' ')}: профиль донора не нужен`);
      assert.match(ok.stdout, /карты сайта demo нет|нет карты|site\.json/, `${args.join(' ')}: доходит до своей проверки\n${ok.stdout}\n${ok.stderr}`);
      const noDonor = { ...base };
      for (const k of ['TILDA_DEFAULT_PAGE', 'TILDA_DONOR_PROJECT_ID', 'TILDA_DONOR_BROWSER_PROFILE']) delete noDonor[k];
      const refused = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: noDonor, timeout: 10_000 });
      assert.equal(refused.status, 2, `${args.join(' ')}: без ID донора — отказ конфигурации\n${refused.stdout}\n${refused.stderr}`);
      assert.match(refused.stdout + refused.stderr, /TILDA_DONOR_PROJECT_ID/);
    }
    assert.equal(existsSync(testProfile), false, 'браузер не запускается');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Окружение для запуска CLI без данных сайта: ни сайта, ни явных папок данных. */
function bareEnv(extra = {}) {
  const env = { ...process.env, LOG_LEVEL: 'ERROR', ...extra };
  for (const k of ['TILDA_SITE_DIR', 'TILDA_BASELINE_DIR', 'TILDA_REFERENCE_DIR', 'TILDA_BROWSER_PROFILE', 'TILDA_CATALOG_DIR', 'TILDA_DEFAULT_PAGE', 'TILDA_PROJECT_ID', 'TILDA_PROTECTED_PAGES', 'TILDA_DONOR_PROJECT_ID', 'TILDA_DONOR_BROWSER_PROFILE']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

const runCli = (args, env) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });

test('без выбранного сайта команды с данными отказывают кодом 2 и ничего не создают в репозитории', () => {
  const env = bareEnv({ TILDA_PROJECT_ID: '100001', TILDA_PROTECTED_PAGES: '' });
  const guarded = ['site-baseline', 'site-reference', '.browser-profile', join('scripts', 'plans')].map((p) => join(repoDir, p));
  const before = guarded.map((p) => existsSync(p));
  for (const args of [['journal', '--page', '100001'], ['page', 'list'], ['catalog', 'list'], ['reference', 'structure', '--slug', 'demo']]) {
    const result = runCli(args, env);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /CONFIG_ERROR/, args.join(' '));
  }
  assert.deepEqual(guarded.map((p) => existsSync(p)), before, 'данные не должны появляться в корне репозитория');
});

test('--site подгружает .env сайта и берёт из него общий каталог шаблонов', () => {
  const site = mkdtempSync(join(tmpdir(), 'tilda-cli-site-'));
  try {
    mkdirSync(join(site, 'catalog'));
    writeFileSync(join(site, '.env'), 'TILDA_PROJECT_ID=100001\nTILDA_PROTECTED_PAGES=\nTILDA_CATALOG_DIR=./catalog\n');
    const result = runCli(['--site', site, 'catalog', 'list', '--json'], bareEnv());
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(resolve(JSON.parse(result.stdout).dir), resolve(site, 'catalog'));
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('папка сайта внутри репозитория — отказ кодом 2', () => {
  const result = runCli(['--site', join(repoDir, 'docs'), 'catalog', 'list'], bareEnv());
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout + result.stderr, /TILDA_SITE_DIR/);
});

test('ID проекта в окружении и в .env сайта с разными значениями — отказ без значений в выводе', () => {
  const site = mkdtempSync(join(tmpdir(), 'tilda-cli-conflict-'));
  try {
    writeFileSync(join(site, '.env'), 'TILDA_PROJECT_ID=100001\n');
    const result = runCli(['--site', site, 'catalog', 'list'], bareEnv({ TILDA_PROJECT_ID: '100002' }));
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.match(out, /TILDA_PROJECT_ID/);
    assert.doesNotMatch(out, /100001|100002/);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('--site и TILDA_SITE_DIR на разные папки — отказ кодом 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-two-sites-'));
  try {
    for (const name of ['a', 'b']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, '.env'), 'TILDA_PROJECT_ID=100001\n');
    }
    const result = runCli(['--site', join(root, 'a'), 'catalog', 'list'], bareEnv({ TILDA_SITE_DIR: join(root, 'b') }));
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /разные папки/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ID проекта только в окружении, а в .env сайта его нет — отказ кодом 2 без значения в выводе', () => {
  const site = mkdtempSync(join(tmpdir(), 'tilda-cli-orphan-'));
  try {
    writeFileSync(join(site, '.env'), 'TILDA_PROTECTED_PAGES=\n');
    const result = runCli(['--site', site, 'catalog', 'list'], bareEnv({ TILDA_PROJECT_ID: '100002' }));
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.match(out, /TILDA_PROJECT_ID/);
    assert.match(out, /только в окружении/);
    assert.doesNotMatch(out, /100002/);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});

test('parseCli accepts doctor without positionals and usage lists it', () => {
  assert.equal(parseCli(['doctor']).cmd, 'doctor');
  assert.equal(parseCli(['doctor', '--json', '--site', 'x']).values.json, true);
  assert.throws(() => parseCli(['doctor', 'x']), UsageError);
  assert.match(usage(), /doctor/);
});

test('doctor без сайта печатает отчёт, пропускает пункт site и не создаёт профиль браузера', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-doctor-'));
  try {
    const profile = join(root, 'profile');
    const result = runCli(['doctor', '--json'], bareEnv({ TILDA_BROWSER_PROFILE: profile }));
    assert.ok([0, 1].includes(result.status), `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.checks.map((check) => check.id), ['node', 'dependencies', 'chrome', 'git', 'repo-env', 'site', 'skill']);
    assert.equal(report.checks.find((check) => check.id === 'site').status, 'skip');
    assert.equal(existsSync(profile), false, 'doctor не должен создавать профиль браузера');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor с несуществующей папкой сайта отвечает провалом пункта site, а не кодом 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-doctor-'));
  try {
    const result = runCli(['--site', join(root, 'no-such-site'), 'doctor', '--json'], bareEnv());
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const site = JSON.parse(result.stdout).checks.find((check) => check.id === 'site');
    assert.equal(site.status, 'fail');
    assert.match(site.fix, /setup/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCli validates setup flags', () => {
  assert.throws(() => parseCli(['setup']), UsageError);
  assert.throws(() => parseCli(['setup', '--agent', 'vim']), UsageError);
  assert.throws(() => parseCli(['setup', '--agent', 'claude', '--project', '1000000000001']), UsageError);
  assert.throws(() => parseCli(['setup', '--site=']), UsageError);
  assert.throws(() => parseCli(['setup', '--site', 'x', 'extra']), UsageError);
  assert.throws(() => parseCli(['doctor', '--agent', 'claude']), UsageError);
  assert.throws(() => parseCli(['journal', '--project', '1000000000001']), UsageError);
  assert.equal(parseCli(['setup', '--agent', 'all']).cmd, 'setup');
  assert.equal(parseCli(['setup', '--site', 'x', '--project', '1000000000001']).values.project, '1000000000001');
  assert.match(usage(), /setup/);
  assert.match(usage(), /--agent/);
});

test('setup создаёт папку сайта и .env вне репозитория и не трогает папки агентов', () => {
  const root = mkdtempSync(join(tmpdir(), 'tilda-cli-setup-'));
  try {
    const site = join(root, 'site');
    const guarded = ['.claude', '.agents'].map((name) => join(repoDir, name, 'skills', 'tilda-manager'));
    const before = guarded.map((path) => existsSync(path));
    const result = runCli(['setup', '--site', site, '--project', '1000000000001', '--json'], bareEnv());
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.site.env, 'created');
    assert.equal(existsSync(join(site, '.env')), true);
    assert.deepEqual(guarded.map((path) => existsSync(path)), before, 'без --agent копии скилла не создаются');

    const doctor = runCli(['--site', site, 'doctor', '--json'], bareEnv());
    const check = JSON.parse(doctor.stdout).checks.find((item) => item.id === 'site');
    assert.ok(['ok', 'warn'].includes(check.status), `site: ${check.status} ${check.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup с папкой сайта внутри репозитория — отказ кодом 2 и ничего не создаёт', () => {
  const target = join(repoDir, 'docs', 'setup-should-not-exist');
  const result = runCli(['setup', '--site', target], bareEnv());
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(target), false);
});
