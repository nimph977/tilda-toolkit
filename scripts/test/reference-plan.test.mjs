import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { buildReferencePlan, BUTTON_REASONS, generateReferencePlan, linkFieldFor, menuItems, parseSubstitutes, SHAPE_REASONS, soclinksShapeSupported, VIDEO_FIELD_BY_KIND, VIDEO_REASONS } from '../reference-plan.mjs';
import { buildLinkIndex, LINK_REASONS } from '../lib/reference-links.mjs';

setLogLevel('ERROR');

const cat = (tplid, content, settings = ['bgcolor']) => ({ tplid, available: true, tabs: { content, settings }, defaults: {}, cardKeys: [] });
const CATALOGS = {
  796: cat('796', ['title', 'descr', 'buttontitle', 'buttonlink', 'img']),
  702: cat('702', ['btitle', 'bdescr', 'list']),
  835: { tplid: '835', available: false, error: 'no access' },
  30: cat('30', ['title']),
};
const IMAGE_MAP = { 'https://cdn.test/a.jpg': 'site-reference/demo/images/aaa.jpg', 'https://cdn.test/one.png': 'site-reference/demo/images/one.png' };

const block = (order, tplid, extra = {}) => ({ order, recid: String(7000 + order), tplid, fields: [], images: [], links: [], cards: [], hasForm: false, text: '', ...extra });

const STRUCTURE = {
  name: 'index',
  url: 'https://ref.test/',
  blocks: [
    block(1, '796', {
      fields: [{ name: 'title', text: 'Заголовок', href: null }, { name: 'descr', text: 'Описание вторая строка', html: 'Описание<br>вторая строка', href: null }, { name: 'buttontitle', text: 'Кнопка', href: 'https://ref.test/about' }],
      images: [{ field: 'img', src: 'https://cdn.test/a.jpg', alt: '' }],
    }),
    block(2, '702', {
      cards: [
        { lid: '11', fields: { li_title: 'Один', li_descr: 'Первая Б', li_extra: 'x' }, html: { li_title: 'Один', li_descr: 'Первая<br>Б' }, hrefs: { li_title: 'https://ref.test/1' }, images: { li_img: 'https://cdn.test/one.png' } },
        { lid: '22', fields: { li_title: 'Два' }, hrefs: {}, images: { li_img: 'https://cdn.test/two.png' } },
      ],
    }),
    block(3, '396'),
    block(4, '835', { fields: [{ name: 'title', text: 'x', href: null }] }),
    block(5, '131', { fields: [{ name: 'code', text: 'x', href: null }] }),
    block(6, '30', { fields: [{ name: 'title', text: 'Заг', href: null }, { name: 'foo', text: 'bar', href: null }], hasForm: true }),
    block(7, '30'),
  ],
};

test('linkFieldFor maps button titles to link fields when the template knows them', () => {
  assert.equal(linkFieldFor('buttontitle2', new Set(['buttonlink2'])), 'buttonlink2');
  assert.equal(linkFieldFor('buttontitle', new Set(['buttonlink'])), 'buttonlink');
  assert.equal(linkFieldFor('buttontitle', new Set(['title'])), null);
  assert.equal(linkFieldFor('title', new Set(['buttonlink'])), null);
});

test('buildReferencePlan falls back to text when html is absent', () => {
  // Структуры, снятые до появления формы `html`, остаются читаемыми.
  const legacy = {
    ...STRUCTURE,
    blocks: [{ order: 1, recid: '1', tplid: '796', fields: [{ name: 'title', text: 'Старый заголовок', href: null }], images: [], cards: [], links: [] }],
  };
  const { plan } = buildReferencePlan(legacy, { page: '200002', slug: 'demo', catalogs: CATALOGS, imageMap: {} });
  const byName = Object.fromEntries(plan.ops[0].newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.title, 'Старый заголовок');
});

test('buildReferencePlan builds newRecord ops with fields, links, cards and images', () => {
  const { plan, skipped, unmapped } = buildReferencePlan(STRUCTURE, { page: '200002', slug: 'demo', catalogs: CATALOGS, imageMap: IMAGE_MAP });
  assert.equal(plan.page, '200002');
  assert.equal(plan.name, 'reference:demo/index');
  assert.deepEqual(plan.ops.map((o) => o.id), ['b1', 'b2', 'b6']);

  const b1 = plan.ops[0].newRecord;
  assert.equal(b1.tplid, '796');
  assert.deepEqual(Object.fromEntries(b1.fields.map((f) => [f.name, f.value])), { title: 'Заголовок', descr: 'Описание<br>вторая строка', buttontitle: 'Кнопка', buttonlink: 'https://ref.test/about' });
  assert.deepEqual(b1.images, [{ field: 'img', file: 'site-reference/demo/images/aaa.jpg' }]);
  assert.equal(plan.ops[0].hidden, 'n');

  const b2 = plan.ops[1].newRecord;
  assert.equal(b2.cards.length, 2);
  assert.deepEqual(b2.cards[0], { li_title: 'Один', li_descr: 'Первая<br>Б', li_img: '', 'li-tubutton': '', li_imgalt: '' });
  assert.deepEqual(b2.images, [{ card: 0, field: 'li_img', file: 'site-reference/demo/images/one.png' }]);
  assert.ok(unmapped.some((u) => u.order === 2 && u.card === 1 && /не скачан/.test(u.reason)));
  assert.ok(unmapped.some((u) => u.order === 2 && u.field === 'li_extra'));
  assert.ok(unmapped.some((u) => u.order === 2 && /ссылка карточки/.test(u.reason)));

  assert.deepEqual(skipped.map((s) => [s.order, s.reason]), [
    [3, 'Zero Block не поддерживается'],
    [4, 'шаблон недоступен на тарифе — укажите --substitute <tplid>=<доступный>'],
    [5, 'каталог не снят: catalog capture'],
    [7, 'содержимое вне полей field= — не переносится'],
  ]);
  assert.ok(unmapped.some((u) => u.order === 6 && u.field === 'foo' && u.reason === 'поля нет в каталоге'));
  assert.ok(unmapped.some((u) => u.order === 6 && /форма/.test(u.reason)));
  assert.deepEqual(plan.ops[2].newRecord.fields, [{ name: 'title', value: 'Заг' }]);
});

test('generateReferencePlan writes a plan file from the snapshot and catalog dirs', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-plan-'));
  try {
    assert.throws(() => generateReferencePlan({ slug: 'demo', source: 'index', page: '200002', baseDir, catalogDir: baseDir, out: join(baseDir, 'p.json') }), (e) => e.code === 'NO_STRUCTURE' && e.exitCode === 1);
    mkdirSync(join(baseDir, 'demo', 'structure'), { recursive: true });
    mkdirSync(join(baseDir, 'catalog'), { recursive: true });
    writeFileSync(join(baseDir, 'demo', 'structure', 'index.json'), JSON.stringify(STRUCTURE));
    writeFileSync(join(baseDir, 'demo', 'reference.json'), JSON.stringify({ slug: 'demo', url: 'https://ref.test/', pages: [], images: IMAGE_MAP }));
    for (const [tplid, entry] of Object.entries(CATALOGS)) writeFileSync(join(baseDir, 'catalog', `${tplid}.json`), JSON.stringify(entry));
    const out = join(baseDir, 'plans', 'p.json');
    const r = generateReferencePlan({ slug: 'demo', source: 'index', page: '200002', baseDir, catalogDir: baseDir, out });
    assert.equal(r.path, out);
    assert.equal(r.ops, 3);
    assert.equal(r.blocks, 7);
    assert.equal(r.skipped.length, 4);
    assert.ok(existsSync(out));
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(plan.ops.every((o) => o.newRecord));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildReferencePlan blanks catalog defaults for content fields missing in the reference', () => {
  const catalogs = {
    30: { tplid: '30', available: true, tabs: { content: ['id', 'pageid', 'tplid', 'title', 'descr', 'subtitle', 'img', 'slideqty', 'formactiontype'], settings: ['bgcolor'] }, defaults: { title: 'Pulp Fiction', descr: 'Stock descr', subtitle: 'STOCK SUBTITLE', img: 'https://static.tildacdn.com/tild1/stock.jpg', bgcolor: '#fff' }, cardKeys: [] },
  };
  const structure = { name: 'index', blocks: [block(1, '30', { fields: [{ name: 'title', text: 'Заголовок', href: null }] })] };
  const { plan } = buildReferencePlan(structure, { page: '200002', slug: 'demo', catalogs, imageMap: {} });
  const fields = Object.fromEntries(plan.ops[0].newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(fields.title, 'Заголовок');
  assert.equal(fields.descr, '', 'стоковое descr должно быть очищено');
  assert.equal(fields.subtitle, '', 'стоковый subtitle должен быть очищен');
  assert.equal(fields['img-del'], 'yes', 'стоковая картинка сбрасывается флагом img-del');
  assert.ok(!('img' in fields), 'голое img не пишем');
  assert.ok(!('bgcolor' in fields), 'поля вкладки «Настройки» не трогаем');
  assert.ok(!('slideqty' in fields) && !('pageid' in fields), 'служебные поля не пишем');
});

test('buildReferencePlan creates field-less spacer blocks and skips unmapped content blocks', () => {
  const service = ['id', 'pageid', 'tplid', 'slideqty', 'formactiontype'];
  const catalogs = {
    796: { tplid: '796', available: true, tabs: { content: [...service], settings: ['height', 'bgcolor'] }, defaults: { height: '100px' }, cardKeys: [] },
    794: { tplid: '794', available: true, tabs: { content: [...service, 'menuitems'], settings: [] }, defaults: { menuitems: '[{"title":"About"}]' }, cardKeys: [] },
  };
  // Блок 746: содержимое есть, но вне полей field= и без menuitems — остаётся пропуском.
  catalogs[746] = { tplid: '746', available: true, tabs: { content: [...service, 'gallery', 'json'], settings: [] }, defaults: {}, cardKeys: [] };
  const structure = {
    name: 'index',
    blocks: [
      block(1, '796'),
      block(2, '794', { text: 'About Work', links: [{ href: 'https://ref.test/about', text: 'About' }] }),
      block(3, '746', { text: 'Галерея', links: [{ href: 'https://ref.test/g', text: 'Фото' }] }),
    ],
  };
  const { plan, skipped } = buildReferencePlan(structure, { page: '200002', slug: 'demo', catalogs, imageMap: {} });
  assert.deepEqual(plan.ops.map((o) => o.id), ['b1', 'b2'], 'разделитель без полей и меню с menuitems должны стать операциями');
  assert.deepEqual(plan.ops[0].newRecord, { tplid: '796', fields: [] });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].order, 3);
  assert.match(skipped[0].reason, /вне полей/);
});

// --- Оформление блоков (Фаза 3) ---

const STYLES_464 = { paddingTop: '30px', paddingBottom: '90px', bgColor: '#4599ff', typo: { title: { color: '#ffffff' }, descr: { color: '#000000' } } };
const styleStructure = (catalogs, blocks) => ({ structure: { name: 'index', url: 'https://ref.test/', blocks }, catalogs });

test('styleFields maps paddings, background and typo onto catalog settings', () => {
  const catalogs = { 464: cat('464', ['title', 'descr'], ['margintop', 'marginbottom', 'blockbackground', 'title_typo']) };
  const blocks = [block(1, '464', { fields: [{ name: 'title', text: 'Заг', html: 'Заг', href: null }], styles: STYLES_464 })];
  const { plan, unmapped } = buildReferencePlan(styleStructure(catalogs, blocks).structure, { page: '200002', slug: 'demo', catalogs });
  const byName = Object.fromEntries(plan.ops[0].newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.margintop, '30px');
  assert.equal(byName.marginbottom, '90px');
  assert.equal(byName.blockbackground, '#4599ff');
  assert.equal(byName.title_typo, '{"color":"#ffffff"}');
  // Семейство, которого нет во вкладке «Настройки», уходит причиной, а не молча.
  assert.ok(unmapped.some((u) => u.field === 'descr_typo' && /типографика: поля descr_typo/.test(u.reason)));
});

test('styleFields reports every style family when the template has no settings fields', () => {
  const catalogs = { 464: cat('464', ['title'], []) };
  const blocks = [block(1, '464', { fields: [{ name: 'title', text: 'Заг', html: 'Заг', href: null }], styles: STYLES_464 })];
  const { plan, unmapped } = buildReferencePlan(styleStructure(catalogs, blocks).structure, { page: '200002', slug: 'demo', catalogs });
  assert.deepEqual(plan.ops[0].newRecord.fields.map((f) => f.name), ['title']);
  assert.ok(unmapped.some((u) => /^отступ:/.test(u.reason) && u.field === 'margintop'));
  assert.ok(unmapped.some((u) => /^отступ:/.test(u.reason) && u.field === 'marginbottom'));
  assert.ok(unmapped.some((u) => /^фон:/.test(u.reason)));
  assert.ok(unmapped.some((u) => /^типографика:/.test(u.reason)));
});

test('buildReferencePlan with styles=false writes no style fields and no style reasons', () => {
  const catalogs = { 464: cat('464', ['title'], ['margintop', 'blockbackground', 'title_typo']) };
  const blocks = [block(1, '464', { fields: [{ name: 'title', text: 'Заг', html: 'Заг', href: null }], styles: STYLES_464 })];
  const { plan, unmapped } = buildReferencePlan(styleStructure(catalogs, blocks).structure, { page: '200002', slug: 'demo', catalogs, styles: false });
  assert.deepEqual(plan.ops[0].newRecord.fields.map((f) => f.name), ['title']);
  assert.equal(unmapped.length, 0);
});

test('spacer block carries its paddings', () => {
  const catalogs = { 113: cat('113', ['id', 'pageid', 'tplid'], ['margintop', 'marginbottom']) };
  const blocks = [block(1, '113', { styles: { paddingTop: '45px', paddingBottom: null, bgColor: null, typo: {} } })];
  const { plan } = buildReferencePlan(styleStructure(catalogs, blocks).structure, { page: '200002', slug: 'demo', catalogs });
  assert.deepEqual(plan.ops[0].newRecord.fields, [{ name: 'margintop', value: '45px' }]);
});

test('styles do not create a block that is otherwise skipped', () => {
  const catalogs = { 464: cat('464', ['title', 'descr'], ['margintop', 'blockbackground']) };
  const blocks = [block(1, '464', { styles: STYLES_464 })];
  const { plan, skipped } = buildReferencePlan(styleStructure(catalogs, blocks).structure, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops.length, 0);
  assert.ok(skipped.some((s) => /содержимое вне полей field=/.test(s.reason)));
});

// --- Соцссылки (Фаза 4) ---

const SOC_ITEMS = [{ service: 'whatsapp', href: 'https://wa.me/example' }, { service: 'telegram', href: 'https://t.me/example' }];
const SOC_VALUE = '[{"service":"whatsapp","link":"https://wa.me/example"},{"service":"telegram","link":"https://t.me/example"}]';
const withDefaults = (entry, defaults) => ({ ...entry, defaults });

test('soclinksShapeSupported distinguishes {service,link} from messenger form', () => {
  assert.equal(soclinksShapeSupported({ defaults: { soclinks: '[{"service":"facebook","link":"https://x"}]' } }), true);
  assert.equal(soclinksShapeSupported({ defaults: { soclinks: '[{"service":"telegram","title":"T","type":"username","username":"u"}]' } }), false);
  assert.equal(soclinksShapeSupported({ defaults: { soclinks: '' } }), true);
  assert.equal(soclinksShapeSupported({ defaults: {} }), true);
  assert.equal(soclinksShapeSupported({ defaults: { soclinks: 'не json' } }), false);
});

test('buildReferencePlan writes soclinks and creates the block instead of skipping it', () => {
  const catalogs = { 212: withDefaults(cat('212', ['soclinks'], ['margintop', 'marginbottom']), { soclinks: '[{"service":"facebook","link":"https://x"}]' }) };
  const blocks = [block(1, '212', { soclinks: SOC_ITEMS })];
  const { plan, skipped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(skipped.length, 0);
  assert.deepEqual(plan.ops[0].newRecord.fields, [{ name: 'soclinks', value: SOC_VALUE }]);
});

test('buildReferencePlan reports messenger-form soclinks and keeps the block skipped', () => {
  const catalogs = { 898: withDefaults(cat('898', ['soclinks'], []), { soclinks: '[{"service":"telegram","title":"T","type":"username","username":"u"}]' }) };
  const blocks = [block(1, '898', { soclinks: SOC_ITEMS })];
  const { plan, skipped, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops.length, 0);
  assert.ok(skipped.some((s) => /содержимое вне полей field=/.test(s.reason)));
  assert.ok(unmapped.some((u) => u.reason === 'соцссылки: формат soclinks шаблона не поддерживается'));
});

test('buildReferencePlan reports soclinks when the template has no such field', () => {
  const catalogs = { 796: cat('796', ['title'], []) };
  const blocks = [block(1, '796', { fields: [{ name: 'title', text: 'Заг', html: 'Заг', href: null }], soclinks: SOC_ITEMS })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.deepEqual(plan.ops[0].newRecord.fields.map((f) => f.name), ['title']);
  assert.ok(unmapped.some((u) => u.reason === 'соцссылки: нет поля soclinks в каталоге'));
});

test('a template with stock soclinks but no reference links gets the field blanked', () => {
  const catalogs = { 212: withDefaults(cat('212', ['soclinks'], []), { soclinks: '[{"service":"facebook","link":"https://x"}]' }) };
  const blocks = [block(1, '212', { fields: [{ name: 'soclinks', text: '', html: '', href: null }] })];
  const { plan } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.deepEqual(plan.ops[0].newRecord.fields, [{ name: 'soclinks', value: '' }]);
});

// --- Ссылки карточек (Фаза 5) ---

test('card href goes to li_link when the template stores it', () => {
  const catalogs = { 702: { ...cat('702', ['btitle', 'bdescr', 'list']), cardKeys: ['li_title', 'li_descr', 'li_link'] } };
  const blocks = [block(1, '702', { cards: [{ lid: '11', fields: { li_title: 'Один' }, html: { li_title: 'Один' }, hrefs: { li_title: 'https://ref.test/1' }, images: {} }] })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops[0].newRecord.cards[0].li_link, 'https://ref.test/1');
  assert.ok(!unmapped.some((u) => /ссылка карточки/.test(u.reason)));
});

test('card href is reported when the template does not store li_link', () => {
  const catalogs = { 702: { ...cat('702', ['btitle', 'bdescr', 'list']), cardKeys: ['li_title', 'li_descr'] } };
  const blocks = [block(1, '702', { cards: [{ lid: '11', fields: { li_title: 'Один' }, html: { li_title: 'Один' }, hrefs: { li_title: 'https://ref.test/1' }, images: {} }] })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.ok(!('li_link' in plan.ops[0].newRecord.cards[0]));
  assert.ok(unmapped.some((u) => u.reason === 'ссылка карточки: шаблон не хранит li_link'));
});

// --- Меню и замена шаблона (Фаза 5) ---

const MENU_LINKS = [
  { text: '', href: 'https://ref.test/' },
  { text: 'О нас', href: 'https://ref.test/about' },
  { text: 'О нас', href: 'https://ref.test/about2' },
  { text: 'Telegram', href: 'https://t.me/x' },
  { text: 'Контакты', href: 'https://ref.test/contacts' },
];

test('menuItems drops empty titles, social hosts and duplicates', () => {
  const { items, duplicates } = menuItems({ links: MENU_LINKS });
  assert.deepEqual(items, [
    { title: 'О нас', link: 'https://ref.test/about' },
    { title: 'Контакты', link: 'https://ref.test/contacts' },
  ]);
  // Отброшенный дубль возвращается отдельно — причину по нему пишет menuFields.
  assert.deepEqual(duplicates, [{ title: 'О нас', link: 'https://ref.test/about2' }]);
  assert.deepEqual(menuItems({}), { items: [], duplicates: [] });
});

test('a template with menuitems gets the menu and linkhook instead of being skipped', () => {
  const catalogs = { 794: cat('794', ['menuitems', 'linkhook'], []) };
  const blocks = [block(1, '794', { links: MENU_LINKS, linkhook: '#submenu:more' })];
  const { plan, skipped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(skipped.length, 0);
  const byName = Object.fromEntries(plan.ops[0].newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.menuitems, '[{"title":"О нас","link":"https://ref.test/about","linktarget":""},{"title":"Контакты","link":"https://ref.test/contacts","linktarget":""}]');
  assert.equal(byName.linkhook, '#submenu:more');
});

test('linkhook alone does not create a block without content', () => {
  const catalogs = {
    702: cat('702', ['title', 'linkhook'], []),
    746: cat('746', ['gallery', 'json', 'linkhook'], []),
  };
  const blocks = [
    block(1, '702', { hasForm: true, linkhook: '#popup:x' }),
    block(2, '746', { linkhook: '#gallery:y' }),
  ];
  const { plan, skipped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops.length, 0);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => /вне полей/.test(s.reason)));
});

test('menu links are not content for a template without menuitems and without substitution', () => {
  const catalogs = { 746: cat('746', ['gallery', 'json'], []) };
  const blocks = [block(1, '746', { links: MENU_LINKS })];
  const { plan, skipped, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops.length, 0);
  assert.ok(skipped.some((s) => /вне полей/.test(s.reason)));
  assert.ok(!unmapped.some((u) => /меню/.test(u.reason)));
});

test('parseSubstitutes accepts repeats and comma-separated pairs, last wins', () => {
  assert.deepEqual(parseSubstitutes(['770=228,835=580', '770=229']), { 770: '229', 835: '580' });
  assert.deepEqual(parseSubstitutes(), {});
});

test('substitution builds an unavailable menu block with the replacement template', () => {
  const catalogs = {
    835: { tplid: '835', available: false, error: 'no access' },
    702: { ...cat('702', ['btitle', 'bdescr', 'list'], []), cardKeys: ['li_title', 'li_descr', 'li_link'] },
  };
  const blocks = [block(1, '835', { links: MENU_LINKS, fields: [{ name: 'title', text: 'Шапка', html: 'Шапка', href: null }] })];
  const { plan, skipped, unmapped, substituted } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs, substitutes: { 835: '702' } });
  assert.equal(skipped.length, 0);
  assert.equal(plan.ops[0].newRecord.tplid, '702');
  assert.deepEqual(plan.ops[0].newRecord.cards.map((c) => [c.li_title, c.li_link]), [['О нас', 'https://ref.test/about'], ['Контакты', 'https://ref.test/contacts']]);
  assert.ok(unmapped.some((u) => u.field === 'title' && u.reason === 'поля нет в каталоге'));
  assert.deepEqual(substituted, [{ order: 1, from: '835', to: '702' }]);
});

test('substitution to a menuitems template writes JSON instead of cards', () => {
  const catalogs = { 835: { tplid: '835', available: false }, 794: cat('794', ['menuitems'], []) };
  const blocks = [block(1, '835', { links: MENU_LINKS })];
  const { plan } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs, substitutes: { 835: '794' } });
  assert.equal(plan.ops[0].newRecord.tplid, '794');
  assert.ok(!plan.ops[0].newRecord.cards);
  assert.match(plan.ops[0].newRecord.fields.find((f) => f.name === 'menuitems').value, /О нас/);
});

test('substitution to a template without a captured catalog is reported', () => {
  const catalogs = { 835: { tplid: '835', available: false } };
  const blocks = [block(1, '835', { links: MENU_LINKS })];
  const { plan, skipped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs, substitutes: { 835: '999' } });
  assert.equal(plan.ops.length, 0);
  assert.equal(skipped[0].reason, 'каталог замены не снят: catalog capture --tplid 999');
});

test('card text keys come from the catalog, not a fixed list', () => {
  // Шаблон 686 хранит подпись карточки в li_text; жёсткий список её терял.
  const catalogs = {
    686: { ...cat('686', ['btitle', 'bdescr', 'list'], []), cardKeys: ['ls', 'loff', 'li_img', 'li_img2', 'li_title', 'li_text', 'li_link', 'li_linktarget'] },
  };
  const blocks = [block(1, '686', {
    cards: [{ lid: '11', fields: { li_title: 'КТК', li_text: 'Каркасно-тентовые конструкции' }, html: { li_title: 'КТК', li_text: 'Каркасно-тентовые<br>конструкции' }, hrefs: {}, images: {} }],
  })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  const card = plan.ops[0].newRecord.cards[0];
  assert.equal(card.li_title, 'КТК');
  assert.equal(card.li_text, 'Каркасно-тентовые<br>конструкции', 'подпись карточки должна переноситься');
  assert.ok(!unmapped.some((u) => u.field === 'li_text'), 'li_text не должен попадать в unmapped');
  // Картинки и служебные ключи каталога текстом не переносятся.
  for (const k of ['ls', 'loff', 'li_img2', 'li_linktarget']) assert.ok(!(k in card), k + ' не должен попадать в карточку');
});

test('a catalog without cardKeys keeps the previous pair of text keys', () => {
  const catalogs = { 702: cat('702', ['btitle', 'bdescr', 'list'], []) };
  const blocks = [block(1, '702', {
    cards: [{ lid: '11', fields: { li_title: 'Один', li_descr: 'Текст', li_text: 'лишнее' }, html: { li_title: 'Один', li_descr: 'Текст' }, hrefs: {}, images: {} }],
  })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops[0].newRecord.cards[0].li_title, 'Один');
  assert.equal(plan.ops[0].newRecord.cards[0].li_descr, 'Текст');
  assert.ok(unmapped.some((u) => u.field === 'li_text' && /не переносится/.test(u.reason)));
});

test('substitution to an unavailable template is not counted as a substitution', () => {
  // Замена засчитывалась до проверки доступности: блок уходил в skipped, а итог показывал «замен: 1».
  const catalogs = {
    835: { tplid: '835', available: false, error: 'no access' },
    770: { tplid: '770', available: false, error: 'no access' },
  };
  const blocks = [block(1, '835', { fields: [{ name: 'title', text: 'Шапка', html: 'Шапка', href: null }] })];
  const { plan, skipped, substituted } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs, substitutes: { 835: '770' } });
  assert.equal(plan.ops.length, 0);
  assert.equal(skipped[0].reason, 'шаблон замены недоступен на тарифе');
  assert.deepEqual(substituted, [], 'несобранная замена не должна попадать в счётчик');
});

test('card links beyond the one written to li_link get their own reason', () => {
  // Бралась первая ссылка из hrefs, остальные исчезали без причины.
  const catalogs = { 702: { ...cat('702', ['btitle', 'bdescr', 'list']), cardKeys: ['li_title', 'li_descr', 'li_link'] } };
  const blocks = [block(1, '702', {
    cards: [{
      lid: '11',
      fields: { li_title: 'Один', li_descr: 'Текст' },
      html: { li_title: 'Один', li_descr: 'Текст' },
      hrefs: { li_title: 'https://ref.test/1', li_descr: 'https://ref.test/2' },
      images: {},
    }],
  })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  assert.equal(plan.ops[0].newRecord.cards[0].li_link, 'https://ref.test/1');
  const extra = unmapped.filter((u) => /вторая ссылка|ссылка карточки/.test(u.reason) && u.text?.includes('/2'));
  assert.equal(extra.length, 1, 'у неиспользованной ссылки карточки должна быть своя причина');
});

test('a duplicate menu title is dropped with its own reason', () => {
  // Дубль по тексту схлопывается (для навигации верно), но адрес не должен исчезать без следа.
  const catalogs = { 794: cat('794', ['menuitems'], []) };
  const blocks = [block(1, '794', {
    links: [
      { text: 'О нас', href: 'https://ref.test/a' },
      { text: 'О нас', href: 'https://ref.test/b' },
    ],
  })];
  const { plan, unmapped } = buildReferencePlan({ name: 'index', blocks }, { page: '200002', slug: 'demo', catalogs });
  const items = JSON.parse(plan.ops[0].newRecord.fields.find((f) => f.name === 'menuitems').value);
  assert.equal(items.length, 1, 'дубль по тексту остаётся отброшенным');
  assert.equal(items[0].link, 'https://ref.test/a');
  const dup = unmapped.filter((u) => /пункт меню/.test(u.reason));
  assert.equal(dup.length, 1, 'у отброшенного дубля должна быть причина');
  assert.ok(dup[0].text.includes('/b'), 'причина должна называть потерянный адрес');
});

// --- Сборка сайта: зона и ссылки ---

const SITE = {
  slug: 'x',
  projectid: null,
  substitutes: { 770: '794' },
  pages: [
    { label: 'HDR', role: 'header', pageid: '100009' },
    { label: 'FTR', role: 'footer', pageid: null },
    { label: 'P00', role: 'content', name: 'index', url: 'https://ref.test/', pageid: '100001' },
    { label: 'P01', role: 'content', name: 'about', url: 'https://ref.test/about', pageid: '100002' },
  ],
};
const LINKS = { origin: 'https://ref.test', pageUrl: 'https://ref.test/', index: buildLinkIndex(SITE) };

const zoned = () => ({
  name: 'index',
  url: 'https://ref.test/',
  counts: { zones: { header: 1, footer: 1, content: 2 } },
  blocks: [
    block(1, '30', { zone: 'header', fields: [{ name: 'title', text: 'Шапка', href: null }] }),
    block(2, '30', { zone: 'content', fields: [{ name: 'title', text: 'Контент', href: null }] }),
    block(3, '30', { fields: [{ name: 'title', text: 'Без зоны', href: null }] }),
    block(4, '30', { zone: 'footer', fields: [{ name: 'title', text: 'Подвал', href: null }] }),
  ],
});

test('zone content keeps content blocks and counts the rest as filtered', () => {
  const r = buildReferencePlan(zoned(), { page: '200002', slug: 'demo', catalogs: CATALOGS, zone: 'content' });
  assert.deepEqual(r.plan.ops.map((o) => o.id), ['b2', 'b3']);
  assert.equal(r.zoneFiltered, 2);
  assert.equal(r.skipped.length, 0);
});

test('zone header builds only the header block', () => {
  const r = buildReferencePlan(zoned(), { page: '200002', slug: 'demo', catalogs: CATALOGS, zone: 'header' });
  assert.deepEqual(r.plan.ops.map((o) => o.id), ['b1']);
  assert.equal(r.zoneFiltered, 3);
});

test('links rewrite fields, menus and cards to /page<pageid>.html and explain the rest', () => {
  const catalogs = { ...CATALOGS, 794: cat('794', ['menuitems'], []), 702: { ...cat('702', ['btitle', 'bdescr', 'list']), cardKeys: ['li_title', 'li_link'] } };
  const structure = {
    name: 'index',
    url: 'https://ref.test/',
    blocks: [
      block(1, '796', { fields: [{ name: 'buttontitle', text: 'О нас', href: 'https://ref.test/about' }] }),
      block(2, '794', { links: [{ text: 'О нас', href: 'https://ref.test/about/' }, { text: 'Нет', href: 'https://ref.test/nope' }] }),
      block(3, '702', { cards: [{ lid: '1', fields: { li_title: 'К' }, hrefs: { li_title: 'https://ref.test/about#f' }, images: {} }] }),
    ],
  };
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs, links: LINKS });
  const fieldsOf = (id) => Object.fromEntries(r.plan.ops.find((o) => o.id === id).newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(fieldsOf('b1').buttonlink, '/page100002.html');
  assert.deepEqual(JSON.parse(fieldsOf('b2').menuitems).map((i) => i.link), ['/page100002.html', 'https://ref.test/nope']);
  assert.equal(r.plan.ops.find((o) => o.id === 'b3').newRecord.cards[0].li_link, '/page100002.html#f');
  const lost = r.unmapped.filter((u) => u.reason === LINK_REASONS.unknownPage);
  assert.deepEqual(lost.map((u) => [u.order, u.field, u.text]), [[2, 'menuitems', '/nope']]);
  assert.ok(lost.every((u) => !u.text.includes('ref.test')));
  // Уникальные исходные адреса по блокам: /about, /about/, /about#f — три; /nope оставлен.
  assert.deepEqual(r.links, { rewritten: 3, kept: 1 });
});

test('a block that ends in skipped gives no link reasons', () => {
  const structure = { name: 'index', url: 'https://ref.test/', blocks: [block(1, '999', { fields: [{ name: 'title', text: 'x', href: 'https://ref.test/nope' }] })] };
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs: CATALOGS, links: LINKS });
  assert.equal(r.skipped.length, 1);
  assert.equal(r.unmapped.length, 0);
  assert.deepEqual(r.links, { rewritten: 0, kept: 0 });
});

test('a button address kept on the reference gives one reason from the button, not from links', () => {
  const structure = {
    name: 'index',
    url: 'https://ref.test/',
    blocks: [block(1, '796', {
      fields: [{ name: 'title', text: 'Заголовок', href: null }],
      buttons: [{ slot: '', text: 'Куда-то', html: 'Куда-то', href: 'https://ref.test/nope', source: 'attr' }],
      links: [{ text: 'Куда-то', href: 'https://ref.test/nope' }],
    })],
  };
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs: CATALOGS, links: LINKS });
  const reasons = r.unmapped.filter((u) => u.reason === LINK_REASONS.unknownPage);
  assert.deepEqual(reasons.map((u) => u.field), ['buttontitle']);
  assert.equal(r.links.kept, 1);

  const menuCatalogs = { 835: { tplid: '835', available: false }, 702: { ...cat('702', ['btitle', 'list'], []), cardKeys: ['li_title', 'li_link'] } };
  const menu = { name: 'index', url: 'https://ref.test/', blocks: [block(1, '835', { links: [{ text: 'Куда-то', href: 'https://ref.test/nope' }] })] };
  const m = buildReferencePlan(menu, { page: '100001', slug: 'demo', catalogs: menuCatalogs, links: LINKS, substitutes: { 835: '702' } });
  assert.deepEqual(m.unmapped.filter((u) => u.reason === LINK_REASONS.unknownPage).map((u) => u.field), ['li_link']);
});

test('without links the plan only counts reference addresses', () => {
  const r = buildReferencePlan(STRUCTURE, { page: '200002', slug: 'demo', catalogs: CATALOGS, imageMap: IMAGE_MAP });
  assert.equal(r.links.rewritten, 0);
  assert.ok(r.links.referenceLinks >= 1);
});

function labelFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'ref-plan-label-'));
  mkdirSync(join(baseDir, 'x', 'structure'), { recursive: true });
  mkdirSync(join(baseDir, 'catalog'), { recursive: true });
  const structure = {
    name: 'index',
    url: 'https://ref.test/',
    counts: { zones: { header: 1, footer: 0, content: 1 } },
    blocks: [
      block(1, '770', { zone: 'header', links: [{ text: 'О нас', href: 'https://ref.test/about' }] }),
      block(2, '796', { zone: 'content', fields: [{ name: 'buttontitle', text: 'Дальше', href: 'https://ref.test/about' }] }),
    ],
  };
  writeFileSync(join(baseDir, 'x', 'structure', 'index.json'), JSON.stringify(structure));
  writeFileSync(join(baseDir, 'x', 'reference.json'), JSON.stringify({ slug: 'x', url: 'https://ref.test/', pages: [], images: {} }));
  writeFileSync(join(baseDir, 'x', 'site.json'), JSON.stringify(SITE));
  const catalogs = { 796: CATALOGS[796], 770: { tplid: '770', available: false }, 794: cat('794', ['menuitems'], []), 30: CATALOGS[30] };
  for (const [tplid, entry] of Object.entries(catalogs)) writeFileSync(join(baseDir, 'catalog', `${tplid}.json`), JSON.stringify(entry));
  return baseDir;
}

test('generateReferencePlan by label takes page, zone and substitutes from site.json', () => {
  const baseDir = labelFixture();
  try {
    const opts = { slug: 'x', baseDir, catalogDir: baseDir };
    const r = generateReferencePlan({ ...opts, source: 'P00', out: join(baseDir, 'plans', 'reference-x-P00-100001.json') });
    assert.equal(r.label, 'P00');
    assert.equal(r.zone, 'content');
    assert.equal(r.zoneFiltered, 1);
    const plan = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(plan.page, '100001');
    assert.equal(plan.name, 'reference:x/P00');
    assert.equal(plan.ops[0].newRecord.fields.find((f) => f.name === 'buttonlink').value, '/page100002.html');

    const hdr = generateReferencePlan({ ...opts, source: 'HDR', out: join(baseDir, 'hdr.json') });
    assert.equal(hdr.zone, 'header');
    const hdrPlan = JSON.parse(readFileSync(hdr.path, 'utf8'));
    assert.equal(hdrPlan.page, '100009');
    assert.equal(hdrPlan.ops[0].newRecord.tplid, '794');
    assert.equal(JSON.parse(hdrPlan.ops[0].newRecord.fields.find((f) => f.name === 'menuitems').value)[0].link, '/page100002.html');

    assert.throws(() => generateReferencePlan({ ...opts, source: 'P00', page: '100005', out: join(baseDir, 'm.json') }), (e) => e.code === 'PAGE_MISMATCH' && e.exitCode === 2);
    assert.throws(() => generateReferencePlan({ ...opts, source: 'FTR', out: join(baseDir, 'f.json') }), (e) => e.code === 'NO_PAGEID' && e.exitCode === 1);
    assert.throws(() => generateReferencePlan({ ...opts, source: 'P77', out: join(baseDir, 'u.json') }), (e) => e.code === 'UNKNOWN_LABEL' && e.exitCode === 2);
    assert.throws(() => generateReferencePlan({ ...opts, source: 'P00', zone: 'content', out: join(baseDir, 'z.json') }), (e) => e.code === 'ZONE_WITH_LABEL');

    const flag = generateReferencePlan({ ...opts, source: 'HDR', substitutes: { 770: '30' }, out: join(baseDir, 'flag.json') });
    assert.deepEqual(flag.substituted.map((s) => s.to), ['30']);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('generateReferencePlan by page name with zones warns and keeps all blocks', () => {
  const baseDir = labelFixture();
  try {
    const r = generateReferencePlan({ slug: 'x', source: 'index', page: '200002', baseDir, catalogDir: baseDir, out: join(baseDir, 'n.json') });
    assert.equal(r.zone, 'all');
    assert.equal(r.zoneFiltered, 0);
    assert.match(r.hint, /метки/);
    assert.equal(r.label, undefined);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('generateReferencePlan without a site map refuses a label', () => {
  const baseDir = labelFixture();
  try {
    rmSync(join(baseDir, 'x', 'site.json'));
    assert.throws(() => generateReferencePlan({ slug: 'x', source: 'P00', baseDir, catalogDir: baseDir }), (e) => e.code === 'NO_SITE' && e.exitCode === 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- Кнопки и фон-видео ---

const btnCat = (content, extra = {}) => ({ tplid: '213', available: true, tabs: { content, settings: [] }, defaults: { buttontitle: 'About us' }, cardKeys: [], ...extra });
const btnBlock = (buttons, extra = {}) => ({ name: 'index', blocks: [block(1, '213', { fields: [{ name: 'title', text: 'Т', href: null }], buttons, ...extra })] });
const opFields = (r) => Object.fromEntries(r.plan.ops[0].newRecord.fields.map((f) => [f.name, f.value]));

test('a button goes to buttontitle and its link to the link field from tplFields', () => {
  const catalogs = { 213: btnCat(['title', 'buttontitle'], { tplFields: ['title', 'buttontitle', 'buttonlink'] }) };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: 'Заказать', html: 'Заказать', href: '/page100002.html', source: 'attr' }]), { page: '100001', slug: 'demo', catalogs });
  const f = opFields(r);
  assert.equal(f.buttontitle, 'Заказать');
  assert.equal(f.buttonlink, '/page100002.html');
  assert.equal(r.buttons, 1);
  assert.equal(r.unmapped.length, 0);
});

test('without tplFields the link follows an allowed button title (branch A′)', () => {
  const catalogs = { 213: btnCat(['title', 'buttontitle']) };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: 'Заказать', html: 'Заказать', href: '#popup:form', source: 'attr' }]), { page: '100001', slug: 'demo', catalogs });
  assert.equal(opFields(r).buttonlink, '#popup:form');
});

test('a button without a title field in the catalog is reported', () => {
  const catalogs = { 213: btnCat(['title']) };
  const r = buildReferencePlan(btnBlock([{ slot: '2', text: 'Ещё', html: 'Ещё', href: '', source: 'order' }]), { page: '100001', slug: 'demo', catalogs });
  assert.deepEqual(r.unmapped.map((u) => [u.field, u.reason]), [['buttontitle2', BUTTON_REASONS.noField('2')]]);
  assert.equal(r.buttons, 0);
});

// [FIX] У свежего блока текст кнопки пуст, и снимок каталога его не возвращает (480, сверка P00
// 2026-09-23): кнопка «Посмотреть сертификаты» уходила в «нет поля», хотя tplFields её знает.
test('a button title known only from tplFields is written, and a field known nowhere is still reported', () => {
  const catalogs = { 213: btnCat(['title'], { tplFields: ['title', 'buttontitle', 'buttonlink'] }) };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: 'Сертификаты', html: 'Сертификаты', href: '#popup:certs', source: 'attr' }]), { page: '100001', slug: 'demo', catalogs });
  assert.equal(opFields(r).buttontitle, 'Сертификаты');
  assert.equal(opFields(r).buttonlink, '#popup:certs');
  assert.equal(r.buttons, 1);
  assert.equal(r.unmapped.length, 0);

  const r2 = buildReferencePlan(btnBlock([{ slot: '2', text: 'Ещё', html: 'Ещё', href: '', source: 'order' }]), { page: '100001', slug: 'demo', catalogs });
  assert.deepEqual(r2.unmapped.map((u) => [u.field, u.reason]), [['buttontitle2', BUTTON_REASONS.noField('2')]]);
});

test('a plain field known only from tplFields is written, not reported as missing', () => {
  const catalogs = { 213: btnCat(['title'], { tplFields: ['title', 'descr2'] }) };
  const structure = { name: 'index', blocks: [block(1, '213', { fields: [{ name: 'title', text: 'Т', href: null }, { name: 'descr2', text: 'Контакты', html: 'Контакты', href: null }] })] };
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs });
  assert.equal(opFields(r).descr2, 'Контакты');
  assert.equal(r.unmapped.length, 0);
});

test('a button whose link field the template lacks keeps its text and reports the link', () => {
  const catalogs = { 213: btnCat(['title', 'buttontitle'], { tplFields: ['title', 'buttontitle'] }) };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: 'Заказать', html: 'Заказать', href: '/page100002.html', source: 'attr' }]), { page: '100001', slug: 'demo', catalogs });
  assert.equal(opFields(r).buttontitle, 'Заказать');
  assert.equal(opFields(r).buttonlink, undefined);
  assert.deepEqual(r.unmapped.map((u) => u.reason), [BUTTON_REASONS.noLinkField('')]);
});

test('a button without text is not transferred', () => {
  const catalogs = { 213: btnCat(['title', 'buttontitle']) };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: '', html: '', href: '/x', source: 'order' }]), { page: '100001', slug: 'demo', catalogs });
  assert.deepEqual(r.unmapped.map((u) => u.reason), [BUTTON_REASONS.noText('')]);
});

test('a buttontitle field wins over a button of the same slot', () => {
  const catalogs = { 213: btnCat(['title', 'buttontitle']) };
  const structure = btnBlock([{ slot: '', text: 'Кнопка', html: 'Кнопка', href: '', source: 'attr' }], {
    fields: [{ name: 'title', text: 'Т', href: null }, { name: 'buttontitle', text: 'Поле', html: 'Поле', href: null }],
  });
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs });
  assert.equal(r.plan.ops[0].newRecord.fields.filter((f) => f.name === 'buttontitle').length, 1);
  assert.equal(opFields(r).buttontitle, 'Поле');
});

test('the stock button title is not blanked when the reference has a button', () => {
  const catalogs = { 213: btnCat(['title', 'buttontitle']) };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: 'Заказать', html: 'Заказать', href: '', source: 'attr' }]), { page: '100001', slug: 'demo', catalogs });
  assert.equal(opFields(r).buttontitle, 'Заказать');
});

test('cover video goes to the field of its kind when the template has it', () => {
  const video = { kind: 'youtube', url: 'https://ext.test/v' };
  const withField = { 213: btnCat(['title'], { tplFields: ['title', VIDEO_FIELD_BY_KIND.youtube] }) };
  const r = buildReferencePlan(btnBlock([], { video }), { page: '100001', slug: 'demo', catalogs: withField });
  assert.equal(opFields(r)[VIDEO_FIELD_BY_KIND.youtube], 'https://ext.test/v');
  assert.equal(r.videos, 1);

  const without = { 213: btnCat(['title']) };
  const r2 = buildReferencePlan(btnBlock([], { video }), { page: '100001', slug: 'demo', catalogs: without });
  assert.deepEqual(r2.unmapped.map((u) => [u.field, u.reason]), [['youtubeid', VIDEO_REASONS.noField]]);
  assert.equal(r2.videos, 0);
});

test('buttons and videos of a skipped block are not counted', () => {
  const catalogs = { 213: { tplid: '213', available: false } };
  const r = buildReferencePlan(btnBlock([{ slot: '', text: 'Заказать', html: 'Заказать', href: '', source: 'attr' }], { video: { kind: 'rutube', url: 'abc' } }), { page: '100001', slug: 'demo', catalogs });
  assert.equal(r.skipped.length, 1);
  assert.equal(r.buttons, 0);
  assert.equal(r.videos, 0);
});

// [FIX] Ссылки внутри полей переписываются в html поля; счётчик «переписано» — только за адреса,
// которые реально легли в план.
test('links inside field html are rewritten and a kept one gets its reason', () => {
  const structure = {
    name: 'index',
    url: 'https://ref.test/',
    blocks: [block(1, '796', { fields: [{ name: 'descr', text: 'О нас Нет', html: '<a href="https://ref.test/about" style="color: rgb(0, 0, 0)">О нас</a><br><a href="https://ref.test/nope">Нет</a>', href: null }],
      links: [{ text: 'О нас', href: 'https://ref.test/about' }, { text: 'Нет', href: 'https://ref.test/nope' }] })],
  };
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs: CATALOGS, links: LINKS });
  const descr = r.plan.ops[0].newRecord.fields.find((f) => f.name === 'descr').value;
  assert.equal(descr, '<a href="/page100002.html" style="color: rgb(0, 0, 0)">О нас</a><br><a href="https://ref.test/nope">Нет</a>');
  assert.deepEqual(r.unmapped.filter((u) => u.reason === LINK_REASONS.unknownPage).map((u) => [u.field, u.text]), [['descr', '/nope']]);
  assert.deepEqual(r.links, { rewritten: 1, kept: 1 });
});

test('a link that lands nowhere in the plan is not counted as rewritten and gets a reason', () => {
  const structure = {
    name: 'index',
    url: 'https://ref.test/',
    blocks: [block(1, '30', { fields: [{ name: 'title', text: 'О нас', html: 'О нас', href: null }], links: [{ text: 'О нас', href: 'https://ref.test/about' }] })],
  };
  const r = buildReferencePlan(structure, { page: '100001', slug: 'demo', catalogs: CATALOGS, links: LINKS });
  assert.deepEqual(r.links, { rewritten: 0, kept: 0 });
  const lost = r.unmapped.filter((u) => u.reason === LINK_REASONS.outsideFields);
  assert.deepEqual(lost.map((u) => [u.order, u.text]), [[1, '/about']]);
});

// [FIX] Меню 770 → 3535 (сверка P00, 2026-09-23): ссылка кнопки меню становилась лишним пунктом,
// а пункт с подменю (#submenu:<имя>) терялся.
test('menuItems skips the link of a block button and keeps a submenu hook item', () => {
  const b = block(1, '770', {
    links: [{ text: 'О нас', href: '/page100002.html' }, { text: 'Продукция', href: '#submenu:products' }, { text: 'Заказать', href: '/page100003.html' }],
    buttons: [{ slot: '', text: 'Заказать', html: 'Заказать', href: '/page100003.html', source: 'attr' }],
  });
  const { items } = menuItems(b);
  assert.deepEqual(items.map((i) => [i.title, i.link]), [['О нас', '/page100002.html'], ['Продукция', '#submenu:products']]);
});

test('menuItems keeps a link that only shares its text with a button but goes elsewhere', () => {
  const b = block(1, '770', {
    links: [{ text: 'Заказать', href: '/page100004.html' }],
    buttons: [{ slot: '', text: 'Заказать', html: 'Заказать', href: '/page100003.html', source: 'attr' }],
  });
  assert.deepEqual(menuItems(b).items.map((i) => i.link), ['/page100004.html']);
});

test('a divider shape goes to shapedividerstyle; an unknown shape or a missing field gets a reason', () => {
  const catalogs = { 796: { tplid: '796', available: true, tabs: { content: ['id', 'pageid', 'tplid', 'slideqty', 'formactiontype'], settings: ['shapedividerstyle', 'shapescale'] }, defaults: { shapedividerstyle: 'zigzag' }, cardKeys: [] } };
  const of = (shape, cats = catalogs) => buildReferencePlan({ name: 'index', blocks: [block(1, '796', { shape })] }, { page: '100001', slug: 'demo', catalogs: cats });
  const r = of({ style: 'skew', position: 'bottom', path: null });
  assert.deepEqual(r.plan.ops[0].newRecord.fields, [{ name: 'shapedividerstyle', value: 'skew' }]);
  assert.equal(r.unmapped.length, 0);
  const odd = of({ style: null, position: 'bottom', path: 'M0 0L10 10z' });
  assert.deepEqual(odd.plan.ops[0].newRecord.fields, []);
  assert.deepEqual(odd.unmapped.map((u) => [u.field, u.reason]), [['shapedividerstyle', SHAPE_REASONS.unknown]]);
  const noField = of({ style: 'skew', position: 'bottom', path: null }, { 796: { ...catalogs[796], tabs: { content: catalogs[796].tabs.content, settings: [] } } });
  assert.deepEqual(noField.unmapped.map((u) => [u.field, u.reason]), [['shapedividerstyle', SHAPE_REASONS.noField]]);
});

// --- настройки по карте влияния ---------------------------------------------------------------

const GRAD = (a) => `style:background-image:linear-gradient(to bottom,rgba(0,0,0,${a}),rgba(0,0,0,${a}))`;
const MAP_686 = {
  tplid: '686',
  version: 1,
  baseFeatures: ['class:t-col_6', GRAD('0.70')],
  schema: { blocks: { type: 'sb', kind: 'enum' }, filteropacity: { type: 'sb', kind: 'enum' } },
  fields: {
    blocks: { kind: 'enum', rule: { type: 'enum', cases: [{ value: '2', signature: ['class:t-col_6'] }, { value: '3', signature: ['class:t-col_4'] }] } },
    filteropacity: { kind: 'enum', rule: { type: 'enum', cases: [{ value: '70', signature: [GRAD('0.70')] }, { value: '30', signature: [GRAD('0.30')] }] } },
  },
};
const CAT_686 = { tplid: '686', available: true, tabs: { content: ['btitle'], settings: ['margintop', 'blocks', 'filteropacity'] }, defaults: { blocks: '2', filteropacity: '70' }, cardKeys: [] };
const block686 = (extra = {}) => block(1, '686', { fields: [{ name: 'btitle', text: 'Карточки', href: null }], styles: { paddingTop: '60px', typo: {} }, features: ['class:t-col_4', GRAD('0.30')], ...extra });

test('settings go by the settings map when the template is calibrated', () => {
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [block686()] }, { page: '1', slug: 'demo', catalogs: { 686: CAT_686 }, settingsMaps: { 686: MAP_686 } });
  const fields = Object.fromEntries(r.plan.ops[0].newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(fields.blocks, '3');
  assert.equal(fields.filteropacity, '30');
  assert.equal(fields.margintop, '60px', 'отступ, не решённый картой, — из классов записи');
  assert.ok(!r.unmapped.some((u) => /не откалиброван/.test(u.reason)));
  assert.deepEqual(r.settings, { decoded: 3, undecided: 0, unexplained: 0, byMap: 1, byRules: 0 });
});

test('a block without a map keeps rule-based settings and names why, a substituted one names the substitute', () => {
  const blocks = [block686(), { ...block686(), order: 2, recid: '7002', tplid: '30' }, { ...block686(), order: 3, recid: '7003', tplid: '770' }];
  const catalogs = { 686: CAT_686, 30: { ...cat('30', ['btitle'], ['margintop']) }, 794: { ...cat('794', ['btitle'], ['margintop']) } };
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks }, { page: '1', slug: 'demo', catalogs, settingsMaps: { 686: MAP_686 }, substitutes: { 770: '794' } });
  const second = Object.fromEntries(r.plan.ops[1].newRecord.fields.map((f) => [f.name, f.value]));
  assert.equal(second.margintop, '60px');
  assert.ok(r.unmapped.some((u) => u.order === 2 && u.reason === 'настройки: шаблон не откалиброван — catalog calibrate'));
  assert.ok(r.unmapped.some((u) => u.order === 3 && /шаблон 770 заменён на 794/.test(u.reason)));
});

test('--no-styles writes no settings at all, even with a map', () => {
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [block686()] }, { page: '1', slug: 'demo', catalogs: { 686: CAT_686 }, settingsMaps: { 686: MAP_686 }, styles: false });
  const names = r.plan.ops[0].newRecord.fields.map((f) => f.name);
  for (const n of ['blocks', 'filteropacity', 'margintop']) assert.ok(!names.includes(n), n);
});

test('card buttons go to li_buttontitle when the template stores it, otherwise get noButton', () => {
  const cards = [{ lid: '11', fields: { li_title: 'Один', li_buttontitle: 'Подробнее' }, html: { li_title: 'Один', li_buttontitle: 'Подробнее' }, hrefs: {}, images: {} }];
  const withKey = { ...cat('686', ['btitle', 'list']), cardKeys: ['li_title', 'li_buttontitle'] };
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [block(1, '686', { cards })] }, { page: '1', slug: 'demo', catalogs: { 686: withKey } });
  assert.equal(r.plan.ops[0].newRecord.cards[0].li_buttontitle, 'Подробнее');
  const without = { ...cat('686', ['btitle', 'list']), cardKeys: ['li_title'] };
  const r2 = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [block(1, '686', { cards })] }, { page: '1', slug: 'demo', catalogs: { 686: without } });
  assert.ok(r2.unmapped.some((u) => u.field === 'li_buttontitle' && u.reason === 'кнопка карточки: у шаблона нет li_buttontitle'));
});

// --- формы ------------------------------------------------------------------------------------

const FORM = {
  inputs: [
    { type: 'nm', name: 'Имя', placeholder: 'Ваше имя', required: true, rule: 'name', mask: '', title: '' },
    { type: 'ph', name: 'Телефон', placeholder: 'Ваш телефон', required: true, rule: 'phone', mask: '+7 (999) 999-9999', title: '' },
    { type: 'sb', name: 'Выбор', placeholder: '', required: false, rule: '', mask: '', title: '' },
  ],
  successUrl: 'https://ref.test/thanks',
  successMessage: 'Спасибо!',
  successTitle: null,
};
const CAT_702 = { tplid: '702', available: true, tabs: { content: ['title', 'list'], settings: [] }, defaults: {}, cardKeys: [], tplFields: ['title', 'forminputs', 'formtitlesuccess', 'formmsgsuccess', 'formmsgurl'] };

test('a form becomes forminputs, success message and a rewritten formmsgurl with formContent', () => {
  const site = { pages: [{ label: 'P00', role: 'content', url: 'https://ref.test/', pageid: '1000000000101' }, { label: 'P01', role: 'content', url: 'https://ref.test/thanks', pageid: '1000000000102' }] };
  const links = { origin: 'https://ref.test', pageUrl: 'https://ref.test/', index: buildLinkIndex(site) };
  const blk = block(1, '702', { fields: [{ name: 'title', text: 'Заявка', href: null }], hasForm: true, form: FORM });
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [blk] }, { page: '1', slug: 'demo', catalogs: { 702: CAT_702 }, links });
  const op = r.plan.ops[0];
  assert.equal(op.formContent, 'reference');
  const f = Object.fromEntries(op.newRecord.fields.map((x) => [x.name, x.value]));
  const items = JSON.parse(f.forminputs);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { li_type: 'ph', li_nm: 'Телефон', li_name: 'Телефон', li_ph: 'Ваш телефон', li_req: 'y', li_title: '', li_masktype: '', li_mask: '+7 (999) 999-9999' });
  assert.ok(!('li_descr' in items[0]) && !('lid' in items[0]), 'без ключей контентной карточки и без lid');
  assert.equal(f.formmsgsuccess, 'Спасибо!');
  assert.equal(f.formmsgurl, '/page1000000000102.html');
  assert.ok(!('receivers' in f));
  assert.ok(r.unmapped.some((u) => u.reason === 'форма: получатели заявок — настройка проекта-копии, не переносится'));
  assert.ok(r.unmapped.some((u) => u.reason === 'форма: тип поля sb не распознан'));
});

test('a template without the success message field gets noField', () => {
  const cat702 = { ...CAT_702, tplFields: ['title', 'forminputs'] };
  const blk = block(1, '702', { fields: [{ name: 'title', text: 'Заявка', href: null }], hasForm: true, form: FORM });
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [blk] }, { page: '1', slug: 'demo', catalogs: { 702: cat702 } });
  assert.ok(r.unmapped.some((u) => u.field === 'formmsgsuccess' && u.reason === 'форма: у шаблона нет поля formmsgsuccess'));
  assert.ok(r.unmapped.some((u) => u.field === 'formmsgurl'));
  assert.equal(r.plan.ops[0].formContent, undefined);
});

// --- мессенджеры 898 -------------------------------------------------------------------------

test('898 messengers become soclinks elements by MESSENGER_LINK_RULES', () => {
  const stock = [{ service: 'telegram', title: 'Telegram', type: 'username', username: 'u' }, { service: 'whatsapp', title: 'WhatsApp', type: 'tel', tel: '1' }, { service: 'phone', title: 'Phone', tel: '1' }];
  const cat898 = { tplid: '898', available: true, tabs: { content: ['soclinks'], settings: [] }, defaults: { soclinks: JSON.stringify(stock) }, cardKeys: [] };
  const messengers = [
    { service: 'telegram', href: 'https://t.me/+AbCdEf' },
    { service: 'whatsapp', href: 'https://wa.me/71234567890?text=Hi' },
    { service: 'phone', href: 'tel:+71234567890' },
    { service: 'viber', href: 'viber://chat?number=1' },
  ];
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [block(1, '898', { messengers })] }, { page: '1', slug: 'demo', catalogs: { 898: cat898 } });
  const soc = JSON.parse(r.plan.ops[0].newRecord.fields.find((f) => f.name === 'soclinks').value);
  assert.deepEqual(soc, [
    { service: 'telegram', title: 'Telegram', type: 'username', username: '+AbCdEf' },
    { service: 'whatsapp', title: 'WhatsApp', type: 'tel', tel: '71234567890' },
    { service: 'phone', title: 'Phone', tel: '+71234567890' },
  ]);
  assert.ok(r.unmapped.some((u) => u.reason === 'мессенджер viber: адрес не переводится в элемент soclinks'));
  assert.ok(r.unmapped.some((u) => /whatsapp: параметры адреса/.test(u.reason)));
  assert.ok(!r.skipped.length);
});

// --- HTML-блок --------------------------------------------------------------------------------

test('a T123 block becomes newRecord with code, removed scripts get a reason, oversized code is skipped', () => {
  const cat131 = cat('131', ['code']);
  const small = block(1, '131', { code: { code: '<div>x</div>', scripts: 1 } });
  const big = block(2, '131', { code: { code: 'x'.repeat(26 * 1024), scripts: 0 } });
  const r = buildReferencePlan({ name: 'x', url: 'https://ref.test/', blocks: [small, big] }, { page: '1', slug: 'demo', catalogs: { 131: cat131 } });
  assert.deepEqual(r.plan.ops[0].newRecord, { tplid: '131', fields: [], code: '<div>x</div>' });
  assert.ok(r.unmapped.some((u) => u.field === 'code' && u.reason === 'HTML-блок: скрипты вырезаны — их запись сбрасывает сессию Tilda' && u.text === '1'));
  assert.deepEqual(r.skipped, [{ order: 2, tplid: '131', reason: 'HTML-блок: код больше 25 КБ' }]);
});

test('applyFontAliases replaces the reference custom font family in JSON settings with the Tilda preset', async () => {
  const { applyFontAliases } = await import('../reference-plan.mjs');
  const out = applyFontAliases([
    { name: 'button_styles', value: '{"color":"#ffffff","fontfamily":"monserat"}' },
    { name: 'title_typo', value: '{"fontfamily":"Roboto"}' },
    { name: 'margintop', value: '60px' },
  ], { monserat: 'Montserrat' });
  assert.deepEqual(JSON.parse(out[0].value), { color: '#ffffff', fontfamily: 'Montserrat' });
  assert.equal(out[1].value, '{"fontfamily":"Roboto"}');
  assert.equal(out[2].value, '60px');
});
