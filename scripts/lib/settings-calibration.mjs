/**
 * Ядро калибровки настроек шаблона: какие
 * значения пробовать, чем заполнить содержимое, чтобы элементы блока отрисовались, и как из
 * набора предпросмотров `previewrecord` получить карту влияния «значение поля → признаки
 * разметки», по которой разбор референса читает значения.
 *
 * Виды правил карты:
 *   `enum`  — у каждого значения своя сигнатура (подмножество изменчивых признаков);
 *   `slot`  — значение закодировано токеном признака заданной формы (`shapeOf`): `hex`, `rgb`
 *             (три токена подряд) или `number` (+ единица);
 *   `text`  — значение подставлено в признак подстрокой (`§t` в форме).
 * Правила уровня Tilda, общие для всех шаблонов (`JSON_KEY_KIND`, пробные значения по виду поля);
 * правил под отдельный шаблон нет.
 *
 * Чистые функции, без сети и файловой системы; на неполных данных не бросают — пропуск с причиной.
 */
import { createLogger } from './log.mjs';
import { diffFeatures, shapeOf } from './markup-features.mjs';

const log = createLogger('settings-calibration');

export const MAP_VERSION = 1;

/** Причины пропуска поля калибровкой. */
export const CALIBRATION_REASONS = {
  unknownType: (t) => ({ code: 'calibrationUnknownType', reason: `field type "${t || 'empty'}" is unknown to the calibration dictionary` }),
  jsonKeyUntyped: (k) => ({ code: 'calibrationJsonKeyUntyped', reason: `JSON key "${k}" has no kind in JSON_KEY_KIND` }),
  noSignal: { code: 'calibrationNoSignal', reason: 'the value does not change the preview markup' },
  unstable: { code: 'calibrationUnstable', reason: 'the probes gave different features' },
  previewFailed: (e) => ({ code: 'calibrationPreviewFailed', reason: `no preview received: ${e}` }),
};

/** Пробные значения по виду поля. */
export const COLOR_PROBES = ['#123456', '#65a3c1'];
export const SIZE_PROBES = { in_px: ['37px', '53px'], in_vh: ['337px', '63vh'], radius: ['7px', '13px'], screen: ['640px', '1200px'] };
export const FLAG_PROBES = ['on', ''];
export const TEXT_PROBES = ['CalibA', 'CalibB'];

/**
 * Вид ключа JSON (`button_styles`, `*_typo`) — правило уровня Tilda: по имени ключа. Порядок
 * важен: первое совпадение побеждает (`bordercolorhover` — цвет, `fontsize_res_480` — размер).
 */
export const JSON_KEY_KIND = [
  [/color/, { kind: 'color', values: COLOR_PROBES }],
  [/lineheight/, { kind: 'size', values: ['1.37', '1.73'] }],
  [/letterspacing/, { kind: 'size', values: ['1.3px', '2.7px'] }],
  [/fontsize|radius|bordersize|padding|gap|iconsize|underlinesize|widthpx|margintop|marginbottom|shadowsize/, { kind: 'size', values: ['17px', '23px'] }],
  [/fontweight/, { kind: 'enum', values: ['100', '300', '500', '600', '700', '900'] }],
  [/fontfamily/, { kind: 'text', values: TEXT_PROBES }],
  [/uppercase/, { kind: 'enum', values: ['uppercase', ''] }],
  [/^size$/, { kind: 'enum', values: ['sm', 'md', 'lg', 'xl'] }],
  [/opacity/, { kind: 'enum', values: ['10', '50', '90'] }],
];

/** Вид ключа JSON или null. */
export function jsonKeyKind(key) {
  for (const [re, spec] of JSON_KEY_KIND) if (re.test(String(key))) return spec;
  return null;
}

function parseJsonObject(value) {
  if (value && typeof value === 'object') return { ...value };
  try {
    const o = JSON.parse(String(value || '{}'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Пробные значения полей схемы относительно текущих значений блока.
 * @param {{ fields: Record<string, {type, kind, options?, jsonFields?}> }} schema
 * @param {Record<string, string>} current
 */
export function probeVariants(schema, current = {}) {
  const variants = [];
  const skipped = [];
  for (const [field, spec] of Object.entries(schema?.fields || {})) {
    const cur = String(current[field] ?? '');
    const push = (values) => {
      for (const value of values) if (String(value) !== cur) variants.push({ field, value: String(value) });
    };
    switch (spec.kind) {
      case 'enum':
        push(spec.options || []);
        break;
      case 'flag':
        push(FLAG_PROBES);
        break;
      case 'color':
        push(COLOR_PROBES);
        break;
      case 'size':
        push(SIZE_PROBES[spec.type] || SIZE_PROBES.in_px);
        break;
      case 'json': {
        const base = parseJsonObject(current[field]);
        for (const key of spec.jsonFields || []) {
          const kind = jsonKeyKind(key);
          if (!kind) {
            skipped.push({ field, key, ...CALIBRATION_REASONS.jsonKeyUntyped(key) });
            continue;
          }
          const curKey = String(base[key] ?? '');
          for (const v of kind.values) if (v !== curKey) variants.push({ field, key, value: JSON.stringify({ ...base, [key]: v }), keyValue: v });
        }
        break;
      }
      default:
        skipped.push({ field, ...CALIBRATION_REASONS.unknownType(spec.type) });
    }
  }
  log.debug('probeVariants', 'variants', { variants: variants.length, skipped: skipped.length });
  return { variants, skipped };
}

const TEXT_FIELD_RE = /^(b?title|b?descr|subtitle|text)\d*$/;
const BUTTON_TITLE_RE = /^buttontitle\d*$/;
const BUTTON_LINK_RE = /^buttonlink\d*$/;
const SKIP_CONTENT = new Set(['id', 'recordid', 'pageid', 'tplid', 'projectid', 'slideqty', 'formactiontype', 'off']);

/**
 * Содержимое для калибровки: значения свежего блока из каталога плюс заглушки для пустых текстов и
 * кнопок — без текста кнопки `button_styles` не меняет разметку.
 * @param {{ defaults?: object, tplFields?: string[], cardKeys?: string[] }} entry  запись каталога
 */
export function sampleContent(entry = {}) {
  const out = {};
  for (const [k, v] of Object.entries(entry.defaults || {})) if (!SKIP_CONTENT.has(k)) out[k] = String(v ?? '');
  for (const name of entry.tplFields || []) {
    if (out[name]) continue;
    if (TEXT_FIELD_RE.test(name)) out[name] = 'Sample';
    else if (BUTTON_TITLE_RE.test(name)) out[name] = 'Button';
    else if (BUTTON_LINK_RE.test(name)) out[name] = '#';
  }
  if (out.list) {
    let cards;
    try {
      cards = JSON.parse(out.list);
    } catch {
      cards = null;
    }
    if (Array.isArray(cards)) {
      const keys = entry.cardKeys || [];
      out.list = JSON.stringify(
        cards.map((c) => {
          const card = { ...c };
          for (const k of keys) {
            if (card[k]) continue;
            if (k === 'li_buttontitle') card[k] = 'Button';
            else if (/link$/.test(k)) card[k] = '#';
            else if (/^li_(title|descr|text)$/.test(k)) card[k] = 'Sample';
          }
          return card;
        }),
      );
    }
  }
  log.debug('sampleContent', 'sample content', { fields: Object.keys(out).length, list: Boolean(out.list) });
  return out;
}

/** Числовая часть и единица значения: `337px` → [337, 'px']; `1.37` → [1.37, '']. */
function numberOf(value) {
  const m = String(value).match(/^(-?\d+(?:\.\d+)?)([a-z%]*)$/i);
  return m ? [Number(m[1]), m[2]] : null;
}

/** Кандидаты правила `slot` из признака: позиции токенов, кодирующих значение. */
function slotCandidates(feature, value) {
  const { shape, tokens } = shapeOf(feature);
  const out = [];
  const v = String(value).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) {
    tokens.forEach((t, i) => {
      if (t === v) out.push({ shape, slot: i, encoding: 'hex' });
    });
    const rgb = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      if (Number(tokens[i]) === rgb[0] && Number(tokens[i + 1]) === rgb[1] && Number(tokens[i + 2]) === rgb[2]) out.push({ shape, slot: i, encoding: 'rgb' });
    }
    return out;
  }
  const num = numberOf(v);
  if (num) {
    tokens.forEach((t, i) => {
      if (!t.startsWith('#') && Number(t) === num[0]) out.push({ shape, slot: i, encoding: 'number', unit: num[1] });
    });
  }
  return out;
}

const candidateKey = (c) => `${c.encoding}|${c.slot}|${c.unit ?? ''}|${c.shape}`;

/** Правило `slot`/`text` по наблюдениям: кандидат, повторившийся в наибольшем числе проб. */
function valueRule(kind, obs, B) {
  const counts = new Map();
  for (const o of obs) {
    const { added } = diffFeatures(B, o.features);
    const seen = new Set();
    for (const f of added) {
      let cands;
      if (kind === 'text') {
        const v = String(o.keyValue ?? o.value);
        cands = v && f.includes(v) ? [{ type: 'text', shape: f.split(v).join('§t') }] : [];
      } else {
        cands = slotCandidates(f, o.keyValue ?? o.value).map((c) => ({ type: 'slot', ...c }));
      }
      for (const c of cands) {
        const key = c.type === 'text' ? `text|${c.shape}` : candidateKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = counts.get(key) || { rule: c, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
  }
  if (!counts.size) return null;
  const max = Math.max(...[...counts.values()].map((e) => e.count));
  const best = [...counts.entries()].filter(([, e]) => e.count === max).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e.rule);
  const [primary, ...also] = best;
  const rule = { ...primary, confirmed: max >= 2 || obs.length < 2 };
  if (also.length) rule.also = also;
  return rule;
}

/** Правило `enum` по наблюдениям: сигнатура каждого значения — изменчивые признаки, присутствующие при нём. */
function enumRule(obs, B, baseValue, V) {
  const cases = [{ value: String(baseValue ?? ''), signature: B.filter((f) => V.has(f)).sort() }];
  for (const o of obs) {
    const value = String(o.keyValue ?? o.value);
    if (cases.some((c) => c.value === value)) continue;
    cases.push({ value, signature: o.features.filter((f) => V.has(f)).sort() });
  }
  const distinct = new Set(cases.map((c) => c.signature.join('\n')));
  if (distinct.size < 2) return null;
  return { type: 'enum', cases };
}

/**
 * Карта влияния шаблона.
 * @param {{ tplid: string, schema: object, baseFeatures: string[], observations: Array<{field, key?, value, keyValue?, features}>,
 *           current?: Record<string,string>, noiseFeatures?: string[], failed?: Array<{field, key?, error}>, now?: string }} input
 */
export function buildSettingsMap({ tplid, schema, baseFeatures = [], observations = [], current = {}, noiseFeatures = [], failed = [], skipped: preSkipped = [], now } = {}) {
  const noise = new Set(noiseFeatures);
  const B = baseFeatures.filter((f) => !noise.has(f));
  const fields = {};
  const skipped = [...preSkipped];
  for (const f of failed) skipped.push({ field: f.field, ...(f.key ? { key: f.key } : {}), ...CALIBRATION_REASONS.previewFailed(f.error) });
  const groups = new Map();
  for (const o of observations) {
    const id = o.key ? `${o.field}\u0000${o.key}` : o.field;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ ...o, features: o.features.filter((f) => !noise.has(f)) });
  }
  const stats = { enum: 0, slot: 0, text: 0 };
  for (const [id, obs] of groups) {
    const [field, key] = id.split('\u0000');
    const spec = schema?.fields?.[field] || {};
    const kind = key ? jsonKeyKind(key)?.kind : spec.kind;
    const V = new Set();
    for (const o of obs) {
      const d = diffFeatures(B, o.features);
      d.added.forEach((f) => V.add(f));
      d.removed.forEach((f) => V.add(f));
    }
    const miss = () => skipped.push({ field, ...(key ? { key } : {}), ...CALIBRATION_REASONS.noSignal });
    if (!V.size) {
      miss();
      continue;
    }
    let rule = null;
    if (kind === 'enum' || kind === 'flag') {
      const baseValue = key ? parseJsonObject(current[field])[key] : current[field];
      rule = enumRule(obs, B, baseValue ?? '', V);
    } else if (kind === 'color' || kind === 'size' || kind === 'text') {
      rule = valueRule(kind, obs, B);
    }
    if (!rule) {
      miss();
      continue;
    }
    stats[rule.type] += 1;
    log.debug('buildSettingsMap', 'field', { field, key, kind, rule: rule.type, cases: rule.cases?.length });
    if (key) {
      fields[field] = fields[field] || { kind: 'json', keys: {} };
      fields[field].keys[key] = { kind, rule };
    } else {
      fields[field] = { kind, rule };
    }
  }
  log.info('buildSettingsMap', 'settings map built', { tplid, fields: Object.keys(fields).length, ...stats, skipped: skipped.length });
  return { tplid: String(tplid), version: MAP_VERSION, calibratedAt: now || new Date().toISOString(), baseFeatures: B, fields, skipped };
}
