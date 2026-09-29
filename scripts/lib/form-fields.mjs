/**
 * Чёрный список полей формы и общие guard'ы записи.
 *
 * С переходом на запись любого поля модели запрет «формы вне автоматизации»
 * перестаёт держаться на том, что код умел писать шесть полей. Держится он этим списком:
 * попытка записать поле формы — отказ FORM_FIELD_REJECTED, на обоих путях записи (модель Zero
 * Block и поля стандартного блока) и в обоих слоях (Node здесь, браузер — копия списка в
 * scripts/browser/tilda-zero.js и tilda-page.js).
 *
 * Значение с `<script` не пишется ни в одно поле: такая запись инвалидирует сессию Тильды
 * глобально.
 */
import { createLogger } from './log.mjs';

const log = createLogger('form-fields');

// `formname` (подпись заявки в письме и CRM) выведен из списка 2026-09-21 по решению владельца:
// на доставку заявок не влияет, а копия блока наследует чужое имя формы.
// Строгая копия: получатели заявок и модель
// формы Zero Block (`inputs`) не пишутся никогда; адрес перехода после отправки (`formmsgurl`)
// пишется только операцией с флагом `formContent: 'reference'` (сборка по референсу).
export const FORM_LOCKED_FIELDS = Object.freeze(['receivers', 'receivers_names', 'inputs']);
export const FORM_CONTENT_FIELDS = Object.freeze(['formmsgurl']);
export const FORM_FIELDS = Object.freeze([...FORM_LOCKED_FIELDS, ...FORM_CONTENT_FIELDS]);
const FORM_SET = new Set(FORM_FIELDS);
const CONTENT_SET = new Set(FORM_CONTENT_FIELDS);

export function isFormField(name) {
  return FORM_SET.has(String(name));
}

/**
 * Отказ FORM_FIELD_REJECTED, если поле из чёрного списка. ctx — что писалось (для лога).
 * `allowContent` пропускает только `FORM_CONTENT_FIELDS` — получатели запрещены всегда.
 */
export function assertNotFormField(name, ctx = {}, { allowContent = false } = {}) {
  if (!isFormField(name)) return;
  if (allowContent && CONTENT_SET.has(String(name))) {
    log.warn('assertNotFormField', 'поле формы пропущено по флагу formContent', { field: String(name), ...ctx });
    return;
  }
  log.warn('assertNotFormField', 'отказ: поле формы не пишется', { field: String(name), ...ctx });
  const e = new Error(`FORM_FIELD_REJECTED ${name}: поля формы (${FORM_FIELDS.join(', ')}) не пишутся никогда`);
  e.code = 'FORM_FIELD_REJECTED';
  throw e;
}

/** Есть ли `<script` в строке или в любой строке внутри объекта/массива (на любой глубине). */
export function containsScript(value) {
  if (typeof value === 'string') return /<script/i.test(value);
  if (Array.isArray(value)) return value.some(containsScript);
  if (value && typeof value === 'object') return Object.values(value).some(containsScript);
  return false;
}

/** Отказ SCRIPT_REJECTED, если значение (или что-то внутри него) содержит `<script`. */
export function assertNoScript(value, ctx = {}) {
  if (!containsScript(value)) return;
  log.error('assertNoScript', 'отказ: значение содержит <script', ctx);
  const e = new Error(`SCRIPT_REJECTED${ctx.field ? ' ' + ctx.field : ''}: значения с <script не пишутся ни в одно поле`);
  e.code = 'SCRIPT_REJECTED';
  throw e;
}

/**
 * Изменились ли поля формы между двумя моделями Zero Block (по элементам). Возвращает список
 * {key, field} — пустой значит запись безопасна. Нужен guard'у над записью модели целиком.
 */
export function formFieldChanges(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})].filter((k) => /^\d+$/.test(k)));
  for (const key of keys) {
    // Элемент удалён целиком (`removeElement`) — это не запись полей формы, а структурная правка
    // блока (2026-09-21: копия блока без формы). Исчезновение полей вместе с элементом
    // не считается изменением; появление формы в новом элементе — по-прежнему считается.
    if (before && before[key] && !(after && after[key])) {
      if (FORM_FIELDS.some((f) => before[key][f] !== undefined)) log.info('formFieldChanges', 'элемент формы удалён целиком — допускается', { key, elem_id: before[key].elem_id });
      continue;
    }
    const a = (before && before[key]) || {};
    const b = (after && after[key]) || {};
    for (const field of FORM_FIELDS) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) out.push({ key, field });
    }
  }
  return out;
}
