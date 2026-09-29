/**
 * Дописывание уже собранной страницы: план сборки по
 * метке (операции `newRecord`) сравнивается с живыми блоками страницы, и вместо пересоздания
 * получаются операции `field` (отличающиеся поля), `listSet` (тексты карточек по индексу) и
 * `newRecord` (блоки, которых на странице нет). Лишние блоки страницы не удаляются — причина.
 *
 * Карточки меняются по индексу (`listSet.set`), а не полной заменой: у плана картинки карточек
 * пустые (они грузятся отдельно), и полная замена стёрла бы картинки, уже стоящие на странице.
 * Новые блоки встают подряд после `startAfter` плана (так вставляет `buildBlocks`): для первой
 * группы это место совпадает с референсом, блоки следующих групп получают причину `placement`.
 *
 * Чистые функции без сети.
 */
import { createLogger } from './log.mjs';
import { alignBlocks } from './block-compare.mjs';

const log = createLogger('plan-update');

export const UPDATE_REASONS = {
  extraBlock: 'на странице лишний блок — не удаляется',
  codeManual: 'код HTML-блока отличается — перенос вручную',
  imageKept: 'картинка уже на странице — не перезаливается',
  cardsCount: 'число карточек отличается от референса — карточки не переписаны',
  placement: (after) => `новый блок встанет после предыдущего нового — переставьте после блока ${after}`,
};

const IMAGE_FIELD_RE = /-(uploadmethod|tuinfo-[a-z]+|del)$/;
const CARD_IMAGE_KEYS = new Set(['lid', 'ls', 'loff', 'li_img', 'li_img2', 'li-tubutton', 'li_imgalt']);

/** JSON-объект с ключами по алфавиту на любой глубине; не JSON — строка как есть. */
function orderless(text) {
  if (!/^[[{]/.test(text)) return text;
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  try {
    return JSON.stringify(sort(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** Значение для сравнения: `<br>`-варианты и пробелы — нормализатором сверки, JSON — без учёта порядка ключей. */
function differs(a, b, normalize) {
  return orderless(normalize(String(a ?? ''))) !== orderless(normalize(String(b ?? '')));
}

function decodeCards(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : Object.values(v ?? {});
  } catch {
    return [];
  }
}

/**
 * @param {object[]} planOps  операции плана сборки по метке (`newRecord`)
 * @param {Array<{recordid: string, tplid: string, fields: Record<string,string>}>} live  видимые блоки страницы по порядку
 * @param {{ normalize: (s: string) => string }} deps  нормализатор значений сверки (`normalizeFieldValue`)
 * @returns {{ ops: object[], unmapped: object[], startAfter: string }}
 */
export function buildUpdateOps(planOps, live, { normalize = (s) => s } = {}) {
  const creates = planOps.filter((op) => op.newRecord).map((op, i) => ({ ...op, order: i, tplid: String(op.newRecord.tplid) }));
  const liveBlocks = live.map((b, i) => ({ ...b, order: i, tplid: String(b.tplid) }));
  const { pairs, refOnly, builtOnly } = alignBlocks(creates, liveBlocks, {});
  const ops = [];
  const unmapped = [];
  const stats = { fields: 0, lists: 0, created: 0 };
  for (const { ref: op, built: blk } of pairs) {
    const spec = op.newRecord;
    const block = { recordid: String(blk.recordid) };
    // Поле может встретиться в плане дважды (разбор настроек, затем `linkhook` из разметки);
    // при создании блока побеждает последнее значение — здесь так же.
    const lastFields = [...new Map((spec.fields ?? []).map((f) => [f.name, f])).values()];
    for (const f of lastFields) {
      if (IMAGE_FIELD_RE.test(f.name)) continue;
      if (f.name === 'forminputs') {
        const want = decodeCards(f.value).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'lid')));
        const have = decodeCards(blk.fields.list);
        const same = want.length === have.length && want.every((w, i) => Object.entries(w).every(([k, v]) => !differs(v, have[i]?.[k], normalize)));
        if (same) continue;
      } else if (!differs(f.value, blk.fields[f.name], normalize)) continue;
      ops.push({ id: `${op.id ?? 'b'}.${f.name}`, block, field: { name: f.name, value: f.value }, ...(op.formContent ? { formContent: op.formContent } : {}) });
      stats.fields += 1;
    }
    if (spec.code !== undefined && differs(String(spec.code).trim(), String(blk.fields.code ?? '').trim(), (s) => s)) {
      unmapped.push({ id: op.id, recordid: block.recordid, field: 'code', reason: UPDATE_REASONS.codeManual });
    }
    for (const im of spec.images ?? []) unmapped.push({ id: op.id, recordid: block.recordid, field: im.field, ...(im.card !== undefined ? { card: im.card } : {}), reason: UPDATE_REASONS.imageKept });
    if ((spec.cards ?? []).length) {
      const have = decodeCards(blk.fields.list);
      if (have.length !== spec.cards.length) {
        unmapped.push({ id: op.id, recordid: block.recordid, field: 'list', reason: UPDATE_REASONS.cardsCount, text: `${have.length}→${spec.cards.length}` });
      } else {
        const set = [];
        spec.cards.forEach((c, index) => {
          const fields = {};
          for (const [k, v] of Object.entries(c)) if (!CARD_IMAGE_KEYS.has(k) && differs(v, have[index]?.[k], normalize)) fields[k] = v;
          if (Object.keys(fields).length) set.push({ index, fields });
        });
        if (set.length) {
          ops.push({ id: `${op.id ?? 'b'}.list`, block, listSet: { set } });
          stats.lists += 1;
        }
      }
    }
  }
  // Новые блоки: первая группа встаёт после живого блока, стоящего перед ней в выравнивании.
  let startAfter = '';
  let firstGroupEnd = null;
  const pairedByOrder = new Map(pairs.map((p) => [p.ref.order, p.built]));
  for (const op of refOnly) {
    let prev = null;
    for (let k = op.order - 1; k >= 0; k -= 1) {
      if (pairedByOrder.has(k)) {
        prev = pairedByOrder.get(k);
        break;
      }
    }
    const created = { id: op.id, newRecord: op.newRecord, hidden: op.hidden ?? 'n', ...(op.formContent ? { formContent: op.formContent } : {}) };
    if (firstGroupEnd === null) {
      startAfter = prev ? String(prev.recordid) : '';
      firstGroupEnd = prev ? prev.order : -1;
    } else if ((prev ? prev.order : -1) !== firstGroupEnd) {
      unmapped.push({ id: op.id, field: null, reason: UPDATE_REASONS.placement(prev ? prev.recordid : '(начало страницы)') });
    }
    ops.push(created);
    stats.created += 1;
  }
  for (const blk of builtOnly) unmapped.push({ recordid: String(blk.recordid), tplid: blk.tplid, field: null, reason: UPDATE_REASONS.extraBlock });
  log.debug('buildUpdateOps', 'дописывание', { ...stats, extra: builtOnly.length, unmapped: unmapped.length });
  return { ops, unmapped, startAfter, stats };
}
