/**
 * Поблочная сверка разметки собранной страницы с референсом: блоки выравниваются по порядку шаблонов, каждая пара сравнивается по
 * признакам разметки (`lib/markup-features.mjs`), расхождения получают причины, доклад — Markdown
 * «совпало / не совпало / причина». В доклад попадают только метки и `tplid` — без адресов,
 * доменов и `recordid`.
 *
 * Чистые функции без сети и файловой системы.
 */
import { createLogger } from './log.mjs';
import { diffFeatures, shapeOf } from './markup-features.mjs';

const log = createLogger('block-compare');

export const COMPARE_REASONS = {
  valueDiffers: 'значение настройки отличается',
  undecided: (f) => `настройка ${f} не распознана картой`,
  substituted: (a, b) => `шаблон ${a} заменён на ${b}`,
  noMap: 'шаблон не откалиброван',
  markupDiffers: 'разметка отличается — возможно, версия шаблона',
  notBuilt: 'блок не собран',
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
  log.debug('alignBlocks', 'выравнивание', { ref: n, built: m, pairs: pairs.length, refOnly: refOnly.length, builtOnly: builtOnly.length });
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
  const add = (reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  if (refOnly.length) {
    if (substituted) add(COMPARE_REASONS.substituted(substituted.from, substituted.to));
    else if (!map) add(COMPARE_REASONS.noMap);
    const builtShapes = new Set(builtOnly.map((f) => shapeOf(f).shape));
    for (const f of refOnly) {
      if (substituted || !map) continue;
      if (builtShapes.has(shapeOf(f).shape)) {
        add(COMPARE_REASONS.valueDiffers);
        continue;
      }
      const field = fieldOfFeature(f, map);
      add(field ? COMPARE_REASONS.undecided(field) : COMPARE_REASONS.markupDiffers);
    }
  }
  const reasons = [...counts.entries()].map(([r, c]) => (c > 1 ? `${r} ×${c}` : r));
  return { common, refOnly, builtOnly, score, reasons };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * Доклад сверки в Markdown.
 * @param {{ label: string, rows: Array<{order, tplid, common?, refOnly?, builtOnly?, score?, reasons?, notBuilt?: string}>, builtOnly?: object[], at?: string }} input
 */
export function renderCompareReport({ label, rows, builtOnly = [], at = '' }) {
  const paired = rows.filter((r) => !r.notBuilt);
  const mean = paired.length ? paired.reduce((s, r) => s + r.score, 0) / paired.length : 0;
  const lines = [
    `# Сверка разметки ${label}`,
    '',
    `${at ? `Снято: ${at}. ` : ''}Блоков референса: ${rows.length}, собрано в пару: ${paired.length}, не собрано: ${rows.length - paired.length}, лишних у сборки: ${builtOnly.length}. Средняя доля совпавших признаков: ${pct(mean)}.`,
    '',
    '| # | Шаблон | Совпало | Только у референса | Только у сборки | Причины |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    if (r.notBuilt) lines.push(`| ${r.order} | ${r.tplid} | — | — | — | ${cell(`${COMPARE_REASONS.notBuilt}${r.notBuilt === true ? '' : `: ${r.notBuilt}`}`)} |`);
    else lines.push(`| ${r.order} | ${r.tplid} | ${pct(r.score)} (${r.common}) | ${r.refOnly} | ${r.builtOnly} | ${cell(r.reasons.join('; ') || '—')} |`);
  }
  if (builtOnly.length) {
    lines.push('', `Лишние блоки сборки (шаблоны): ${builtOnly.map((b) => b.tplid).join(', ')}.`);
  }
  lines.push('', 'Причины «разметка отличается» и «настройка не распознана картой» — кандидаты на ручную проверку по снимкам 1440 и 320.', '');
  return lines.join('\n');
}
