import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogLevel } from '../lib/log.mjs';
import { desiredProjectSettings, fontBaseName, projectCssUrl, projectStyleFromCss, PROJECT_REASONS, weightFromLabel } from '../lib/project-style.mjs';
import { applyProjectStyle, sameValue, STYLE_CONFIRM } from '../project-style.mjs';

setLogLevel('ERROR');

const CSS = `@font-face{font-family:'monserat';src:url('https://cdn.test/fonts/Montserrat-Thin.woff') format('woff');font-weight:100;font-style:normal;}
@font-face{font-family:'monserat';src:url('https://cdn.test/fonts/Montserrat-SemiBold.woff') format('woff');font-weight:600;font-style:normal;}
.t-title{font-family:'monserat';font-weight:600;color:#000000;}
.t-descr{font-family:'monserat';font-weight:300;color:#000;}
@media screen and (max-width:640px){.t-title{font-weight:300;}}
#allrecords a{color:#ff8562;text-decoration:none;}`;

test('projectStyleFromCss reads font faces, headline, text and link colour outside media queries', () => {
  const s = projectStyleFromCss(CSS);
  assert.equal(s.fonts.length, 2);
  assert.deepEqual(s.headline, { family: 'monserat', weight: '600', color: '#000000' });
  assert.deepEqual(s.text, { family: 'monserat', weight: '300', color: '#000000' });
  assert.equal(s.link.color, '#ff8562');
  assert.deepEqual(s.undecided, []);
  assert.equal(fontBaseName(s.fonts[1].url), 'Montserrat');
});

test('projectCssUrl finds the project stylesheet link', () => {
  assert.equal(projectCssUrl('<link rel="stylesheet" href="https://cdn.test/ws/project1/tilda-blocks-page2.min.css?t=3">'), 'https://cdn.test/ws/project1/tilda-blocks-page2.min.css?t=3');
  assert.equal(projectCssUrl('<html></html>'), null);
});

test('desiredProjectSettings maps a custom font to a Tilda preset by font file name and aliases the family', () => {
  const d = desiredProjectSettings(projectStyleFromCss(CSS), { presets: ['Tilda Sans', 'Roboto', 'Montserrat'] });
  assert.deepEqual(d.values, { headlinefont: 'Montserrat', textfont: 'Montserrat', headlinefontweight: '600', headlinecolor: '#000000', textfontweight: '300', textcolor: '#000000', linkcolor: '#ff8562' });
  assert.deepEqual(d.fontAliases, { monserat: 'Montserrat' });
  assert.ok(d.undecided.some((u) => u.key === 'myfonts_json' && u.reason === PROJECT_REASONS.fontsNotTransferred));
  const none = desiredProjectSettings(projectStyleFromCss(CSS), { presets: ['Roboto'] });
  assert.equal(none.values.headlinefont, undefined);
  assert.ok(none.undecided.some((u) => u.key === 'headlinefont' && u.reason === PROJECT_REASONS.noPreset('monserat')));
});

test('weight labels and value comparison follow the settings form', () => {
  assert.equal(weightFromLabel('Semibold'), 600);
  assert.equal(weightFromLabel('Light'), 300);
  assert.equal(sameValue('headlinefont', 'TildaSans', 'Tilda Sans'), true);
  assert.equal(sameValue('headlinecolor', '#FFFFFF', '#ffffff'), true);
});

function fakeDriver({ text = 'OK', drift = false, options = null } = {}) {
  const calls = [];
  let values = { headlinefont: 'TildaSans', headlinefontweight: '', headlinecolor: '', textfont: 'TildaSans', textcolor: '' };
  let fingerprints = { headlinefont: 'a', other: 'x' };
  return {
    calls,
    readProjectStyle: async () => {
      calls.push('read');
      return { values: { ...values }, fingerprints: { ...fingerprints }, presets: ['Montserrat'] };
    },
    setProjectStyle: async (v) => {
      calls.push(['set', v]);
      // Форма хранит значение выбранного варианта списка, а не желаемый вес.
      const chosen = options ? Object.fromEntries(Object.keys(v).filter((k) => k in options).map((k) => [k, options[k]])) : undefined;
      if (text === 'OK') {
        values = { ...values, ...v, ...(chosen ?? {}) };
        fingerprints = { ...fingerprints, headlinefont: 'b', ...(drift ? { other: 'y' } : {}) };
      }
      return { text, ...(chosen ? { chosen } : {}) };
    },
    reload: async () => calls.push('reload'),
  };
}

test('applyProjectStyle refuses without confirmation, writes the rollback record first and reports other changes', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'project-style-'));
  const desired = { values: { headlinefont: 'Montserrat', headlinecolor: '#000000' } };
  await assert.rejects(applyProjectStyle(fakeDriver(), { desired, confirmed: false, projectid: '1' }, { baseDir }), /STYLE_NOT_CONFIRMED|нужен --confirm/);
  await assert.rejects(applyProjectStyle(fakeDriver(), { desired, confirmed: true, confirm: 'нет', projectid: '1' }, { baseDir }), /нужен --confirm/);

  const d = fakeDriver();
  const r = await applyProjectStyle(d, { desired, confirmed: true, confirm: STYLE_CONFIRM, projectid: '1', now: '2026-01-01T00:00:00.000Z' }, { baseDir });
  assert.deepEqual(r.changed, ['headlinefont', 'headlinecolor']);
  assert.deepEqual(r.otherChanged, []);
  const rec = JSON.parse(readFileSync(r.record, 'utf8'));
  assert.equal(rec.before.headlinefont, 'TildaSans');
  assert.deepEqual(d.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['read', 'set', 'reload', 'read']);

  const same = fakeDriver();
  const again = await applyProjectStyle(same, { desired: { values: { headlinefont: 'Tilda Sans' } }, confirmed: true, confirm: STYLE_CONFIRM, projectid: '1' }, { baseDir });
  assert.equal(again.record, null);
  assert.ok(!same.calls.some((c) => Array.isArray(c)), 'нет изменений — нет записи');

  const bad = fakeDriver({ text: 'ERROR' });
  await assert.rejects(applyProjectStyle(bad, { desired, confirmed: true, confirm: STYLE_CONFIRM, projectid: '1', now: '2026-01-01T00:00:01.000Z' }, { baseDir }), /SAVE_FAILED|не сохранены/);
  assert.ok(readdirSync(join(baseDir, 'project-settings', '1')).length >= 2, 'запись отката есть и при отказе');

  const drift = await applyProjectStyle(fakeDriver({ drift: true }), { desired, confirmed: true, confirm: STYLE_CONFIRM, projectid: '1', now: '2026-01-01T00:00:02.000Z' }, { baseDir });
  assert.deepEqual(drift.otherChanged, ['other']);
});

test('applyProjectStyle checks a weight against the chosen form option, not the wanted number', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'project-style-'));
  const desired = { values: { headlinefontweight: '600', headlinecolor: '#000000' } };
  const r = await applyProjectStyle(fakeDriver({ options: { headlinefontweight: '' } }), { desired, confirmed: true, confirm: STYLE_CONFIRM, projectid: '1', now: '2026-01-01T00:00:03.000Z' }, { baseDir });
  assert.deepEqual(r.notApplied, []);
  assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).chosen.headlinefontweight, '');
});
