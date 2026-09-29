import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { collectInternalLinks, extractBlock, extractButtons, extractShape, extractStructure, parseSitemap } from '../lib/reference-structure.mjs';
import { cleanText, liteHtml, splitRecords } from '../lib/html-blocks.mjs';

setLogLevel('ERROR');

const BASE = 'https://ref.test/';

const page = `<html><head><title>Демо &mdash; страница</title></head><body>
<div id="rec7001" class="r t-rec t-rec_pt_60" data-bg-color="#ededed" data-record-type="796">
  <div field="title" class="t-title">Заголовок</div>
  <div field="descr" class="t-descr">Первая<br>Вторая</div>
  <a href="/about" class="t-btn"><span field="buttontitle">Кнопка</span></a>
  <img imgfield="img" data-original="https://cdn.test/a.jpg" src="data:image/gif;base64,x" alt="Фото">
  <div class="t-bgimg" bgimgfield="img2" data-original="https://cdn.test/bg.jpg" style="background-image:url('https://cdn.test/bg.jpg')"></div>
  <a href="#top">якорь</a><a href="mailto:x@y.z">почта</a>
</div>
<div id="rec7002" class="r" data-record-type="702">
  <div class="card"><img imgfield="li_img__11" src="/img/one.png"><div field="li_title__11">Один</div><div field="li_descr__11">A<br />B</div></div>
  <div class="card"><div field="li_title__22">Два</div></div>
</div>
<div id="rec7003" class="r" data-record-type="1002">
  <div field="text"><div>a</div><div>b</div></div>
  <form data-formactiontype="2"><input name="email"></form>
</div>
</body></html>`;

test('liteHtml keeps line breaks and drops other markup', () => {
  assert.equal(
    liteHtml('<div style="color:#010101" data-customstyle="yes"><strong>Раз</strong><br>Два<br/><br />\n  Три &amp; четыре</div>'),
    'Раз<br>Два<br><br>Три & четыре',
  );
  assert.equal(liteHtml('<p>А</p><p>Б</p>'), 'А<br>Б');
  // Без переносов и блочных закрытий форма совпадает с видимым текстом.
  assert.equal(liteHtml(' Один  два '), 'Один два');
  assert.equal(liteHtml(' Один  два '), cleanText(' Один  два '));
  // Края обрезаются, подряд остаётся не больше двух переносов.
  assert.equal(liteHtml('<br>Х<br><br><br>Y<br>'), 'Х<br><br>Y');
});

test('extractBlock reads fields, hrefs and lazy images', () => {
  const rec = splitRecords(page)[0];
  const block = extractBlock(rec, { baseUrl: BASE });
  assert.equal(block.tplid, '796');
  const title = block.fields.find((f) => f.name === 'title');
  assert.equal(title.text, 'Заголовок');
  assert.equal(title.href, null);
  assert.equal(title.html, 'Заголовок');
  const descr = block.fields.find((f) => f.name === 'descr');
  assert.equal(descr.text, 'Первая Вторая');
  assert.equal(descr.html, 'Первая<br>Вторая');
  const button = block.fields.find((f) => f.name === 'buttontitle');
  assert.equal(button.text, 'Кнопка');
  assert.equal(button.href, 'https://ref.test/about');
  assert.equal(block.images.length, 2);
  assert.deepEqual(block.images[0], { field: 'img', src: 'https://cdn.test/a.jpg', alt: 'Фото' });
  assert.deepEqual(block.images[1], { field: 'img2', src: 'https://cdn.test/bg.jpg', alt: '' });
  assert.deepEqual(block.links.map((l) => l.href), ['https://ref.test/about']);
  assert.equal(block.hasForm, false);
  assert.equal(block.styles.paddingTop, '60px');
  assert.equal(block.styles.bgColor, '#ededed');
});

test('extractBlock groups li_* fields into cards', () => {
  const rec = splitRecords(page)[1];
  const block = extractBlock(rec, { baseUrl: BASE });
  assert.equal(block.cards.length, 2);
  assert.equal(block.cards[0].lid, '11');
  assert.deepEqual(block.cards[0].fields, { li_title: 'Один', li_descr: 'A B' });
  assert.equal(block.cards[0].html.li_descr, 'A<br>B');
  assert.equal(block.cards[0].images.li_img, 'https://ref.test/img/one.png');
  assert.deepEqual(block.cards[1].fields, { li_title: 'Два' });
  assert.equal(block.fields.length, 0);
  assert.equal(block.images.length, 0);
});

test('extractBlock handles nested same-name tags and forms', () => {
  const rec = splitRecords(page)[2];
  const block = extractBlock(rec, { baseUrl: BASE });
  assert.equal(block.fields.find((f) => f.name === 'text').text, 'a b');
  assert.equal(block.hasForm, true);
});

test('extractStructure returns title, counts and blocks', () => {
  const s = extractStructure(page, { url: BASE, name: 'index' });
  assert.equal(s.title, 'Демо — страница');
  assert.equal(s.name, 'index');
  assert.equal(s.counts.blocks, 3);
  assert.equal(s.counts.zero, 0);
  assert.equal(s.counts.images, 3);
  assert.equal(s.counts.forms, 1);
  assert.deepEqual(s.counts.tplids, ['796', '702', '1002']);
  assert.equal(extractStructure('<div id="rec1" data-record-type="396"></div>').title, '');
});

test('collectInternalLinks filters external, anchors, queries and files', () => {
  const html = `<a href="/about">a</a><a href="https://ref.test/about#x">b</a><a href="/about?utm=1">c</a>
    <a href="https://other.test/">d</a><a href="#top">e</a><a href="/file.pdf">f</a><a href="/img.png">g</a><a href="/contacts/">h</a>`;
  assert.deepEqual(collectInternalLinks(html, BASE), ['https://ref.test/about', 'https://ref.test/contacts/']);
});

test('extractBlock reads social links from t-sociallinks markup', () => {
  const chunk = `<div id="rec7004" class="r" data-record-type="212"><ul class="t-sociallinks__wrapper"><li class="t-sociallinks__item t-sociallinks__item_whatsapp"><a href="https://wa.me/example" target="_blank"><svg></svg></a></li><li class="t-sociallinks__item t-sociallinks__item_telegram"><a href="/tg"><svg></svg></a></li><li class="t-sociallinks__item t-sociallinks__item_vk"><a href="#"><svg></svg></a></li></ul></div>`;
  const block = extractBlock(splitRecords(chunk)[0], { baseUrl: BASE });
  assert.deepEqual(block.soclinks, [
    { service: 'whatsapp', href: 'https://wa.me/example' },
    { service: 'telegram', href: 'https://ref.test/tg' },
  ]);
});

test('parseSitemap keeps same-origin pages without query and drops files and foreign urls', () => {
  const xml = `<?xml version="1.0"?><urlset>
  <url><loc>https://ref.test/a</loc></url>
  <url><loc> https://ref.test/b?x=1&amp;y=2 </loc></url>
  <url><loc>https://other.test/c</loc></url>
  <url><loc>https://ref.test/price.pdf</loc></url>
  <url><loc>https://ref.test/a#top</loc></url>
</urlset>`;
  assert.deepEqual(parseSitemap(xml, 'https://ref.test'), { pages: ['https://ref.test/a', 'https://ref.test/b'], sitemaps: [], dropped: 2 });
});

test('parseSitemap returns nested maps for sitemapindex', () => {
  const xml = '<sitemapindex><sitemap><loc>https://ref.test/s1.xml</loc></sitemap><sitemap><loc>https://ref.test/s2.xml</loc></sitemap></sitemapindex>';
  assert.deepEqual(parseSitemap(xml, 'https://ref.test'), { pages: [], sitemaps: ['https://ref.test/s1.xml', 'https://ref.test/s2.xml'], dropped: 0 });
});

test('parseSitemap of an empty string is empty', () => {
  assert.deepEqual(parseSitemap('', 'https://ref.test'), { pages: [], sitemaps: [], dropped: 0 });
});

test('extractStructure marks header and footer zones by data-tilda-page-id', () => {
  const html = '<html><body><header data-tilda-page-id="100001"><div id="rec7001" data-record-type="770"><a href="/a">меню</a></div></header>'
    + '<div id="rec7002" data-record-type="30"><div field="title">T</div><header class="x">внутри блока</header></div>'
    + '<footer data-tilda-page-id="100002"><div id="rec7003" data-record-type="464"><div field="title">F</div></div></footer></body></html>';
  const s = extractStructure(html, { url: BASE, name: 'index' });
  assert.deepEqual(s.blocks.map((b) => b.zone), ['header', 'content', 'footer']);
  assert.deepEqual(s.counts.zones, { header: 1, footer: 1, content: 1 });
  assert.equal(s.counts.blocks, 3);
});

test('extractStructure without zone tags marks every block as content', () => {
  const s = extractStructure(page, { url: BASE, name: 'index' });
  assert.ok(s.blocks.every((b) => b.zone === 'content'));
  assert.equal(s.counts.zones.content, s.counts.blocks);
});

test('extractButtons takes slots from data-buttonfieldset and keeps hash links as is', () => {
  const chunk = '<a href="#popup:form" class="t-btn t-btn_md" data-buttonfieldset="button"><table><tr><td>Заказать</td></tr></table></a>'
    + '<a href="/about" class="t-btn t-btn_md" data-buttonfieldset="button2">О нас</a>';
  assert.deepEqual(extractButtons(chunk, BASE), [
    { slot: '', text: 'Заказать', html: 'Заказать', href: '#popup:form', source: 'attr' },
    { slot: '2', text: 'О нас', html: 'О нас', href: 'https://ref.test/about', source: 'attr' },
  ]);
});

test('extractButtons uses the click event number, then the order in the block', () => {
  const chunk = '<a class="t-btn t-btnflex" href="tel:+70000000000" data-tilda-event-name="/tilda/click/rec1/button2"><span class="t-btnflex__text">Позвонить</span><style>.x{}</style></a>'
    + '<a class="t-btn t-btnflex" href="/a"><span class="t-btnflex__text">Первая<br>строка</span></a>'
    + '<a class="t-btnflex__text" href="/not-a-button">нет</a>'
    + '<a class="t-btn" href="#x" data-buttonfieldset="li_button">карточка</a>';
  const b = extractButtons(chunk, BASE);
  assert.deepEqual(b.map((x) => [x.slot, x.source, x.href]), [['2', 'attr', 'tel:+70000000000'], ['', 'order', 'https://ref.test/a']]);
  assert.equal(b[0].text, 'Позвонить');
  assert.equal(b[1].html, 'Первая<br>строка');
  assert.equal(b[1].text, 'Первая строка');
});

test('extractBlock drops a button whose title already has field=', () => {
  const [rec] = splitRecords('<div id="rec7001" data-record-type="213"><a href="/x" class="t-btn"><span field="buttontitle">Поле</span></a><a href="/y" class="t-btn" data-buttonfieldset="button2">Вторая</a></div>');
  const block = extractBlock(rec, { baseUrl: BASE });
  assert.ok(block.fields.some((f) => f.name === 'buttontitle'));
  assert.deepEqual(block.buttons.map((b) => b.slot), ['2']);
});

test('extractBlock reads cover video from data-content-video-url-<kind>', () => {
  const [cover] = splitRecords('<div id="rec7001" data-record-type="213"><div class="t-cover" data-content-video-url-youtube="abcdefghijk" data-content-video-noloop="yes"></div></div>');
  assert.deepEqual(extractBlock(cover, { baseUrl: BASE }).video, { kind: 'youtube', url: 'abcdefghijk' });
  const [rutube] = splitRecords('<div id="rec7002" data-record-type="213"><div class="t-cover" data-content-video-url-youtube="" data-content-video-url-rutube="0123456789abcdef"></div></div>');
  assert.deepEqual(extractBlock(rutube, { baseUrl: BASE }).video, { kind: 'rutube', url: '0123456789abcdef' });
  const [plain] = splitRecords('<div id="rec7003" data-record-type="213"><div class="t-cover" data-content-cover-bg="https://cdn.test/a.jpg"></div></div>');
  assert.equal('video' in extractBlock(plain, { baseUrl: BASE }), false);
});

// [FIX] Ссылка внутри поля (подвал 464, текст 106, формы 704) раньше вырезалась liteHtml: адрес
// оставался только в links блока и в план не попадал; пункты подвала выходили белыми на белом.
test('extractBlock keeps links inside a text field with an absolute href and the link color', () => {
  const [rec] = splitRecords(`<div id="rec7001" data-record-type="464"><div field="descr"><div style="color: rgb(29, 29, 29);"><ul>
<li style="color: rgb(0, 0, 0);"><a href="/about" style="text-decoration: none; color: rgb(0, 0, 0);">О НАС</a></li>
<li><a href="https://ref.test/a?x=1&amp;y=2" target="_blank">Два</a></li><li><a href="javascript:void(0)">Три</a></li></ul></div></div></div>`);
  const b = extractBlock(rec, { baseUrl: BASE });
  const descr = b.fields.find((f) => f.name === 'descr');
  assert.equal(descr.html, '<a href="https://ref.test/about" style="color: rgb(0, 0, 0)">О НАС</a><br><a href="https://ref.test/a?x=1&amp;y=2" target="_blank" style="color: rgb(29, 29, 29)">Два</a><br>Три');
  assert.equal(descr.text, 'О НАС Два Три');
  assert.equal(descr.href, null);
});

test('an inline link without its own color takes the color of its styled ancestor inside the field', () => {
  const [rec] = splitRecords(`<div id="rec7001" data-record-type="464"><div field="descr2"><div style="line-height:20px;color:#1d1d1d;" data-customstyle="yes"><ul>
<li><a href="/a" style="color:#000000 !important;">ПКС</a></li><li><a href="/b">ВОС</a></li></ul></div></div>
<div field="descr">Ссылка <a href="/c">без цвета</a></div></div>`);
  const b = extractBlock(rec, { baseUrl: BASE });
  const html = (name) => b.fields.find((f) => f.name === name).html;
  // Обёртка редактора с цветом теперь сохраняется (оформление по белому списку); цвет ссылки
  // остаётся явным — он нужен и там, где обёртка не переносится.
  assert.equal(html('descr2'), '<div style="line-height: 20px; color: #1d1d1d;" data-customstyle="yes"><a href="https://ref.test/a" style="color: #000000">ПКС</a><br><a href="https://ref.test/b" style="color: #1d1d1d">ВОС</a></div>');
  assert.equal(html('descr'), 'Ссылка <a href="https://ref.test/c">без цвета</a>');
});

test('extractBlock takes a link around the whole field as the field href, not as inline markup', () => {
  const [rec] = splitRecords(`<div id="rec7001" data-record-type="686"><div field="li_title__11"> <a href="/about" class="t-card__link"> <div style="font-size:40px;"><span>КТК</span></div> </a> </div>
<div field="li_text__11">Каркас <a href="/about">подробнее</a></div></div>`);
  const b = extractBlock(rec, { baseUrl: BASE });
  assert.deepEqual(b.cards[0].hrefs, { li_title: 'https://ref.test/about' });
  assert.equal(b.cards[0].html.li_title, 'КТК');
  assert.equal(b.cards[0].html.li_text, 'Каркас <a href="https://ref.test/about">подробнее</a>');
});

test('liteHtml without the link option still drops links', () => {
  assert.equal(liteHtml('Раз <a href="/x" style="color:#000">два</a>'), 'Раз два');
});

test('extractBlock keeps submenu and popup hooks in block links but not plain anchors', () => {
  const [rec] = splitRecords('<div id="rec7001" data-record-type="770"><a href="#submenu:products">Продукция</a><a href="#popup:order">Заявка</a><a href="#top">Наверх</a><a href="/about">О нас</a></div>');
  const b = extractBlock(rec, { baseUrl: BASE });
  assert.deepEqual(b.links.map((l) => [l.text, l.href]), [['Продукция', '#submenu:products'], ['Заявка', '#popup:order'], ['О нас', 'https://ref.test/about']]);
});

// [FIX] Разделитель 796 собирался со стоковым «зигзагом» вместо «скоса» референса (сверка P00, 2026-09-23).
test('extractShape recognizes the divider style by its svg path and position', () => {
  const skew = '<div id="rec7001" data-record-type="796"><div class="t796"><div class="t796__shape-border t796__shape-border_bottom" data-fill-color="#4599ff"><svg class="t796__svg" style="height:8vw;" viewBox="0 0 1280 200"><path d="M1280 200H0V0l1280 195.5v4.5z"></path></svg></div></div></div>';
  const arrow = skew.replace('M1280 200H0V0l1280 195.5v4.5z', 'M640 195.5L0 0v200h1280V0');
  const odd = skew.replace('M1280 200H0V0l1280 195.5v4.5z', 'M0 0L10 10z');
  assert.deepEqual(extractShape(skew), { style: 'skew', position: 'bottom', path: null });
  assert.deepEqual(extractShape(arrow), { style: 'arrow', position: 'bottom', path: null });
  assert.deepEqual(extractShape(odd), { style: null, position: 'bottom', path: 'M0 0L10 10z' });
  assert.equal(extractShape('<div id="rec7002" data-record-type="30"><div field="title">T</div></div>'), null);
  assert.deepEqual(extractBlock(splitRecords(skew)[0], { baseUrl: BASE }).shape, { style: 'skew', position: 'bottom', path: null });
});

// [FIX] Оформление текста из редактора (data-customstyle, жирность, размер) раньше вырезалось:
// заголовок обложки 213 на P00 выходил мельче и без выделения (решение владельца 2026-09-23 — переносить).
test('liteHtml with format keeps whitelisted editor formatting and drops the rest', () => {
  const src = '<div data-customstyle="yes" style="font-size:36px;line-height:46px;font-family:Arial;background:url(x)" onclick="alert(1)"><strong>Раз</strong><br>'
    + '<span data-redactor-tag="span" style="font-weight: 600; color: red; letter-spacing: -1px !important">Два</span> <em>три</em><u>ч</u><b>ж</b><i>к</i><span>пусто</span>'
    + '<span style="color: expression(alert(1))">x</span><font color="#ff0000">ф</font></div>';
  assert.equal(liteHtml(src, { format: true }),
    '<div style="font-size: 36px; line-height: 46px;" data-customstyle="yes"><strong>Раз</strong><br><span style="font-weight: 600; letter-spacing: -1px;">Два</span> <em>три</em><u>ч</u><b>ж</b><i>к</i> пусто x ф</div>');
  // Без опции — прежнее поведение: только текст и переносы (снятый тег — пробел).
  assert.equal(liteHtml(src), 'Раз<br>Два три ч ж к пусто x ф');
  // Незакрытый тег оформления закрывается в конце; обёртка без стиля не сохраняется.
  assert.equal(liteHtml('<strong>жирный', { format: true }), '<strong>жирный</strong>');
  assert.equal(liteHtml('<div data-customstyle="yes">А</div><div data-customstyle="yes">Б</div>', { format: true }), 'А<br>Б');
});

test('extractBlock keeps the editor formatting of a cover title', () => {
  const [rec] = splitRecords('<div id="rec7001" data-record-type="213"><div class="t-cover__title" field="title"><div style="font-size:36px;line-height:46px;" data-customstyle="yes"><strong><span data-redactor-tag="span" style="font-weight: 600;">Строительство</span></strong><br>по всей России</div></div></div>');
  const title = extractBlock(rec, { baseUrl: BASE }).fields.find((f) => f.name === 'title');
  assert.equal(title.html, '<div style="font-size: 36px; line-height: 46px;" data-customstyle="yes"><strong><span style="font-weight: 600;">Строительство</span></strong><br>по всей России</div>');
  assert.equal(title.text, 'Строительство по всей России');
});

test('extractBlock carries markup features of its own record and not of the footer after it', () => {
  const html = `<div id="rec1000000000001" class="r t-rec" data-record-type="686"><div class="t686 t-col_4" data-columns-in-row="3" style="height:327px"></div></div>
</div><footer id="t-footer" data-tilda-page-id="1000000000009"><div class="t-footer-own" data-foot="1"></div></footer>`;
  const [rec] = splitRecords(html);
  const b = extractBlock(rec, { baseUrl: BASE });
  assert.ok(b.features.includes('class:t-col_4'));
  assert.ok(b.features.includes('attr:data-columns-in-row=3'));
  assert.ok(b.features.includes('style:height:327px'));
  assert.ok(!b.features.some((f) => f.includes('t-footer-own') || f.includes('data-foot')), 'признаки подвала не попадают в блок');
  assert.ok(!b.features.some((f) => f.includes('1000000000001')), 'recid заменён на RID');
});

test('extractBlock puts card button text into li_buttontitle of its card', () => {
  const card = (lid, withButton) => `<div class="t-card"><div field="li_title__${lid}">Карточка ${lid}</div>${withButton ? `<div class="t-btn t-btnflex t-card__btn" data-buttonfieldset="li_button" data-lid="${lid}"><span class="t-btnflex__text">Подробнее</span><style>#rec1 .t-btn{color:red}</style></div>` : ''}</div>`;
  const html = `<div id="rec1000000000002" class="r" data-record-type="686">${card('1000000000011', true)}${card('1000000000012', false)}${card('1000000000013', true)}</div>`;
  const [rec] = splitRecords(html);
  const b = extractBlock(rec, { baseUrl: BASE });
  const byLid = Object.fromEntries(b.cards.map((c) => [c.lid, c.fields.li_buttontitle ?? null]));
  assert.deepEqual(byLid, { 1000000000011: 'Подробнее', 1000000000012: null, 1000000000013: 'Подробнее' });
  assert.equal(b.buttons.length, 0, 'кнопки карточек не входят в кнопки блока');
});

test('extractForm reads input groups and the success message without receivers', () => {
  const html = `<div id="rec1000000000003" class="r" data-record-type="702"><form data-formactiontype="2" data-success-url="/thanks" data-success-message="Спасибо!">
<input type="hidden" name="formservices[]" value="abc">
<div class="t-input-group t-input-group_nm"><div class="t-input-title">Как вас зовут</div><div class="t-input-block"><input type="text" name="Имя" placeholder="Ваше имя" data-tilda-req="1" data-tilda-rule="name"></div></div>
<div class="t-input-group t-input-group_ph"><div class="t-input-block"><input type="hidden" name="tildaspec-mask-Телефон" value="x"><input type="tel" name="Телефон" placeholder="Ваш телефон" data-tilda-req="1" data-tilda-rule="phone" data-tilda-mask="+7 (999) 999-9999"></div></div>
</form></div>`;
  const [rec] = splitRecords(html);
  const b = extractBlock(rec, { baseUrl: BASE });
  assert.deepEqual(b.form, {
    inputs: [
      { type: 'nm', name: 'Имя', placeholder: 'Ваше имя', required: true, rule: 'name', mask: '', title: 'Как вас зовут' },
      { type: 'ph', name: 'Телефон', placeholder: 'Ваш телефон', required: true, rule: 'phone', mask: '+7 (999) 999-9999', title: '' },
    ],
    successUrl: 'https://ref.test/thanks',
    successMessage: 'Спасибо!',
    successTitle: null,
  });
  assert.ok(!JSON.stringify(b.form).includes('formservices'));
});

test('extractBlock reads 898 messengers and skips service icons', () => {
  const html = `<div id="rec1000000000004" class="r" data-record-type="898"><div class="t898">
<a href="https://t.me/+AbCdEf" class="t898__icon t898__icon-telegram_wrapper t898__icon_link" target="_blank"></a>
<a href="https://wa.me/71234567890?text=Hi" class="t898__icon t898__icon-whatsapp_wrapper t898__icon_link"></a>
<a href="tel:+71234567890" class="t898__icon t898__icon-phone_wrapper t898__icon_link"></a>
<div class="t898__icon t898__icon-close"></div><div class="t898__icon t898__icon-write"></div></div></div>`;
  const [rec] = splitRecords(html);
  const b = extractBlock(rec, { baseUrl: BASE });
  assert.deepEqual(b.messengers, [
    { service: 'telegram', href: 'https://t.me/+AbCdEf' },
    { service: 'whatsapp', href: 'https://wa.me/71234567890?text=Hi' },
    { service: 'phone', href: 'tel:+71234567890' },
  ]);
});

test('extractBlock takes T123 code between nominify markers without scripts and footer markup', () => {
  const html = `<div id="rec1000000000005" class="r" data-record-type="131"><div class="t123"><div class="t-width"><!-- nominify begin --><div class="my">Код</div><script>alert(1)</script><script src="x.js"/><!-- nominify end --></div></div></div>
</div><footer data-tilda-page-id="1000000000009"><!-- nominify begin --><div>подвал</div><!-- nominify end --></footer>`;
  const [rec] = splitRecords(html);
  const b = extractBlock(rec, { baseUrl: BASE });
  assert.deepEqual(b.code, { code: '<div class="my">Код</div>', scripts: 2 });
});
