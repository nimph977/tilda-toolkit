import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyImageUpload, canonicalJson, normalizeFieldValue, prepare, verify } from '../apply-plan.mjs';
import { resetUnprotected, unprotectForThisRun } from '../lib/paths.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');
const page = '200002';
const recordid = '7001';

function baseline() {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-plan-test-'));
  mkdirSync(join(baseDir, 'zero', page), { recursive: true });
  mkdirSync(join(baseDir, 'records', page), { recursive: true });
  writeFileSync(join(baseDir, 'zero', page, `${recordid}.json`), JSON.stringify({
    ab_height: '300', groups: [],
    0: { elem_id: '9000000000001', elem_type: 'text', text: 'Before', top: '20', left: '20', width: '200', height: '30' },
  }));
  writeFileSync(join(baseDir, 'records', page, '_inventory.json'), JSON.stringify([
    { recordid, zeroIndex: 1, tplid: '396', hidden: false },
  ]));
  return baseDir;
}

test('prepare rejects protected pages, then explicit per-run unprotect permits a synthetic payload', () => {
  const original = process.env.TILDA_PROTECTED_PAGES;
  process.env.TILDA_PROTECTED_PAGES = page;
  resetUnprotected();
  const baseDir = baseline();
  const plan = { page, ops: [{ block: { recordid }, elem: { elem_id: '9000000000001' }, set: { text: 'After' } }] };
  try {
    assert.throws(() => prepare(plan, { baseDir }), /PROTECTED_PAGE/);
    assert.deepEqual(unprotectForThisRun(page), []);
    const [payload] = prepare(plan, { baseDir });
    assert.equal(payload.model['0'].text, 'After');
  } finally {
    resetUnprotected();
    if (original === undefined) delete process.env.TILDA_PROTECTED_PAGES;
    else process.env.TILDA_PROTECTED_PAGES = original;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('verification reports a missing reread and a field mismatch from synthetic snapshots', () => {
  const original = process.env.TILDA_PROTECTED_PAGES;
  process.env.TILDA_PROTECTED_PAGES = '';
  const baseDir = baseline();
  const plan = { page, ops: [{ block: { recordid }, elem: { elem_id: '9000000000001' }, set: { text: 'After' } }] };
  try {
    const [payload] = prepare(plan, { baseDir });
    assert.equal(verify(plan, { baseDir })[0].problem.key, 'apply.problem.noRereadSnapshot');
    const reread = join(baseDir, 'reread', page);
    mkdirSync(reread, { recursive: true });
    writeFileSync(join(reread, `${recordid}.json`), JSON.stringify(payload.model));
    assert.deepEqual(verify(plan, { baseDir }), []);
    payload.model['0'].text = 'Different';
    writeFileSync(join(reread, `${recordid}.json`), JSON.stringify(payload.model));
    assert.equal(verify(plan, { baseDir })[0].field, 'text');
  } finally {
    if (original === undefined) delete process.env.TILDA_PROTECTED_PAGES;
    else process.env.TILDA_PROTECTED_PAGES = original;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- newRecord: блок из полей без источника ---------------------------------------------------

function withNewRecordEnv(fn) {
  const original = process.env.TILDA_PROTECTED_PAGES;
  process.env.TILDA_PROTECTED_PAGES = '';
  resetUnprotected();
  const baseDir = baseline();
  try {
    return fn(baseDir);
  } finally {
    resetUnprotected();
    if (original === undefined) delete process.env.TILDA_PROTECTED_PAGES;
    else process.env.TILDA_PROTECTED_PAGES = original;
    rmSync(baseDir, { recursive: true, force: true });
  }
}

test('newRecord prepare builds fields, list and expect without a source snapshot', () =>
  withNewRecordEnv((baseDir) => {
    const plan = {
      page,
      ops: [{
        id: 'b1', hidden: 'y',
        newRecord: { tplid: '702', fields: [{ name: 'title', value: 'Заголовок' }, { name: 'btitle', value: 'Список' }], cards: [{ li_title: 'Карточка', li_descr: 'Текст' }] },
      }],
    };
    const [payload] = prepare(plan, { baseDir });
    assert.equal(payload.kind, 'create');
    assert.equal(payload.mode, 'new');
    assert.equal(payload.hidden, 'y');
    const names = payload.fields.map((f) => f.name);
    for (const n of ['title', 'btitle', 'bdescr', 'list', 'li_title', 'li_descr']) assert.ok(names.includes(n), n);
    assert.equal(payload.expect.values.title, 'Заголовок');
    assert.equal(payload.expect.values.btitle, 'Список');
    assert.equal(payload.expect.cards[0].li_title, 'Карточка');
    const list = JSON.parse(payload.fields.find((f) => f.name === 'list').value);
    assert.match(String(list['0'].lid), /^\d+$/);
    const written = readFileSync(join(baseDir, 'payload', page, 'b1.create.payload.json'), 'utf8');
    assert.match(written, /"mode": "new"/);
    assert.match(readFileSync(join(baseDir, 'payload', page, '_build.call.js'), 'utf8'), /"mode":"new"/);
  }));

test('newRecord prepare rejects zero, form fields and script', () =>
  withNewRecordEnv((baseDir) => {
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '396', fields: [] } }] }, { baseDir }), (e) => e.code === 'PLAN_INVALID' && e.key === 'apply.newRecordNoZero');
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '702', fields: [{ name: 'inputs', value: 'x' }] } }] }, { baseDir }), /FORM_FIELD/);
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '702', fields: [{ name: 'text', value: '<script>1</script>' }] } }] }, { baseDir }), /SCRIPT_REJECTED/);
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: 'abc', fields: [] } }] }, { baseDir }), (e) => e.code === 'PLAN_INVALID' && e.key === 'apply.newRecordNeedsTplid');
  }));

test('newRecord prepare refuses tplid marked unavailable in catalog', () =>
  withNewRecordEnv((baseDir) => {
    mkdirSync(join(baseDir, 'catalog'), { recursive: true });
    writeFileSync(join(baseDir, 'catalog', '835.json'), JSON.stringify({ tplid: '835', available: false, error: 'no access' }));
    writeFileSync(join(baseDir, 'catalog', '796.json'), JSON.stringify({ tplid: '796', available: true, tabs: { content: ['title'], settings: [] }, defaults: {}, cardKeys: [] }));
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '835', fields: [] } }] }, { baseDir }), (e) => e.code === 'TEMPLATE_UNAVAILABLE' && e.key === 'apply.templateUnavailable');
    const [payload] = prepare({ page, ops: [{ newRecord: { tplid: '796', fields: [{ name: 'title', value: 'a' }, { name: 'foo', value: 'b' }] } }] }, { baseDir });
    assert.equal(payload.mode, 'new');
  }));

test('normalizeFieldValue treats br variants and JSON serialization as equal', () => {
  // Переносы: Tilda возвращает `<br />`, план пишет `<br>`; пробелы вокруг тега незначимы.
  assert.equal(normalizeFieldValue('А<br />Б'), 'А<br>Б');
  assert.equal(normalizeFieldValue('А <br> Б'), 'А<br>Б');
  assert.equal(normalizeFieldValue('А<br/>Б'), 'А<br>Б');
  assert.equal(normalizeFieldValue('Один&lt;br /&gt;Два'), 'Один<br>Два');
  // JSON: экранированные слэши, `\uXXXX` и кавычки-сущности приводятся к одному канону.
  const plain = '[{"service":"telegram","link":"https://t.me/x"}]';
  assert.equal(normalizeFieldValue('[{"service":"telegram","link":"https:\\/\\/t.me\\/x"}]'), normalizeFieldValue(plain));
  assert.equal(normalizeFieldValue('[{&quot;service&quot;:&quot;telegram&quot;,&quot;link&quot;:&quot;https:\\/\\/t.me\\/x&quot;}]'), normalizeFieldValue(plain));
  assert.equal(normalizeFieldValue('[{"title":"\\u041e\\u0434\\u0438\\u043d"}]'), '[{"title":"Один"}]');
  // Не-JSON и битый JSON остаются строкой.
  assert.equal(normalizeFieldValue('{не json'), '{не json');
  assert.equal(canonicalJson('обычный текст'), 'обычный текст');
  assert.equal(canonicalJson('{"a":1}'), '{"a":1}');
});

test('newRecord verify compares reread fields and cards', () =>
  withNewRecordEnv((baseDir) => {
    const plan = { page, ops: [{ id: 'b1', newRecord: { tplid: '702', fields: [{ name: 'title', value: 'Заголовок' }, { name: 'descr', value: 'Один<br>Два' }, { name: 'title_typo', value: '{"color":"#ffffff","link":"https://example.com/a"}' }, { name: 'btitle', value: 'Список' }], cards: [{ li_title: 'Карточка', li_descr: 'Текст' }] } }] };
    prepare(plan, { baseDir });
    const reread = join(baseDir, 'reread', page);
    mkdirSync(reread, { recursive: true });
    writeFileSync(join(reread, '_built.json'), JSON.stringify({ built: [{ id: 'b1', status: 'ok', recordid: '7009', mode: 'new', hidden: 'n' }] }));
    // Формы, в которых Tilda возвращает записанное: `<br />` в тексте, `\/` и `&quot;` в JSON.
    const good = { record: { title: 'Заголовок', descr: 'Один<br />Два', title_typo: '{&quot;color&quot;:&quot;#ffffff&quot;,&quot;link&quot;:&quot;https:\\/\\/example.com\\/a&quot;}', btitle: 'Список', bdescr: '', list: '[{"lid":"9","li_title":"Карточка","li_descr":"Текст"}]' } };
    writeFileSync(join(reread, '7009.record.json'), JSON.stringify(good));
    assert.deepEqual(verify(plan, { baseDir }), []);

    writeFileSync(join(reread, '7009.record.json'), JSON.stringify({ record: { ...good.record, title: 'Другой' } }));
    const p1 = verify(plan, { baseDir });
    assert.equal(p1.length, 1);
    assert.equal(p1[0].problem.key, 'apply.problem.fieldValueMismatch');
    assert.equal(p1[0].field, 'title');

    writeFileSync(join(reread, '7009.record.json'), JSON.stringify({ record: { ...good.record, list: '[]' } }));
    const p2 = verify(plan, { baseDir });
    assert.ok(p2.some((p) => p.problem.key === 'apply.problem.cardCountMismatch'));
  }));

// [FIX] Поле, записанное с onlythisfield, Tilda хранит экранированным (`&lt;a …&gt;`, `&lt;br /&gt;`),
// а на странице показывает ссылками; сверка `field` сравнивала строки буквально и давала ложное
// «поле не сохранилось» (подвал 464, 2026-09-23).
test('field verify accepts the escaped form Tilda stores and still catches a different value', () => {
  const original = process.env.TILDA_PROTECTED_PAGES;
  process.env.TILDA_PROTECTED_PAGES = '';
  const baseDir = baseline();
  writeFileSync(join(baseDir, 'records', page, '_inventory.json'), JSON.stringify([{ recordid: '7002', tplid: '464', hidden: false }]));
  const value = '<a href="/page100002.html" style="color: rgb(0, 0, 0)">О нас</a><br><a href="/page100003.html">Два</a>';
  const plan = { page, ops: [{ block: { recordid: '7002' }, field: { name: 'descr', value } }] };
  try {
    prepare(plan, { baseDir });
    const reread = join(baseDir, 'reread', page);
    mkdirSync(reread, { recursive: true });
    const stored = '&lt;a href=&quot;/page100002.html&quot; style=&quot;color: rgb(0, 0, 0)&quot;&gt;О нас&lt;/a&gt;&lt;br /&gt;&lt;a href=&quot;/page100003.html&quot;&gt;Два&lt;/a&gt;';
    writeFileSync(join(reread, '7002.record.json'), JSON.stringify({ record: { descr: stored } }));
    assert.deepEqual(verify(plan, { baseDir }), []);
    writeFileSync(join(reread, '7002.record.json'), JSON.stringify({ record: { descr: stored.replace('page100003', 'page100004') } }));
    const problems = verify(plan, { baseDir });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].problem.key, 'apply.problem.fieldNotSaved');
  } finally {
    if (original === undefined) delete process.env.TILDA_PROTECTED_PAGES;
    else process.env.TILDA_PROTECTED_PAGES = original;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// Пустое значение Tilda не хранит: после записи `''` поле пропадает из записи (P00, 2026-09-24).
test('field verify treats a field missing from the record as the written empty value', () => {
  const original = process.env.TILDA_PROTECTED_PAGES;
  process.env.TILDA_PROTECTED_PAGES = '';
  const baseDir = baseline();
  writeFileSync(join(baseDir, 'records', page, '_inventory.json'), JSON.stringify([{ recordid: '7003', tplid: '686', hidden: false }]));
  const plan = { page, ops: [{ block: { recordid: '7003' }, field: { name: 'margintop', value: '' } }] };
  try {
    prepare(plan, { baseDir });
    const reread = join(baseDir, 'reread', page);
    mkdirSync(reread, { recursive: true });
    writeFileSync(join(reread, '7003.record.json'), JSON.stringify({ record: { blocks: '3' } }));
    assert.deepEqual(verify(plan, { baseDir }), []);
    writeFileSync(join(reread, '7003.record.json'), JSON.stringify({ record: { margintop: '135px' } }));
    assert.equal(verify(plan, { baseDir })[0]?.problem.key, 'apply.problem.fieldNotSaved');
  } finally {
    if (original === undefined) delete process.env.TILDA_PROTECTED_PAGES;
    else process.env.TILDA_PROTECTED_PAGES = original;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('applyImageUpload substitutes plain and card images', () => {
  const op = { newRecord: { tplid: '702', fields: [{ name: 'img', value: '' }], cards: [{ li_title: 'a' }], images: [{ field: 'img', file: 'x.png' }, { card: 0, field: 'li_img', file: 'y.png' }] } };
  applyImageUpload(op, op.newRecord.images[0], 'https://cdn.test/x.png');
  applyImageUpload(op, op.newRecord.images[1], 'https://cdn.test/y.png');
  assert.equal(op.newRecord.fields.find((f) => f.name === 'img').value, 'https://cdn.test/x.png');
  assert.equal(op.newRecord.cards[0].li_img, 'https://cdn.test/y.png');
  assert.equal(op.newRecord.images[0].url, 'https://cdn.test/x.png');
  assert.throws(() => applyImageUpload(op, { card: 5, field: 'li_img' }, 'u'), (e) => e.code === 'PLAN_INVALID' && e.key === 'apply.imageCardMissing' && e.params.card === 5);
});

test('applyImageUpload writes tu upload fields for a plain image field', () => {
  const op = { newRecord: { tplid: '464', fields: [{ name: 'title', value: 'x' }], images: [{ field: 'img', file: 'a.png' }] } };
  applyImageUpload(op, op.newRecord.images[0], { cdnUrl: 'https://static.tildacdn.com/tild1/a.png', uuid: 'tild1', width: 100, height: 80, size: 2822, file: 'a.png' });
  const byName = Object.fromEntries(op.newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.img, 'https://static.tildacdn.com/tild1/a.png');
  assert.equal(byName['img-uploadmethod'], 'tu');
  assert.equal(byName['img-tuinfo-uuid'], 'tild1');
  assert.equal(byName['img-tuinfo-cdnurl'], 'https://static.tildacdn.com/tild1/a.png');
  assert.equal(byName['img-tuinfo-name'], 'a.png');
  assert.equal(byName['img-tuinfo-width'], '100');
  assert.equal(byName['img-tuinfo-size'], '2822');
});

test('planTargets ignores newRecord ops', async () => {
  const { planTargets } = await import('../cycle.mjs');
  const targets = planTargets({ page, ops: [{ newRecord: { tplid: '796', fields: [] } }] }, { baseDir: baseline() });
  assert.deepEqual(targets, []);
});

test('newRecord verify compares card li_link that travels inside list', () =>
  withNewRecordEnv((baseDir) => {
    const plan = { page, ops: [{ id: 'b1', newRecord: { tplid: '702', fields: [{ name: 'btitle', value: 'Список' }], cards: [{ li_title: 'Карточка', li_link: 'https://example.com/card' }] } }] };
    prepare(plan, { baseDir });
    const reread = join(baseDir, 'reread', page);
    mkdirSync(reread, { recursive: true });
    writeFileSync(join(reread, '_built.json'), JSON.stringify({ built: [{ id: 'b1', status: 'ok', recordid: '7009', mode: 'new', hidden: 'n' }] }));
    // Сервер дописывает карточке `lid` — он сверке не подлежит.
    const list = (link) => JSON.stringify([{ lid: '9', li_title: 'Карточка', li_descr: '', li_link: link }]);
    const record = (link) => ({ record: { btitle: 'Список', bdescr: '', list: list(link) } });

    writeFileSync(join(reread, '7009.record.json'), JSON.stringify(record('https://example.com/card')));
    assert.deepEqual(verify(plan, { baseDir }), []);

    writeFileSync(join(reread, '7009.record.json'), JSON.stringify(record('https://example.com/other')));
    const problems = verify(plan, { baseDir });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].problem.key, 'apply.problem.cardMismatch');
    assert.equal(problems[0].field, 'li_link');
  }));

test('newRecord prepare knows settings fields from the settings map of the template', () =>
  withNewRecordEnv((baseDir) => {
    mkdirSync(join(baseDir, 'catalog'), { recursive: true });
    writeFileSync(join(baseDir, 'catalog', '686.json'), JSON.stringify({ tplid: '686', available: true, tabs: { content: ['btitle'], settings: ['blocks'] }, defaults: {}, cardKeys: [] }));
    const op = { newRecord: { tplid: '686', fields: [{ name: 'btitle', value: 'a' }, { name: 'screenmax', value: '980px' }] } };
    const warned = [];
    const write = process.stderr.write;
    setLogLevel('WARN');
    process.stderr.write = (chunk, ...rest) => {
      if (String(chunk).includes('поля нет в каталоге шаблона')) warned.push(String(chunk));
      return true;
    };
    try {
      prepare({ page, ops: [op] }, { baseDir });
      assert.equal(warned.length, 1, 'без карты screenmax — неизвестное поле');
      writeFileSync(join(baseDir, 'catalog', '686.settings.json'), JSON.stringify({ tplid: '686', version: 1, baseFeatures: [], fields: {}, skipped: [], schema: { screenmax: { type: 'screen', kind: 'size' } } }));
      warned.length = 0;
      prepare({ page, ops: [op] }, { baseDir });
      assert.equal(warned.length, 0, 'с картой screenmax известно');
    } finally {
      process.stderr.write = write;
      setLogLevel('ERROR');
    }
  }));

test('formContent lets newRecord and field write formmsgurl but never receivers', () =>
  withNewRecordEnv((baseDir) => {
    const url = { name: 'formmsgurl', value: '/thanks' };
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '702', fields: [url] } }] }, { baseDir }), /FORM_FIELD_REJECTED/);
    assert.throws(() => prepare({ page, ops: [{ formContent: 'x', newRecord: { tplid: '702', fields: [url] } }] }, { baseDir }), (e) => e.code === 'PLAN_INVALID' && e.key === 'apply.formContentOnlyReference');
    assert.throws(() => prepare({ page, ops: [{ formContent: 'reference', newRecord: { tplid: '702', fields: [{ name: 'receivers', value: 'x' }] } }] }, { baseDir }), /FORM_FIELD_REJECTED/);
    const items = [{ li_type: 'nm', li_nm: 'Имя', li_req: 'y' }];
    const [payload] = prepare({ page, ops: [{ id: 'f1', formContent: 'reference', newRecord: { tplid: '702', fields: [url, { name: 'forminputs', value: JSON.stringify(items) }] } }] }, { baseDir });
    assert.equal(payload.formContent, 'reference');
    assert.equal(payload.expect.values.formmsgurl, '/thanks');
    assert.equal('forminputs' in payload.expect.values, false, 'forminputs сверяется по list');
    assert.equal(payload.expect.cards[0].li_nm, 'Имя');
    const written = JSON.parse(payload.fields.find((f) => f.name === 'forminputs').value);
    assert.match(String(written[0].lid), /^\d+$/);
    assert.equal(written[0].ls, '10');
    const build = readFileSync(join(baseDir, 'payload', page, '_build.call.js'), 'utf8');
    assert.match(build, /"formContent":"reference"/);
  }));

test('a field op with formContent carries the flag to its payload call', () =>
  withNewRecordEnv((baseDir) => {
    const plan = { page, ops: [{ block: { recordid }, formContent: 'reference', field: { name: 'formmsgurl', value: '/thanks' } }] };
    const [payload] = prepare(plan, { baseDir });
    assert.equal(payload.formContent, 'reference');
    assert.match(readFileSync(payload.callPath, 'utf8'), /\{"allowFormContent":true\}/);
  }));

test('newRecord code goes only to 131, without script, and is verified against the reread code', () =>
  withNewRecordEnv((baseDir) => {
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '796', fields: [], code: '<div></div>' } }] }, { baseDir }), (e) => e.code === 'PLAN_INVALID' && e.key === 'apply.codeOnlyIn131' && e.params.tplid === '796');
    assert.throws(() => prepare({ page, ops: [{ newRecord: { tplid: '131', fields: [], code: '<script>1</script>' } }] }, { baseDir }), /SCRIPT_REJECTED/);
    const [payload] = prepare({ page, ops: [{ id: 'h1', newRecord: { tplid: '131', fields: [], code: '<div>код</div>' } }] }, { baseDir });
    assert.equal(payload.code, '<div>код</div>');
    assert.equal(payload.expect.code, '<div>код</div>');
    assert.match(readFileSync(join(baseDir, 'payload', page, '_build.call.js'), 'utf8'), /"code":"<div>код<\/div>"/);
    // Сверка по перечитанному снимку.
    const rereadDir = join(baseDir, 'reread', page);
    mkdirSync(rereadDir, { recursive: true });
    writeFileSync(join(rereadDir, '_built.json'), JSON.stringify({ built: [{ id: 'h1', status: 'ok', recordid: '7011', tplid: '131', hidden: 'n' }] }));
    writeFileSync(join(rereadDir, '7011.record.json'), JSON.stringify({ record: { tplid: '131' }, t123code: '  <div>код</div>\n' }));
    assert.deepEqual(verify({ page, ops: [{ id: 'h1', newRecord: { tplid: '131', fields: [], code: '<div>код</div>' } }] }, { baseDir }), []);
    writeFileSync(join(rereadDir, '7011.record.json'), JSON.stringify({ record: { tplid: '131' }, t123code: '<div>другой</div>' }));
    const problems = verify({ page, ops: [{ id: 'h1', newRecord: { tplid: '131', fields: [], code: '<div>код</div>' } }] }, { baseDir });
    assert.equal(problems[0].problem.key, 'apply.problem.htmlCodeMismatch');
  }));
