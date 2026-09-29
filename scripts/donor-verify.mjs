/**
 * Сверка перенесённой страницы (`donor verify`): состав
 * блоков приёмника против структуры слепка, поблочная сверка разметки (`reference compare`),
 * кадры сборки и референса на одних ширинах, высоты — и доклад `reports/<метка>.transfer.md`
 * с колонками «совпало / не совпало / причина» и пустым разделом «Вердикт агента» (агент
 * заполняет его после осмотра кадров; владелец подтверждает вывод, а не сверяет кадры).
 *
 * Две части: `collectTransferData` работает внутри сессии редактора тестового проекта;
 * `finishTransferReport` пишет файлы после того, как кадр референса снят своей сессией
 * (`shotReference` открывает держатель сам — внутри `withEditor` он занят lock-ом команды).
 * Драйвер приходит снаружи — `lib/browser.mjs` не импортируется.
 *
 * HTML-блоки — проба 2026-09-24 на перенесённых страницах: код блока шаблона 131 лежит
 * в поле записи `code` снимка (`readRecordSnapshot`), HTML экранирован (`&lt;script …`); у пустого
 * блока поля `code` в снимке нет — на публикации он показывает заглушку Tilda «Html code will be here».
 * Предпросмотр (`pageRawHtml`) вместо кода отдаёт заглушку «Код будет выполнен на опубликованной
 * странице», поэтому источник — снимок записи, а не HTML предпросмотра. Перечень блоков — сведения
 * для вердикта и владельца, код выхода сверки он не меняет.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { readSite, refPaths } from './lib/reference-store.mjs';
import { compareReferencePage } from './reference-compare.mjs';
import { prepareReferencePlan } from './reference-plan.mjs';
import { readDonorStyle } from './donor-style.mjs';
import { decodeEntities } from './lib/entities.mjs';

const log = createLogger('donor-verify');

/** Шаблоны, код которых пишет владелец сайта (проба: 131 — «HTML-код»). */
export const HTML_BLOCK_TPLIDS = ['131'];
const PLACEHOLDER_RE = /Html code will be here/i;
const EXTERNAL_HOST_RE = /\b(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\/([^/"'\s>?#]+)/gi;

/**
 * Перечень HTML-блоков. Чистая: `source` — `[{ recordid, tplid, code, hidden }]` (код как в снимке,
 * экранированный или нет). Итог — `[{ recordid, tplid, hidden, empty, placeholder, hosts, iframes, scripts, forms }]`;
 * `placeholder` — посетитель увидит заглушку Tilda (пустой код или её текст), `hosts` — внешние хосты
 * из src/href/action.
 */
export function listHtmlBlocks(source) {
  return (source ?? [])
    .filter((b) => HTML_BLOCK_TPLIDS.includes(String(b.tplid)))
    .map((b) => {
      const code = decodeEntities(String(b.code ?? ''));
      const empty = !code.trim();
      const hosts = [...new Set([...code.matchAll(EXTERNAL_HOST_RE)].map((m) => m[1].toLowerCase()))];
      const count = (re) => (code.match(re) || []).length;
      return {
        recordid: String(b.recordid),
        tplid: String(b.tplid),
        hidden: b.hidden === true || b.hidden === 'y',
        empty,
        placeholder: empty || PLACEHOLDER_RE.test(code),
        hosts,
        iframes: count(/<iframe\b/gi),
        scripts: count(/<script\b/gi),
        forms: count(/<form\b/gi),
      };
    });
}

/** Строки раздела «HTML-блоки» доклада. */
function renderHtmlBlocks(blocks) {
  if (!blocks) return ['Перечень не собирался.'];
  if (!blocks.length) return ['HTML-блоков нет.'];
  const state = (b) => [
    b.hidden ? 'скрыт' : null,
    b.empty ? 'пустой — на публикации заглушка «Html code will be here»' : b.placeholder ? 'в коде заглушка «Html code will be here»' : 'есть код',
  ].filter(Boolean).join('; ');
  return [
    `Блоков: ${blocks.length}; с заглушкой: ${blocks.filter((b) => b.placeholder).length}; с внешними хостами: ${blocks.filter((b) => b.hosts.length).length}. Предпросмотр код не выполняет — проверять на публикации.`,
    '',
    '| Блок | Состояние | Внешние хосты | iframe / script / form |',
    '| --- | --- | --- | --- |',
    ...blocks.map((b) => `| ${b.recordid} | ${state(b)} | ${b.hosts.join(', ') || '—'} | ${b.iframes} / ${b.scripts} / ${b.forms} |`),
  ];
}

/** Известные ложные отличия предпросмотра от публикации. */
export const PREVIEW_ARTIFACTS = [
  'ссылки tel: в предпросмотре отдаются как href="#" цветом ссылок проекта — на публикации tel: чёрным',
  'текст кнопки формы в предпросмотре может переноситься на две строки против одной с многоточием на публикации (причина не проверена)',
  'шапка и подвал на кадре сборки — страницы HDR/FTR тестового проекта, на кадре референса — донорские',
];

/** Ожидаемая последовательность tplid зоны метки из структуры слепка с учётом substitutes. */
export function expectedTplids(structureBlocks, zone, substitutes = {}) {
  return (structureBlocks ?? [])
    .filter((b) => zone === 'all' || (b.zone ?? 'content') === zone)
    .map((b) => String(substitutes[String(b.tplid)] ?? b.tplid));
}

/** Сравнение последовательностей tplid: { equal, expected, actual, missing, extra, reasons }. */
export function compareTplidSequence(expected, actual) {
  const exp = (expected ?? []).map(String);
  const act = (actual ?? []).map(String);
  const count = (list) => list.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map());
  const ce = count(exp);
  const ca = count(act);
  const missing = [];
  const extra = [];
  const seenMissing = new Map();
  exp.forEach((tplid, index) => {
    const left = (ce.get(tplid) ?? 0) - (ca.get(tplid) ?? 0);
    const used = seenMissing.get(tplid) ?? 0;
    if (left > used) {
      missing.push({ index, tplid });
      seenMissing.set(tplid, used + 1);
    }
  });
  const seenExtra = new Map();
  act.forEach((tplid, index) => {
    const left = (ca.get(tplid) ?? 0) - (ce.get(tplid) ?? 0);
    const used = seenExtra.get(tplid) ?? 0;
    if (left > used) {
      extra.push({ index, tplid });
      seenExtra.set(tplid, used + 1);
    }
  });
  const reasons = [
    ...missing.map((m) => `блок ${m.tplid} отсутствует на позиции ${m.index + 1}`),
    ...extra.map((e) => `лишний блок ${e.tplid} на позиции ${e.index + 1}`),
  ];
  const sameSet = missing.length === 0 && extra.length === 0;
  let equal = sameSet;
  if (sameSet) {
    const first = exp.findIndex((t, i) => t !== act[i]);
    if (first >= 0) {
      equal = false;
      reasons.push(`порядок отличается начиная с позиции ${first + 1}`);
    }
  }
  return { equal, expected: exp, actual: act, missing, extra, reasons };
}

const rel = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^.*?(site-baseline\/|site-reference\/)/, '$1');
const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

const VERDICT_HEADING = '## Вердикт агента';
const VERDICT_TEMPLATE = 'Заполняется после осмотра кадров сборки и референса на каждой ширине.';
const VERDICT_CARRIED = 'Вердикт перенесён из доклада от';

/**
 * Раздел «Вердикт агента» прежнего доклада. Чистая: `{ text, filled }` — текст раздела до
 * следующего `## ` без прежних пометок о переносе; `filled` — в таблице есть строка с непустой ячейкой
 * «Совпало» или «Не совпало», либо абзац раздела не шаблонный. Раздела нет → `{ text: '', filled: false }`.
 */
export function extractVerdict(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === VERDICT_HEADING);
  if (start < 0) return { text: '', filled: false };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const body = (end < 0 ? rest : rest.slice(0, end)).filter((l) => !l.startsWith(VERDICT_CARRIED));
  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const rows = body.filter((l) => l.trim().startsWith('|') && !/^\|\s*(?:Ширина|-{3})/.test(l.trim()));
  const tableFilled = rows.some((l) => {
    const cells = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    return Boolean(cells[1] || cells[2]);
  });
  const prose = body.map((l) => l.trim()).filter((l) => l && !l.startsWith('|'));
  const proseFilled = prose.some((l) => l !== VERDICT_TEMPLATE);
  return { text, filled: tableFilled || proseFilled };
}

/** Строка «Снято: …» доклада → время съёмки или null. */
function reportTakenAt(md) {
  return String(md ?? '').match(/^Снято: (\S+?)\.?\s/m)?.[1] ?? null;
}

/** Markdown-доклад сверки перенесённой страницы. */
export function renderTransferReport(data) {
  const { label, at, composition, markup, heights = [], shots = {}, artifacts = PREVIEW_ARTIFACTS, styleSkipped = [], referenceNote, htmlBlocks, previousVerdict } = data;
  const rows = [
    ['состав блоков', composition.equal ? 'совпало' : 'не совпало', `${composition.equal ? `${composition.expected.length} блоков в том же порядке` : composition.reasons.join('; ')}${composition.hidden ? `; скрытых блоков на приёмнике ${composition.hidden} (на публикации не видны)` : ''}`],
    ['разметка (reference compare)', markup ? `${pct(markup.meanScore)} признаков` : '—', markup ? `в паре ${markup.pairs}, не собрано ${markup.refOnly}, лишних ${markup.builtOnly}; доклад ${rel(markup.report)}` : 'сверка разметки не выполнена'],
  ];
  for (const h of heights) {
    const same = h.built != null && h.reference != null && h.built === h.reference;
    rows.push([`высота ${h.width}`, h.reference == null ? 'справочно' : same ? 'совпало' : 'отличается', `сборка ${h.built ?? '—'} px, референс ${h.reference ?? '—'} px${h.reference == null ? ` (${referenceNote ?? 'кадр референса не снимался'})` : ''}`]);
  }
  rows.push(['кадры', shots.built?.length ? 'сняты' : 'нет', `сборка: ${(shots.built ?? []).map(rel).join(', ') || '—'}; референс: ${shots.reference ? rel(shots.reference) : (referenceNote ?? 'не снимался')}`]);
  if (styleSkipped.length) rows.push(['не перенесено: настройки проекта', 'пропущено', `${styleSkipped.map((s) => s.key).join(', ')} — ${[...new Set(styleSkipped.map((s) => s.reason))].join('; ')}`]);
  const lines = [
    `# Сверка переноса ${label}`,
    '',
    `Снято: ${at}. Машинная часть приёмки; вердикт по кадрам даёт агент, владелец подтверждает вывод.`,
    '',
    '| Проверка | Итог | Причина |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${String(r[2]).replace(/\|/g, '\\|')} |`),
    '',
    '## Известные артефакты предпросмотра',
    '',
    ...artifacts.map((a) => `- ${a}`),
    '',
    '## HTML-блоки',
    '',
    ...renderHtmlBlocks(htmlBlocks),
    '',
    VERDICT_HEADING,
    '',
    // Повторная сверка — обычный шаг (после donor links, после исправлений): заполненный вердикт
    // переносится с пометкой, агент перепроверяет его по новым кадрам.
    ...(previousVerdict?.filled
      ? [
        previousVerdict.text,
        '',
        `${VERDICT_CARRIED} ${previousVerdict.at ?? 'неизвестной даты'}; кадры сняты заново ${at} — перепроверить, если состав или высоты изменились.`,
        '',
      ]
      : [
        VERDICT_TEMPLATE,
        '',
        '| Ширина | Совпало | Не совпало | Причина |',
        '| --- | --- | --- | --- |',
        ...heights.map((h) => `| ${h.width} | | | |`),
        '',
      ]),
  ];
  return lines.join('\n');
}

/**
 * Внутри сессии редактора приёмника: сверка разметки, состав, кадры сборки.
 * driver: { listRecords(), pageRawHtml(), shot({ widths }), readRecord(recordid)? } — readRecord даёт снимок записи для HTML-блоков.
 */
export async function collectTransferData(driver, { slug, label, pageid, widths, baseDir, catalogDir, now = new Date().toISOString() }) {
  // Замены шаблонов из site.json относятся к сборке по референсу; перенос через буфер несёт
  // исходные шаблоны донора — замены нейтрализуются тождественными парами.
  const site = readSite(slug, baseDir ? { baseDir } : undefined);
  const identity = Object.fromEntries(Object.keys(site?.substitutes ?? {}).map((k) => [k, k]));
  const { resolved, structure } = prepareReferencePlan({ slug, source: label, baseDir, catalogDir, substitutes: identity });
  const cmp = await compareReferencePage(driver, { slug, label, baseDir, catalogDir, substitutes: identity, now });
  // Структура слепка снята с публикации — скрытых блоков (off=y) там нет; в редактор они переносятся как есть.
  const records = await driver.listRecords();
  const hiddenCount = records.filter((r) => r.hidden === true || r.hidden === 'y').length;
  const actual = records.filter((r) => !(r.hidden === true || r.hidden === 'y')).map((r) => String(r.tplid));
  const composition = { ...compareTplidSequence(expectedTplids(structure.blocks, resolved.zone, {}), actual), hidden: hiddenCount };
  // Код HTML-блоков — из снимков записей (предпросмотр отдаёт заглушку); драйвер без readRecord — перечень не собирается.
  let htmlBlocks = null;
  if (typeof driver.readRecord === 'function') {
    const source = [];
    for (const r of records.filter((x) => HTML_BLOCK_TPLIDS.includes(String(x.tplid)))) {
      const snap = await driver.readRecord(String(r.recordid));
      const rec = snap?.record ?? snap ?? {};
      source.push({ recordid: r.recordid, tplid: r.tplid, hidden: r.hidden, code: rec.code });
    }
    htmlBlocks = listHtmlBlocks(source);
    log.info('collectTransferData', 'HTML-блоки', { label, blocks: htmlBlocks.length, placeholder: htmlBlocks.filter((b) => b.placeholder).length, external: htmlBlocks.filter((b) => b.hosts.length).length });
    log.debug('collectTransferData', 'внешние хосты HTML-блоков', { label, hosts: [...new Set(htmlBlocks.flatMap((b) => b.hosts))] });
  }
  const built = await driver.shot({ widths });
  log.info('collectTransferData', 'состав и кадры сборки', { label, equal: composition.equal, meanScore: Math.round(cmp.meanScore * 100) / 100, files: built.files.length });
  return {
    at: now, label, pageid: String(pageid), zone: resolved.zone,
    composition,
    htmlBlocks,
    markup: { meanScore: cmp.meanScore, pairs: cmp.pairs, refOnly: cmp.refOnly, builtOnly: cmp.builtOnly, report: cmp.report, path: cmp.path },
    built: { widths: built.widths.map((w) => ({ width: w.width, height: w.height, records: w.records, files: w.files.map(rel) })), files: built.files.map(rel) },
    widths,
  };
}

/** Кадр референса снят (или нет) — доклад и данные пишутся в слепок. */
export function finishTransferReport(data, referenceShots, { slug, baseDir, referenceNote } = {}) {
  const style = readDonorStyle(slug, baseDir ? { baseDir } : undefined);
  const styleSkipped = Array.isArray(style?.skipped) ? style.skipped : [];
  const refWidths = referenceShots?.widths ?? [];
  const heights = data.widths.map((w) => ({
    width: w,
    built: data.built.widths.find((x) => x.width === w)?.height ?? null,
    reference: refWidths.find((x) => x.width === w)?.height ?? null,
  }));
  const full = {
    ...data,
    heights,
    shots: { built: data.built.files, reference: referenceShots ? rel(referenceShots.dir) : null },
    artifacts: PREVIEW_ARTIFACTS,
    styleSkipped,
    referenceNote: referenceShots ? null : referenceNote ?? null,
  };
  const root = refPaths(slug, baseDir ? { baseDir } : undefined).root;
  mkdirSync(join(root, 'transfer'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  const path = join(root, 'transfer', `${data.label}.json`);
  const report = join(root, 'reports', `${data.label}.transfer.md`);
  // Прежний доклад: заполненный вердикт агента не затирается повторной сверкой.
  let previousVerdict = null;
  if (existsSync(report)) {
    try {
      const prev = readFileSync(report, 'utf8');
      previousVerdict = { ...extractVerdict(prev), at: reportTakenAt(prev) };
    } catch (e) {
      log.warn('finishTransferReport', 'прежний доклад не прочитан — вердикт пишется пустым', { label: data.label, error: e.message });
    }
  }
  full.verdictCarried = Boolean(previousVerdict?.filled);
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
  writeFileSync(report, renderTransferReport({ ...full, previousVerdict }), 'utf8');
  const exitCode = data.composition.equal ? 0 : 1;
  log.info('finishTransferReport', 'доклад записан', { label: data.label, report: rel(report), equal: data.composition.equal, verdictCarried: full.verdictCarried, exitCode });
  return { ...full, path: rel(path), report: rel(report), exitCode };
}

/** Полный цикл, когда кадр референса уже снят (или не нужен): собрать данные и записать доклад. */
export async function verifyTransferredPage(driver, params) {
  const data = await collectTransferData(driver, params);
  return finishTransferReport(data, params.referenceShots ?? null, { slug: params.slug, baseDir: params.baseDir, referenceNote: params.referenceNote });
}
