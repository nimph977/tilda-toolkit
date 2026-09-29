import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { extractFeatures, normalizeDecl, shapeOf, diffFeatures } from '../lib/markup-features.mjs';

setLogLevel('ERROR');

// Идентификаторы синтетические, 13 знаков (правило no-real-ids).
const REC = '1000000000001';

const card686 = `<div id="rec${REC}" class="r t-rec" data-record-type="686">
<style>#rec${REC} .t-btnflex{border-radius:20px;}
@media screen and (max-width: 980px) { #rec${REC} .t-card__title { font-size : 18px } }</style>
<div class="t686 t-col_4" data-columns-in-row="3">
<div class="t686__bg" style="background-image: -webkit-linear-gradient(top, rgba(0,0,0,0.30), rgba(0,0,0,0.30)); -moz-box-shadow: 0 0 1px #000; background-image: linear-gradient(to bottom, rgba(0,0,0,0.30), rgba(0,0,0,0.30));"></div>
<a href="https://example.com/page" class="t-card__link">x</a>
</div></div>`;

test('extractFeatures collects classes, data attributes, inline styles and record CSS', () => {
  const f = extractFeatures(card686, { recid: REC });
  assert.ok(f.includes('class:t-col_4'));
  assert.ok(f.includes('attr:data-columns-in-row=3'));
  assert.ok(f.includes('attr:data-record-type=686'));
  assert.ok(f.includes('css:|#recRID .t-btnflex{border-radius:20px}'));
  assert.ok(f.includes('css:screenand(max-width:980px)|#recRID .t-card__title{font-size:18px}'));
  assert.ok(f.includes('style:background-image:linear-gradient(to bottom,rgba(0,0,0,0.30),rgba(0,0,0,0.30))'));
  assert.ok(!f.some((x) => x.includes('box-shadow')), 'свойство с префиксом браузера выброшено');
  assert.ok(!f.some((x) => x.includes(REC)), 'recid заменён на RID');
  assert.deepEqual(f, [...f].sort());
  assert.deepEqual(extractFeatures(card686, { recid: REC }), f, 'детерминирована');
});

test('normalizeDecl unifies colours, spaces, gradients and vendor prefixes', () => {
  assert.deepEqual(normalizeDecl('color', 'rgb(235, 235, 235)'), ['color', '#ebebeb']);
  assert.deepEqual(normalizeDecl('color', '#EBEBEB'), ['color', '#ebebeb']);
  assert.deepEqual(normalizeDecl('color', '#abc'), ['color', '#aabbcc']);
  assert.deepEqual(normalizeDecl('color', 'rgba(1,2,3,1)'), ['color', '#010203']);
  assert.deepEqual(normalizeDecl('background-image', '-webkit-linear-gradient(top, rgba(0,0,0,0.30), rgba(0,0,0,0.30))'), ['background-image', 'linear-gradient(to bottom,rgba(0,0,0,0.30),rgba(0,0,0,0.30))']);
  assert.equal(normalizeDecl('-moz-box-shadow', '0 0 1px #000'), null);
  assert.equal(normalizeDecl('display', '-webkit-box'), null);
  assert.deepEqual(normalizeDecl('transition-property', 'color, border-color,  gap'), ['transition-property', 'color,border-color,gap']);
  assert.deepEqual(normalizeDecl('color', '#FFF!important'), ['color', '#ffffff !important']);
  assert.deepEqual(normalizeDecl('font-family', '&quot;Mont&quot;,Arial'), ['font-family', '"Mont",Arial']);
});

test('extractFeatures drops editor-only and runtime-only features and renames screen attributes', () => {
  const html = `<div id="rec${REC}" class="r t-rec record loaded t-screenmax-980px" data-record-cod="TE100" data-ai-tpl="y" data-screenmax="980px" data-screenmin="320px" style="cursor:pointer;height:327px"><div class="t-column-draggable" data-column-id="1"></div></div>`;
  const f = extractFeatures(html, { recid: REC });
  assert.ok(f.includes('attr:data-screen-max=980px'));
  assert.ok(f.includes('attr:data-screen-min=320px'));
  assert.ok(f.includes('style:height:327px'));
  for (const gone of ['class:record', 'class:loaded', 'class:t-screenmax-980px', 'class:t-column-draggable', 'attr:data-record-cod=TE100', 'attr:data-ai-tpl=y', 'style:cursor:pointer', 'attr:data-column-id=1']) {
    assert.ok(!f.includes(gone), gone);
  }
  // Публикация: другая форма тех же признаков даёт тот же набор.
  const published = `<div id="rec${REC}" class="r t-rec t-screenmax-980px" data-screen-max="980px" data-screen-min="320px" style="height:327px"><div></div></div>`;
  assert.deepEqual(diffFeatures(extractFeatures(published, { recid: REC }), f), { added: [], removed: [] });
});

test('extractFeatures replaces URLs and skips long attributes and scripts', () => {
  const html = `<div data-src="https://example.com/a.jpg" data-long="${'x'.repeat(81)}"><script>var a = "<div class='fake'>";</script></div>`;
  const f = extractFeatures(html, {});
  assert.ok(f.includes('attr:data-src=URL'));
  assert.ok(!f.some((x) => x.startsWith('attr:data-long')));
  assert.ok(!f.includes('class:fake'));
});

test('shapeOf replaces hex colours and numbers with a placeholder', () => {
  assert.deepEqual(shapeOf('style:background-image:linear-gradient(to bottom,rgba(18,52,86,0.70))'), {
    shape: 'style:background-image:linear-gradient(to bottom,rgba(§,§,§,§))',
    tokens: ['18', '52', '86', '0.70'],
  });
  assert.deepEqual(shapeOf('css:|#recRID .t-btn{color:#65a3c1}'), { shape: 'css:|#recRID .t-btn{color:§}', tokens: ['#65a3c1'] });
  assert.deepEqual(shapeOf('class:t-screenmax-980px').tokens, ['980']);
  assert.deepEqual(shapeOf('style:margin-top:-20px').tokens, ['-20']);
});

test('diffFeatures returns added and removed sets', () => {
  assert.deepEqual(diffFeatures(['a', 'b', 'c'], ['b', 'c', 'd']), { added: ['d'], removed: ['a'] });
  assert.deepEqual(diffFeatures([], []), { added: [], removed: [] });
});
