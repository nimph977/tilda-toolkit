import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWidthSpec, parseSweepArgs, cdpTarget, boxesOverlap, checkBoxes, relativeBoxes, verticalGaps } from '../layout-sweep.mjs';
import { t } from '../lib/i18n.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

const script = fileURLToPath(new URL('../layout-sweep.mjs', import.meta.url));

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
const el = (id, type, b, extra = {}) => ({ id, type, visible: true, box: b, clipped: false, scrollHeight: 0, clientHeight: 0, text: id, ...extra });

test('parseWidthSpec: диапазон с шагом, хвост, перечисление, ошибки', () => {
  assert.deepEqual(parseWidthSpec('320-1440:40').slice(0, 3), [320, 360, 400]);
  assert.equal(parseWidthSpec('320-1440:40').length, 29);
  assert.deepEqual(parseWidthSpec('320-500:100'), [320, 420, 500]);
  assert.deepEqual(parseWidthSpec('320, 375,768'), [320, 375, 768]);
  assert.deepEqual(parseWidthSpec(undefined), parseWidthSpec('320-1440:40'));
  assert.throws(() => parseWidthSpec('900-300'), /invalid range/);
  assert.throws(() => parseWidthSpec('abc'), /empty/);
});

test('boxesOverlap: порог по обеим осям', () => {
  assert.deepEqual(boxesOverlap(box(0, 0, 100, 50), box(50, 20, 100, 50)), { w: 50, h: 30 });
  assert.equal(boxesOverlap(box(0, 0, 100, 50), box(100, 0, 100, 50)), null);
  assert.equal(boxesOverlap(box(0, 0, 100, 50), box(97, 0, 100, 50)), null, 'касание в 3 px — не пересечение');
  assert.equal(boxesOverlap(box(0, 0, 100, 50), box(0, 48, 100, 50)), null, 'по вертикали 2 px — не пересечение');
});

test('checkBoxes: overflow, outside, below, clipped, overlap; фигуры не считаются', () => {
  const env = { innerWidth: 320, blockBottom: 1000, scrollWidth: 340 };
  const elems = [
    el('bg', 'shape', box(-500, 0, 1700, 1000)),                        // фигура за краем — не нарушение
    el('t1', 'text', box(66, 900, 323, 19)),                            // правый край 389 > 320 → outside
    el('t2', 'text', box(10, 990, 200, 40), { clipped: true, scrollHeight: 60, clientHeight: 40 }), // below + clipped
    el('t3', 'text', box(10, 100, 200, 40)),
    el('t4', 'text', box(100, 120, 200, 40)),                           // пересекает t3 на 110×20
    el('hid', 'text', box(0, 0, 1000, 1000), { visible: false }),      // скрытый не считается
  ];
  const kinds = checkBoxes(elems, env).map((i) => `${i.kind}:${i.elem || ''}${i.other ? '+' + i.other : ''}`).sort();
  assert.deepEqual(kinds, ['below:t2', 'clipped:t2', 'outside:t1', 'overflow:', 'overlap:t3+t4']);
});

test('checkBoxes: кнопка, целиком накрытая формой — приём шаблона; частично — нарушение', () => {
  const env = { innerWidth: 1200, blockBottom: 2000, scrollWidth: 1200 };
  const full = [el('f', 'form', box(80, 800, 1035, 90)), el('b', 'button', box(785, 800, 330, 90))];
  assert.deepEqual(checkBoxes(full, env), []);
  const shifted = [el('f', 'form', box(315, 1396, 330, 310)), el('b', 'button', box(315, 1641, 330, 90))];
  const issues = checkBoxes(shifted, env);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'overlap');
  assert.equal(issues[0].detail, '330×65 px');
});

test('relativeBoxes: целые px от угла блока, фигуры входят, скрытые нет', () => {
  const elems = [
    el('bg', 'shape', box(-490, 1000, 1700, 400)),
    el('t1', 'text', box(10.4, 1000.6, 200.5, 19.4)),
    el('hid', 'text', box(0, 0, 1000, 1000), { visible: false }),
  ];
  assert.deepEqual(relativeBoxes(elems, { blockLeft: 10, blockTop: 1000 }), [
    { id: 'bg', type: 'shape', left: -500, top: 0, width: 1700, height: 400 },
    { id: 't1', type: 'text', left: 0, top: 1, width: 201, height: 19 },
  ]);
});

test('verticalGaps: колонка из трёх элементов — зазор до ближайшего сверху, порядок по top', () => {
  const elems = [
    el('t3', 'text', box(10, 130, 200, 20)),
    el('t1', 'text', box(10, 0, 200, 50)),
    el('t2', 'text', box(10, 70, 200, 30)),
  ];
  assert.deepEqual(verticalGaps(elems), [
    { elem: 't2', above: 't1', gap: 20 },
    { elem: 't3', above: 't2', gap: 30 },
  ]);
});

test('verticalGaps: ближайший сверху — с наибольшим bottom; без перекрытия по горизонтали записи нет', () => {
  const elems = [
    el('a1', 'text', box(0, 0, 100, 20)),
    el('a2', 'text', box(0, 30, 100, 40)),   // bottom 70 — ближе к b, чем a1
    el('b', 'text', box(50, 100, 100, 20)),
    el('side', 'text', box(100, 200, 100, 20)), // с a1/a2 только касается краем (100), с b перекрывается по 50 px
    el('far', 'text', box(400, 300, 50, 20)),   // над ним по горизонтали никого — записи нет
  ];
  assert.deepEqual(verticalGaps(elems), [
    { elem: 'a2', above: 'a1', gap: 10 },
    { elem: 'b', above: 'a2', gap: 30 },
    { elem: 'side', above: 'b', gap: 80 },
  ]);
});

test('verticalGaps: касание краями по горизонтали — не перекрытие', () => {
  const elems = [el('a', 'text', box(0, 0, 100, 50)), el('b', 'text', box(100, 100, 100, 50))];
  assert.deepEqual(verticalGaps(elems), []);
});

test('verticalGaps: наложение — отрицательный зазор; -0 приводится к 0', () => {
  const overlapping = [el('a', 'text', box(0, 0, 100, 50)), el('b', 'text', box(0, 40, 100, 50))];
  assert.deepEqual(verticalGaps(overlapping), [{ elem: 'b', above: 'a', gap: -10 }]);
  const almost = [el('a', 'text', box(0, 0, 100, 50.4)), el('b', 'text', box(0, 50, 100, 20))];
  assert.deepEqual(verticalGaps(almost), [{ elem: 'b', above: 'a', gap: 0 }]);
});

test('verticalGaps: фигура и скрытый элемент не участвуют ни сверху, ни снизу', () => {
  const elems = [
    el('bg', 'shape', box(-500, 0, 1700, 1000)),   // на весь блок — иначе стала бы «ближайшей сверху» для всех
    el('t1', 'text', box(10, 100, 200, 50)),
    el('hid', 'text', box(10, 160, 200, 200), { visible: false }),
    el('t2', 'text', box(10, 200, 200, 20)),
  ];
  assert.deepEqual(verticalGaps(elems), [{ elem: 't2', above: 't1', gap: 50 }]);
});

test('cdpTarget: внешний Chrome главнее держателя; держатель без порта и пустой выбор — null', () => {
  const external = { url: 'http://127.0.0.1:9222', port: 9222 };
  assert.deepEqual(cdpTarget({ external, holder: { port: 5555 } }), { source: 'external', url: 'http://127.0.0.1:9222' });
  assert.deepEqual(cdpTarget({ external }), { source: 'external', url: 'http://127.0.0.1:9222' });
  assert.deepEqual(cdpTarget({ external: null, holder: { port: 5555 } }), { source: 'holder', url: 'http://127.0.0.1:5555' });
  assert.equal(cdpTarget({ external: null, holder: {} }), null, 'держатель без порта');
  assert.equal(cdpTarget({ external: null, holder: null }), null);
  assert.equal(cdpTarget(), null);
});

test('parseSweepArgs: --site разобран, без него undefined, неизвестный флаг — исключение', () => {
  const withSite = parseSweepArgs(['--site', '/tmp/site', '--page', '100001', '--block', '100002', '--widths', '320,640']);
  assert.deepEqual({ ...withSite }, { site: '/tmp/site', page: '100001', block: '100002', widths: '320,640' }); // parseArgs возвращает объект без прототипа
  const withoutSite = parseSweepArgs(['--page', '100001', '--block', '100002']);
  assert.equal(withoutSite.site, undefined);
  assert.throws(() => parseSweepArgs(['--bogus']), TypeError);
});

// Подпроцесс: окружение без TILDA_*, папки сайтов и их .env — во временной папке ОС, вне репозитория.
function sweepEnv(extra = {}) {
  const env = { ...process.env, LOG_LEVEL: 'DEBUG' };
  for (const key of Object.keys(env)) if (key.startsWith('TILDA_')) delete env[key];
  return { ...env, ...extra };
}

function runSweep(args, extraEnv) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: sweepEnv(extraEnv), timeout: 20_000 });
}

/** Временная папка сайта; `.env` пишется, если передан текст. Удаляется после `fn`. */
function withSites(envTexts, fn) {
  const root = mkdtempSync(join(tmpdir(), 'tilda-sweep-'));
  try {
    const sites = envTexts.map((text, i) => {
      const dir = join(root, `site${i}`);
      mkdirSync(dir);
      if (text !== null) writeFileSync(join(dir, '.env'), text);
      return dir;
    });
    return fn(...sites);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SWEEP_ARGS = ['--page', '100001', '--block', '100002'];
const ENV_BASE = 'TILDA_PROJECT_ID=100001\nTILDA_PROTECTED_PAGES=\n';
const ENV_EXTERNAL = `${ENV_BASE}TILDA_BROWSER_CDP=http://127.0.0.1:1\n`;

/** Сбой без итоговой строки (контракт обёртки: код 1 без `total issues` — сбой). */
function assertFailure(result) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /total issues/);
}

test('layout-sweep --site без .env: отказ папки сайта, держатель не проверяется', () => {
  withSites([null], (site) => {
    const result = runSweep(['--site', site, ...SWEEP_ARGS]);
    assertFailure(result);
    assert.ok(result.stderr.includes(t('en', 'site.noEnv', { dir: site })), result.stderr);
    assert.doesNotMatch(result.stderr, /the browser holder is not running/);
  });
});

test('layout-sweep: TILDA_BROWSER_CDP из .env сайта выбирает внешний Chrome, а не держатель', () => {
  withSites([ENV_EXTERNAL], (site) => {
    const result = runSweep(['--site', site, ...SWEEP_ARGS]);
    assertFailure(result);
    assert.match(result.stderr, /127\.0\.0\.1:1/);
    assert.match(result.stderr, /"source":"external"/);
    assert.doesNotMatch(result.stderr, /the browser holder is not running/);
  });
});

test('layout-sweep: папка сайта из TILDA_SITE_DIR без --site даёт тот же результат', () => {
  withSites([ENV_EXTERNAL], (site) => {
    const result = runSweep(SWEEP_ARGS, { TILDA_SITE_DIR: site });
    assertFailure(result);
    assert.match(result.stderr, /127\.0\.0\.1:1/);
    assert.match(result.stderr, /"source":"external"/);
    assert.doesNotMatch(result.stderr, /the browser holder is not running/);
  });
});

test('layout-sweep: --site и TILDA_SITE_DIR на разные папки — отказ', () => {
  withSites([ENV_EXTERNAL, ENV_EXTERNAL], (a, b) => {
    const result = runSweep(['--site', a, ...SWEEP_ARGS], { TILDA_SITE_DIR: b });
    assertFailure(result);
    assert.ok(result.stderr.includes(t('en', 'site.dirsDiffer', { flag: a, env: b })), result.stderr);
  });
});

test('layout-sweep без --page: код 2, прежний контракт', () => {
  const result = runSweep(['--block', '100002']);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--page <pageid> --block <recordid> are required/);
  assert.doesNotMatch(result.stdout, /total issues/);
});

test('layout-sweep без TILDA_BROWSER_CDP и без держателя: прежняя ошибка про держатель', () => {
  withSites([ENV_BASE], (site) => {
    const result = runSweep(['--site', site, ...SWEEP_ARGS]);
    assertFailure(result);
    assert.match(result.stderr, /the browser holder is not running: node scripts\/tilda\.mjs browser start/);
  });
});

test('formFieldChanges: удаление элемента формы целиком допускается, правка поля — нет', async () => {
  const { formFieldChanges } = await import('../lib/form-fields.mjs');
  const before = { 0: { elem_id: 'a', elem_type: 'form', receivers: 'x', inputs: '[]' }, 1: { elem_id: 'b', elem_type: 'text', text: 't' } };
  assert.deepEqual(formFieldChanges(before, { 1: before[1] }), []);
  assert.deepEqual(formFieldChanges(before, { 0: { ...before[0], receivers: 'y' }, 1: before[1] }), [{ key: '0', field: 'receivers' }]);
  assert.deepEqual(formFieldChanges({ 1: before[1] }, before).map((c) => c.field), ['receivers', 'inputs']);
});
