/**
 * Профиль Chrome держателя: сброс масштаба страниц Tilda.
 *
 * Масштаб, выставленный человеком в окне держателя (Ctrl+-), Chrome хранит в
 * `<профиль>/Default/Preferences` под ключом `partition.per_host_zoom_levels` и применяет ко
 * всем следующим кадрам — снимки `shot` выходят в чужом масштабе. Файл правится только пока Chrome не запущен: `browser.startDaemon`
 * вызывает `resetTildaZoom` до спавна держателя.
 *
 * Содержимое Preferences (закладки, служебные данные) в логи не пишется — только имена хостов
 * и путь копии.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from './log.mjs';

const log = createLogger('browser-profile');

/** Хосты, масштаб которых сбрасывается (включая поддомены). */
export const ZOOM_HOSTS = ['tilda.ru', 'tilda.cc'];

const matchesHost = (host, hosts) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Чистая: убирает уровни масштаба хостов Tilda из разобранного Preferences.
 * Понимает и вложенную форму `{ "<partition>": { "<host>": level } }`, и плоскую `{ "<host>": level }`.
 * Возвращает { prefs, removed: ['<partition>/<host>', …] }; исходный объект не мутирует.
 */
export function stripHostZoom(prefs, hosts = ZOOM_HOSTS) {
  const copy = structuredClone(prefs ?? {});
  const levels = copy?.partition?.per_host_zoom_levels;
  const removed = [];
  if (!levels || typeof levels !== 'object') {
    log.debug('stripHostZoom', 'no zoom levels in Preferences', {});
    return { prefs: copy, removed };
  }
  for (const [key, value] of Object.entries(levels)) {
    if (value && typeof value === 'object') {
      for (const host of Object.keys(value)) {
        if (!matchesHost(host, hosts)) continue;
        delete value[host];
        removed.push(`${key}/${host}`);
      }
      if (Object.keys(value).length === 0) delete levels[key];
    } else if (typeof value === 'number' && matchesHost(key, hosts)) {
      delete levels[key];
      removed.push(key);
    }
  }
  log.debug('stripHostZoom', 'zoom levels processed', { removed });
  return { prefs: copy, removed };
}

/**
 * Файловая: <profileDir>/Default/Preferences → копия Preferences.bak-<метка> → запись без масштаба.
 * Ошибки не роняют старт держателя: возвращается { removed: [], skipped: 'no-preferences'|'bad-json'|'io' }.
 */
export function resetTildaZoom(profileDir, { hosts = ZOOM_HOSTS, now = new Date() } = {}) {
  const file = resolve(profileDir, 'Default', 'Preferences');
  if (!existsSync(file)) {
    log.debug('resetTildaZoom', 'no Preferences file, nothing to reset', { file });
    return { removed: [], skipped: 'no-preferences' };
  }
  let prefs;
  try {
    prefs = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    log.warn('resetTildaZoom', 'Preferences is not valid JSON, left as is', { file, error: e.message });
    return { removed: [], skipped: 'bad-json' };
  }
  const { prefs: next, removed } = stripHostZoom(prefs, hosts);
  if (removed.length === 0) {
    log.debug('resetTildaZoom', 'no Tilda zoom in the profile', { file });
    return { removed };
  }
  const backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
  try {
    copyFileSync(file, backup);
    writeFileSync(file, JSON.stringify(next));
  } catch (e) {
    log.warn('resetTildaZoom', 'Preferences not updated', { file, error: e.message });
    return { removed: [], skipped: 'io' };
  }
  log.info('resetTildaZoom', 'Tilda zoom removed from the profile', { removed, backup });
  return { removed, backup };
}
