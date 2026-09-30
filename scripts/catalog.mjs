/**
 * Каталог «tplid → поля редактора»: эталонные снимки стандартных блоков.
 *
 * Из опубликованного HTML восстановимы имена полей, но не то, какие поля принимает `saverecord`
 * и какие значения в них по умолчанию. Эталон снимается с только что созданного блока на
 * черновой странице: `addRecord(tplid)` → `readRecordSnapshot` → `deleteRecord`. Файлы лежат в
 * `TILDA_CATALOG_DIR/<tplid>.json` (общая папка каталога всех сайтов, вне git). Драйвер браузера приходит снаружи —
 * модуль не импортирует `lib/browser.mjs`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { msg } from './lib/i18n.mjs';
import { catalogRoot } from './lib/paths.mjs';
import { recordFields } from './lib/record-fields.mjs';
import { refPaths } from './lib/reference-store.mjs';
import { decodeList } from './list-model.mjs';
import { MAP_VERSION } from './lib/settings-calibration.mjs';

const log = createLogger('catalog');

/** Zero Block не каталогизируется: у него модель элементов, а не поля записи. */
export const ZERO_TPLID = '396';
/** Пауза между эталонами — тот же темп, что у чтений цикла (`cycle.mjs`, READ_DELAY_MS). */
export const CAPTURE_DELAY_MS = 2500;

/**
 * Папка каталога. В работе — общая `TILDA_CATALOG_DIR` (файлы `<tplid>.json` лежат прямо в ней, без подпапки).
 * `opts.baseDir` — только подмена для тестов: там каталог лежит в подпапке `<baseDir>/catalog`.
 */
export function catalogDir(opts = {}) {
  return opts.baseDir ? join(opts.baseDir, 'catalog') : catalogRoot();
}

export function catalogPath(tplid, opts) {
  return join(catalogDir(opts), `${tplid}.json`);
}

/** Запись каталога или null, если файла нет; битый JSON — ошибка. */
export function loadCatalog(tplid, opts) {
  const path = catalogPath(tplid, opts);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    log.error('loadCatalog', 'файл каталога не разобрался', { path, error: e.message });
    throw e;
  }
}

/**
 * Карта влияния настроек шаблона: рядом с каталогом,
 * `<tplid>.settings.json`. Путь и чтение живут здесь, а не в `calibrate.mjs`, чтобы
 * `reference-plan.mjs` читал карту без оркестратора калибровки.
 */
export function settingsMapPath(tplid, opts) {
  return join(catalogDir(opts), `${tplid}.settings.json`);
}

/** Карта влияния или null (файла нет или версия формата другая); битый JSON — ошибка. */
export function loadSettingsMap(tplid, opts) {
  const path = settingsMapPath(tplid, opts);
  if (!existsSync(path)) return null;
  let map;
  try {
    map = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    log.error('loadSettingsMap', 'файл карты не разобрался', { path, error: e.message });
    throw e;
  }
  if (map?.version !== MAP_VERSION) {
    log.warn('loadSettingsMap', 'версия карты не та — карта считается отсутствующей', { tplid: String(tplid), version: map?.version, expected: MAP_VERSION });
    return null;
  }
  return map;
}

export function loadCatalogs(tplids, opts) {
  const out = {};
  for (const tplid of tplids) out[String(tplid)] = loadCatalog(tplid, opts);
  return out;
}

/** Уникальные tplid структуры страницы в порядке появления, без Zero Block и без неизвестных. */
export function tplidsFromStructure(structure) {
  const seen = new Set();
  for (const b of structure?.blocks ?? []) {
    if (b.tplid === undefined || b.tplid === null) continue;
    const tplid = String(b.tplid);
    if (tplid === ZERO_TPLID || tplid === '?') continue;
    seen.add(tplid);
  }
  return [...seen];
}

/** Объединённый список tplid по всем `structure/*.json` слепка. */
export function tplidsFromSlug(slug, opts) {
  const { structure } = refPaths(slug, opts);
  if (!existsSync(structure)) return [];
  const seen = new Set();
  for (const name of readdirSync(structure).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(structure, name), 'utf8'));
    for (const tplid of tplidsFromStructure(parsed)) seen.add(tplid);
  }
  log.debug('tplidsFromSlug', 'шаблоны слепка', { slug, count: seen.size });
  return [...seen];
}

/**
 * Полный список полей содержимого шаблона из `tpl.fields` ответа редактора (проба
 * 2026-09-23): снимок записи не возвращает пустые поля (`buttonlink`, `rutubeid` у свежего блока),
 * а `tpl.fields` перечисляет все. Служебные разделители вида `|gg15|` отбрасываются.
 * Нет строки — null (каталог без поля работает по `tabs`).
 */
export function tplFieldsOf(snapshot) {
  const raw = snapshot?.tpl?.fields;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('|'));
}

/** Запись каталога по снимку эталонного блока. */
export function buildCatalogEntry({ tplid, snapshot, capturedAt }) {
  const defaults = recordFields(snapshot);
  const record = snapshot.record || {};
  const cards = 'list' in record && record.list ? decodeList(record.list) : [];
  const entry = {
    tplid: String(tplid),
    capturedAt,
    available: true,
    tabs: snapshot.tabs,
    defaults,
    cardKeys: cards.length ? Object.keys(cards[0]).filter((k) => k !== 'lid') : [],
  };
  const tplFields = tplFieldsOf(snapshot);
  if (tplFields) entry.tplFields = tplFields;
  return entry;
}

/** Запись для шаблона, который Tilda отвергла (ограничение тарифа). */
export function unavailableEntry({ tplid, capturedAt, error }) {
  return { tplid: String(tplid), capturedAt, available: false, error: String(error).slice(0, 200) };
}

function fieldCount(entry) {
  return entry.tabs ? (entry.tabs.content?.length ?? 0) + (entry.tabs.settings?.length ?? 0) : 0;
}

/** Сводка снятого каталога, по возрастанию tplid; каталога нет → []. */
export function listCatalog(opts) {
  const dir = catalogDir(opts);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const entry = loadCatalog(name.slice(0, -5), opts);
    rows.push({ tplid: entry.tplid, available: entry.available, fields: fieldCount(entry), cardKeys: entry.cardKeys ?? [], capturedAt: entry.capturedAt, calibrated: existsSync(settingsMapPath(entry.tplid, opts)) });
  }
  return rows.sort((a, b) => Number(a.tplid) - Number(b.tplid));
}

export function isAccessError(message) {
  return /do not have access/i.test(String(message));
}

/**
 * Снять эталоны шаблонов на черновой странице. `driver.call(fn, args, opts)` — вызов слоя
 * `tilda-page`; `addRecord`/`deleteRecord` идут с `{ attempts: 1 }`, потому что повтор по таймауту
 * создал бы дубль. Ошибка одного tplid не прерывает остальные; `SESSION_LOST` поднимается наверх.
 */
export async function captureCatalog(
  driver,
  { pageid, tplids, delayMs = CAPTURE_DELAY_MS, force = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) },
  opts = {},
) {
  mkdirSync(catalogDir(opts), { recursive: true });
  const result = { pageid, captured: [], unavailable: [], skipped: [], failed: [] };
  const list = tplids.map(String);
  log.info('captureCatalog', 'снятие каталога начато', { pageid, tplids: list.length, force });

  for (let i = 0; i < list.length; i += 1) {
    const tplid = list[i];
    const last = i === list.length - 1;
    if (tplid === ZERO_TPLID) {
      result.skipped.push({ tplid, reason: msg('catalog.reason.zeroBlock') });
      continue;
    }
    if (!force && existsSync(catalogPath(tplid, opts))) {
      result.skipped.push({ tplid, reason: msg('catalog.reason.alreadyCaptured') });
      continue;
    }

    const capturedAt = new Date().toISOString();
    let recordid = null;
    try {
      ({ recordid } = await driver.call('addRecord', [pageid, tplid, ''], { attempts: 1 }));
    } catch (e) {
      if (isAccessError(e.message)) {
        writeFileSync(catalogPath(tplid, opts), JSON.stringify(unavailableEntry({ tplid, capturedAt, error: e.message }), null, 2) + '\n');
        result.unavailable.push({ tplid });
        log.warn('captureCatalog', 'шаблон недоступен на тарифе', { tplid });
      } else {
        result.failed.push({ tplid, error: e.message });
        log.error('captureCatalog', 'блок не создан', { tplid, error: e.message });
      }
      if (!last) await sleep(delayMs);
      continue;
    }

    let fields = 0;
    try {
      const snapshot = await driver.call('readRecordSnapshot', [pageid, recordid]);
      const entry = buildCatalogEntry({ tplid, snapshot, capturedAt });
      writeFileSync(catalogPath(tplid, opts), JSON.stringify(entry, null, 2) + '\n');
      fields = fieldCount(entry);
      result.captured.push({ tplid, fields, cards: entry.cardKeys.length });
      log.debug('captureCatalog', 'поля эталона', { tplid, content: entry.tabs?.content, settings: entry.tabs?.settings });
    } catch (e) {
      result.failed.push({ tplid, recordid, error: e.message });
      log.error('captureCatalog', 'эталон не прочитан', { tplid, recordid, error: e.message });
    } finally {
      try {
        await driver.call('deleteRecord', [pageid, recordid], { attempts: 1 });
      } catch (e) {
        log.error('captureCatalog', 'эталонный блок не удалён — удалите вручную', { tplid, recordid, error: e.message });
        result.failed.push({ tplid, recordid, error: 'DELETE_FAILED' });
      }
    }
    log.info('captureCatalog', 'эталон снят', { tplid, recordid, fields });
    if (!last) await sleep(delayMs);
  }

  log.info('captureCatalog', 'снятие каталога завершено', {
    captured: result.captured.length, unavailable: result.unavailable.length, skipped: result.skipped.length, failed: result.failed.length,
  });
  return result;
}
