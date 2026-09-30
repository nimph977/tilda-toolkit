/**
 * Проверки после переноса одной командой (`donor check`). Список «Проверки после
 * переноса» (`skills/tilda-manager/references/scenarios.md`) агент проходил руками по каждой
 * метке и собирал сводку сам. Команда проходит метки слепка по одной и пишет итог разделом
 * `reports/transfer-summary.md` между маркерами — остальной текст сводки не меняется.
 *
 * Автоматически: ссылки вида страницы (`auditLinks` — домен донора, относительные адреса без
 * страницы, страницы донора по ID), HTML-блоки (`listHtmlBlocks`), поля `formmsgurl` на домене
 * донора в живых блоках, полнота карты (`donor pages` против `donorPageid`), главная страница
 * проекта. Остальное (получатели заявок, 404, запрет индексации, отличия от публикации донора) —
 * ручные пункты `MANUAL_CHECKS` в том же разделе, чтобы их не забыли.
 *
 * Только чтение тестового проекта: драйвер метки — `{ listRecords(), pageHtml(), readRecord(recordid) }`.
 * Хосты и пути пишутся только в файлы слепка вне git; на INFO — счётчики.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { refPaths } from './lib/reference-store.mjs';
import { auditKindMessage, auditLinks } from './reference-site.mjs';
import { HTML_BLOCK_TPLIDS, listHtmlBlocks } from './donor-verify.mjs';
import { find } from './find-replace.mjs';
import { normalizeAlias } from './donor-map.mjs';
import { messageText, msg, render, t } from './lib/i18n.mjs';

const log = createLogger('donor-check');

/** Сколько сбоев подряд останавливают прогон: сессия потеряна — дальше то же самое. */
export const MAX_FAILURES_IN_ROW = 3;

/**
 * Причины пропуска метки и сбоя проверки: имя → ключ словаря. Подстановки: `duplicate` {label},
 * `failed` {message}, `stopped` {n}. В результате у причины есть `code` (имя), `params` и
 * английский `reason` — их пишут в `checks.json`; `Message` для итога даёт `checkReasonMessage`.
 */
export const CHECK_REASONS = {
  unknownLabel: 'donorCheck.reason.unknownLabel',
  noPageid: 'donorCheck.reason.noPageid',
  duplicate: 'donorCheck.reason.duplicate',
  notTransferred: 'donorCheck.reason.notTransferred',
  failed: 'donorCheck.reason.failed',
  stopped: 'donorCheck.reason.stopped',
};

/** Запись причины: `{ code, params, reason }`, `reason` — английский текст. */
function reasonEntry(code, params = {}) {
  return { code, params, reason: messageText(msg(CHECK_REASONS[code], params)) };
}

/** Причина пропуска или сбоя как `Message` — для итога команды; запись без известного кода даёт свой текст. */
export function checkReasonMessage(entry) {
  return entry.code && CHECK_REASONS[entry.code] ? msg(CHECK_REASONS[entry.code], entry.params ?? {}) : String(entry.reason ?? '');
}

/** Пункты списка, которые команда не проверяет: ключи словаря (где смотреть и что делать). */
export const MANUAL_CHECKS = [
  'report.check.manualRecipients',
  'report.check.manualNotFound',
  'report.check.manualNoindex',
  'report.check.manualDonorDiff',
];

export const SECTION_START = '<!-- donor-check:start -->';
export const SECTION_END = '<!-- donor-check:end -->';

/**
 * Полнота карты. Чистая: страницы донора против уникальных `donorPageid` карты. Страница донора с
 * ролью `404` без метки не нарушение — карта строится по ссылкам опубликованного сайта, 404 в неё
 * не попадает; назначение 404 — ручной пункт. Итог `{ donorPages, mapped, missing: [{ pageid, role }], ok }`.
 */
export function mapCompleteness(site, donorPages) {
  const donorIds = new Set((donorPages ?? []).map((p) => String(p.pageid)));
  const mapped = new Set((site?.pages ?? []).filter((p) => p.donorPageid).map((p) => String(p.donorPageid)));
  const missing = (donorPages ?? []).filter((p) => !mapped.has(String(p.pageid))).map((p) => ({ pageid: String(p.pageid), role: p.role ?? null }));
  const ok = missing.every((m) => m.role === '404');
  log.debug('mapCompleteness', 'map completeness', { donorPages: donorIds.size, mapped: mapped.size, missing: missing.length, ok });
  return { donorPages: donorIds.size, mapped: [...mapped].filter((id) => donorIds.has(id)).length, missing, ok };
}

/**
 * Главная страница проекта. Чистая: страница с ролью `index` в `page list` тестового проекта против
 * страницы метки, чья пара — главная донора. Итог `{ ok, expected, actual, label, fix }`; `fix` —
 * команда CLI (без `node scripts/tilda.mjs`), если главная не та и страница метки известна.
 */
export function indexPageCheck(site, testPages, donorPages) {
  const donorIndex = (donorPages ?? []).find((p) => p.role === 'index');
  const entry = donorIndex ? (site?.pages ?? []).find((p) => p.pageid && String(p.donorPageid) === String(donorIndex.pageid)) : null;
  const expected = entry ? String(entry.pageid) : null;
  const current = (testPages ?? []).find((p) => p.role === 'index');
  const actual = current ? String(current.pageid) : null;
  const ok = Boolean(expected) && expected === actual;
  return { ok, expected, actual, label: entry?.label ?? null, fix: !ok && expected ? `page role --index ${expected} --confirm` : null };
}

/**
 * Метки к проверке. Чистая: по умолчанию — все метки карты; `labels` — выбранные. Пропуск с
 * причиной (`{ label, code, params, reason }`): нет pageid, дубль страницы донора (проверяется первая метка), нет записи переноса.
 * `transferred(pageid)` — есть ли `site-baseline/transfer/<pageid>/`.
 */
export function selectLabels(site, { labels, transferred }) {
  const pages = site?.pages ?? [];
  const byLabel = new Map(pages.map((p) => [p.label, p]));
  const firstByDonor = new Map();
  for (const p of pages) if (p.pageid && p.donorPageid && !firstByDonor.has(String(p.donorPageid))) firstByDonor.set(String(p.donorPageid), p.label);
  const todo = [];
  const skipped = [];
  const skip = (label, code, params) => {
    const entry = reasonEntry(code, params);
    skipped.push({ label, ...entry });
    log.debug('selectLabels', 'skipped', { label, reason: entry.reason });
  };
  for (const label of labels ?? pages.map((p) => p.label)) {
    const entry = byLabel.get(label);
    if (!entry) { skip(label, 'unknownLabel'); continue; }
    if (!entry.pageid) { skip(label, 'noPageid'); continue; }
    const first = entry.donorPageid ? firstByDonor.get(String(entry.donorPageid)) : label;
    if (first && first !== label) { skip(label, 'duplicate', { label: first }); continue; }
    if (!transferred(String(entry.pageid))) { skip(label, 'notTransferred'); continue; }
    todo.push(entry);
  }
  return { todo, skipped };
}

/**
 * Проверка одной метки. Драйвер `{ listRecords(), pageHtml(), readRecord(recordid) }`; `listRecords`
 * отдаёт свежий инвентарь (снимки блоков при этом уже на диске — `formmsgurl` ищется по ним).
 * Итог `{ label, pageid, total, violations, htmlBlocks, forms: [{ recordid, field }] }`.
 */
export async function checkLabel(driver, { entry, referenceHost, hosts, knownAliases, knownPageIds, donorPageIds, baselineBase }) {
  const pageid = String(entry.pageid);
  const records = await driver.listRecords();
  const { url, html } = await driver.pageHtml();
  const audit = auditLinks(html, { baseUrl: url, referenceHost, knownPageIds, knownAliases, donorPageIds });
  const source = [];
  for (const r of records.filter((x) => HTML_BLOCK_TPLIDS.includes(String(x.tplid)))) {
    const snap = await driver.readRecord(String(r.recordid));
    const rec = snap?.record ?? snap ?? {};
    source.push({ recordid: r.recordid, tplid: r.tplid, hidden: r.hidden, code: rec.code });
  }
  const htmlBlocks = listHtmlBlocks(source);
  // Переход после отправки формы на домен донора — поле формы, `donor links` его не меняет (называется владельцу).
  const found = hosts?.length
    ? find(pageid, hosts[0], { baseDir: baselineBase, recordids: records.map((r) => String(r.recordid)), quiet: true })
    : { skippedForm: [] };
  const forms = found.skippedForm.filter((x) => x.field === 'formmsgurl').map((x) => ({ recordid: x.recordid, field: x.field }));
  log.info('checkLabel', `${entry.label}: links ${audit.total}, violations ${audit.violations.length}, HTML blocks ${htmlBlocks.length}, formmsgurl ${forms.length}`, {});
  log.debug('checkLabel', 'violations', { label: entry.label, violations: audit.violations });
  return { label: entry.label, pageid, total: audit.total, violations: audit.violations, htmlBlocks, forms };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

function htmlCell(blocks, lang) {
  if (!blocks?.length) return '—';
  const placeholder = blocks.filter((b) => b.placeholder).length;
  const external = blocks.filter((b) => b.hosts.length).length;
  return t(lang, 'report.check.htmlCell', { total: blocks.length, placeholder, external });
}

/** Текст причины пропуска или сбоя на языке доклада; запись без известного кода — как записана. */
function reasonText(entry, lang) {
  return entry.code && CHECK_REASONS[entry.code] ? t(lang, CHECK_REASONS[entry.code], entry.params ?? {}) : String(entry.reason ?? '');
}

/** Текст сбоя метки на языке доклада: по параметрам, а без них — записанный английский. */
function failureText(label, lang) {
  return label.errorParams ? t(lang, CHECK_REASONS.failed, label.errorParams) : String(label.error);
}

/**
 * Markdown раздела проверок между маркерами на языке `lang`. Чистая. Время съёмки пишется дважды:
 * человекочитаемой строкой и нейтральной меткой `taken-at` — метку читает повторный запуск.
 */
export function renderChecksSection(result, lang = 'en') {
  const { at, labels = [], skipped = [], map, index, stopped } = result;
  const checked = labels.filter((l) => !l.error);
  const failed = labels.filter((l) => l.error);
  const linkViolations = checked.reduce((n, l) => n + l.violations.length, 0);
  const lines = [
    SECTION_START,
    t(lang, 'report.check.heading'),
    '',
    `${t(lang, 'report.takenAt', { at })} ${t(lang, 'report.check.intro')}`,
    `<!-- taken-at: ${at} -->`,
    '',
    t(lang, 'report.check.summary', {
      checked: checked.length,
      failed: failed.length,
      stopped: stopped ? t(lang, 'report.check.stopped') : '',
      skipped: skipped.length,
      violations: linkViolations,
      map: t(lang, map?.ok ? 'report.check.mapComplete' : 'report.check.mapIncomplete'),
      index: t(lang, index?.ok ? 'report.check.indexOk' : 'report.check.indexWrong'),
    }),
    '',
    t(lang, 'report.check.tableHead'),
    '| --- | --- | --- | --- | --- |',
    ...labels.map((l) => (l.error
      ? `| ${l.label} | — | ${cell(failureText(l, lang))} | — | — |`
      : `| ${l.label} | ${l.total} | ${l.violations.length} | ${htmlCell(l.htmlBlocks, lang)} | ${l.forms.length} |`)),
    '',
  ];
  const detail = checked.flatMap((l) => l.violations.map((v) => `- ${l.label}: ${cell(render(lang, auditKindMessage(v.kind)))}: ${v.path} ×${v.count}`));
  if (detail.length) lines.push(t(lang, 'report.check.violationsTitle'), '', ...detail, '');
  const html = checked.flatMap((l) => (l.htmlBlocks ?? []).filter((b) => b.placeholder || b.hosts.length).map((b) => `- ${t(lang, 'report.check.htmlLine', {
    label: l.label,
    recordid: b.recordid,
    hidden: b.hidden ? t(lang, 'report.check.hidden') : '',
    what: b.placeholder ? t(lang, 'report.check.htmlPlaceholder') : t(lang, 'report.check.htmlHosts', { hosts: b.hosts.join(', ') }),
  })}`));
  if (html.length) lines.push(t(lang, 'report.check.htmlTitle'), '', ...html, '');
  const forms = checked.flatMap((l) => l.forms.map((f) => `- ${t(lang, 'report.check.formLine', { label: l.label, recordid: f.recordid, field: f.field })}`));
  if (forms.length) lines.push(t(lang, 'report.check.formsTitle'), '', ...forms, '');
  if (skipped.length) lines.push(t(lang, 'report.check.skippedTitle'), '', ...skipped.map((s) => `- ${s.label}: ${reasonText(s, lang)}`), '');
  if (map) {
    lines.push(t(lang, 'report.check.mapTitle'), '', t(lang, 'report.check.mapSummary', { donorPages: map.donorPages, mapped: map.mapped, missing: map.missing.length }));
    for (const m of map.missing) {
      const role = m.role ? t(lang, 'report.check.mapRole', { role: m.role }) : '';
      lines.push(`- ${m.pageid}${role}: ${t(lang, m.role === '404' ? 'report.check.mapMissing404' : 'report.check.mapMissingNoLabel')}`);
    }
    lines.push('');
  }
  if (index) {
    lines.push(t(lang, 'report.check.indexTitle'), '', index.ok
      ? t(lang, 'report.check.indexAssigned', { label: index.label })
      : t(lang, 'report.check.indexMismatch', {
        label: index.label ?? '—',
        expected: index.expected ?? t(lang, 'report.check.indexNoPair'),
        actual: index.actual ?? t(lang, 'report.check.indexNone'),
        action: index.fix ? t(lang, 'report.check.indexFix', { fix: index.fix }) : t(lang, 'report.check.indexNoFix'),
      }), '');
  }
  lines.push(t(lang, 'report.check.manualTitle'), '', ...MANUAL_CHECKS.map((m) => `- [ ] ${t(lang, m)}`), '', SECTION_END);
  return lines.join('\n');
}

/**
 * Раздел проверок в сводке: заменить между маркерами или дописать в конец; файла нет — создать.
 * Текст вне маркеров не меняется. `lang` — язык заголовка нового файла.
 */
export function writeChecksSection(summaryPath, section, lang = 'en') {
  let text = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null;
  if (text === null) {
    text = `${t(lang, 'report.check.summaryTitle')}\n\n${section}\n`;
  } else {
    const start = text.indexOf(SECTION_START);
    const end = text.indexOf(SECTION_END, start);
    text = start >= 0 && end >= 0
      ? `${text.slice(0, start)}${section}${text.slice(end + SECTION_END.length)}`
      : `${text.replace(/\s*$/, '')}\n\n${section}\n`;
  }
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, text, 'utf8');
  return summaryPath;
}

/**
 * Оркестратор: метки по одной с паузой, затем `reports/checks.json` и раздел сводки.
 * `openLabel(entry, fn)` открывает сессию редактора на странице метки и вызывает `fn(driver)`.
 * Итог `{ ...result, checksPath, summaryPath, exitCode }`; код 1 — нарушения ссылок, сбои меток,
 * неполная карта или не та главная.
 */
export async function runDonorCheck(openLabel, {
  slug, site, donorPages, testPages, referenceHost, hosts, labels, baseDir, baselineBase,
  delayMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = new Date().toISOString(), lang = 'en',
}) {
  const base = baselineBase ?? baselineDir();
  const { todo, skipped } = selectLabels(site, { labels, transferred: (pageid) => existsSync(join(base, 'transfer', pageid)) });
  const knownPageIds = (testPages ?? []).map((p) => String(p.pageid));
  const knownAliases = (testPages ?? []).map((p) => normalizeAlias(p.alias)).filter(Boolean).map((a) => `/${a}`);
  const donorPageIds = (site?.pages ?? []).filter((p) => p.donorPageid).map((p) => String(p.donorPageid));
  log.info('runDonorCheck', `labels to check ${todo.length}, skipped ${skipped.length}`, { slug });
  const results = [];
  let failuresInRow = 0;
  let stopped = false;
  for (const [i, entry] of todo.entries()) {
    if (stopped) { skipped.push({ label: entry.label, ...reasonEntry('stopped', { n: MAX_FAILURES_IN_ROW }) }); continue; }
    if (i > 0) await sleep(delayMs);
    try {
      results.push(await openLabel(entry, (driver) => checkLabel(driver, { entry, referenceHost, hosts, knownAliases, knownPageIds, donorPageIds, baselineBase: base })));
      failuresInRow = 0;
    } catch (e) {
      const message = e.code ? `${e.code}: ${e.message}` : e.message;
      results.push({ label: entry.label, pageid: String(entry.pageid), error: reasonEntry('failed', { message }).reason, errorParams: { message } });
      log.warn('runDonorCheck', 'label not checked', { label: entry.label, error: message });
      failuresInRow += 1;
      if (failuresInRow >= MAX_FAILURES_IN_ROW) {
        stopped = true;
        log.error('runDonorCheck', reasonEntry('stopped', { n: MAX_FAILURES_IN_ROW }).reason, { label: entry.label });
      }
    }
  }
  const map = mapCompleteness(site, donorPages);
  const index = indexPageCheck(site, testPages, donorPages);
  const result = { at: now, slug, labels: results, skipped, map, index, stopped, manual: MANUAL_CHECKS };
  const reports = join(refPaths(slug, baseDir ? { baseDir } : undefined).root, 'reports');
  mkdirSync(reports, { recursive: true });
  const checksPath = join(reports, 'checks.json');
  writeFileSync(checksPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const summaryPath = writeChecksSection(join(reports, 'transfer-summary.md'), renderChecksSection(result, lang), lang);
  log.debug('runDonorCheck', 'report language', { lang, file: summaryPath.replace(/\\/g, '/') });
  const linkViolations = results.reduce((n, l) => n + (l.violations?.length ?? 0), 0);
  const failed = results.filter((l) => l.error).length;
  const exitCode = linkViolations || failed || stopped || !map.ok || !index.ok ? 1 : 0;
  log.info('runDonorCheck', `checked ${results.length - failed}, failures ${failed}, link violations ${linkViolations}, map ${map.ok ? 'complete' : 'incomplete'}, home page ${index.ok ? 'correct' : 'wrong'}`, { exitCode });
  return { ...result, linkViolations, failed, checksPath, summaryPath, exitCode };
}
