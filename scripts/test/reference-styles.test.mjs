import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLogLevel } from '../lib/log.mjs';
import { extractBlockStyles, normalizeHex, typoFromDeclarations } from '../lib/reference-styles.mjs';

setLogLevel('ERROR');

// Идентификаторы синтетические, 13 знаков (правило no-real-ids).
const REC = '1234567890123';
const open = (attrs) => `<div id="rec${REC}" ${attrs} data-record-type="580"><div field="title">Текст</div></div>`;

test('extractBlockStyles reads paddings from classes and inline fallback', () => {
  assert.equal(extractBlockStyles(open('class="r t-rec t-rec_pt_45 t-rec_pb_120"')).paddingTop, '45px');
  assert.equal(extractBlockStyles(open('class="r t-rec t-rec_pt_45 t-rec_pb_120"')).paddingBottom, '120px');

  const inline = extractBlockStyles(open('class="r t-rec" style="padding-top:15px;padding-bottom:0px"'));
  assert.equal(inline.paddingTop, '15px');
  assert.equal(inline.paddingBottom, '0px');

  const none = extractBlockStyles(open('class="r t-rec"'));
  assert.equal(none.paddingTop, null);
  assert.equal(none.paddingBottom, null);

  // Адаптивный класс не должен подменять базовый.
  const adaptive = extractBlockStyles(open('class="r t-rec t-rec_pt_0 t-rec_pt-res-480_75"'));
  assert.equal(adaptive.paddingTop, '0px');
});

test('extractBlockStyles reads background from data attribute, inline hex and ignores rgba', () => {
  assert.equal(extractBlockStyles(open('class="r" data-bg-color="#4599FF"')).bgColor, '#4599ff');
  assert.equal(extractBlockStyles(open('class="r" style="background-color:#fff"')).bgColor, '#ffffff');
  assert.equal(extractBlockStyles(open('class="r" style="background-color: rgba(238,238,238,1)"')).bgColor, null);
  assert.equal(extractBlockStyles(open('class="r"')).bgColor, null);
});

test('extractBlockStyles maps per-record typo rules to field families', () => {
  const chunk = `<div id="rec${REC}" class="r" data-record-type="580"><style>#rec${REC} .t580__title{color:#ffffff;font-size:36px;text-transform:uppercase;} #rec${REC} .t015__uptitle{max-width:400px;} #rec${REC} .t580__descr{font-family:'x';}</style></div>`;
  const { typo } = extractBlockStyles(chunk);
  assert.deepEqual(typo.title, { color: '#ffffff', fontsize: '36px', uppercase: 'uppercase' });
  assert.deepEqual(typo.subtitle, { widthpx: '400px' });
  assert.equal(typo.descr, undefined);
});

test('extractBlockStyles merges min-width rules and drops mobile overrides', () => {
  // Сервер кладёт font-size и line-height в @media (min-width:900px) — это десктопная база.
  const chunk = `<div id="rec${REC}" class="r" data-record-type="580"><style>#rec${REC} .t580__title{color:#ffffff;}@media screen and (min-width:900px){#rec${REC} .t580__title{font-size:36px;line-height:1.2;}}@media screen and (max-width:640px){#rec${REC} .t580__title{font-size:18px;}}</style></div>`;
  const { typo } = extractBlockStyles(chunk);
  assert.deepEqual(typo.title, { color: '#ffffff', fontsize: '36px', lineheight: '1.2' });
});

test('typoFromDeclarations keeps only TYPO_KEYS', () => {
  assert.deepEqual(typoFromDeclarations('font-weight:bold'), { fontweight: '700' });
  assert.deepEqual(typoFromDeclarations('font-weight:600'), { fontweight: '600' });
  assert.deepEqual(typoFromDeclarations('line-height:1.2'), { lineheight: '1.2' });
  assert.deepEqual(typoFromDeclarations('color:red'), {});
  assert.deepEqual(typoFromDeclarations('font-family:Arial;letter-spacing:2px'), {});
  assert.deepEqual(typoFromDeclarations('color:#FFF !important'), { color: '#ffffff' });
});

test('normalizeHex expands short form and rejects non-hex', () => {
  assert.equal(normalizeHex('#AbC'), '#aabbcc');
  assert.equal(normalizeHex('#4599ff'), '#4599ff');
  assert.equal(normalizeHex('transparent'), null);
  assert.equal(normalizeHex('linear-gradient(#fff,#000)'), null);
  assert.equal(normalizeHex(undefined), null);
});
