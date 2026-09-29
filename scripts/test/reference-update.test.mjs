import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogLevel } from '../lib/log.mjs';
import { updateReferencePlan } from '../reference-update.mjs';

setLogLevel('ERROR');

// Идентификаторы синтетические, 13 знаков (правило no-real-ids).
const PAGE = '1000000000031';
const R1 = '1000000000032';

test('updateReferencePlan reads live blocks and writes an update plan with field ops', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-update-'));
  try {
    mkdirSync(join(baseDir, 'x', 'structure'), { recursive: true });
    mkdirSync(join(baseDir, 'catalog'), { recursive: true });
    const structure = { name: 'index', url: 'https://ref.test/', blocks: [{ order: 1, recid: '1', tplid: '30', zone: 'content', fields: [{ name: 'title', text: 'Новый', href: null }], images: [], links: [], cards: [], hasForm: false, text: '' }] };
    writeFileSync(join(baseDir, 'x', 'structure', 'index.json'), JSON.stringify(structure));
    writeFileSync(join(baseDir, 'x', 'reference.json'), JSON.stringify({ slug: 'x', url: 'https://ref.test/', pages: [], images: {} }));
    writeFileSync(join(baseDir, 'x', 'site.json'), JSON.stringify({ slug: 'x', substitutes: {}, pages: [{ label: 'P00', role: 'content', name: 'index', url: 'https://ref.test/', pageid: PAGE }] }));
    writeFileSync(join(baseDir, 'catalog', '30.json'), JSON.stringify({ tplid: '30', available: true, tabs: { content: ['title'], settings: [] }, defaults: {}, cardKeys: [] }));
    const calls = [];
    const driver = {
      call: async (fn, args) => {
        calls.push(fn);
        if (fn === 'listRecords') return [{ recordid: R1, tplid: '30', hidden: false }, { recordid: '1000000000033', tplid: '212', hidden: true }];
        if (fn === 'readRecordFields') return { title: 'Старый' };
        throw new Error(`unexpected ${fn}`);
      },
    };
    const out = join(baseDir, 'plans', 'u.json');
    const r = await updateReferencePlan(driver, { slug: 'x', label: 'P00', pageid: PAGE, out, baseDir, catalogDir: baseDir, sleep: async () => {} });
    assert.equal(r.ops, 1);
    assert.equal(r.fields, 1);
    assert.deepEqual(calls, ['listRecords', 'readRecordFields'], 'скрытый блок не читается');
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(plan.page, PAGE);
    assert.deepEqual(plan.ops, [{ id: 'b1.title', block: { recordid: R1 }, field: { name: 'title', value: 'Новый' } }]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
