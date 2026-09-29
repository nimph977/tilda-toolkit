import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { PREVIEW_ARTIFACTS, compareTplidSequence, expectedTplids, extractVerdict, renderTransferReport, verifyTransferredPage } from '../donor-verify.mjs';

setLogLevel('ERROR');

test('expectedTplids filters by zone and applies substitutes', () => {
  const blocks = [{ tplid: '770', zone: 'header' }, { tplid: '686' }, { tplid: '396', zone: 'content' }, { tplid: '464', zone: 'footer' }];
  assert.deepEqual(expectedTplids(blocks, 'content', { 770: '794' }), ['686', '396']);
  assert.deepEqual(expectedTplids(blocks, 'header', { 770: '794' }), ['794']);
  assert.deepEqual(expectedTplids(blocks, 'all'), ['770', '686', '396', '464']);
});

test('compareTplidSequence names missing, extra and reordered blocks with positions', () => {
  assert.equal(compareTplidSequence(['770', '794'], ['770', '794']).equal, true);
  const missing = compareTplidSequence(['770', '794', '396'], ['770', '396']);
  assert.deepEqual([missing.equal, missing.reasons], [false, ['блок 794 отсутствует на позиции 2']]);
  const extra = compareTplidSequence(['770'], ['770', '212']);
  assert.deepEqual(extra.reasons, ['лишний блок 212 на позиции 2']);
  const swapped = compareTplidSequence(['770', '794'], ['794', '770']);
  assert.deepEqual([swapped.equal, swapped.reasons], [false, ['порядок отличается начиная с позиции 1']]);
});

test('renderTransferReport lists checks, artifacts, skipped project settings and an empty verdict section', () => {
  const base = {
    label: 'P13', at: '2026-09-24T10:00:00.000Z',
    composition: { equal: true, expected: ['770', '686'], actual: ['770', '686'], reasons: [] },
    markup: { meanScore: 0.97, pairs: 2, refOnly: 0, builtOnly: 0, report: 'D:/x/site-reference/demo/reports/P13.auto.md' },
    heights: [{ width: 1440, built: 8645, reference: 8667 }, { width: 320, built: 15665, reference: null }],
    shots: { built: ['site-baseline/shots/1/a-1440.jpg'], reference: 'site-reference/demo/shots/P13' },
  };
  const md = renderTransferReport({ ...base, styleSkipped: [{ key: 'linklinecolor', reason: 'форма настроек не пишет этот ключ' }] });
  assert.match(md, /\| состав блоков \| совпало \|/);
  assert.match(md, /\| разметка \(reference compare\) \| 97% признаков \|/);
  assert.match(md, /\| высота 1440 \| отличается \| сборка 8645 px, референс 8667 px \|/);
  assert.match(md, /\| высота 320 \| справочно \|/);
  assert.match(md, /## Вердикт агента/);
  assert.match(md, /\| 1440 \| \| \| \|/);
  for (const a of PREVIEW_ARTIFACTS) assert.ok(md.includes(a));
  assert.match(md, /не перенесено: настройки проекта \| пропущено \| linklinecolor/);
  assert.doesNotMatch(md, /http/);
  const plain = renderTransferReport({ ...base, styleSkipped: [] });
  assert.doesNotMatch(plain, /не перенесено/);
  const bad = renderTransferReport({ ...base, composition: { equal: false, expected: ['770'], actual: ['770', '212'], reasons: ['лишний блок 212 на позиции 2'] } });
  assert.match(bad, /\| состав блоков \| не совпало \| лишний блок 212 на позиции 2 \|/);
});

test('verifyTransferredPage writes transfer data and the report from a fake editor driver', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-verify-'));
  try {
    const PAGE = '1000000000031';
    mkdirSync(join(baseDir, 'x', 'structure'), { recursive: true });
    mkdirSync(join(baseDir, 'catalog'), { recursive: true });
    const structure = { name: 'index', url: 'https://ref.test/', blocks: [
      { order: 1, recid: '1', tplid: '686', zone: 'content', features: ['class:t-col_4'], fields: [], images: [], links: [], cards: [], hasForm: false, text: '' },
      { order: 2, recid: '2', tplid: '30', zone: 'content', features: ['class:t-text'], fields: [{ name: 'title', text: 'Заг', href: null }], images: [], links: [], cards: [], hasForm: false, text: '' },
    ] };
    writeFileSync(join(baseDir, 'x', 'structure', 'index.json'), JSON.stringify(structure));
    writeFileSync(join(baseDir, 'x', 'reference.json'), JSON.stringify({ slug: 'x', url: 'https://ref.test/', pages: [], images: {} }));
    // Замена 686→999 стоит для сборки по референсу; перенос через донора несёт исходный 686 — сверка не должна её применять.
    writeFileSync(join(baseDir, 'x', 'site.json'), JSON.stringify({ slug: 'x', substitutes: { 686: '999' }, pages: [{ label: 'P00', role: 'content', name: 'index', url: 'https://ref.test/', pageid: PAGE }] }));
    writeFileSync(join(baseDir, 'x', 'donor-style.json'), JSON.stringify({ at: 'x', values: {}, fonts: [], skipped: [{ key: 'linklineheight', reason: 'форма не пишет' }] }));
    writeFileSync(join(baseDir, 'catalog', '30.json'), JSON.stringify({ tplid: '30', available: true, tabs: { content: ['title'], settings: [] }, defaults: {}, cardKeys: [] }));
    const html = `<div id="rec1000000000012" class="r" data-record-type="686"><div class="t-col_4"></div></div>
<div id="rec1000000000013" class="r" data-record-type="30"><div class="t-text"></div></div>`;
    const calls = [];
    const driver = {
      // Скрытый блок переносится в редактор, но на публикации (и в структуре слепка) его нет.
      listRecords: async () => { calls.push('listRecords'); return [{ recordid: '1000000000012', tplid: '686' }, { recordid: '1000000000014', tplid: '396', hidden: true }, { recordid: '1000000000013', tplid: '30' }]; },
      pageRawHtml: async () => { calls.push('pageRawHtml'); return { url: 'https://tilda.test/page/preview/', html }; },
      shot: async ({ widths }) => { calls.push('shot'); return { files: widths.map((w) => `D:/repo/site-baseline/shots/${PAGE}/s-${w}.jpg`), widths: widths.map((w) => ({ width: w, height: 1000 + w, records: 2, files: [`D:/repo/site-baseline/shots/${PAGE}/s-${w}.jpg`] })) }; },
    };
    const r = await verifyTransferredPage(driver, {
      slug: 'x', label: 'P00', pageid: PAGE, widths: [1440, 320], baseDir, catalogDir: baseDir, now: '2026-09-24T10:00:00.000Z',
      referenceShots: { label: 'P00', dir: 'D:/repo/site-reference/x/shots/P00', files: 2, widths: [{ width: 1440, height: 2440, records: 2, files: 1 }, { width: 320, height: 1320, records: 2, files: 1 }] },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.composition.equal, true);
    assert.deepEqual(calls, ['pageRawHtml', 'listRecords', 'shot']);
    assert.deepEqual(r.heights, [{ width: 1440, built: 2440, reference: 2440 }, { width: 320, built: 1320, reference: 1320 }]);
    assert.equal(r.shots.reference, 'site-reference/x/shots/P00');
    assert.ok(existsSync(join(baseDir, 'x', 'transfer', 'P00.json')));
    const md = readFileSync(join(baseDir, 'x', 'reports', 'P00.transfer.md'), 'utf8');
    assert.match(md, /состав блоков \| совпало/);
    assert.match(md, /скрытых блоков на приёмнике 1/);
    assert.match(md, /linklineheight/);
    assert.match(md, /site-baseline\/shots/);
    assert.doesNotMatch(md, /D:\//);
    assert.equal(r.verdictCarried, false, 'первый доклад — пустой вердикт');
    // Агент заполнил вердикт между запусками — повторная сверка его не затирает.
    const reportPath = join(baseDir, 'x', 'reports', 'P00.transfer.md');
    writeFileSync(reportPath, md.replace('| 1440 | | | |', '| 1440 | содержимое и порядок | — | — |'), 'utf8');
    const bad = await verifyTransferredPage({ ...driver, listRecords: async () => [{ recordid: '1', tplid: '686' }] }, { slug: 'x', label: 'P00', pageid: PAGE, widths: [1440], baseDir, catalogDir: baseDir, referenceNote: 'нет', now: '2026-09-25T10:00:00.000Z' });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.composition.reasons[0], /блок 30 отсутствует/);
    assert.equal(bad.verdictCarried, true);
    const again = readFileSync(reportPath, 'utf8');
    assert.match(again, /\| 1440 \| содержимое и порядок \|/);
    assert.match(again, /Вердикт перенесён из доклада от 2026-09-24T10:00:00\.000Z; кадры сняты заново 2026-09-25T10:00:00\.000Z/);
    assert.equal(JSON.parse(readFileSync(join(baseDir, 'x', 'transfer', 'P00.json'), 'utf8')).verdictCarried, true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('listHtmlBlocks names empty placeholders, external hosts and embedded forms; the report lists them', async () => {
  const { listHtmlBlocks } = await import('../donor-verify.mjs');
  const blocks = listHtmlBlocks([
    { recordid: '400001', tplid: '131' },
    { recordid: '400002', tplid: '131', code: '&lt;script src=&quot;https://forms.example.test/embed.js&quot;&gt;&lt;/script&gt;&lt;iframe src=&quot;https://forms.example.test/u/1&quot;&gt;&lt;/iframe&gt;' },
    { recordid: '400003', tplid: '131', code: '<style>.x{}</style>', hidden: true },
    { recordid: '400004', tplid: '686', code: '<script></script>' },
  ]);
  assert.equal(blocks.length, 3, 'только шаблоны HTML-кода');
  assert.deepEqual(blocks[0], { recordid: '400001', tplid: '131', hidden: false, empty: true, placeholder: true, hosts: [], iframes: 0, scripts: 0, forms: 0 });
  assert.deepEqual([blocks[1].hosts, blocks[1].iframes, blocks[1].scripts, blocks[1].placeholder], [['forms.example.test'], 1, 1, false]);
  assert.deepEqual([blocks[2].hidden, blocks[2].empty], [true, false]);
  const md = renderTransferReport({
    label: 'P00', at: '2026-09-24T10:00:00.000Z',
    composition: { equal: true, expected: ['131'], actual: ['131'], reasons: [] },
    markup: null, heights: [], shots: {}, htmlBlocks: blocks,
  });
  assert.match(md, /## HTML-блоки/);
  assert.match(md, /\| 400001 \| пустой — на публикации заглушка «Html code will be here» \|/);
  assert.match(md, /forms\.example\.test/);
  assert.match(renderTransferReport({ label: 'P01', at: 'x', composition: { equal: true, expected: [], actual: [], reasons: [] }, markup: null, htmlBlocks: [] }), /HTML-блоков нет\./);
});

test('extractVerdict tells a filled verdict from the template', () => {
  const template = renderTransferReport({ label: 'P00', at: 'a', composition: { equal: true, expected: [], reasons: [] }, heights: [{ width: 1440 }, { width: 320 }] });
  assert.deepEqual(extractVerdict(template).filled, false, 'шаблонный вердикт не переносится');
  assert.deepEqual(extractVerdict('# Доклад без раздела'), { text: '', filled: false });
  const prose = '## Вердикт агента\n\nВывод: совпадает.\n\n## Другое\n\nтекст';
  assert.deepEqual(extractVerdict(prose), { text: 'Вывод: совпадает.', filled: true }, 'текст до следующего раздела');
  const carried = '## Вердикт агента\n\n| Ширина | Совпало | Не совпало | Причина |\n| --- | --- | --- | --- |\n| 320 | | плашка | предпросмотр |\n\nВердикт перенесён из доклада от x; кадры сняты заново y.\n';
  const v = extractVerdict(carried);
  assert.equal(v.filled, true);
  assert.ok(!v.text.includes('перенесён'), 'прежняя пометка не накапливается');
});
