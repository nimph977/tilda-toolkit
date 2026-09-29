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
import { auditLinks } from './reference-site.mjs';
import { HTML_BLOCK_TPLIDS, listHtmlBlocks } from './donor-verify.mjs';
import { find } from './find-replace.mjs';
import { normalizeAlias } from './donor-map.mjs';

const log = createLogger('donor-check');

/** Сколько сбоев подряд останавливают прогон: сессия потеряна — дальше то же самое. */
export const MAX_FAILURES_IN_ROW = 3;

export const CHECK_REASONS = {
  unknownLabel: 'метки нет в карте сайта',
  noPageid: 'у метки нет pageid',
  duplicate: (label) => `та же страница донора, что у метки ${label} — проверяется там`,
  notTransferred: 'нет записи переноса — страница не переносилась',
  failed: (message) => `проверка не выполнена: ${message}`,
  stopped: `прогон остановлен после ${MAX_FAILURES_IN_ROW} сбоев подряд`,
};

/** Пункты списка, которые команда не проверяет: где смотреть и что делать. */
export const MANUAL_CHECKS = [
  'Получатели заявок: формы переносятся без получателей — заявки с копии никуда не уйдут или уйдут в CRM донора; сказать владельцу',
  'Страница 404: назначается в настройках сайта вручную (`page role` этого не умеет); решение владельца — в сводку',
  'Запрет индексации до публикации: настройки сайта → SEO → «Запрет индексации» — включить до `page publish`',
  'Отличия от публикации донора: предпросмотр той же страницы в редакторе донора (только чтение); совпадает со сборкой — старая публикация донора, не ошибка переноса',
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
  log.debug('mapCompleteness', 'полнота карты', { donorPages: donorIds.size, mapped: mapped.size, missing: missing.length, ok });
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
 * причиной: нет pageid, дубль страницы донора (проверяется первая метка), нет записи переноса.
 * `transferred(pageid)` — есть ли `site-baseline/transfer/<pageid>/`.
 */
export function selectLabels(site, { labels, transferred }) {
  const pages = site?.pages ?? [];
  const byLabel = new Map(pages.map((p) => [p.label, p]));
  const firstByDonor = new Map();
  for (const p of pages) if (p.pageid && p.donorPageid && !firstByDonor.has(String(p.donorPageid))) firstByDonor.set(String(p.donorPageid), p.label);
  const todo = [];
  const skipped = [];
  const skip = (label, reason) => {
    skipped.push({ label, reason });
    log.debug('selectLabels', 'пропуск', { label, reason });
  };
  for (const label of labels ?? pages.map((p) => p.label)) {
    const entry = byLabel.get(label);
    if (!entry) { skip(label, CHECK_REASONS.unknownLabel); continue; }
    if (!entry.pageid) { skip(label, CHECK_REASONS.noPageid); continue; }
    const first = entry.donorPageid ? firstByDonor.get(String(entry.donorPageid)) : label;
    if (first && first !== label) { skip(label, CHECK_REASONS.duplicate(first)); continue; }
    if (!transferred(String(entry.pageid))) { skip(label, CHECK_REASONS.notTransferred); continue; }
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
  log.info('checkLabel', `${entry.label}: ссылок ${audit.total}, нарушений ${audit.violations.length}, HTML-блоков ${htmlBlocks.length}, formmsgurl ${forms.length}`, {});
  log.debug('checkLabel', 'нарушения', { label: entry.label, violations: audit.violations });
  return { label: entry.label, pageid, total: audit.total, violations: audit.violations, htmlBlocks, forms };
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

function htmlCell(blocks) {
  if (!blocks?.length) return '—';
  const placeholder = blocks.filter((b) => b.placeholder).length;
  const external = blocks.filter((b) => b.hosts.length).length;
  return `${blocks.length} (с заглушкой ${placeholder}, с внешними хостами ${external})`;
}

/** Markdown раздела проверок между маркерами. Чистая. */
export function renderChecksSection(result) {
  const { at, labels = [], skipped = [], map, index, stopped } = result;
  const checked = labels.filter((l) => !l.error);
  const failed = labels.filter((l) => l.error);
  const linkViolations = checked.reduce((n, l) => n + l.violations.length, 0);
  const lines = [
    SECTION_START,
    '## Проверки после переноса (donor check)',
    '',
    `Снято: ${at}. Автоматические пункты 1–6 списка «Проверки после переноса»; ручные — в конце раздела.`,
    '',
    `Итог: меток проверено ${checked.length}, не проверено ${failed.length}${stopped ? ' (прогон остановлен)' : ''}, пропущено ${skipped.length}; нарушений ссылок ${linkViolations}; карта ${map?.ok ? 'полная' : 'неполная'}; главная ${index?.ok ? 'назначена верно' : 'не та'}.`,
    '',
    '| Метка | Ссылок | Нарушений ссылок | HTML-блоки | formmsgurl на домене донора |',
    '| --- | --- | --- | --- | --- |',
    ...labels.map((l) => (l.error
      ? `| ${l.label} | — | ${cell(l.error)} | — | — |`
      : `| ${l.label} | ${l.total} | ${l.violations.length} | ${htmlCell(l.htmlBlocks)} | ${l.forms.length} |`)),
    '',
  ];
  const detail = checked.flatMap((l) => l.violations.map((v) => `- ${l.label}: ${cell(v.kind)}: ${v.path} ×${v.count}`));
  if (detail.length) lines.push('Нарушения ссылок:', '', ...detail, '');
  const html = checked.flatMap((l) => (l.htmlBlocks ?? []).filter((b) => b.placeholder || b.hosts.length).map((b) => `- ${l.label}, блок ${b.recordid}${b.hidden ? ' (скрыт)' : ''}: ${b.placeholder ? 'заглушка «Html code will be here»' : `внешние хосты ${b.hosts.join(', ')}`}`));
  if (html.length) lines.push('HTML-блоки — назвать владельцу (предпросмотр код не выполняет, проверять на публикации):', '', ...html, '');
  const forms = checked.flatMap((l) => l.forms.map((f) => `- ${l.label}, блок ${f.recordid}: ${f.field} ведёт на домен донора`));
  if (forms.length) lines.push('Формы — назвать владельцу:', '', ...forms, '');
  if (skipped.length) lines.push('Пропущено:', '', ...skipped.map((s) => `- ${s.label}: ${s.reason}`), '');
  if (map) {
    lines.push('### Полнота карты', '', `Страниц донора ${map.donorPages}, в карте ${map.mapped}, без метки ${map.missing.length}.`);
    for (const m of map.missing) lines.push(`- ${m.pageid}${m.role ? ` (роль ${m.role})` : ''}: ${m.role === '404' ? 'страница 404 — ручной пункт ниже' : 'нет метки — назвать владельцу, решение в сводку'}`);
    lines.push('');
  }
  if (index) {
    lines.push('### Главная страница', '', index.ok
      ? `Главной назначена страница метки ${index.label} — верно.`
      : `Главной должна быть страница метки ${index.label ?? '—'} (${index.expected ?? 'пары главной донора нет'}), назначена ${index.actual ?? 'никакая'} — ${index.fix
        ? `\`node scripts/tilda.mjs ${index.fix}\`, затем \`page list\` и повторный \`donor check\`.`
        : 'у главной донора нет метки со страницей: сначала перенести её (donor copy), затем повторный donor check.'}`, '');
  }
  lines.push('### Ручные проверки', '', ...MANUAL_CHECKS.map((m) => `- [ ] ${m}`), '', SECTION_END);
  return lines.join('\n');
}

/**
 * Раздел проверок в сводке: заменить между маркерами или дописать в конец; файла нет — создать.
 * Текст вне маркеров не меняется.
 */
export function writeChecksSection(summaryPath, section) {
  let text = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null;
  if (text === null) {
    text = `# Сводка переноса\n\n${section}\n`;
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
  delayMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = new Date().toISOString(),
}) {
  const base = baselineBase ?? baselineDir();
  const { todo, skipped } = selectLabels(site, { labels, transferred: (pageid) => existsSync(join(base, 'transfer', pageid)) });
  const knownPageIds = (testPages ?? []).map((p) => String(p.pageid));
  const knownAliases = (testPages ?? []).map((p) => normalizeAlias(p.alias)).filter(Boolean).map((a) => `/${a}`);
  const donorPageIds = (site?.pages ?? []).filter((p) => p.donorPageid).map((p) => String(p.donorPageid));
  log.info('runDonorCheck', `меток к проверке ${todo.length}, пропущено ${skipped.length}`, { slug });
  const results = [];
  let failuresInRow = 0;
  let stopped = false;
  for (const [i, entry] of todo.entries()) {
    if (stopped) { skipped.push({ label: entry.label, reason: CHECK_REASONS.stopped }); continue; }
    if (i > 0) await sleep(delayMs);
    try {
      results.push(await openLabel(entry, (driver) => checkLabel(driver, { entry, referenceHost, hosts, knownAliases, knownPageIds, donorPageIds, baselineBase: base })));
      failuresInRow = 0;
    } catch (e) {
      const message = e.code ? `${e.code}: ${e.message}` : e.message;
      results.push({ label: entry.label, pageid: String(entry.pageid), error: CHECK_REASONS.failed(message) });
      log.warn('runDonorCheck', 'метка не проверена', { label: entry.label, error: message });
      failuresInRow += 1;
      if (failuresInRow >= MAX_FAILURES_IN_ROW) {
        stopped = true;
        log.error('runDonorCheck', CHECK_REASONS.stopped, { label: entry.label });
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
  const summaryPath = writeChecksSection(join(reports, 'transfer-summary.md'), renderChecksSection(result));
  const linkViolations = results.reduce((n, l) => n + (l.violations?.length ?? 0), 0);
  const failed = results.filter((l) => l.error).length;
  const exitCode = linkViolations || failed || stopped || !map.ok || !index.ok ? 1 : 0;
  log.info('runDonorCheck', `проверено ${results.length - failed}, сбоев ${failed}, нарушений ссылок ${linkViolations}, карта ${map.ok ? 'полная' : 'неполная'}, главная ${index.ok ? 'верно' : 'не та'}`, { exitCode });
  return { ...result, linkViolations, failed, checksPath, summaryPath, exitCode };
}
