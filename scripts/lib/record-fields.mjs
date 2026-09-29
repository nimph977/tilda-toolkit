/**
 * Содержательные поля стандартного блока из снимка редактора — общий помощник для
 * `apply-plan.mjs` (сверка и запись), `promote.mjs` (сравнение копий) и `catalog.mjs`
 * (эталонные значения шаблона). Вынесен отдельно, чтобы `catalog.mjs` не тянул `apply-plan.mjs`.
 */
import { decodeEntities } from './entities.mjs';

/**
 * Поля записи, которые не переносятся при копировании блока и не участвуют в сверке:
 * служебные ставит сама Тильда, `slideqty`, `formactiontype` и `off` отвергает `saverecord`
 * (проверено 2026-09-09 и 2026-09-03). Тот же список — в scripts/browser/tilda-page.js.
 */
export const RECORD_SKIP_FIELDS = new Set(['id', 'recordid', 'pageid', 'tplid', 'projectid', 'slideqty', 'formactiontype', 'off']);

/** Содержательные поля стандартного блока из снимка {record, tpl}: без служебных, без пустых, декодированные. */
export function recordFields(snapshot) {
  const rec = (snapshot && snapshot.record) || snapshot || {};
  const out = {};
  for (const [name, value] of Object.entries(rec)) {
    if (RECORD_SKIP_FIELDS.has(name)) continue;
    if (value === '' || value === null || value === undefined) continue;
    out[name] = decodeEntities(value);
  }
  return out;
}
