/**
 * Поблочная сверка разметки собранной страницы с референсом: блоки выравниваются по порядку шаблонов, каждая пара сравнивается по
 * признакам разметки (`lib/markup-features.mjs`), расхождения получают причины, доклад — Markdown
 * «совпало / не совпало / причина». В доклад попадают только метки и `tplid` — без адресов,
 * доменов и `recordid`.
 *
 * Чистые функции без сети и файловой системы.
 */
import { createLogger } from './log.mjs';
import { t } from './i18n.mjs';
import { diffFeatures, shapeOf } from './markup-features.mjs';

const log = createLogger('block-compare');

/**
 * Причины расхождения: имя → английский текст (данные в JSON сверки). В докладе причина
 * переводится по ключу `report.compareReason.<имя>` на язык запуска; подстановки в словаре:
 * `undecided` {field}, `substituted` {from, to}.
 */
export const COMPARE_REASONS = {
  valueDiffers: 'the setting value differs',
  undecided: (f) => `setting ${f} is not recognized by the map`,
  substituted: (a, b) => `template ${a} is replaced by ${b}`,
  noMap: 'the template is not calibrated',
  markupDiffers: 'the markup differs, possibly a template version',
  notBuilt: 'the block is not built',
};

/**
 * Наибольшая общая подпоследовательность по `tplid` (у референса — после замен).
 * @returns {{ pairs: Array<{ref, built}>, refOnly: object[], builtOnly: object[] }}
 */
export function alignBlocks(refBlocks, builtBlocks, substitutes = {}) {
  const a = refBlocks.map((b) => String(substitutes[String(b.tplid)] ?? b.tplid));
  const b = builtBlocks.map((x) => String(x.tplid));
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  const refOnly = [];
  const builtOnly = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push({ ref: refBlocks[i], built: builtBlocks[j] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      refOnly.push(refBlocks[i]);
      i += 1;
    } else {
      builtOnly.push(builtBlocks[j]);
      j += 1;
    }
  }
  while (i < n) refOnly.push(refBlocks[i++]);
  while (j < m) builtOnly.push(builtBlocks[j++]);
  log.debug('alignBlocks', 'blocks aligned', { ref: n, built: m, pairs: pairs.length, refOnly: refOnly.length, builtOnly: builtOnly.length });
  return { pairs, refOnly, builtOnly };
}

/** Поле карты, чьё правило объясняет признак (форма слота/текста или признак сигнатуры варианта). */
function fieldOfFeature(f, map) {
  const shape = shapeOf(f).shape;
  const matches = (rule) => {
    if (!rule) return false;
    if (rule.type === 'slot') return [rule, ...(rule.also ?? [])].some((c) => c.shape === shape);
    if (rule.type === 'text') return new RegExp(`^${rule.shape.split('§t').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`).test(f);
    if (rule.type === 'enum') return rule.cases.some((c) => c.signature.includes(f) || c.signature.some((g) => shapeOf(g).shape === shape));
    return false;
  };
  for (const [name, entry] of Object.entries(map?.fields ?? {})) {
    if (entry.kind === 'json') {
      for (const [key, k] of Object.entries(entry.keys ?? {})) if (matches(k.rule)) return `${name}.${key}`;
    } else if (matches(entry.rule)) return name;
  }
  return null;
}

/**
 * Сравнение пары блоков по признакам.
 * @param {{ features: string[] }} ref   блок структуры референса
 * @param {{ features: string[] }} built блок собранной страницы (признаки уже извлечены)
 * @param {{ map?: object|null, substituted?: {from, to}|null }} ctx
 */
export function compareBlock(ref, built, { map = null, substituted = null } = {}) {
  const refF = ref.features ?? [];
  const builtF = built.features ?? [];
  const { added: builtOnly, removed: refOnly } = diffFeatures(refF, builtF);
  const common = refF.length - refOnly.length;
  const score = common / Math.max(1, refF.length);
  const counts = new Map();
  // Причина — имя из COMPARE_REASONS и подстановки; одинаковые (имя и подстановки) считаются вместе.
  const add = (code, params = {}, text = COMPARE_REASONS[code]) => {
    const id = `${code}|${JSON.stringify(params)}`;
    const item = counts.get(id) ?? { code, params, text, count: 0 };
    item.count += 1;
    counts.set(id, item);
  };
  if (refOnly.length) {
    if (substituted) add('substituted', { from: substituted.from, to: substituted.to }, COMPARE_REASONS.substituted(substituted.from, substituted.to));
    else if (!map) add('noMap');
    const builtShapes = new Set(builtOnly.map((f) => shapeOf(f).shape));
    for (const f of refOnly) {
      if (substituted || !map) continue;
      if (builtShapes.has(shapeOf(f).shape)) {
        add('valueDiffers');
        continue;
      }
      const field = fieldOfFeature(f, map);
      if (field) add('undecided', { field }, COMPARE_REASONS.undecided(field));
      else add('markupDiffers');
    }
  }
  const items = [...counts.values()];
  const reasons = items.map((i) => (i.count > 1 ? `${i.text} ×${i.count}` : i.text));
  return {
    common, refOnly, builtOnly, score, reasons,
    reasonCodes: items.map((i) => i.code),
    reasonItems: items.map((i) => ({ code: i.code, params: i.params, count: i.count })),
  };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
const pct = (x) => `${Math.round(x * 100)}%`;

/** Причина строки на языке доклада: по `reasonItems`, а строка без них — как записана. */
function rowReasons(row, lang) {
  if (!Array.isArray(row.reasonItems)) return row.reasons ?? [];
  return row.reasonItems.map((i) => {
    const text = t(lang, 'report.compareReason.' + i.code, i.params);
    return i.count > 1 ? `${text} ×${i.count}` : text;
  });
}

/**
 * Доклад сверки в Markdown на языке `lang`.
 * @param {{ label: string, rows: Array<{order, tplid, common?, refOnly?, builtOnly?, score?, reasons?, reasonItems?, notBuilt?: string}>, builtOnly?: object[], at?: string, lang?: string }} input
 */
export function renderCompareReport({ label, rows, builtOnly = [], at = '', lang = 'en' }) {
  const paired = rows.filter((r) => !r.notBuilt);
  const mean = paired.length ? paired.reduce((s, r) => s + r.score, 0) / paired.length : 0;
  const lines = [
    t(lang, 'report.compare.title', { label }),
    '',
    ...(at ? [t(lang, 'report.takenAt', { at }), `<!-- taken-at: ${at} -->`, ''] : []),
    t(lang, 'report.compare.summary', { blocks: rows.length, paired: paired.length, notBuilt: rows.length - paired.length, extra: builtOnly.length, mean: pct(mean) }),
    '',
    t(lang, 'report.compare.tableHead'),
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    if (r.notBuilt) lines.push(`| ${r.order} | ${r.tplid} | — | — | — | ${cell(`${t(lang, 'report.compareReason.notBuilt')}${r.notBuilt === true ? '' : `: ${r.notBuilt}`}`)} |`);
    else lines.push(`| ${r.order} | ${r.tplid} | ${pct(r.score)} (${r.common}) | ${r.refOnly} | ${r.builtOnly} | ${cell(rowReasons(r, lang).join('; ') || '—')} |`);
  }
  if (builtOnly.length) {
    lines.push('', t(lang, 'report.compare.builtOnly', { tplids: builtOnly.map((b) => b.tplid).join(', ') }));
  }
  lines.push('', t(lang, 'report.compare.candidates'), '');
  return lines.join('\n');
}
