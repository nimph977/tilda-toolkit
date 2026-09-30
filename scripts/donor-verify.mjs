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
import { STYLE_REASONS, readDonorStyle } from './donor-style.mjs';
import { decodeEntities } from './lib/entities.mjs';
import { LANGS, isMessage, messageText, msg, render, t } from './lib/i18n.mjs';

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

/** Строки раздела «HTML-блоки» доклада на языке `lang`. */
function renderHtmlBlocks(blocks, lang) {
  if (!blocks) return [t(lang, 'report.transfer.htmlNotCollected')];
  if (!blocks.length) return [t(lang, 'report.transfer.htmlNone')];
  const state = (b) => [
    b.hidden ? t(lang, 'report.transfer.htmlHidden') : null,
    t(lang, b.empty ? 'report.transfer.htmlEmpty' : b.placeholder ? 'report.transfer.htmlPlaceholder' : 'report.transfer.htmlHasCode'),
  ].filter(Boolean).join('; ');
  return [
    t(lang, 'report.transfer.htmlSummary', { total: blocks.length, placeholder: blocks.filter((b) => b.placeholder).length, hosts: blocks.filter((b) => b.hosts.length).length }),
    '',
    t(lang, 'report.transfer.htmlHead'),
    '| --- | --- | --- | --- |',
    ...blocks.map((b) => `| ${b.recordid} | ${state(b)} | ${b.hosts.join(', ') || '—'} | ${b.iframes} / ${b.scripts} / ${b.forms} |`),
  ];
}

/**
 * Известные ложные отличия предпросмотра от публикации: имя → ключ словаря. В данные слепка
 * (`transfer/<метка>.json`) пишутся имена, в доклад — текст на языке доклада.
 */
export const PREVIEW_ARTIFACT_KEYS = {
  telLink: 'report.transfer.artifactTelLink',
  buttonWrap: 'report.transfer.artifactButtonWrap',
  headerFooter: 'report.transfer.artifactHeaderFooter',
};
export const PREVIEW_ARTIFACTS = Object.keys(PREVIEW_ARTIFACT_KEYS);

/** Причины расхождения состава блоков: имя → ключ словаря. Подстановки: {tplid, position}, у `orderDiffers` {position}. */
export const SEQUENCE_REASONS = {
  missing: 'report.transfer.reasonMissing',
  extra: 'report.transfer.reasonExtra',
  orderDiffers: 'report.transfer.reasonOrderDiffers',
};

/** Причины расхождения состава как `Message` — для итога команды; состав без `reasonItems` даёт записанные строки. */
export function compositionReasons(composition) {
  if (!Array.isArray(composition?.reasonItems)) return composition?.reasons ?? [];
  return composition.reasonItems.map((i) => msg(SEQUENCE_REASONS[i.code], i.params));
}

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
  const reasonItems = [
    ...missing.map((m) => ({ code: 'missing', params: { tplid: m.tplid, position: m.index + 1 } })),
    ...extra.map((e) => ({ code: 'extra', params: { tplid: e.tplid, position: e.index + 1 } })),
  ];
  const sameSet = missing.length === 0 && extra.length === 0;
  let equal = sameSet;
  if (sameSet) {
    const first = exp.findIndex((tplid, i) => tplid !== act[i]);
    if (first >= 0) {
      equal = false;
      reasonItems.push({ code: 'orderDiffers', params: { position: first + 1 } });
    }
  }
  // `reasons` — английский текст для данных слепка, `reasonItems` — имя и подстановки для доклада.
  const reasons = reasonItems.map((i) => messageText(msg(SEQUENCE_REASONS[i.code], i.params)));
  return { equal, expected: exp, actual: act, missing, extra, reasons, reasonItems };
}

const rel = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^.*?(site-baseline\/|site-reference\/)/, '$1');
const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

/** Метки доклада, не зависящие от языка: по ним доклад читается при повторной сверке. */
const VERDICT_START = '<!-- verdict:start -->';
const VERDICT_END = '<!-- verdict:end -->';
const TABLE_WIDTHS = '<!-- table:widths -->';
const TAKEN_AT_RE = /<!-- taken-at: (\S+) -->/;

// Доклады до двуязычной версии: заголовок вердикта, шаблон, пометка о переносе, шапка таблицы
// и строка «Снято:» были русским текстом без меток. Старые доклады читаются по этим константам.
const LEGACY_VERDICT_HEADING = '## Вердикт агента';
const LEGACY_VERDICT_TEMPLATE = 'Заполняется после осмотра кадров сборки и референса на каждой ширине.';
const LEGACY_VERDICT_CARRIED = 'Вердикт перенесён из доклада от';
const LEGACY_TABLE_HEAD_RE = /^\|\s*Ширина/;
const LEGACY_TAKEN_AT_RE = /^Снято: (\S+?)\.?\s/m;

/** Текст ключа на каждом языке доклада: вердикт мог быть записан на другом языке, чем идёт нынешний запуск. */
const inEveryLang = (key) => LANGS.map((lang) => t(lang, key));

const isTableLine = (l) => l.trim().startsWith('|');
const isSeparatorLine = (l) => /^\|[\s:|-]+\|?$/.test(l.trim());

/**
 * Строки раздела вердикта: по меткам `verdict:start/end`, иначе по заголовку раздела (нынешнему
 * на любом языке или прежнему русскому). Раздела нет — `null`.
 */
function verdictBody(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const untilNextSection = (rest) => {
    const end = rest.findIndex((l) => l.startsWith('## '));
    return end < 0 ? rest : rest.slice(0, end);
  };
  const marked = lines.findIndex((l) => l.trim() === VERDICT_START);
  if (marked >= 0) {
    const rest = lines.slice(marked + 1);
    const end = rest.findIndex((l) => l.trim() === VERDICT_END);
    return end < 0 ? untilNextSection(rest) : rest.slice(0, end);
  }
  const headings = [LEGACY_VERDICT_HEADING, ...inEveryLang('report.transfer.verdictTitle')];
  const start = lines.findIndex((l) => headings.includes(l.trim()));
  if (start < 0) return null;
  return untilNextSection(lines.slice(start + 1)).filter((l) => !l.startsWith(LEGACY_VERDICT_CARRIED));
}

/** Есть ли в докладе раздел вердикта (по меткам или по заголовку). */
export function hasVerdictSection(md) {
  return verdictBody(md) !== null;
}

/**
 * Раздел «Вердикт агента» прежнего доклада. Чистая: `{ text, filled }` — текст раздела без прежних
 * пометок о переносе; `filled` — в таблице есть строка с непустой ячейкой «Совпало» или «Не совпало»,
 * либо абзац раздела не шаблонный (шаблон на любом языке). Раздела нет → `{ text: '', filled: false }`.
 */
export function extractVerdict(md) {
  const body = verdictBody(md);
  if (!body) return { text: '', filled: false };
  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Шапка и разделитель таблицы ширин — не строки данных: их находят по метке, по разделителю и по прежней шапке.
  const notData = new Set();
  body.forEach((l, i) => {
    if (l.trim() === TABLE_WIDTHS) {
      for (let j = i + 1, n = 0; j < body.length && n < 2 && isTableLine(body[j]); j += 1, n += 1) notData.add(j);
    }
    if (isSeparatorLine(l)) {
      notData.add(i);
      if (i > 0 && isTableLine(body[i - 1])) notData.add(i - 1);
    }
    if (LEGACY_TABLE_HEAD_RE.test(l.trim())) notData.add(i);
  });
  const rows = body.filter((l, i) => isTableLine(l) && !notData.has(i));
  const tableFilled = rows.some((l) => {
    const cells = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    return Boolean(cells[1] || cells[2]);
  });
  const templates = [LEGACY_VERDICT_TEMPLATE, ...inEveryLang('report.transfer.verdictTemplate')];
  const prose = body.map((l) => l.trim()).filter((l) => l && !l.startsWith('|') && !l.startsWith('<!--'));
  const proseFilled = prose.some((l) => !templates.includes(l));
  return { text, filled: tableFilled || proseFilled };
}

/** Время съёмки доклада: по метке `taken-at`, у прежнего доклада — по строке «Снято: …»; иначе null. */
function reportTakenAt(md) {
  const text = String(md ?? '');
  return text.match(TAKEN_AT_RE)?.[1] ?? text.match(LEGACY_TAKEN_AT_RE)?.[1] ?? null;
}

/** Причина пропуска настройки проекта на языке доклада: по имени, а у записи без имени — как записана. */
function styleReasonText(entry, lang) {
  return entry.code && STYLE_REASONS[entry.code] ? t(lang, STYLE_REASONS[entry.code]) : String(entry.reason ?? '');
}

/**
 * Markdown-доклад сверки перенесённой страницы на языке `lang` (по умолчанию английский).
 * Время съёмки пишется дважды: строкой для человека и меткой `taken-at`; вердикт окружён
 * метками `verdict:start/end`, таблица ширин — `table:widths`.
 */
export function renderTransferReport(data) {
  const { label, at, composition, markup, heights = [], shots = {}, artifacts = PREVIEW_ARTIFACTS, styleSkipped = [], referenceNote, htmlBlocks, previousVerdict, lang = 'en' } = data;
  const compositionText = Array.isArray(composition.reasonItems)
    ? composition.reasonItems.map((i) => t(lang, SEQUENCE_REASONS[i.code], i.params))
    : composition.reasons;
  const rows = [
    [t(lang, 'report.transfer.rowComposition'), t(lang, composition.equal ? 'report.transfer.equal' : 'report.transfer.notEqual'), `${composition.equal ? t(lang, 'report.transfer.compositionSame', { n: composition.expected.length }) : compositionText.join('; ')}${composition.hidden ? t(lang, 'report.transfer.compositionHidden', { n: composition.hidden }) : ''}`],
    [t(lang, 'report.transfer.rowMarkup'), markup ? t(lang, 'report.transfer.markupScore', { score: pct(markup.meanScore) }) : '—', markup ? t(lang, 'report.transfer.markupPairs', { pairs: markup.pairs, refOnly: markup.refOnly, builtOnly: markup.builtOnly, report: rel(markup.report) }) : t(lang, 'report.transfer.markupNotRun')],
  ];
  for (const h of heights) {
    const same = h.built != null && h.reference != null && h.built === h.reference;
    rows.push([t(lang, 'report.transfer.rowHeight', { width: h.width }), h.reference == null ? t(lang, 'report.transfer.heightReference') : t(lang, same ? 'report.transfer.equal' : 'report.transfer.heightDiffers'), `${t(lang, 'report.transfer.heightDetail', { built: h.built ?? '—', reference: h.reference ?? '—' })}${h.reference == null ? ` (${referenceNote ?? t(lang, 'report.transfer.noReferenceShot')})` : ''}`]);
  }
  rows.push([t(lang, 'report.transfer.rowShots'), t(lang, shots.built?.length ? 'report.transfer.shotsTaken' : 'report.transfer.shotsNone'), t(lang, 'report.transfer.shotsDetail', { built: (shots.built ?? []).map(rel).join(', ') || '—', reference: shots.reference ? rel(shots.reference) : (referenceNote ?? t(lang, 'report.transfer.shotsNotTaken')) })]);
  if (styleSkipped.length) rows.push([t(lang, 'report.transfer.rowStyle'), t(lang, 'report.transfer.styleSkipped'), `${styleSkipped.map((s) => s.key).join(', ')} — ${[...new Set(styleSkipped.map((s) => styleReasonText(s, lang)))].join('; ')}`]);
  const widthsTable = [
    TABLE_WIDTHS,
    t(lang, 'report.transfer.verdictHead'),
    '| --- | --- | --- | --- |',
    ...heights.map((h) => `| ${h.width} | | | |`),
  ];
  const lines = [
    t(lang, 'report.transfer.title', { label }),
    '',
    `${t(lang, 'report.takenAt', { at })} ${t(lang, 'report.transfer.intro')}`,
    `<!-- taken-at: ${at} -->`,
    '',
    t(lang, 'report.transfer.tableHead'),
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${String(r[2]).replace(/\|/g, '\\|')} |`),
    '',
    t(lang, 'report.transfer.artifactsTitle'),
    '',
    ...artifacts.map((a) => `- ${PREVIEW_ARTIFACT_KEYS[a] ? t(lang, PREVIEW_ARTIFACT_KEYS[a]) : a}`),
    '',
    t(lang, 'report.transfer.htmlTitle'),
    '',
    ...renderHtmlBlocks(htmlBlocks, lang),
    '',
    t(lang, 'report.transfer.verdictTitle'),
    '',
    VERDICT_START,
    // Повторная сверка — обычный шаг (после donor links, после исправлений): заполненный вердикт
    // переносится, агент перепроверяет его по новым кадрам; пометка о переносе стоит вне меток вердикта.
    ...(previousVerdict?.filled ? [previousVerdict.text] : [t(lang, 'report.transfer.verdictTemplate'), '', ...widthsTable]),
    VERDICT_END,
    '',
    ...(previousVerdict?.filled
      ? [t(lang, 'report.transfer.verdictCarried', { from: previousVerdict.at ?? t(lang, 'report.transfer.unknownDate'), at }), '']
      : []),
  ];
  return lines.join('\n');
}

/**
 * Внутри сессии редактора приёмника: сверка разметки, состав, кадры сборки.
 * driver: { listRecords(), pageRawHtml(), shot({ widths }), readRecord(recordid)? } — readRecord даёт снимок записи для HTML-блоков.
 */
export async function collectTransferData(driver, { slug, label, pageid, widths, baseDir, catalogDir, now = new Date().toISOString(), lang = 'en' }) {
  // Замены шаблонов из site.json относятся к сборке по референсу; перенос через буфер несёт
  // исходные шаблоны донора — замены нейтрализуются тождественными парами.
  const site = readSite(slug, baseDir ? { baseDir } : undefined);
  const identity = Object.fromEntries(Object.keys(site?.substitutes ?? {}).map((k) => [k, k]));
  const { resolved, structure } = prepareReferencePlan({ slug, source: label, baseDir, catalogDir, substitutes: identity });
  const cmp = await compareReferencePage(driver, { slug, label, baseDir, catalogDir, substitutes: identity, now, lang });
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

/**
 * Кадр референса снят (или нет) — доклад и данные пишутся в слепок. Доклад пишется на языке `lang`.
 * `referenceNote` — строка или `Message`: в данные слепка идёт английский текст, в доклад — на `lang`.
 */
export function finishTransferReport(data, referenceShots, { slug, baseDir, referenceNote, lang = 'en' } = {}) {
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
    referenceNote: referenceShots || referenceNote == null ? null : messageText(referenceNote),
  };
  const noteForReport = referenceShots || referenceNote == null ? null : (isMessage(referenceNote) ? render(lang, referenceNote) : referenceNote);
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
      if (!hasVerdictSection(prev)) log.warn('extractVerdict', 'verdict not found in previous report', { file: rel(report) });
      previousVerdict = { ...extractVerdict(prev), at: reportTakenAt(prev) };
    } catch (e) {
      log.warn('finishTransferReport', 'прежний доклад не прочитан — вердикт пишется пустым', { label: data.label, error: e.message });
    }
  }
  full.verdictCarried = Boolean(previousVerdict?.filled);
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
  log.debug('finishTransferReport', 'report language', { lang, file: rel(report) });
  writeFileSync(report, renderTransferReport({ ...full, referenceNote: noteForReport, previousVerdict, lang }), 'utf8');
  const exitCode = data.composition.equal ? 0 : 1;
  log.info('finishTransferReport', 'доклад записан', { label: data.label, report: rel(report), equal: data.composition.equal, verdictCarried: full.verdictCarried, exitCode });
  return { ...full, path: rel(path), report: rel(report), exitCode };
}

/** Полный цикл, когда кадр референса уже снят (или не нужен): собрать данные и записать доклад. */
export async function verifyTransferredPage(driver, params) {
  const data = await collectTransferData(driver, params);
  return finishTransferReport(data, params.referenceShots ?? null, { slug: params.slug, baseDir: params.baseDir, referenceNote: params.referenceNote, lang: params.lang });
}
