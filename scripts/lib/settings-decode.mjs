/**
 * Разбор значений полей «Настроек» по признакам опубликованного блока и карте влияния шаблона.
 * Карта снята `catalog calibrate`
 * (`lib/settings-calibration.mjs`): для каждого поля — правило `slot`, `text` или `enum`.
 *
 *   `slot`  — признак референса той же формы (`shapeOf`) → токен в позиции `slot` → значение
 *             (`hex` как есть, `rgb` — три токена в `#rrggbb`, `number` — число + единица);
 *   `text`  — признак, совпадающий с формой, где `§t` — любая подстрока без `;{}`;
 *   `enum`  — вариант, большая часть сигнатуры которого найдена у референса (доля ≥ 0.5,
 *             единственный лучший; пустая сигнатура — только если у остальных доля 0).
 * Форма признака есть в базе карты, но нет у референса → значение `''` (у референса поле пусто).
 *
 * Чистая функция, без сети и файловой системы.
 */
import { createLogger } from './log.mjs';
import { shapeOf } from './markup-features.mjs';

const log = createLogger('settings-decode');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function indexByShape(features) {
  const index = new Map();
  for (const f of features) {
    const { shape, tokens } = shapeOf(f);
    if (!index.has(shape)) index.set(shape, []);
    index.get(shape).push({ feature: f, tokens });
  }
  return index;
}

function decodeToken(rule, tokens) {
  const t = tokens[rule.slot];
  if (t === undefined) return null;
  if (rule.encoding === 'hex') return t;
  if (rule.encoding === 'rgb') {
    const rgb = tokens.slice(rule.slot, rule.slot + 3).map(Number);
    if (rgb.length !== 3 || rgb.some((n) => !Number.isFinite(n))) return null;
    return `#${rgb.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
  }
  if (rule.encoding === 'number') return `${t}${rule.unit ?? ''}`;
  return null;
}

/** Значение по правилу `slot`/`text`: `{ value, used }`, `{ value: '' }` или `{ undecided: 'absent' }`. */
function decodeValueRule(rule, ctx) {
  if (rule.type === 'slot') {
    for (const cand of [rule, ...(rule.also || [])]) {
      const hits = ctx.ref.get(cand.shape);
      if (!hits) continue;
      const values = [...new Set(hits.map((h) => decodeToken(cand, h.tokens)).filter((v) => v !== null))].sort();
      if (values.length) return { value: values[0], used: hits.map((h) => h.feature) };
    }
    if ([rule, ...(rule.also || [])].some((c) => ctx.base.has(c.shape))) return { value: '' };
    return { undecided: 'absent' };
  }
  if (rule.type === 'text') {
    const re = new RegExp(`^${rule.shape.split('§t').map(escapeRe).join('([^;{}]+?)')}$`);
    for (const f of ctx.features) {
      const m = f.match(re);
      if (m) return { value: m[1].replace(/^['"]|['"]$/g, ''), used: [f] };
    }
    if (ctx.baseFeatures.some((f) => re.test(f))) return { value: '' };
    return { undecided: 'absent' };
  }
  return { undecided: 'absent' };
}

/** Позиции токенов, которые меняются между признаками одной формы в сигнатурах вариантов. */
function varyingSlots(rule) {
  const byShape = new Map();
  for (const c of rule.cases) {
    for (const f of c.signature) {
      const { shape, tokens } = shapeOf(f);
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape).push(tokens);
    }
  }
  const slots = new Map();
  for (const [shape, list] of byShape) {
    const pos = [];
    const len = Math.max(...list.map((t) => t.length));
    for (let i = 0; i < len; i += 1) if (new Set(list.map((t) => t[i])).size > 1) pos.push(i);
    slots.set(shape, pos);
  }
  return slots;
}

/** Найден ли признак сигнатуры у референса: целиком или той же формы с теми же токенами в изменчивых позициях. */
function signatureHit(f, ctx, slots) {
  if (ctx.refSet.has(f)) return f;
  const { shape, tokens } = shapeOf(f);
  const pos = slots.get(shape);
  if (!pos || !pos.length) return null;
  const hit = (ctx.ref.get(shape) || []).find((h) => pos.every((i) => h.tokens[i] === tokens[i]));
  return hit ? hit.feature : null;
}

function decodeEnumRule(rule, ctx) {
  const slots = varyingSlots(rule);
  const scored = rule.cases.map((c) => {
    const hits = c.signature.map((f) => signatureHit(f, ctx, slots)).filter(Boolean);
    return { value: c.value, empty: c.signature.length === 0, score: c.signature.length ? hits.length / c.signature.length : 0, used: hits };
  });
  const nonEmpty = scored.filter((s) => !s.empty);
  const best = Math.max(0, ...nonEmpty.map((s) => s.score));
  if (best === 0) {
    const empty = scored.filter((s) => s.empty);
    if (empty.length === 1) return { value: empty[0].value, used: [] };
    return { undecided: 'ambiguous' };
  }
  const winners = nonEmpty.filter((s) => s.score === best);
  if (best < 0.5 || winners.length !== 1) return { undecided: 'ambiguous' };
  return { value: winners[0].value, used: winners[0].used };
}

function decodeRule(rule, ctx) {
  if (!rule) return { undecided: 'absent' };
  return rule.type === 'enum' ? decodeEnumRule(rule, ctx) : decodeValueRule(rule, ctx);
}

function parseObject(s) {
  try {
    const o = JSON.parse(String(s || '{}'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

const canonical = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/**
 * @param {string[]} features  признаки блока референса (`extractFeatures`)
 * @param {object} map  карта влияния (`<tplid>.settings.json`)
 * @param {Record<string,string>} defaults  значения свежего блока из каталога
 * @returns {{ values: Record<string,string>, undecided: Array<{field, key?, reason}>, unexplained: string[] }}
 */
export function decodeSettings(features = [], map = {}, defaults = {}) {
  const baseFeatures = map.baseFeatures || [];
  const ctx = {
    features,
    refSet: new Set(features),
    ref: indexByShape(features),
    baseFeatures,
    base: new Set(baseFeatures.map((f) => shapeOf(f).shape)),
  };
  const values = {};
  const undecided = [];
  const used = new Set();
  for (const [field, entry] of Object.entries(map.fields || {})) {
    if (entry.kind === 'json') {
      const obj = parseObject(defaults[field]);
      let decided = 0;
      for (const [key, k] of Object.entries(entry.keys || {})) {
        const r = decodeRule(k.rule, ctx);
        if (r.undecided) {
          undecided.push({ field, key, reason: r.undecided });
          continue;
        }
        (r.used || []).forEach((f) => used.add(f));
        decided += 1;
        if (r.value === '') delete obj[key];
        else obj[key] = r.value;
      }
      if (decided && canonical(obj) !== canonical(parseObject(defaults[field]))) values[field] = JSON.stringify(obj);
      continue;
    }
    const r = decodeRule(entry.rule, ctx);
    if (r.undecided) {
      undecided.push({ field, reason: r.undecided });
      continue;
    }
    (r.used || []).forEach((f) => used.add(f));
    if (String(r.value) !== String(defaults[field] ?? '')) values[field] = String(r.value);
  }
  const baseSet = new Set(baseFeatures);
  const unexplained = features.filter((f) => !baseSet.has(f) && !used.has(f));
  log.debug('decodeSettings', 'settings decoded', { decided: Object.keys(values).length, undecided: undecided.length, unexplained: unexplained.length });
  return { values, undecided, unexplained };
}
