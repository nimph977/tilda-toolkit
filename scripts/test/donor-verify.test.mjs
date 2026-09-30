import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { isMessage, msg, t } from '../lib/i18n.mjs';
import {
  PREVIEW_ARTIFACTS, PREVIEW_ARTIFACT_KEYS, SEQUENCE_REASONS, compareTplidSequence, compositionReasons, expectedTplids, extractVerdict, hasVerdictSection,
  renderTransferReport, verifyTransferredPage,
} from '../donor-verify.mjs';

setLogLevel('ERROR');

// Доклад до двуязычной версии: русский текст без меток `taken-at` и `verdict:start/end`.
const LEGACY_REPORT = `# Сверка переноса P00

Снято: 2026-09-01T10:00:00Z. Машинная часть приёмки; вердикт по кадрам даёт агент, владелец подтверждает вывод.

| Проверка | Итог | Причина |
| --- | --- | --- |
| состав блоков | совпало | 2 блоков в том же порядке |

## Известные артефакты предпросмотра

- ссылки tel: в предпросмотре отдаются как href="#"

## Вердикт агента

| Ширина | Совпало | Не совпало | Причина |
| --- | --- | --- | --- |
| 1440 | содержимое и порядок | — | — |
| 320 | | плашка | предпросмотр |

Вердикт перенесён из доклада от 2026-08-30T09:00:00Z; кадры сняты заново 2026-09-01T10:00:00Z — перепроверить, если состав или высоты изменились.
`;

test('expectedTplids filters by zone and applies substitutes', () => {
  const blocks = [{ tplid: '770', zone: 'header' }, { tplid: '686' }, { tplid: '396', zone: 'content' }, { tplid: '464', zone: 'footer' }];
  assert.deepEqual(expectedTplids(blocks, 'content', { 770: '794' }), ['686', '396']);
  assert.deepEqual(expectedTplids(blocks, 'header', { 770: '794' }), ['794']);
  assert.deepEqual(expectedTplids(blocks, 'all'), ['770', '686', '396', '464']);
});

test('compareTplidSequence names missing, extra and reordered blocks with positions', () => {
  assert.equal(compareTplidSequence(['770', '794'], ['770', '794']).equal, true);
  const missing = compareTplidSequence(['770', '794', '396'], ['770', '396']);
  assert.deepEqual([missing.equal, missing.reasons], [false, ['block 794 is missing at position 2']]);
  assert.deepEqual(missing.reasonItems, [{ code: 'missing', params: { tplid: '794', position: 2 } }]);
  const extra = compareTplidSequence(['770'], ['770', '212']);
  assert.deepEqual(extra.reasons, ['extra block 212 at position 2']);
  assert.deepEqual(extra.reasonItems, [{ code: 'extra', params: { tplid: '212', position: 2 } }]);
  const swapped = compareTplidSequence(['770', '794'], ['794', '770']);
  assert.deepEqual([swapped.equal, swapped.reasons], [false, ['the order differs starting from position 1']]);
  assert.deepEqual(compositionReasons(missing), [msg(SEQUENCE_REASONS.missing, { tplid: '794', position: 2 })], 'для итога — Message');
  assert.deepEqual(compositionReasons({ reasons: ['old text'] }), ['old text'], 'состав без reasonItems даёт записанный текст');
});

const BASE = {
  label: 'P13', at: '2026-09-24T10:00:00.000Z',
  composition: { equal: true, expected: ['770', '686'], actual: ['770', '686'], reasons: [] },
  markup: { meanScore: 0.97, pairs: 2, refOnly: 0, builtOnly: 0, report: 'D:/x/site-reference/demo/reports/P13.auto.md' },
  heights: [{ width: 1440, built: 8645, reference: 8667 }, { width: 320, built: 15665, reference: null }],
  shots: { built: ['site-baseline/shots/1/a-1440.jpg'], reference: 'site-reference/demo/shots/P13' },
};

test('renderTransferReport lists checks, artifacts, skipped project settings and an empty verdict section', () => {
  const md = renderTransferReport({ ...BASE, lang: 'ru', styleSkipped: [{ key: 'linklinecolor', code: 'formCannot', reason: 'the settings form does not write this key' }] });
  assert.match(md, /\| состав блоков \| совпало \|/);
  assert.match(md, /\| разметка \(reference compare\) \| 97% признаков \|/);
  assert.match(md, /\| высота 1440 \| отличается \| сборка 8645 px, референс 8667 px \|/);
  assert.match(md, /\| высота 320 \| справочно \|/);
  assert.match(md, /## Вердикт агента/);
  assert.match(md, /\| 1440 \| \| \| \|/);
  for (const a of PREVIEW_ARTIFACTS) assert.ok(md.includes(t('ru', PREVIEW_ARTIFACT_KEYS[a])), a);
  assert.match(md, /не перенесено: настройки проекта \| пропущено \| linklinecolor — форма настроек не пишет этот ключ/, 'причина с именем переводится на язык доклада');
  assert.doesNotMatch(md, /http/);
  const plain = renderTransferReport({ ...BASE, lang: 'ru', styleSkipped: [] });
  assert.doesNotMatch(plain, /не перенесено/);
  const bad = renderTransferReport({ ...BASE, lang: 'ru', composition: { equal: false, expected: ['770'], actual: ['770', '212'], reasons: ['extra block 212 at position 2'], reasonItems: [{ code: 'extra', params: { tplid: '212', position: 2 } }] } });
  assert.match(bad, /\| состав блоков \| не совпало \| лишний блок 212 на позиции 2 \|/);
  const oldStyle = renderTransferReport({ ...BASE, lang: 'ru', styleSkipped: [{ key: 'linklinecolor', reason: 'форма не пишет' }], composition: { equal: false, expected: [], actual: [], reasons: ['своя причина'] } });
  assert.match(oldStyle, /linklinecolor — форма не пишет/, 'запись без имени причины выводится как записана');
  assert.match(oldStyle, /\| не совпало \| своя причина \|/, 'состав без reasonItems выводится как записан');
});

test('renderTransferReport in English has no Cyrillic and writes the machine labels', () => {
  const md = renderTransferReport({ ...BASE, styleSkipped: [{ key: 'linklinecolor', code: 'formCannot', reason: 'the settings form does not write this key' }] });
  assert.doesNotMatch(md, /[А-Яа-яЁё]/);
  assert.match(md, /^# Transfer check P13/);
  assert.match(md, /Taken: 2026-09-24T10:00:00\.000Z\./);
  assert.match(md, /<!-- taken-at: 2026-09-24T10:00:00\.000Z -->/);
  assert.match(md, /\| block composition \| matched \|/);
  assert.match(md, /## Agent verdict\n\n<!-- verdict:start -->\n/);
  assert.match(md, /<!-- table:widths -->\n\| Width \| Matched \| Did not match \| Reason \|/);
  assert.match(md, /<!-- verdict:end -->/);
  assert.equal(renderTransferReport({ ...BASE, lang: 'en', styleSkipped: [{ key: 'linklinecolor', code: 'formCannot', reason: 'the settings form does not write this key' }] }), md, 'язык по умолчанию — английский');
});

const HTML_INPUT = [
  { recordid: '400001', tplid: '131' },
  { recordid: '400002', tplid: '131', code: '&lt;script src=&quot;https://forms.example.test/embed.js&quot;&gt;&lt;/script&gt;&lt;iframe src=&quot;https://forms.example.test/u/1&quot;&gt;&lt;/iframe&gt;' },
  { recordid: '400003', tplid: '131', code: '<style>.x{}</style>', hidden: true },
  { recordid: '400004', tplid: '686', code: '<script></script>' },
];

test('listHtmlBlocks names empty placeholders, external hosts and embedded forms; the report lists them', async () => {
  const { listHtmlBlocks } = await import('../donor-verify.mjs');
  const blocks = listHtmlBlocks(HTML_INPUT);
  assert.equal(blocks.length, 3, 'только шаблоны HTML-кода');
  assert.deepEqual(blocks[0], { recordid: '400001', tplid: '131', hidden: false, empty: true, placeholder: true, hosts: [], iframes: 0, scripts: 0, forms: 0 });
  assert.deepEqual([blocks[1].hosts, blocks[1].iframes, blocks[1].scripts, blocks[1].placeholder], [['forms.example.test'], 1, 1, false]);
  assert.deepEqual([blocks[2].hidden, blocks[2].empty], [true, false]);
  const input = {
    label: 'P00', at: '2026-09-24T10:00:00.000Z',
    composition: { equal: true, expected: ['131'], actual: ['131'], reasons: [] },
    markup: null, heights: [], shots: {}, htmlBlocks: blocks,
  };
  const md = renderTransferReport({ ...input, lang: 'ru' });
  assert.match(md, /## HTML-блоки/);
  assert.match(md, /\| 400001 \| пустой — на публикации заглушка «Html code will be here» \|/);
  assert.match(md, /forms\.example\.test/);
  const en = renderTransferReport(input);
  assert.match(en, /## HTML blocks/);
  assert.match(en, /\| 400001 \| empty — the published page shows the placeholder "Html code will be here" \|/);
  assert.doesNotMatch(en, /[А-Яа-яЁё]/);
  const none = { label: 'P01', at: 'x', composition: { equal: true, expected: [], actual: [], reasons: [] }, markup: null, htmlBlocks: [] };
  assert.match(renderTransferReport({ ...none, lang: 'ru' }), /HTML-блоков нет\./);
  assert.match(renderTransferReport(none), /No HTML blocks\./);
});

test('extractVerdict tells a filled verdict from the template in every language', () => {
  const input = { label: 'P00', at: 'a', composition: { equal: true, expected: [], reasons: [] }, heights: [{ width: 1440 }, { width: 320 }] };
  for (const lang of ['ru', 'en']) {
    const template = renderTransferReport({ ...input, lang });
    assert.deepEqual(extractVerdict(template).filled, false, `${lang}: шаблонный вердикт не переносится`);
    assert.equal(hasVerdictSection(template), true);
  }
  assert.deepEqual(extractVerdict('# Доклад без раздела'), { text: '', filled: false });
  assert.equal(hasVerdictSection('# Доклад без раздела'), false);
  const prose = '## Вердикт агента\n\nВывод: совпадает.\n\n## Другое\n\nтекст';
  assert.deepEqual(extractVerdict(prose), { text: 'Вывод: совпадает.', filled: true }, 'текст до следующего раздела');
  const carried = '## Вердикт агента\n\n| Ширина | Совпало | Не совпало | Причина |\n| --- | --- | --- | --- |\n| 320 | | плашка | предпросмотр |\n\nВердикт перенесён из доклада от x; кадры сняты заново y.\n';
  const v = extractVerdict(carried);
  assert.equal(v.filled, true);
  assert.ok(!v.text.includes('перенесён'), 'прежняя пометка не накапливается');
});

test('extractVerdict reads the marked verdict of a new report and ignores a note after the end mark', () => {
  const md = 'x\n\n## Agent verdict\n\n<!-- verdict:start -->\nLooks the same.\n\n<!-- table:widths -->\n| Width | Matched | Did not match | Reason |\n| --- | --- | --- | --- |\n| 1440 | | | |\n<!-- verdict:end -->\n\nVerdict carried over from the report of a.\n\n## Next\n';
  const v = extractVerdict(md);
  assert.equal(v.filled, true);
  assert.ok(v.text.startsWith('Looks the same.') && v.text.includes('<!-- table:widths -->'));
  assert.ok(!v.text.includes('carried over'));
  const onlyTable = md.replace('Looks the same.\n\n', '').replace('| 1440 | | | |', '| 1440 | text | | |');
  assert.equal(extractVerdict(onlyTable).filled, true, 'непустая ячейка таблицы считается заполненным вердиктом');
  assert.equal(extractVerdict(md.replace('Looks the same.\n\n', '')).filled, false, 'метки и пустая таблица — не вердикт');
});

test('a verdict of a pre-bilingual report and its time are read and carried into a new report', async () => {
  const v = extractVerdict(LEGACY_REPORT);
  assert.equal(v.filled, true);
  assert.match(v.text, /содержимое и порядок/);
  assert.match(v.text, /плашка/);
  assert.ok(!v.text.includes('перенесён'), 'пометка прежнего переноса отброшена');
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-verify-legacy-'));
  try {
    const PAGE = '1000000000031';
    prepareFixture(baseDir, PAGE);
    const reportPath = join(baseDir, 'x', 'reports', 'P00.transfer.md');
    mkdirSync(join(baseDir, 'x', 'reports'), { recursive: true });
    writeFileSync(reportPath, LEGACY_REPORT, 'utf8');
    const r = await verifyTransferredPage(fakeDriver(PAGE), { slug: 'x', label: 'P00', pageid: PAGE, widths: [1440], baseDir, catalogDir: baseDir, now: '2026-09-25T10:00:00.000Z', lang: 'en', referenceNote: msg('report.transfer.noteHeaderFooter') });
    assert.equal(r.verdictCarried, true, 'вердикт владельца из старого формата не потерян');
    const md = readFileSync(reportPath, 'utf8');
    assert.doesNotMatch(md.replace(/<!-- verdict:start -->[\s\S]*<!-- verdict:end -->/, ''), /[А-Яа-яЁё]/, 'вне перенесённого вердикта кириллицы нет');
    assert.match(md, /\| 1440 \| содержимое и порядок \| — \| — \|/);
    assert.match(md, /\| 320 \| \| плашка \| предпросмотр \|/);
    assert.match(md, /Verdict carried over from the report of 2026-09-01T10:00:00Z; frames taken again 2026-09-25T10:00:00\.000Z/);
    assert.match(md, /<!-- verdict:start -->[\s\S]*содержимое и порядок[\s\S]*<!-- verdict:end -->/);
    // Повторный запуск читает уже новый доклад по меткам и не копит пометок.
    const again = await verifyTransferredPage(fakeDriver(PAGE), { slug: 'x', label: 'P00', pageid: PAGE, widths: [1440], baseDir, catalogDir: baseDir, now: '2026-09-26T10:00:00.000Z', lang: 'ru' });
    assert.equal(again.verdictCarried, true);
    const md2 = readFileSync(reportPath, 'utf8');
    assert.match(md2, /Вердикт перенесён из доклада от 2026-09-25T10:00:00\.000Z; кадры сняты заново 2026-09-26T10:00:00\.000Z/, 'время прежнего доклада взято по метке');
    assert.equal((md2.match(/Вердикт перенесён/g) ?? []).length, 1);
    assert.match(md2, /\| 1440 \| содержимое и порядок \| — \| — \|/);
    assert.equal(JSON.parse(readFileSync(join(baseDir, 'x', 'transfer', 'P00.json'), 'utf8')).referenceNote, null, 'заметки нет, когда её не передавали');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

function prepareFixture(baseDir, PAGE) {
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
  writeFileSync(join(baseDir, 'x', 'donor-style.json'), JSON.stringify({ at: 'x', values: {}, fonts: [], skipped: [{ key: 'linklineheight', code: 'formCannot', reason: 'the settings form does not write this key' }] }));
  writeFileSync(join(baseDir, 'catalog', '30.json'), JSON.stringify({ tplid: '30', available: true, tabs: { content: ['title'], settings: [] }, defaults: {}, cardKeys: [] }));
}

function fakeDriver(PAGE, calls = []) {
  const html = `<div id="rec1000000000012" class="r" data-record-type="686"><div class="t-col_4"></div></div>
<div id="rec1000000000013" class="r" data-record-type="30"><div class="t-text"></div></div>`;
  return {
    // Скрытый блок переносится в редактор, но на публикации (и в структуре слепка) его нет.
    listRecords: async () => { calls.push('listRecords'); return [{ recordid: '1000000000012', tplid: '686' }, { recordid: '1000000000014', tplid: '396', hidden: true }, { recordid: '1000000000013', tplid: '30' }]; },
    pageRawHtml: async () => { calls.push('pageRawHtml'); return { url: 'https://tilda.test/page/preview/', html }; },
    shot: async ({ widths }) => { calls.push('shot'); return { files: widths.map((w) => `D:/repo/site-baseline/shots/${PAGE}/s-${w}.jpg`), widths: widths.map((w) => ({ width: w, height: 1000 + w, records: 2, files: [`D:/repo/site-baseline/shots/${PAGE}/s-${w}.jpg`] })) }; },
  };
}

test('verifyTransferredPage writes transfer data and the report from a fake editor driver', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-verify-'));
  try {
    const PAGE = '1000000000031';
    prepareFixture(baseDir, PAGE);
    const calls = [];
    const driver = fakeDriver(PAGE, calls);
    const r = await verifyTransferredPage(driver, {
      slug: 'x', label: 'P00', pageid: PAGE, widths: [1440, 320], baseDir, catalogDir: baseDir, now: '2026-09-24T10:00:00.000Z', lang: 'ru',
      referenceShots: { label: 'P00', dir: 'D:/repo/site-reference/x/shots/P00', files: 2, widths: [{ width: 1440, height: 2440, records: 2, files: 1 }, { width: 320, height: 1320, records: 2, files: 1 }] },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.composition.equal, true);
    assert.deepEqual(calls, ['pageRawHtml', 'listRecords', 'shot']);
    assert.deepEqual(r.heights, [{ width: 1440, built: 2440, reference: 2440 }, { width: 320, built: 1320, reference: 1320 }]);
    assert.equal(r.shots.reference, 'site-reference/x/shots/P00');
    assert.ok(existsSync(join(baseDir, 'x', 'transfer', 'P00.json')));
    const data = JSON.parse(readFileSync(join(baseDir, 'x', 'transfer', 'P00.json'), 'utf8'));
    assert.deepEqual(data.artifacts, PREVIEW_ARTIFACTS, 'в данных слепка — имена, а не тексты');
    assert.deepEqual(data.styleSkipped, [{ key: 'linklineheight', code: 'formCannot', reason: 'the settings form does not write this key' }]);
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
    const bad = await verifyTransferredPage({ ...driver, listRecords: async () => [{ recordid: '1', tplid: '686' }] }, { slug: 'x', label: 'P00', pageid: PAGE, widths: [1440], baseDir, catalogDir: baseDir, referenceNote: msg('report.transfer.noteReferenceUnavailable', { error: 'HTTP 404' }), now: '2026-09-25T10:00:00.000Z', lang: 'ru' });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.composition.reasons[0], /block 30 is missing/, 'в данных причина — английский текст');
    assert.equal(bad.verdictCarried, true);
    const again = readFileSync(reportPath, 'utf8');
    assert.match(again, /\| 1440 \| содержимое и порядок \|/);
    assert.match(again, /блок 30 отсутствует на позиции 2/, 'в докладе причина на языке доклада');
    assert.match(again, /страница референса недоступна: HTTP 404/, 'заметка Message переводится в доклад');
    assert.match(again, /Вердикт перенесён из доклада от 2026-09-24T10:00:00\.000Z; кадры сняты заново 2026-09-25T10:00:00\.000Z/);
    const dataAgain = JSON.parse(readFileSync(join(baseDir, 'x', 'transfer', 'P00.json'), 'utf8'));
    assert.equal(dataAgain.verdictCarried, true);
    assert.equal(dataAgain.referenceNote, 'the reference page is unavailable: HTTP 404', 'в данные слепка заметка идёт английским текстом');
    assert.ok(!isMessage(dataAgain.referenceNote));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('verifyTransferredPage in English writes a report without Cyrillic', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-verify-en-'));
  try {
    const PAGE = '1000000000031';
    prepareFixture(baseDir, PAGE);
    const r = await verifyTransferredPage(fakeDriver(PAGE), { slug: 'x', label: 'P00', pageid: PAGE, widths: [1440], baseDir, catalogDir: baseDir, now: '2026-09-24T10:00:00.000Z', lang: 'en' });
    assert.equal(r.exitCode, 0);
    const md = readFileSync(join(baseDir, 'x', 'reports', 'P00.transfer.md'), 'utf8');
    assert.doesNotMatch(md, /[А-Яа-яЁё]/);
    assert.match(md, /hidden blocks on the target 1/);
    assert.match(md, /linklineheight — the settings form does not write this key/);
    const auto = readFileSync(join(baseDir, 'x', 'reports', 'P00.auto.md'), 'utf8');
    assert.match(auto, /# Markup comparison P00/, 'доклад сверки разметки тоже на языке запуска');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
