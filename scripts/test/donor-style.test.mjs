import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setLogLevel } from '../lib/log.mjs';
import { isMessage } from '../lib/i18n.mjs';
import { STYLE_CONFIRM } from '../project-style.mjs';
import {
  DonorStyleError, applyDonorFonts, applyDonorStyle, captureDonorStyle, desiredFromDonor,
  fontsToUpload, parseFontUploadResponse, parseMyFonts, readDonorStyle, writeDonorStyle,
} from '../donor-style.mjs';

setLogLevel('ERROR');

const myfonts = JSON.stringify([{ f_name: 'myfont', f_100: 'https://cdn.test/a.woff', f_200: '', f_400: 'https://cdn.test/b.woff', f_woff2_400: 'https://cdn.test/b.woff2', f_vf: '', cnt: 2 }]);
const donorValues = () => ({
  headlinefont: 'myfont', textfont: 'myfont', headlinefontweight: '600', textfontweight: '300', textfontsize: '18', headlinecolor: '', textcolor: '#000000',
  linkcolor: '#ff8562', linkfontweight: '700', linklinecolor: '#000000', linklineheight: '1', bgcolor: '#ffffff', myfonts_json: myfonts,
});

test('parseMyFonts reads the fontsupload shape and tolerates empty or broken input', () => {
  assert.deepEqual(parseMyFonts(myfonts), [{ name: 'myfont', files: { 100: 'https://cdn.test/a.woff', 400: 'https://cdn.test/b.woff', woff2_400: 'https://cdn.test/b.woff2' } }]);
  assert.deepEqual(parseMyFonts(''), []);
  assert.deepEqual(parseMyFonts('[]'), []);
  assert.deepEqual(parseMyFonts('{bad'), []);
  assert.deepEqual(parseMyFonts({ 0: { f_name: 'x', f_400: 'u' } }), [{ name: 'x', files: { 400: 'u' } }]);
});

test('fontsToUpload and parseFontUploadResponse decide idempotent uploads', () => {
  const f = { name: 'f', files: { 400: 'u' } };
  assert.deepEqual(fontsToUpload([f], []).upload.map((x) => x.name), ['f']);
  assert.deepEqual(fontsToUpload([f], [f]).present.map((x) => x.name), ['f']);
  assert.deepEqual(fontsToUpload([f], [{ name: 'f', files: { 400: 'u', 700: 'v' } }]).upload.map((x) => x.name), ['f']);
  assert.deepEqual(parseFontUploadResponse('OK'), { ok: true, message: 'OK' });
  assert.equal(parseFontUploadResponse('{"error":"x"}').ok, false);
  assert.equal(parseFontUploadResponse('<html>').message.key, 'donorStyle.fontUploadHtml');
});

test('desiredFromDonor keeps only form keys and skips fonts assigned at upload', () => {
  const r = desiredFromDonor(donorValues(), { uploadedFonts: ['myfont'] });
  assert.equal('headlinefont' in r.values, false);
  assert.equal('textfont' in r.values, false);
  assert.equal(r.values.headlinecolor, '');
  assert.equal(r.values.linkcolor, '#ff8562');
  assert.deepEqual(r.skipped.filter((s) => s.code === 'assignedAtUpload').map((s) => s.key), ['headlinefont', 'textfont']);
  assert.deepEqual(r.skipped.filter((s) => s.code === 'formCannot').map((s) => s.key), ['linkfontweight', 'linklinecolor', 'linklineheight']);
  assert.equal(desiredFromDonor(donorValues(), { uploadedFonts: [] }).values.headlinefont, 'myfont');
  const only = desiredFromDonor({ linklinecolor: '#000000', linkfontweight: '700', linklineheight: '1' });
  assert.deepEqual(Object.values(only.values).filter(Boolean), []);
  assert.equal(only.skipped.filter((s) => s.code === 'formCannot').length, 3);
});

function fakeDriver({ testValues, uploadText = 'OK', afterFonts } = {}) {
  const calls = [];
  let values = { ...testValues };
  return {
    calls,
    readProjectStyle: async () => { calls.push('readProjectStyle'); return { values: { ...values }, fingerprints: {}, count: 0, presets: [] }; },
    uploadProjectFont: async (args) => {
      calls.push(['uploadProjectFont', args.name, args.asHeadline, args.asText]);
      if (uploadText === 'OK') values.myfonts_json = afterFonts ?? myfonts;
      return { name: args.name, status: 200, text: uploadText };
    },
    setProjectStyle: async (v) => { calls.push(['setProjectStyle', Object.keys(v)]); Object.assign(values, v); return { submitted: Object.keys(v), chosen: {}, status: 200, text: 'OK' }; },
    reload: async () => { calls.push('reload'); },
  };
}

test('captureDonorStyle writes donor-style.json with values and parsed fonts', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-style-'));
  try {
    const driver = fakeDriver({ testValues: donorValues() });
    const r = await captureDonorStyle(driver, { slug: 'demo', baseDir, now: '2026-09-24T10:00:00.000Z' });
    assert.equal(r.fonts.length, 1);
    assert.equal(r.values.headlinefont, 'myfont');
    const saved = readDonorStyle('demo', { baseDir });
    assert.equal(saved.at, '2026-09-24T10:00:00.000Z');
    assert.equal(saved.fonts[0].name, 'myfont');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('applyDonorFonts uploads a missing font with the assignment flags and verifies it afterwards', async () => {
  const fonts = parseMyFonts(myfonts);
  const d = fakeDriver({ testValues: { myfonts_json: '' } });
  const r = await applyDonorFonts(d, { projectid: '100001', fonts, headlinefont: 'myfont', textfont: 'other' });
  assert.deepEqual(r.uploaded, ['myfont']);
  assert.deepEqual(d.calls[1], ['uploadProjectFont', 'myfont', true, false]);
  assert.deepEqual(d.calls.slice(2), ['reload', 'readProjectStyle']);
  const present = fakeDriver({ testValues: { myfonts_json: myfonts } });
  const p = await applyDonorFonts(present, { projectid: '100001', fonts, headlinefont: 'myfont', textfont: 'myfont' });
  assert.deepEqual([p.uploaded, p.present], [[], ['myfont']]);
  assert.deepEqual(present.calls, ['readProjectStyle']);
  const failed = fakeDriver({ testValues: { myfonts_json: '' }, uploadText: '{"error":"no"}' });
  await assert.rejects(() => applyDonorFonts(failed, { projectid: '100001', fonts }), (e) => e instanceof DonorStyleError && e.code === 'FONT_UPLOAD_FAILED');
  assert.ok(!failed.calls.includes('reload'));
  const notApplied = fakeDriver({ testValues: { myfonts_json: '' }, afterFonts: '[]' });
  await assert.rejects(() => applyDonorFonts(notApplied, { projectid: '100001', fonts }), (e) => e.code === 'FONT_NOT_APPLIED');
});

test('applyDonorStyle refuses without confirmation, then uploads, writes the form keys and checks only them', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'tilda-donor-style-'));
  try {
    writeDonorStyle('demo', { at: 'x', values: donorValues(), fonts: parseMyFonts(myfonts) }, { baseDir });
    const unconfirmed = fakeDriver({ testValues: { myfonts_json: '' } });
    await assert.rejects(() => applyDonorStyle(unconfirmed, { slug: 'demo', projectid: '100001', baseDir }), (e) => e.code === 'STYLE_NOT_CONFIRMED');
    assert.equal(unconfirmed.calls.length, 0);
    await assert.rejects(() => applyDonorStyle(fakeDriver({}), { slug: 'none', projectid: '100001', confirmed: true, confirm: STYLE_CONFIRM, baseDir }), (e) => e.code === 'NO_DONOR_STYLE');
    // Тестовый проект: шрифта нет, цвета пустые, ключи вне формы отличаются от донора и после записи остаются другими.
    const d = fakeDriver({ testValues: { headlinefont: 'Arial', textfont: 'Arial', headlinefontweight: '', textfontweight: '', textfontsize: '', headlinecolor: '', textcolor: '', linkcolor: '', linkfontweight: '', linklinecolor: '#ff0000', linklineheight: '', bgcolor: '', myfonts_json: '' } });
    const r = await applyDonorStyle(d, { slug: 'demo', projectid: '100001', confirmed: true, confirm: STYLE_CONFIRM, baseDir, now: '2026-09-24T10:00:00.000Z' });
    assert.deepEqual(r.fonts.uploaded, ['myfont']);
    assert.deepEqual(d.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['readProjectStyle', 'uploadProjectFont', 'reload', 'readProjectStyle', 'readProjectStyle', 'setProjectStyle', 'reload', 'readProjectStyle', 'readProjectStyle']);
    const set = d.calls.find((c) => Array.isArray(c) && c[0] === 'setProjectStyle')[1];
    assert.ok(!set.includes('headlinefont') && !set.includes('linklinecolor'));
    assert.ok(set.includes('linkcolor') && set.includes('textfontsize'));
    assert.deepEqual(r.notMatched, ['headlinefont', 'textfont'], 'поддельная загрузка не назначает шрифт — расхождение только по назначенным ключам');
    assert.equal(r.skipped.length, 5);
    assert.ok(existsSync(join(baseDir, 'demo', 'donor-style.json')));
    const written = JSON.parse(readFileSync(join(baseDir, 'demo', 'donor-style.json'), 'utf8')).skipped;
    assert.equal(written.length, 5);
    assert.deepEqual(written.find((x) => x.key === 'headlinefont'), { key: 'headlinefont', code: 'assignedAtUpload', reason: 'the font is assigned at upload (set_ff_to_h/set_ff_to_t)' }, 'в файл слепка причина идёт английским текстом');
    assert.ok(r.skipped.every((x) => isMessage(x.reason)), 'в итоге причина — Message');
    // Повтор на проекте, где всё уже как у донора (кроме ключей вне формы): без изменений, notMatched пуст.
    const same = fakeDriver({ testValues: { ...donorValues(), linklinecolor: '#ff0000' } });
    const again = await applyDonorStyle(same, { slug: 'demo', projectid: '100001', confirmed: true, confirm: STYLE_CONFIRM, baseDir });
    assert.deepEqual([again.changed, again.notMatched, again.fonts.uploaded], [[], [], []]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
