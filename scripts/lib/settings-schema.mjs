/**
 * Схема вкладки «Настройки» шаблона для каталога.
 *
 * Сырая схема приходит из браузерного слоя `T.readSettingsSchema` — поля шаблона с типом
 * словаря редактора (`edrec__drawUI__getFieldObj`). Здесь тип сводится к виду поля, по которому
 * калибровка выбирает пробные значения:
 *   `sb`, `cpb`, `screen` с вариантами → `enum`; `screen` без вариантов → `size`;
 *   `cb` → `flag`; `co` → `color`; `in_px`, `in_vh`, `radius` → `size`; `json` → `json`;
 *   прочее → `unknown` (калибровка пропускает такое поле с причиной).
 * Подписи и картинки вариантов в схему не попадают.
 */
import { createLogger } from './log.mjs';

const log = createLogger('settings-schema');

/** Тип словаря редактора → вид поля. `screen` без вариантов уточняется в `kindOf`. */
export const KIND_BY_TYPE = {
  sb: 'enum',
  cpb: 'enum',
  screen: 'enum',
  cb: 'flag',
  co: 'color',
  in_px: 'size',
  in_vh: 'size',
  radius: 'size',
  json: 'json',
};

function kindOf(field) {
  const kind = KIND_BY_TYPE[field.type] || 'unknown';
  if (field.type === 'screen' && !(Array.isArray(field.options) && field.options.length)) return 'size';
  if (kind === 'enum' && !(Array.isArray(field.options) && field.options.length)) return 'unknown';
  return kind;
}

/**
 * @param {{ tplid: string, fields: Array<{name, type, options, jsonFields, mobile, desktop}> }} raw
 * @returns {{ tplid: string, fields: Record<string, { type: string, kind: string, options?: string[], jsonFields?: string[], mobileOf?: string }> }}
 */
export function normalizeSchema(raw) {
  const fields = {};
  const unknown = [];
  for (const f of raw?.fields || []) {
    if (!f || !f.name) continue;
    const entry = { type: String(f.type || ''), kind: kindOf(f) };
    if (Array.isArray(f.options) && f.options.length) entry.options = [...new Set(f.options.map(String))];
    if (Array.isArray(f.jsonFields) && f.jsonFields.length) entry.jsonFields = f.jsonFields.map(String);
    if (f.desktop) entry.mobileOf = String(f.desktop);
    if (entry.kind === 'unknown') unknown.push(f.name);
    fields[f.name] = entry;
  }
  if (unknown.length) log.debug('normalizeSchema', 'поля неизвестного типа', { tplid: raw?.tplid, fields: unknown });
  log.debug('normalizeSchema', 'схема', { tplid: raw?.tplid, fields: Object.keys(fields).length, unknown: unknown.length });
  return { tplid: String(raw?.tplid ?? ''), fields };
}
