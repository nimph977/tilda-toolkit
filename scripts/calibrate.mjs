/**
 * `catalog calibrate` — карта влияния настроек шаблона по предпросмотру.
 *
 * Для каждого шаблона на черновой странице создаётся временный блок (как в `catalog capture`),
 * читается схема вкладки «Настройки» (`readSettingsSchema`), затем `previewrecord` перебирает
 * пробные значения полей — сервер отдаёт HTML блока и ничего не сохраняет. Признаки разметки
 * (`lib/markup-features.mjs`) каждого предпросмотра сводятся в карту (`lib/settings-calibration.mjs`),
 * карта пишется в `TILDA_CATALOG_DIR/<tplid>.settings.json`, блок удаляется.
 * Запись в Tilda — только создание и удаление временного блока. Драйвер браузера приходит
 * снаружи — модуль не импортирует `lib/browser.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createLogger } from './lib/log.mjs';
import { attachMessage, messageText, msg } from './lib/i18n.mjs';
import { extractFeatures, diffFeatures } from './lib/markup-features.mjs';
import { normalizeSchema } from './lib/settings-schema.mjs';
import { probeVariants, sampleContent, buildSettingsMap } from './lib/settings-calibration.mjs';
import { catalogDir, loadCatalog, loadSettingsMap, settingsMapPath } from './catalog.mjs';
import { decodeList, CARD_FORM_FIELDS } from './list-model.mjs';

const log = createLogger('calibrate');

/**
 * Темп предпросмотров — итог пробы 2026-09-23: 60 подряд с паузой 300 мс, 150 с паузой
 * 800 мс и 300 с паузой 800 мс без единого сбоя; по правилу плана взята самая быстрая серия —
 * пауза 300 мс, пачка 60, пауза после пачки 60 с.
 */
export const CALIBRATE_DELAY_MS = 300;
export const CALIBRATE_BATCH = 60;
export const CALIBRATE_PAUSE_S = 60;
/** Столько отказов предпросмотра подряд — шаблон уходит в `failed`. */
export const MAX_PREVIEW_FAILURES = 5;

/** Поля блока в форме тела `saverecord`/`previewrecord`: у блока-списка — и поля формы карточек. */
export function toFieldList(fields) {
  const out = [];
  for (const [name, value] of Object.entries(fields)) out.push({ name, value: value == null ? '' : String(value) });
  if (fields.list) {
    for (const c of decodeList(fields.list)) for (const f of CARD_FORM_FIELDS) out.push({ name: f, value: String(c[f] ?? '') });
  }
  return out;
}

class CalibrationError extends Error {
  constructor(code, message) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'CalibrationError';
    this.code = code;
  }
}

/**
 * @param {{ call: Function }} driver  драйвер цикла (`cycle.browserDriver`)
 * @param {{ pageid: string, tplids: string[], force?: boolean, delayMs?: number, batch?: number, pauseS?: number, sleep?: Function, now?: () => string }} params
 */
export async function calibrateCatalog(
  driver,
  { pageid, tplids, force = false, delayMs = CALIBRATE_DELAY_MS, batch = CALIBRATE_BATCH, pauseS = CALIBRATE_PAUSE_S, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString() },
  opts = {},
) {
  mkdirSync(catalogDir(opts), { recursive: true });
  const result = { pageid: String(pageid), calibrated: [], skipped: [], failed: [], previews: 0 };
  let sinceBatch = 0;
  const pace = async () => {
    sinceBatch += 1;
    if (batch > 0 && sinceBatch >= batch) {
      sinceBatch = 0;
      log.info('calibrateCatalog', 'пауза после пачки предпросмотров', { batch, pauseS });
      await sleep(pauseS * 1000);
    } else {
      await sleep(delayMs);
    }
  };
  log.info('calibrateCatalog', 'калибровка начата', { pageid: String(pageid), tplids: tplids.length, force, delayMs, batch, pauseS });

  for (const raw of tplids) {
    const tplid = String(raw);
    const entry = loadCatalog(tplid, opts);
    if (!entry) {
      result.skipped.push({ tplid, reason: msg('calibrate.reason.catalogNotCaptured') });
      continue;
    }
    if (entry.available === false) {
      result.skipped.push({ tplid, reason: msg('calibrate.reason.templateUnavailable') });
      continue;
    }
    if (!force && hasSettingsMap(tplid, opts)) {
      result.skipped.push({ tplid, reason: msg('calibrate.reason.alreadyCalibrated') });
      continue;
    }
    const started = Date.now();
    let recordid = null;
    try {
      ({ recordid } = await driver.call('addRecord', [pageid, tplid, ''], { attempts: 1 }));
    } catch (e) {
      if (e.code === 'SESSION_LOST') throw e;
      result.failed.push({ tplid, error: String(e.message).slice(0, 200) });
      log.error('calibrateCatalog', 'временный блок не создан', { tplid, error: String(e.message).slice(0, 200) });
      continue;
    }
    let previews = 0;
    try {
      const schema = normalizeSchema(await driver.call('readSettingsSchema', [pageid, recordid]));
      const current = await driver.call('readRecordFields', [pageid, recordid]);
      const base = { ...current, ...sampleContent(entry) };
      let failuresInRow = 0;
      const preview = async (fields) => {
        const r = await driver.call('previewRecord', [pageid, recordid, toFieldList(fields), { withHtml: true }]);
        previews += 1;
        result.previews += 1;
        await pace();
        return extractFeatures(r.html, { recid: recordid });
      };
      const baseFeatures = await preview(base);
      // Второй предпросмотр той же базы: признаки, которые меняются сами по себе, — шум.
      const again = await preview(base);
      const d = diffFeatures(baseFeatures, again);
      const noiseFeatures = [...d.added, ...d.removed];
      if (noiseFeatures.length) log.debug('calibrateCatalog', 'шум предпросмотра', { tplid, noise: noiseFeatures.length });
      const { variants, skipped } = probeVariants(schema, base);
      const observations = [];
      const failed = [];
      for (const v of variants) {
        const t = Date.now();
        try {
          const features = await preview({ ...base, [v.field]: v.value });
          observations.push({ ...v, features });
          failuresInRow = 0;
          log.debug('calibrateCatalog', 'предпросмотр', { tplid, field: v.field, key: v.key, ms: Date.now() - t });
        } catch (e) {
          if (e.code === 'SESSION_LOST' || /SESSION_LOST/.test(e.message)) throw e;
          failed.push({ field: v.field, key: v.key, error: e.code || String(e.message).slice(0, 60) });
          failuresInRow += 1;
          log.warn('calibrateCatalog', 'предпросмотр не получен', { tplid, field: v.field, key: v.key, error: String(e.message).slice(0, 120) });
          if (failuresInRow > MAX_PREVIEW_FAILURES) throw new CalibrationError('PREVIEW_FAILED', msg('calibrate.previewFailed', { max: MAX_PREVIEW_FAILURES }));
        }
      }
      const map = buildSettingsMap({ tplid, schema, baseFeatures, observations, current: base, noiseFeatures, failed, skipped, now: now() });
      map.schema = schema.fields;
      writeFileSync(settingsMapPath(tplid, opts), JSON.stringify(map, null, 2) + '\n');
      result.calibrated.push({ tplid, fields: Object.keys(map.fields).length, skipped: map.skipped.length, previews });
      log.info('calibrateCatalog', 'шаблон откалиброван', { tplid, fields: Object.keys(map.fields).length, skipped: map.skipped.length, previews, ms: Date.now() - started });
    } catch (e) {
      // Потеря сессии прерывает весь прогон; удаление в finally попробует убрать блок.
      if (e.code === 'SESSION_LOST' || /SESSION_LOST/.test(e.message)) throw e;
      result.failed.push({ tplid, error: String(e.message).slice(0, 200), previews });
      log.error('calibrateCatalog', 'калибровка шаблона сорвалась', { tplid, previews, error: String(e.message).slice(0, 200) });
    } finally {
      await deleteTemp(driver, pageid, tplid, recordid, result);
    }
  }
  log.info('calibrateCatalog', 'калибровка завершена', { calibrated: result.calibrated.length, skipped: result.skipped.length, failed: result.failed.length, previews: result.previews });
  return result;
}

/** Есть ли действующая карта: битая или другой версии считается отсутствующей (перекалибруется). */
function hasSettingsMap(tplid, opts) {
  try {
    return Boolean(loadSettingsMap(tplid, opts));
  } catch {
    return false;
  }
}

/** Удалить временный блок; неудача — `failed` с `DELETE_FAILED`, прогон продолжается. */
async function deleteTemp(driver, pageid, tplid, recordid, result) {
  try {
    await driver.call('deleteRecord', [pageid, recordid], { attempts: 1 });
  } catch (e) {
    result.failed.push({ tplid, error: 'DELETE_FAILED' });
    log.error('calibrateCatalog', 'временный блок не удалён — удалите блок вручную: последний на черновой', { tplid, error: String(e.message).slice(0, 120) });
  }
}
