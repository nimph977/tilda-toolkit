import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogLevel } from '../lib/log.mjs';
import { calibrateCatalog, toFieldList } from '../calibrate.mjs';
import { settingsMapPath, loadSettingsMap, listCatalog } from '../catalog.mjs';

setLogLevel('ERROR');

// Идентификаторы синтетические, 13 знаков (правило no-real-ids).
const PAGE = '1000000000001';
const REC = '1000000000002';

function setup() {
  const baseDir = mkdtempSync(join(tmpdir(), 'calibrate-'));
  mkdirSync(join(baseDir, 'catalog'), { recursive: true });
  const put = (tplid, entry) => writeFileSync(join(baseDir, 'catalog', `${tplid}.json`), JSON.stringify({ tplid, capturedAt: 'T', ...entry }));
  put('686', { available: true, tabs: { content: [], settings: [] }, defaults: { btitle: 'Head' }, cardKeys: [], tplFields: ['btitle', 'buttontitle'] });
  put('770', { available: false });
  return { baseDir, opts: { baseDir } };
}

function makeDriver({ failMap = false } = {}) {
  const calls = [];
  const driver = {
    call: async (fn, args, opts) => {
      calls.push({ fn, args, opts });
      if (fn === 'addRecord') return { recordid: REC, tplid: args[1] };
      if (fn === 'readSettingsSchema') {
        return {
          tplid: '686',
          fields: [
            { name: 'blocks', type: 'sb', options: ['2', '3'], jsonFields: null, mobile: null, desktop: null },
            { name: 'filtercolor', type: 'co', options: null, jsonFields: null, mobile: null, desktop: null },
          ],
        };
      }
      if (fn === 'readRecordFields') return { blocks: '2' };
      if (fn === 'previewRecord') {
        if (failMap) throw new Error('boom');
        const f = Object.fromEntries(args[2].map((x) => [x.name, x.value]));
        const color = f.filtercolor || '#000000';
        return { html: `<div id="rec${REC}" class="t686 t-col_${f.blocks === '3' ? 4 : 6}" style="color:${color}"></div>` };
      }
      if (fn === 'deleteRecord') return 'OK';
      throw new Error(`unexpected ${fn}`);
    },
  };
  return { driver, calls };
}

test('calibrateCatalog writes a settings map, paces previews and deletes the temporary block', async () => {
  const { opts } = setup();
  const { driver, calls } = makeDriver();
  const sleeps = [];
  const r = await calibrateCatalog(driver, { pageid: PAGE, tplids: ['686', '770', '999'], delayMs: 11, batch: 3, pauseS: 2, sleep: async (ms) => sleeps.push(ms), now: () => 'NOW' }, opts);

  assert.deepEqual(r.calibrated.map((c) => c.tplid), ['686']);
  assert.deepEqual(r.skipped.map((s) => [s.tplid, s.reason.key]), [['770', 'calibrate.reason.templateUnavailable'], ['999', 'calibrate.reason.catalogNotCaptured']]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.previews, 5, 'база дважды + blocks=3 + два цвета');

  const map = loadSettingsMap('686', opts);
  assert.equal(map.version, 1);
  assert.equal(map.fields.blocks.rule.type, 'enum');
  assert.equal(map.fields.filtercolor.rule.type, 'slot');
  assert.equal(map.fields.filtercolor.rule.encoding, 'hex');
  assert.equal(map.schema.blocks.kind, 'enum');

  const add = calls.find((c) => c.fn === 'addRecord');
  assert.deepEqual(add.opts, { attempts: 1 });
  assert.ok(calls.some((c) => c.fn === 'deleteRecord' && c.args[1] === REC));
  assert.ok(sleeps.includes(11));
  assert.ok(sleeps.includes(2000), 'пауза после пачки');
  const preview = calls.find((c) => c.fn === 'previewRecord');
  assert.ok(preview.args[2].some((f) => f.name === 'buttontitle' && f.value === 'Button'), 'образец содержимого подставлен');

  assert.equal(listCatalog(opts).find((row) => row.tplid === '686').calibrated, true);

  const again = await calibrateCatalog(driver, { pageid: PAGE, tplids: ['686'], sleep: async () => {} }, opts);
  assert.deepEqual(again.skipped.map((s) => [s.tplid, s.reason.key]), [['686', 'calibrate.reason.alreadyCalibrated']]);
});

test('calibrateCatalog deletes the block and reports failure when previews keep failing', async () => {
  const { opts } = setup();
  const { driver, calls } = makeDriver({ failMap: true });
  const r = await calibrateCatalog(driver, { pageid: PAGE, tplids: ['686'], sleep: async () => {} }, opts);
  assert.equal(r.calibrated.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(existsSync(settingsMapPath('686', opts)), false);
  assert.ok(calls.some((c) => c.fn === 'deleteRecord'));
});

test('toFieldList expands list cards into card form fields', () => {
  const list = JSON.stringify([{ lid: '1', li_title: 'A', li_descr: 'B' }]);
  const f = toFieldList({ btitle: 'H', list });
  assert.deepEqual(f.slice(0, 2), [{ name: 'btitle', value: 'H' }, { name: 'list', value: list }]);
  assert.ok(f.some((x) => x.name === 'li_title' && x.value === 'A'));
});
