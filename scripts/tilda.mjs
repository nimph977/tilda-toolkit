#!/usr/bin/env node
/**
 * CLI правки проекта Tilda: одна команда — один цикл внутри одного процесса.
 *
 *   node scripts/tilda.mjs <команда> [--page <pageid>] [--plan <файл>] [--out <путь>] [--json] [--dry-run]
 *
 * Команды:
 *   browser     start | stop | status — держатель браузера: Chrome открыт один раз и живёт между
 *               командами (сессия Тильды не переживает перезапуск Chrome); команды подключаются к нему;
 *               --donor — второй держатель для аккаунта донора (профиль TILDA_DONOR_BROWSER_PROFILE)
 *   session     открыть редактор, ответить «сессия жива» или дождаться входа человека;
 *               session --donor — вход аккаунта донора на странице его проекта (только чтение)
 *   inventory   инвентарь блоков страницы → records/<pageid>/_inventory.json
 *   snapshot    снимки блоков: --plan <план> (затронутые), recordid… (перечисленные) или все
 *   apply       инвентарь → снимки → prepare → запись → перечитать → verify, одним запуском
 *   verify      перечитать затронутые планом блоки и сверить с payload (без записи)
 *   rollback    <запись журнала> — обратный план из from тем же циклом с той же сверкой
 *   journal     список записей журнала страницы (--page)
 *   find        <строка> — адреса вхождений по локальным снимкам страницы (без браузера)
 *   replace     <строка> <строка> — план замены по всем адресам → --out (по умолчанию <папка сайта>/plans/replace-<pageid>.json)
 *   upload      <файл> — картинка с диска на CDN Тильды; в ответе готовый set.image (в плане можно писать "image": {"file": "путь"})
 *   preview     --plan <план> — предпросмотр правки без записи (previewrecord) и скриншот затронутых блоков
 *   shot        --page <id> [--width 1440,320] [--links] — скриншоты вида страницы (и проверка ссылок)
 *   links       --page <id> — битые ссылки и картинки вида страницы
 *   map         --page <id> [--width 1440] [--no-open] — карта блоков: скриншот вида страницы с подписанными
 *               номерами (по свежему инвентарю) и легенда <ISO>-map.json; файл открывается человеку,
 *               в контекст агента не грузится
 *   page        duplicate | create | publish | delete | list — операции уровня страницы:
 *               duplicate --page <id> → дубль (новый pageid); create → пустая страница из шаблона 1231;
 *               publish --page <id> --confirm → публикация ТОЛЬКО по явной команде пользователя, без
 *               --confirm и без явного --page отказ до запроса; delete --page <id> → инструкция человеку;
 *               list [--out <путь>] [--json] → перечень страниц проекта в файл, без --page
 *   promote     --plan <план> [план2 …] --from <копия> --to <живая> [--unprotect] [--batch 10 --delay 2500 --pause 60]
 *               — накат на живую главную:
 *               план проверен на копии по журналу → бэкап-дубль живой и полный снимок →
 *               сверка бэкапа с копией (расхождение сверх плана — останов) → накат заменой page →
 *               бэкап остаётся; защита живой снимается только явным --unprotect на этот вызов
 *   stage       режим реплик: stage '<json-операция>' | stage --plan <файл> — добавить в
 *               накопительный план <папка сайта>/plans/session-<ISO>-<pageid>.json и показать локальный diff (без сети);
 *               stage diff | stage apply | stage drop | stage list
 *   reference   fetch | structure | pages | plan | shot | audit — слепок референс-сайта через держатель (--url --slug [--follow --sitemap --max
 *               --images --delay --settle]), переразбор структуры без сети, план сборки newRecord по структуре
 *               и каталогу (--source <страница слепка> --page <черновая> [--no-styles] [--substitute a=b], без сети);
 *               fetch|structure не требуют TILDA_PROJECT_ID и TILDA_PROTECTED_PAGES
 *   donor       pages | map | copy | style | verify — перенос через кабинет донора: перечень страниц донора
 *               под его входом (держатель донора, только чтение), карта меток карты сайта ↔ страницы донора
 *               (--slug, без сети, donorPageid в site.json); copy/style/verify — фазы 5–8 плана
 *   catalog     capture | list — эталонные поля шаблонов: снять на черновой странице (--page --slug|--tplid;
 *               блок каждого шаблона создаётся, читается и удаляется) или показать снятое без сети;
 *               calibrate — карта «значение настройки → разметка» по предпросмотру (временный блок на черновой)
 *   doctor      [--site <папка>] [--json] — проверить Node.js, зависимости, Chrome, git, папку сайта, .env и скилл;
 *               только читает и печатает готовые команды исправления; доступен и как node scripts/doctor.mjs
 *   setup       [--site <папка>] [--project <ID>] [--agent claude|codex|all] — создать папку сайта и .env из
 *               .env.example (существующий .env не перезаписывается), поставить скилл tilda-manager в папку
 *               агента внутри репозитория; только флаги, без вопросов; все проверки до первой записи
 *
 * В stdout — короткий итог (не длиннее ~20 строк), подробности уходят в файлы. Логи — в stderr
 * через lib/log.mjs (LOG_LEVEL=DEBUG печатает тела запросов к Тильде без кук).
 *
 * Коды выхода: 0 успех; 1 расхождение или отказ операции; 2 ошибка аргументов; 3 SESSION_LOST.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from './lib/log.mjs';
import { LANGS, resolveLang, peekLang, render, renderError, msg, isMessage, messageText, attachMessage, setI18nLogger, t } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { protectedPages, plansDir, repoRoot } from './lib/paths.mjs';
import { applySite, cliHint } from './lib/site.mjs';
import { getDefaultPage, requireOnlineConfig } from './lib/config.mjs';
import { isLabel } from './lib/reference-store.mjs';
import { SETUP_AGENTS, runSetup } from './setup.mjs';

const log = createLogger('tilda');
setI18nLogger(createLogger('i18n'));

export const EXIT = { OK: 0, REFUSED: 1, USAGE: 2, SESSION_LOST: 3 };
export const COMMANDS = ['browser', 'session', 'inventory', 'snapshot', 'apply', 'verify', 'rollback', 'journal', 'find', 'replace', 'upload', 'preview', 'shot', 'links', 'map', 'page', 'promote', 'stage', 'reference', 'catalog', 'donor', 'doctor', 'setup'];
/** Действия переноса через кабинет донора. */
export const DONOR_ACTIONS = ['pages', 'map', 'copy', 'style', 'verify', 'aliases', 'links', 'check'];
export const BROWSER_ACTIONS = ['start', 'stop', 'status', 'show', 'hide'];
export const PAGE_ACTIONS = ['duplicate', 'create', 'publish', 'delete', 'list', 'role', 'title'];
export const STAGE_ACTIONS = ['diff', 'apply', 'drop', 'list'];
export const REFERENCE_ACTIONS = ['fetch', 'structure', 'pages', 'plan', 'shot', 'audit', 'project', 'compare'];
export const REFERENCE_ZONES = ['all', 'content', 'header', 'footer'];
export const CATALOG_ACTIONS = ['capture', 'list', 'calibrate'];
export const NOT_IMPLEMENTED = new Set([]);
const ONLINE_COMMANDS = new Set(['session', 'inventory', 'snapshot', 'apply', 'verify', 'rollback', 'upload', 'preview', 'shot', 'links', 'map', 'page', 'promote']);

export const OPTIONS = {
  site: { type: 'string' },
  page: { type: 'string' },
  plan: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  wait: { type: 'string' },
  'emit-calls': { type: 'boolean', default: false },
  width: { type: 'string' },
  links: { type: 'boolean', default: false },
  open: { type: 'boolean', default: true },
  styles: { type: 'boolean', default: true },
  substitute: { type: 'string', multiple: true },
  confirm: { type: 'boolean', default: false },
  from: { type: 'string' },
  to: { type: 'string' },
  unprotect: { type: 'boolean', default: false },
  batch: { type: 'string' },
  delay: { type: 'string' },
  pause: { type: 'string' },
  url: { type: 'string' },
  slug: { type: 'string' },
  source: { type: 'string' },
  follow: { type: 'boolean', default: false },
  sitemap: { type: 'boolean', default: false },
  create: { type: 'boolean', default: false },
  zone: { type: 'string' },
  force: { type: 'boolean', default: false },
  header: { type: 'string' },
  footer: { type: 'string' },
  index: { type: 'string' },
  max: { type: 'string' },
  images: { type: 'boolean', default: false },
  settle: { type: 'string' },
  tplid: { type: 'string' },
  apply: { type: 'boolean', default: false },
  update: { type: 'boolean', default: false },
  published: { type: 'boolean', default: false },
  donor: { type: 'boolean', default: false },
  replace: { type: 'boolean', default: false },
  title: { type: 'string' },
  agent: { type: 'string' },
  project: { type: 'string' },
  lang: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

/** Команды, у которых допустим флаг --donor (держатель и вход аккаунта донора). */
export const DONOR_FLAG_COMMANDS = ['browser', 'session'];

/** Ошибка разбора аргументов → код выхода 2. Принимает строку или `Message`. */
export class UsageError extends Error {
  constructor(message) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'UsageError';
    this.code = 'USAGE_ERROR';
    this.exitCode = EXIT.USAGE;
  }
}

/** Справка на языке `lang`: все строки берутся из словаря (`cli.help.*`). */
export function usage(lang = 'en') {
  return [
    t(lang, 'cli.help.usage'),
    '',
    t(lang, 'cli.help.commandsTitle', { list: COMMANDS.join(', ') }),
    t(lang, 'cli.help.cmd.browser'),
    t(lang, 'cli.help.cmd.session'),
    t(lang, 'cli.help.cmd.page'),
    t(lang, 'cli.help.cmd.pageTitle'),
    t(lang, 'cli.help.cmd.pageRoleFlags'),
    t(lang, 'cli.help.cmd.pageRoleIndex'),
    t(lang, 'cli.help.cmd.stage'),
    t(lang, 'cli.help.cmd.reference'),
    t(lang, 'cli.help.cmd.referenceShot'),
    t(lang, 'cli.help.cmd.referenceAudit'),
    t(lang, 'cli.help.cmd.referencePages'),
    t(lang, 'cli.help.cmd.referenceProject'),
    t(lang, 'cli.help.cmd.referenceCompare'),
    t(lang, 'cli.help.cmd.catalog'),
    t(lang, 'cli.help.cmd.donor'),
    t(lang, 'cli.help.cmd.donorMap'),
    t(lang, 'cli.help.cmd.donorCopy'),
    t(lang, 'cli.help.cmd.donorStyle'),
    t(lang, 'cli.help.cmd.donorAliases'),
    t(lang, 'cli.help.cmd.donorLinks'),
    t(lang, 'cli.help.cmd.donorCheck'),
    t(lang, 'cli.help.cmd.donorVerify'),
    t(lang, 'cli.help.cmd.catalogCalibrate'),
    t(lang, 'cli.help.cmd.doctor'),
    t(lang, 'cli.help.cmd.setup'),
    '',
    t(lang, 'cli.help.flagsTitle'),
    t(lang, 'cli.help.flag.site'),
    t(lang, 'cli.help.flag.page'),
    t(lang, 'cli.help.flag.plan'),
    t(lang, 'cli.help.flag.out'),
    t(lang, 'cli.help.flag.json'),
    t(lang, 'cli.help.flag.lang'),
    t(lang, 'cli.help.flag.dryRun'),
    t(lang, 'cli.help.flag.wait'),
    t(lang, 'cli.help.flag.agent'),
    t(lang, 'cli.help.flag.project'),
    t(lang, 'cli.help.flag.donor'),
    t(lang, 'cli.help.flag.replace'),
    t(lang, 'cli.help.flag.emitCalls'),
    t(lang, 'cli.help.flag.width'),
    t(lang, 'cli.help.flag.links'),
    t(lang, 'cli.help.flag.noOpen'),
    t(lang, 'cli.help.flag.confirm'),
    t(lang, 'cli.help.flag.fromTo'),
    t(lang, 'cli.help.flag.unprotect'),
    t(lang, 'cli.help.flag.batchDelayPause'),
    t(lang, 'cli.help.flag.url'),
    t(lang, 'cli.help.flag.slug'),
    t(lang, 'cli.help.flag.source'),
    t(lang, 'cli.help.flag.zone'),
    t(lang, 'cli.help.flag.noStyles'),
    t(lang, 'cli.help.flag.update'),
    t(lang, 'cli.help.flag.apply'),
    t(lang, 'cli.help.flag.published'),
    t(lang, 'cli.help.flag.substitute'),
    t(lang, 'cli.help.flag.follow'),
    t(lang, 'cli.help.flag.sitemap'),
    t(lang, 'cli.help.flag.create'),
    t(lang, 'cli.help.flag.max'),
    t(lang, 'cli.help.flag.images'),
    t(lang, 'cli.help.flag.delaySettle'),
    t(lang, 'cli.help.flag.tplid'),
    t(lang, 'cli.help.flag.force'),
    '',
    t(lang, 'cli.help.rollback'),
    '',
    t(lang, 'cli.help.exitCodes'),
    '',
    t(lang, 'cli.help.anyFolder'),
  ].join('\n');
}

/**
 * Разбор argv (без node и пути скрипта). Чистая функция: возвращает { cmd, values, positionals }
 * или бросает UsageError.
 */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true });
  } catch (e) {
    throw new UsageError(msg('cli.usage.parseArgs', { detail: e.message }));
  }
  const { values, positionals } = parsed;
  if (values.lang !== undefined) {
    const lang = values.lang.trim().toLowerCase();
    if (!LANGS.includes(lang)) throw new UsageError(msg('i18n.badFlag', { value: values.lang }));
    values.lang = lang;
  }
  if (values.help) return { cmd: 'help', values, positionals: [] };
  const [cmd, ...rest] = positionals;
  if (!cmd) throw new UsageError(msg('cli.usage.noCommand'));
  if (!COMMANDS.includes(cmd)) throw new UsageError(msg('cli.usage.unknownCommand', { command: cmd }));
  if (['apply', 'verify', 'preview'].includes(cmd) && !values.plan) throw new UsageError(msg('cli.usage.needPlan', { command: cmd }));
  if (cmd === 'browser' && !BROWSER_ACTIONS.includes(rest[0])) throw new UsageError(msg('cli.usage.needAction', { command: cmd, actions: BROWSER_ACTIONS.join('|') }));
  if (values.donor && !DONOR_FLAG_COMMANDS.includes(cmd)) throw new UsageError(msg(cmd === 'donor' ? 'cli.usage.donorFlagOnDonor' : 'cli.usage.donorFlagOnly'));
  if (cmd === 'donor') {
    const act = `donor ${rest[0]}`;
    if (!DONOR_ACTIONS.includes(rest[0])) throw new UsageError(msg('cli.usage.needAction', { command: cmd, actions: DONOR_ACTIONS.join('|') }));
    if ((rest[0] === 'map' || rest[0] === 'style' || rest[0] === 'verify' || rest[0] === 'aliases' || rest[0] === 'links' || rest[0] === 'check') && !values.slug) throw new UsageError(msg('cli.usage.needSlug', { command: act }));
    if (rest[0] === 'verify' && !isLabel(values.source)) throw new UsageError(msg('cli.usage.needSourceLabel', { command: act }));
    if (rest[0] === 'links' && !isLabel(values.source)) throw new UsageError(msg('cli.usage.needSourceLabel', { command: act }));
    if (rest[0] === 'check' && values.source !== undefined && !String(values.source).split(',').every((l) => isLabel(l.trim()))) {
      throw new UsageError(msg('cli.usage.checkSourceList'));
    }
    if (rest[0] === 'copy') {
      if (!values.slug) throw new UsageError(msg('cli.usage.needSlug', { command: act }));
      if (values.source !== undefined && !isLabel(values.source)) throw new UsageError(msg('cli.usage.copySourceLabel', { value: values.source }));
      if (values.source === undefined && (!values.from || !values.to)) throw new UsageError(msg('cli.usage.copyNeedTarget'));
      for (const k of ['from', 'to']) if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(msg('cli.usage.mustBeNumber', { command: act, flag: k, value: values[k] }));
      if (values.from !== undefined && values.from === values.to) throw new UsageError(msg('cli.usage.fromToSame', { command: act }));
      if (values.replace && values.source === undefined && !values.to) throw new UsageError(msg('cli.usage.copyReplaceNeedsTarget'));
    }
  }
  if (cmd === 'session' && values.donor && values.page !== undefined) throw new UsageError(msg('cli.usage.sessionDonorNoPage'));
  if (cmd === 'page' && !PAGE_ACTIONS.includes(rest[0])) throw new UsageError(msg('cli.usage.needAction', { command: cmd, actions: PAGE_ACTIONS.join('|') }));
  if (cmd === 'page' && rest[0] === 'publish' && values.page === undefined) throw new UsageError(msg('cli.usage.needExplicitPage', { command: 'page publish' }));
  if (cmd === 'page' && rest[0] === 'title') {
    if (values.page === undefined) throw new UsageError(msg('cli.usage.needExplicitPage', { command: 'page title' }));
    if (!values.title || !String(values.title).trim()) throw new UsageError(msg('cli.usage.needTitle'));
  }
  if (cmd === 'page' && rest[0] === 'role') {
    if (values.header === undefined && values.footer === undefined && values.index === undefined) throw new UsageError(msg('cli.usage.roleNeedFlag'));
    for (const k of ['header', 'footer']) if (values[k] !== undefined && !/^(\d+|none)$/.test(values[k])) throw new UsageError(msg('cli.usage.roleIdOrNone', { flag: k, value: values[k] }));
    if (values.index !== undefined) {
      if (!/^\d+$/.test(values.index)) throw new UsageError(msg('cli.usage.roleIndexId', { value: values.index }));
      if (values.header !== undefined || values.footer !== undefined) throw new UsageError(msg('cli.usage.roleIndexSeparate'));
    }
  }
  if (cmd === 'stage' && !values.plan && !rest[0]) throw new UsageError(msg('cli.usage.stageNeedOperation', { actions: STAGE_ACTIONS.join('|') }));
  if (cmd === 'promote') {
    if (!values.plan && !rest.length) throw new UsageError(msg('cli.usage.promoteNeedPlan'));
    if (!values.from || !values.to) throw new UsageError(msg('cli.usage.promoteNeedFromTo'));
    if (!/^\d+$/.test(values.from) || !/^\d+$/.test(values.to)) throw new UsageError(msg('cli.usage.promoteNumbers'));
    if (values.from === values.to) throw new UsageError(msg('cli.usage.fromToSame', { command: cmd }));
    for (const k of ['batch', 'delay', 'pause']) if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(msg('cli.usage.notInteger', { command: cmd, flag: k, value: values[k] }));
  }
  if (cmd === 'reference') {
    if (!REFERENCE_ACTIONS.includes(rest[0])) throw new UsageError(msg('cli.usage.needAction', { command: cmd, actions: REFERENCE_ACTIONS.join('|') }));
    if (!values.slug) throw new UsageError(msg('cli.usage.needSlugReference'));
    if (rest[0] === 'fetch' && !values.url) throw new UsageError(msg('cli.usage.needUrl'));
    if ((rest[0] === 'shot' || rest[0] === 'audit' || rest[0] === 'compare' || (rest[0] === 'plan' && values.update)) && !isLabel(values.source)) throw new UsageError(msg('cli.usage.needSourceLabelStrict', { command: `reference ${rest[0]}` }));
    if (rest[0] === 'plan' && !values.source) throw new UsageError(msg('cli.usage.planNeedSource'));
    if (rest[0] === 'plan' && values.page === undefined && !isLabel(values.source)) throw new UsageError(msg('cli.usage.needDraftPageOrLabel'));
    if (rest[0] === 'plan' && values.zone !== undefined) {
      if (!REFERENCE_ZONES.includes(values.zone)) throw new UsageError(msg('cli.usage.zoneValue', { zones: REFERENCE_ZONES.join('|'), value: values.zone }));
      if (isLabel(values.source)) throw new UsageError(msg('cli.usage.zoneByLabel'));
    }
    for (const k of ['max', 'delay', 'settle']) if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(msg('cli.usage.notInteger', { command: cmd, flag: k, value: values[k] }));
    if (rest[0] === 'plan' && values.substitute) {
      for (const pair of values.substitute.flatMap((s) => s.split(','))) {
        if (!/^\d+=\d+$/.test(pair.trim())) throw new UsageError(msg('cli.usage.substitutePair', { value: pair }));
      }
    }
  }
  if (cmd === 'catalog') {
    if (!CATALOG_ACTIONS.includes(rest[0])) throw new UsageError(msg('cli.usage.needAction', { command: cmd, actions: CATALOG_ACTIONS.join('|') }));
    if (rest[0] === 'capture' || rest[0] === 'calibrate') {
      const act = `catalog ${rest[0]}`;
      if (values.page === undefined) throw new UsageError(msg('cli.usage.needDraftPage', { command: act }));
      if (!values.slug && !values.tplid) throw new UsageError(msg('cli.usage.needSlugOrTplid', { command: act }));
      if (values.tplid !== undefined && !/^\d+(,\d+)*$/.test(values.tplid)) throw new UsageError(msg('cli.usage.tplidList', { command: act, value: values.tplid }));
      for (const k of ['delay', 'batch', 'pause']) {
        if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(msg('cli.usage.notInteger', { command: act, flag: k, value: values[k] }));
      }
    }
  }
  if (cmd === 'doctor' && rest.length) throw new UsageError(msg('cli.usage.extraArgs', { command: cmd }));
  if (cmd !== 'setup' && (values.agent !== undefined || values.project !== undefined)) throw new UsageError(msg('cli.usage.setupOnlyFlags'));
  if (cmd === 'setup') {
    if (rest.length) throw new UsageError(msg('cli.usage.extraArgs', { command: cmd }));
    if (values.site !== undefined && !values.site.trim()) throw new UsageError(msg('cli.usage.siteEmpty'));
    if (values.site === undefined && values.agent === undefined) throw new UsageError(msg('setup.needSiteOrAgent'));
    if (values.agent !== undefined && !SETUP_AGENTS.includes(values.agent)) throw new UsageError(msg('setup.badAgent'));
    if (values.project !== undefined && values.site === undefined) throw new UsageError(msg('setup.projectNeedsSite'));
  }
  if (cmd === 'rollback' && !rest[0]) throw new UsageError(msg('cli.usage.rollbackNeedPath'));
  if (cmd === 'find' && !rest[0]) throw new UsageError(msg('cli.usage.findNeedString'));
  if (cmd === 'upload' && !rest[0]) throw new UsageError(msg('cli.usage.uploadNeedPath'));
  if (cmd === 'replace' && rest.length < 2) throw new UsageError(msg('cli.usage.replaceNeedTwo'));
  if (values.page !== undefined && !/^\d+$/.test(values.page)) throw new UsageError(msg('cli.usage.pageNumber', { value: values.page }));
  if (values.wait !== undefined && !/^\d+$/.test(values.wait)) throw new UsageError(msg('cli.usage.waitNumber', { value: values.wait }));
  return { cmd, values: { ...values, pageExplicit: values.page !== undefined }, positionals: rest };
}

/** Код выхода по ошибке: SESSION_LOST → 3, ошибка аргументов → 2, остальное → 1. */
export function exitCodeFor(error) {
  if (!error) return EXIT.OK;
  if (error.exitCode !== undefined) return error.exitCode;
  if (error.code === 'SESSION_LOST') return EXIT.SESSION_LOST;
  return EXIT.REFUSED;
}

/** Машинный код статуса: последний сегмент ключа (`cli.browser.status.holderRunning` → `holderRunning`). */
export function statusCode(key) {
  return String(key).split('.').pop();
}

/**
 * Короткий итог для stdout: текст не длиннее ~20 строк либо JSON по --json.
 * Поля-`Message` переводятся на `lang`; в JSON `status`-`Message` даёт код `status` и текст `statusText`.
 */
export function formatSummary(summary, asJson, lang = 'en') {
  const rendered = render(lang, summary);
  if (asJson) {
    if (!isMessage(summary.status)) return JSON.stringify(rendered, null, 2);
    const out = {};
    for (const [k, v] of Object.entries(rendered)) {
      if (k === 'status') {
        out.status = statusCode(summary.status.key);
        out.statusText = v;
      } else {
        out[k] = v;
      }
    }
    return JSON.stringify(out, null, 2);
  }
  const lines = Object.entries(rendered).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return lines.slice(0, 20).join('\n');
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

/** Слои браузера, нужные командам цикла: tilda-copy требует tilda-zero и tilda-page. */
const CYCLE_LAYERS = ['tilda-zero', 'tilda-page', 'tilda-copy', 'tilda-upload'];

/**
 * Поднять браузер, открыть редактор страницы, собрать драйвер цикла, выполнить fn(driver, ctx),
 * закрыть браузер. SESSION_LOST уходит наверх как есть (код выхода 3).
 */
async function withEditor(values, fn) {
  const browser = await import('./lib/browser.mjs');
  const cycle = await import('./cycle.mjs');
  const session = await browser.open();
  try {
    const state = await browser.openEditor(session, values.page, { layers: CYCLE_LAYERS });
    const driver = cycle.browserDriver(session, values.page, { layers: CYCLE_LAYERS, browser });
    return await fn(driver, { state, cycle, session });
  } finally {
    await browser.close(session);
  }
}

async function cmdInventory(values) {
  return withEditor(values, async (driver, { cycle }) => {
    const list = await cycle.inventory(driver, values.page);
    return {
      status: msg('cli.inventory.status.taken'),
      pageid: values.page,
      records: list.length,
      zero: list.filter((r) => r.zeroIndex).length,
      hidden: list.filter((r) => r.hidden).map((r) => r.recordid),
      path: msg('cli.inventory.path', { pageid: values.page }),
    };
  });
}

async function cmdSnapshot(values, positionals) {
  return withEditor(values, async (driver, { cycle }) => {
    const inv = await cycle.inventory(driver, values.page);
    let targets;
    if (values.plan) {
      targets = cycle.planTargets(cycle.readPlan(values.plan));
    } else {
      const wanted = positionals.length ? new Set(positionals.map(String)) : null;
      targets = inv
        .filter((r) => !wanted || wanted.has(String(r.recordid)))
        .map((r) => ({ kind: String(r.tplid) === '396' ? 'zero' : 'record', page: values.page, recordid: String(r.recordid) }));
      if (wanted && targets.length !== wanted.size) throw new ToolError('RECORDS_NOT_IN_INVENTORY', msg('cli.snapshot.recordsNotFound', { ids: [...wanted].filter((id) => !targets.some((t) => t.recordid === id)).join(', ') }));
    }
    const saved = await cycle.snapshotBlocks(driver, targets, { source: 'tilda snapshot' });
    return { status: msg('cli.snapshot.status.taken'), pageid: values.page, blocks: saved.length, zero: saved.filter((s) => s.kind === 'zero').length, records: saved.filter((s) => s.kind === 'record').length, backups: saved.filter((s) => s.backup).length };
  });
}

/** Строка итога об одной операции плана: `Message` там, где в ней есть слова, и готовая строка для правки поля. */
function diffLine(d) {
  if (d.create) {
    return d.source
      ? msg('cli.apply.diff.createFromSource', { create: d.create, source: d.source, tplid: d.tplid })
      : msg('cli.apply.diff.createFromFields', { create: d.create, tplid: d.tplid, fields: d.fields });
  }
  if (d.blockHidden !== undefined) return msg(d.blockHidden === 'y' ? 'cli.apply.diff.blockHide' : 'cli.apply.diff.blockShow', { recordid: d.recordid });
  if (d.list) {
    const change = d.to !== undefined && typeof d.to !== 'object' ? ` → ${JSON.stringify(d.to).slice(0, 60)}` : '';
    return msg('cli.apply.diff.list', { recordid: d.recordid, list: d.list, target: `${d.lid || ''}${d.field ? '.' + d.field : ''}`, change });
  }
  if (d.sort) return msg('cli.apply.diff.sort', { recordid: d.recordid, from: d.from + 1, to: d.to + 1 });
  return `${d.recordid}${d.key ? `[${d.key}]` : ''}.${d.field}: ${JSON.stringify(d.from ?? '')} → ${JSON.stringify(d.to)}`.slice(0, 160);
}

/** Строка итога о геометрии: менялась ли она и сняты ли скриншоты. */
function layoutLine(r) {
  if (!r.layout) return msg('cli.apply.layout.none');
  if (r.shots && r.shots.length) return msg('cli.apply.layout.shots', { count: r.shots.length });
  return r.shotError ? msg('cli.apply.layout.noShotError', { error: r.shotError }) : msg('cli.apply.layout.noShot');
}

export function planSummary(r, values) {
  const diff = (r.diff || []).slice(0, 12).map(diffLine);
  return {
    status: r.dryRun ? msg('cli.apply.status.dryRun') : r.verify.length ? msg('cli.apply.status.verifyMismatch', { count: r.verify.length }) : msg('cli.apply.status.written'),
    pageid: r.pageid,
    plan: values.plan,
    ops: r.ops,
    payloads: r.payloads,
    written: r.written,
    created: r.created.map((c) => `${c.id} → ${c.recordid}${c.zeroIndex ? ` (zero#${c.zeroIndex})` : ''}`),
    uploads: (r.uploads || []).length,
    diff,
    verify: r.verify.slice(0, 5),
    layout: layoutLine(r),
    shots: (r.shots || []).map((f) => f.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')),
    ms: r.ms,
  };
}

async function cmdApply(values) {
  const cycleMod = await import('./cycle.mjs');
  const plan = cycleMod.readPlan(values.plan);
  if (values.pageExplicit && String(plan.page) !== String(values.page)) throw new UsageError(msg('cli.usage.pagePlanMismatch', { page: values.page, planPage: plan.page }));
  values = { ...values, page: String(plan.page) };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.apply(driver, plan, { dryRun: values['dry-run'], emitCalls: values['emit-calls'], planPath: values.plan });
    const summary = planSummary(r, values);
    summary.journal = r.journal ? r.journal.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/') : null;
    if (r.verify.length) summary.exitCode = EXIT.REFUSED;
    return summary;
  });
}

async function cmdRollback(values, positionals) {
  const journalMod = await import('./journal.mjs');
  const record = journalMod.readRecord(positionals[0]);
  if (values.pageExplicit && String(record.page) !== String(values.page)) throw new UsageError(msg('cli.usage.pageRecordMismatch', { page: values.page, recordPage: record.page }));
  values = { ...values, page: String(record.page), plan: positionals[0] };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.rollback(driver, positionals[0], { dryRun: values['dry-run'] });
    const summary = planSummary(r, values);
    summary.status = r.dryRun ? msg('cli.rollback.status.dryRun') : r.verify.length ? msg('cli.rollback.status.verifyMismatch', { count: r.verify.length }) : msg('cli.rollback.status.done', { ops: r.ops });
    summary.rollbackOf = r.rollbackOf;
    summary.skipped = r.skipped.map((x) => msg('cli.rollback.skipped', { target: `${x.kind}:${x.recordid || x.id}${x.field ? '.' + x.field : ''}`, reason: x.reason }));
    summary.journal = r.journal ? r.journal.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/') : null;
    if (r.verify.length) summary.exitCode = EXIT.REFUSED;
    return summary;
  });
}

/** Строка итога о пропущенных снимках удалённых блоков; пусто, если пропусков нет. */
function staleLine(n) {
  return n > 0 ? { skippedStale: msg('cli.find.skippedStale', { count: n }) } : {};
}

async function cmdFind(values, positionals) {
  const fr = await import('./find-replace.mjs');
  const { inventoryAgeMs } = await import('./apply-plan.mjs');
  const { baselineDir } = await import('./lib/paths.mjs');
  const r = fr.find(values.page, positionals[0]);
  const ageSec = Math.round(inventoryAgeMs(values.page, { baseDir: baselineDir() }) / 1000);
  return {
    status: msg('cli.find.status.found', { hits: r.hits.length, blocks: new Set(r.hits.map((h) => h.recordid)).size, scanned: r.blocks }),
    pageid: values.page,
    needle: positionals[0],
    hits: r.hits.slice(0, 15).map((h) => `${h.kind} ${h.recordid}${h.elem_id ? ' elem ' + h.elem_id : h.lid ? ' lid ' + h.lid : ''} .${h.field}: ${JSON.stringify(fr.normalize(h.value)).slice(0, 80)}`),
    skippedForm: r.skippedForm.map((x) => msg('cli.find.skippedForm', { address: `${x.kind} ${x.recordid} .${x.field}` })),
    ...staleLine(r.skippedStale),
    snapshotsAge: Number.isFinite(ageSec) ? msg('cli.find.snapshotsAge', { seconds: ageSec }) : msg('cli.find.noInventory'),
  };
}

async function cmdReplace(values, positionals) {
  const fr = await import('./find-replace.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const [needle, replacement] = positionals;
  const r = fr.buildReplacePlan(values.page, needle, replacement);
  const out = resolve(values.out || join(plansDir(), `replace-${values.page}.json`));
  const outSlash = out.replace(/\\/g, '/');
  if (r.plan.ops.length) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ _: `Replacement ${JSON.stringify(needle)} → ${JSON.stringify(replacement)} across the snapshots of page ${values.page}, built by tilda.mjs replace`, ...r.plan }, null, 2) + '\n', 'utf8');
  }
  return {
    status: r.plan.ops.length ? msg('cli.replace.status.planBuilt', { ops: r.plan.ops.length, replacements: r.replacements }) : msg('cli.replace.status.noHits'),
    pageid: values.page,
    plan: r.plan.ops.length ? outSlash : null,
    addresses: r.hits.slice(0, 15).map((h) => `${h.kind} ${h.recordid}${h.elem_id ? ' elem ' + h.elem_id : h.lid ? ' lid ' + h.lid : ''} .${h.field}`),
    skippedForm: r.skippedForm.map((x) => msg('cli.replace.skippedForm', { address: `${x.kind} ${x.recordid} .${x.field}` })),
    ...staleLine(r.skippedStale),
    next: r.plan.ops.length ? `node scripts/tilda.mjs apply --plan ${outSlash}` : null,
  };
}

async function cmdUpload(values, positionals) {
  const up = await import('./upload.mjs');
  const file = up.validateFile(positionals[0]); // отказ до браузера и до CDN
  return withEditor(values, async (driver) => {
    const r = await up.upload(driver, file.path);
    return { status: msg('cli.upload.status.uploaded', { file: r.file, cdnUrl: r.cdnUrl }), bytes: r.bytes, width: r.width, height: r.height, uuid: r.uuid, image: r.image };
  });
}

async function cmdPreview(values) {
  const cycleMod = await import('./cycle.mjs');
  const plan = cycleMod.readPlan(values.plan);
  if (values.pageExplicit && String(plan.page) !== String(values.page)) throw new UsageError(msg('cli.usage.pagePlanMismatch', { page: values.page, planPage: plan.page }));
  values = { ...values, page: String(plan.page) };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.preview(driver, plan, { shotsDir: values.out });
    return {
      status: msg('cli.preview.status.previewed', { count: r.previews.length }),
      pageid: r.pageid,
      plan: values.plan,
      shots: r.previews.map((p) => p.shot && p.shot.replace(/\\\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')).filter(Boolean),
      skipped: r.skipped.map((s) => msg('cli.preview.skipped', { recordid: s.recordid, kind: s.kind, reason: s.reason })),
    };
  });
}

function linksSummary(l) {
  const { summarize } = linksSummary.mod;
  return summarize(l.results);
}

async function cmdShot(values) {
  const shotMod = await import('./shot.mjs');
  const lc = await import('./link-check.mjs');
  linksSummary.mod = lc;
  const widths = shotMod.parseWidths(values.width);
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.shot(driver, values.page, { widths, outDir: values.out, links: values.links });
    const out = {
      status: msg('cli.shot.status.taken', { count: r.files.length }),
      pageid: r.pageid,
      widths: r.widths.map((w) => msg('cli.shot.width', { width: w.width, height: w.height, records: w.records, files: w.files.length })),
      files: r.files.map((f) => f.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')),
    };
    if (r.links) {
      const s = lc.summarize(r.links.results);
      out.status = msg('cli.shot.status.takenLinks', { count: r.files.length, checked: s.checked, brokenLinks: s.brokenLinks, brokenImages: s.brokenImages });
      out.links = s;
      if (s.brokenLinks || s.brokenImages || s.brokenAssets) out.exitCode = EXIT.REFUSED;
    }
    return out;
  });
}

async function cmdLinks(values) {
  const lc = await import('./link-check.mjs');
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.links(driver, values.page);
    const s = lc.summarize(r.results);
    return { status: msg('cli.links.status.checked', { checked: s.checked, brokenLinks: s.brokenLinks, brokenImages: s.brokenImages, brokenAssets: s.brokenAssets, warnings: s.warnings, internal: s.internal }), pageid: r.pageid, ...s, exitCode: s.brokenLinks || s.brokenImages || s.brokenAssets ? EXIT.REFUSED : EXIT.OK };
  });
}

/** Карта блоков: свежий инвентарь → вид страницы с подписями → файл человеку. */
async function cmdMap(values) {
  const shotMod = await import('./shot.mjs');
  const mapMod = await import('./map-blocks.mjs');
  const widths = values.width === undefined ? [mapMod.DEFAULT_MAP_WIDTH] : shotMod.parseWidths(values.width);
  const rel = (f) => f.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/');
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.mapBlocks(driver, values.page, { widths, outDir: values.out });
    if (values.open) r.files.forEach((f) => mapMod.openFile(f));
    return {
      status: msg(values.open ? 'cli.map.status.drawnOpened' : 'cli.map.status.drawn', { files: r.files.length, drawn: r.drawn, inventory: r.inventory }),
      pageid: r.pageid,
      widths: r.widths.map((w) => msg('cli.map.width', { width: w.width, height: w.height, drawn: w.drawn, missing: w.labels.length - w.drawn, files: w.files.length })),
      files: r.files.map(rel),
      legend: rel(r.legend),
    };
  });
}

/** Операции уровня страницы: слой tilda-project, редактор открывается на --page. */
async function cmdPage(values, positionals) {
  const ops = await import('./page-ops.mjs');
  const action = positionals[0];
  if (action === 'delete') {
    return { status: msg('cli.page.status.deleteManual'), pageid: values.page, steps: ops.deletePageInstructions(values.page) };
  }
  if (action === 'role') return pageRole(values, ops);
  if (action === 'title') return pageTitle(values, ops);
  if (action === 'publish' && !values.confirm) {
    log.warn('page', 'publishing without --confirm - refused before requesting the browser', { pageid: values.page });
    return { status: msg('cli.page.status.publishNotConfirmed'), pageid: values.page, exitCode: EXIT.REFUSED };
  }
  const browser = await import('./lib/browser.mjs');
  const session = await browser.open();
  try {
    if (action === 'list') {
      // Перечень читается со страницы проекта: редактор не нужен, --page не используется.
      await browser.openProject(session, { layers: ['tilda-project'] });
      const driver = { call: (fn, args = []) => browser.call(session.page, fn, args, { attempts: 1 }) };
      return await pageList(driver, values);
    }
    if (action === 'create' && !values.page) {
      // В пустом проекте открывать нечего: слой tilda-project работает и на странице проекта —
      // там есть getCSRF() и window.projectid (проверено 2026-09-22 на новом проекте без страниц).
      await browser.openProject(session, { layers: ['tilda-project'] });
    } else {
      await browser.openEditor(session, values.page, { layers: ['tilda-project'] });
    }
    const driver = { call: (fn, args = []) => browser.call(session.page, fn, args, { attempts: 1 }) };
    if (action === 'duplicate') {
      const r = await ops.duplicatePage(driver, values.page);
      const st = await browser.openEditor(session, r.pageid, { layers: [] });
      return { status: msg('cli.page.status.duplicated', { pageid: r.pageid }), source: r.source, pageid: r.pageid, title: st.title, records: st.records, editor: r.editor, note: msg('cli.page.note.notPublished') };
    }
    if (action === 'create') {
      const r = await ops.createPage(driver);
      const st = await browser.openEditor(session, r.pageid, { layers: [] });
      return { status: msg('cli.page.status.created', { pageid: r.pageid }), pageid: r.pageid, title: st.title, records: st.records, editor: r.editor };
    }
    const r = await ops.publishPage(driver, values.page, { confirmed: values.confirm === true });
    return { status: msg('cli.page.status.published', { pageid: r.pageid }), pageid: r.pageid, link: r.link, wslink: r.wslink, customdomain: r.customdomain, note: msg('cli.page.note.cdnDelay') };
  } finally {
    await browser.close(session);
  }
}

/**
 * `page role`: шапка и подвал (`#tab=ss_menu_header`) или главная (`--index`, `#tab=ss_menu_index`)
 * проекта через интерфейс настроек; без --confirm — отказ до браузера.
 */
async function pageRole(values) {
  const indexMode = values.index !== undefined;
  if (!values.confirm) {
    log.warn('page', 'page role without --confirm - refused before requesting the browser', { header: values.header, footer: values.footer, index: values.index });
    const target = indexMode ? msg('cli.page.roleTargetIndex') : msg('cli.page.roleTargetHeaderFooter');
    return { status: msg('cli.page.status.roleNeedsConfirm', { target }), exitCode: EXIT.REFUSED };
  }
  const role = await import('./page-role.mjs');
  const { resolveProjectId } = await import('./lib/config.mjs');
  const browser = await import('./lib/browser.mjs');
  const tab = indexMode ? 'ss_menu_index' : 'ss_menu_header';
  const session = await browser.open();
  try {
    await browser.openProjectSettings(session, { tab });
    const driver = {
      call: (fn, args = []) => browser.call(session.page, fn, args),
      callWithResponse: (fn, args, opts) => browser.callWithResponse(session.page, fn, args, opts),
      reload: () => browser.openProjectSettings(session, { tab }),
    };
    const r = await role.assignPageRoles(driver, {
      header: role.parseRoleArg(values.header),
      footer: role.parseRoleArg(values.footer),
      index: indexMode ? String(values.index) : undefined,
      confirmed: true,
      projectid: resolveProjectId(),
      protectedIds: protectedPages(),
    });
    const rollback = isMessage(r.rollback) ? r.rollback : cliHint(r.rollback);
    const base = { before: r.before, after: r.after, record: r.record, rollback, protectedAffected: protectedPages().length, next: cliHint('page list') };
    if (r.otherChanged.length) {
      // Имена настроек и (для счётчика) `Message` склеиваются вложенными сообщениями: «первая, вторая».
      const names = r.otherChanged.reduce((first, second) => msg('cli.page.namesJoin', { first, second }));
      return { status: msg('cli.page.status.roleOtherChanged', { names }), ...base, otherChanged: r.otherChanged, exitCode: EXIT.REFUSED };
    }
    if (!r.changed) return { status: msg('cli.page.status.rolesUnchanged'), ...base };
    return { status: indexMode ? msg('cli.page.status.indexAssigned') : msg('cli.page.status.rolesAssigned'), ...base };
  } finally {
    await browser.close(session);
  }
}

/**
 * `page list`: перечень страниц проекта в файл (`--out` или <TILDA_BASELINE_DIR>/pages/<projectid>.json),
 * в stdout — итог. Исходы: страницы есть или проект пуст — код 0; записей ноль без признака
 * пустого проекта — «не распознан», код 1.
 */
/**
 * `page title --page --title`: заголовок страницы через окно настроек со страницы проекта
 * (после OK кабинет обновляет список без перезагрузки); итог — заголовок из перечитанного редактора.
 */
async function pageTitle(values, ops) {
  const browser = await import('./lib/browser.mjs');
  const guard = protectedPages();
  if (guard.includes(String(values.page))) return { status: msg('cli.page.status.protectedPage', { pageid: values.page }), exitCode: EXIT.REFUSED };
  const session = await browser.open();
  try {
    await browser.openProject(session, { layers: ['tilda-project'] });
    const driver = { callWithResponse: (fn, args, opts) => browser.callWithResponse(session.page, fn, args, opts) };
    const r = await ops.setPageTitle(driver, values.page, values.title, { protectedIds: guard });
    const st = await browser.openEditor(session, values.page, { layers: [] });
    // document.title редактора — «Tilda: <заголовок>»; в итоге — сам заголовок.
    return { status: msg('cli.page.status.titleSet', { pageid: r.pageid }), pageid: r.pageid, title: String(st.title ?? '').replace(/^tilda:\s*/i, ''), next: cliHint('page list') };
  } finally {
    await browser.close(session);
  }
}

/**
 * Перечень страниц проекта в файл. По умолчанию — тестовый проект и его защищённые страницы;
 * `donor pages` передаёт ID донора, пустой список защищённых и `titles: false` (заголовки страниц
 * донора в stdout не печатаются — в них имя компании).
 */
async function pageList(driver, values, { projectid: projectOpt, protectedIds, titles = true } = {}) {
  const { listPages } = await import('./page-list.mjs');
  const { resolveProjectId } = await import('./lib/config.mjs');
  const { baselineDir } = await import('./lib/paths.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const projectid = String(projectOpt ?? resolveProjectId());
  const r = await listPages(driver, { projectid, protectedIds: protectedIds ?? protectedPages() });
  const out = resolve(values.out || `${baselineDir()}/pages/${projectid}.json`);
  const outSlash = out.replace(/\\/g, '/');
  log.debug('page', 'page list', { projectid, out: outSlash, count: r.pages.length });
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ projectid, source: r.source, captured: new Date().toISOString(), pages: r.pages, skipped: r.skipped }, null, 2)}\n`);
  } catch (e) {
    log.error('page', 'list received but the file was not written', { out: outSlash, error: e.message });
    // message остаётся исходным (английский текст системной ошибки); для пользователя — ключ с путём.
    throw attachMessage(e, msg('cli.page.listNotWritten', { path: outSlash, detail: e.message }));
  }
  const summary = { projectid, source: r.source, pages: r.pages.length, path: outSlash };
  if (r.pages.length) {
    const protectedCount = r.pages.filter((p) => p.protected).length;
    const head = r.pages.slice(0, 5).map((p) => (titles ? `${p.pageid} ${p.title}` : `${p.pageid}${p.role ? ` (${p.role})` : ''}`)).join('; ');
    Object.assign(summary, { status: msg('cli.page.status.listed', { count: r.pages.length, protectedCount }), protected: protectedCount, preview: r.pages.length > 5 ? msg('cli.page.previewMore', { head, rest: r.pages.length - 5 }) : head });
  } else if (r.emptyMarker) {
    summary.status = msg('cli.page.status.noPages');
  } else {
    Object.assign(summary, { status: msg('cli.page.status.listUnrecognized'), note: msg('cli.page.note.listUnrecognized'), exitCode: EXIT.REFUSED });
  }
  if (r.skipped.length) summary.skipped = r.skipped.map((s) => `${s.reason}: ${s.count}`).join('; ');
  if (values.json) summary.list = r.pages;
  return { status: summary.status, ...summary };
}

/** Накат на живую главную: пять шагов внутри одной сессии браузера. */
async function cmdPromote(values, positionals) {
  const promoteMod = await import('./promote.mjs');
  const plans = promoteMod.readPlans([values.plan, ...positionals].filter(Boolean));
  for (const { path, plan } of plans) {
    if (String(plan.page) !== values.from) throw new UsageError(msg('cli.usage.promotePlanPage', { path, planPage: plan.page, from: values.from }));
  }
  const browser = await import('./lib/browser.mjs');
  const cycle = await import('./cycle.mjs');
  const ops = await import('./page-ops.mjs');
  const rel = (f) => (f ? String(f).replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/') : f);
  const session = await browser.open();
  try {
    const pace = { ...promoteMod.SNAPSHOT_PACE };
    if (values.batch !== undefined) pace.batch = Number(values.batch);
    if (values.delay !== undefined) pace.delayMs = Number(values.delay);
    if (values.pause !== undefined) pace.pauseMs = Number(values.pause) * 1000;
    const betweenSnapshotsMs = values.pause !== undefined ? Number(values.pause) * 1000 : promoteMod.BETWEEN_SNAPSHOTS_MS;
    log.info('promote', 'snapshot mode', { ...pace, betweenSnapshotsMs });
    const r = await promoteMod.promote({ browser, session, cycle, ops }, { plans, from: values.from, to: values.to, unprotect: values.unprotect, dryRun: values['dry-run'], pace, betweenSnapshotsMs });
    return {
      status: msg('cli.promote.status.done', { to: r.to, plans: r.applied.length, backup: r.backup, backupName: r.backupName }),
      from: r.from,
      to: r.to,
      backup: r.backup,
      backupName: r.backupName,
      compare: msg('cli.promote.compare', { blocks: r.compare.blocks, explained: r.compare.explained }),
      applied: r.applied.map((a) => msg('cli.promote.applied', {
        plan: a.plan,
        written: a.written,
        verify: a.verify,
        created: a.created && a.created.length ? msg('cli.promote.appliedCreated', { count: a.created.length }) : '',
        dryRun: a.dryRun ? msg('cli.promote.appliedDryRun') : '',
      })),
      journal: r.applied.map((a) => rel(a.journal)).filter(Boolean),
      report: rel(r.reportPath),
      capture: r.analysis ? msg('cli.promote.capture', { calls: r.analysis.calls, span: r.analysis.spanSec, max: r.analysis.maxPerMinute }) : null,
      note: msg('cli.promote.note.notPublished', { command: 'page publish --page <id> --confirm' }),
    };
  } catch (e) {
    if (e && e.name === 'PromoteError' && e.report) {
      const a = e.report.analysis;
      const lost = a && a.firstLost;
      return {
        // Причина останова: с ключом — как сообщение (переводится), иначе английский текст ошибки.
        status: msg('cli.promote.status.stopped', { code: e.code, reason: e.key ? msg(e.key, e.params) : e.message }),
        backup: e.report.backup,
        report: rel(e.report.reportPath),
        capture: a ? msg('cli.promote.captureStopped', { calls: a.calls, span: a.spanSec, max: a.maxPerMinute, retry: a.retryAfter ? `, Retry-After ${a.retryAfter}` : '' }) : null,
        firstLost: lost ? msg('cli.promote.firstLost', { index: lost.index, since: lost.sinceStartSec, path: lost.url.replace(/^https:\/\/tilda\.ru/, ''), status: lost.status, marker: lost.marker || msg('cli.promote.htmlNoMarker'), in60: lost.inLast60s, in120: lost.inLast120s, in300: lost.inLast300s }) : null,
        setCookie: a && a.setCookieAt.length ? a.setCookieAt.slice(0, 5).map((x) => `#${x.index} ${x.url.replace(/^https:\/\/tilda\.ru/, '')} ${x.status}`) : null,
        problems: (e.report.problems || e.report.compare?.problems || []).slice(0, 8),
        exitCode: e.code === 'SESSION_LOST' ? EXIT.SESSION_LOST : EXIT.REFUSED,
      };
    }
    throw e;
  } finally {
    await browser.close(session);
  }
}

/** Режим реплик: накопление операций, локальный diff, запись разом, сброс. */
async function cmdStage(values, positionals) {
  const sp = await import('./session-plan.mjs');
  const rel = (f) => (f ? String(f).replace(/\\/g, '/').replace(/^.*[\\/]scripts\//, 'scripts/').replace(/^.*site-baseline\//, 'site-baseline/') : f);
  const action = STAGE_ACTIONS.includes(positionals[0]) ? positionals[0] : 'add';
  if (action === 'list') {
    const all = sp.listSessions(values.page);
    return {
      status: all.length ? msg('cli.stage.status.plans', { count: all.length }) : msg('cli.stage.status.noPlans'),
      pageid: values.page,
      sessions: all.slice(0, 10).map((x) => (x.session.applied
        ? msg('cli.stage.sessionApplied', { path: rel(x.path), ops: x.session.ops.length, at: x.session.applied })
        : msg('cli.stage.sessionOpen', { path: rel(x.path), ops: x.session.ops.length }))),
    };
  }
  const open = sp.listSessions(values.page).find((x) => !x.session.applied);
  if (action === 'diff' || action === 'drop' || action === 'apply') {
    if (!open) return { status: msg('cli.stage.status.noOpenPlan'), pageid: values.page, exitCode: EXIT.REFUSED };
    if (action === 'drop') {
      sp.dropSession(open.path);
      return { status: msg('cli.stage.status.dropped', { ops: open.session.ops.length }), pageid: values.page, plan: rel(open.path) };
    }
    if (action === 'diff') {
      const d = sp.diffSession(open.session);
      return { status: msg('cli.stage.status.diff', { ops: d.ops, changes: d.changes.length }), pageid: values.page, plan: rel(open.path), changes: d.changes.slice(0, 15), next: `node scripts/tilda.mjs stage apply --page ${values.page}` };
    }
    const plan = { page: open.session.page, name: open.session.name, resStrategy: open.session.resStrategy, ops: open.session.ops };
    return withEditor({ ...values, page: String(plan.page) }, async (driver, { cycle }) => {
      const r = await cycle.apply(driver, plan, { dryRun: values['dry-run'], emitCalls: values['emit-calls'], planPath: open.path });
      const summary = planSummary(r, { plan: rel(open.path) });
      summary.journal = rel(r.journal);
      if (r.verify.length) summary.exitCode = EXIT.REFUSED;
      else if (!r.dryRun) {
        sp.markApplied(open.session, new Date().toISOString());
        summary.closed = msg('cli.stage.note.planClosed');
      }
      return summary;
    });
  }
  const ops = sp.parseOpArgument(values.plan || positionals[0]);
  const { path, session } = open || sp.openSession(values.page);
  const results = ops.map((op) => sp.stageOp(session, op));
  sp.writeSession(session);
  const d = sp.diffSession(session);
  return {
    status: msg('cli.stage.status.staged', { ops: d.ops, added: results.filter((r) => r.action === 'added').length, replaced: results.filter((r) => r.action === 'replaced').length, changes: d.changes.length }),
    pageid: values.page,
    plan: rel(path),
    staged: results.map((r) => {
      const sign = r.action === 'added' ? '+' : '~';
      return r.overwritten && r.overwritten.length
        ? msg('cli.stage.stagedOverwritten', { sign, kind: r.kind, address: r.address, fields: r.overwritten.join(', ') })
        : msg('cli.stage.staged', { sign, kind: r.kind, address: r.address });
    }),
    changes: d.changes.slice(0, 15),
    next: msg('cli.stage.next.add', { command: `node scripts/tilda.mjs stage apply --page ${values.page}` }),
  };
}

async function cmdJournal(values) {
  const journalMod = await import('./journal.mjs');
  const list = journalMod.listRecords(values.page);
  return {
    status: list.length ? msg('cli.journal.status.records', { count: list.length }) : msg('cli.journal.status.empty'),
    pageid: values.page,
    records: list.slice(0, 15).map((r) => {
      const params = { at: r.at, name: r.plan.name, blocks: r.blocks.length, written: r.written, verify: r.verify.length, rollbackOf: r.rollbackOf, file: r.file.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/') };
      return r.rollbackOf ? msg('cli.journal.recordRollback', params) : msg('cli.journal.record', params);
    }),
  };
}

async function cmdVerify(values) {
  const cycleMod = await import('./cycle.mjs');
  const plan = cycleMod.readPlan(values.plan);
  if (values.pageExplicit && String(plan.page) !== String(values.page)) throw new UsageError(msg('cli.usage.pagePlanMismatch', { page: values.page, planPage: plan.page }));
  values = { ...values, page: String(plan.page) };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.verifyPlan(driver, plan);
    return { status: r.verify.length ? msg('cli.verify.status.verifyMismatch', { count: r.verify.length }) : msg('cli.verify.status.verifyClean'), pageid: r.pageid, plan: values.plan, blocks: r.blocks, verify: r.verify.slice(0, 5), exitCode: r.verify.length ? EXIT.REFUSED : EXIT.OK };
  });
}

async function cmdBrowser(values, positionals) {
  const browser = await import('./lib/browser.mjs');
  const action = positionals[0];
  const role = values.donor ? 'donor' : 'test';
  const profile = browser.profileDir(role);
  const flag = values.donor ? ' --donor' : '';
  log.debug('browser', 'action', { action, role, profile });
  if (action === 'status') {
    const st = browser.daemonStatus(profile);
    return st ? { status: msg('cli.browser.status.holderRunning'), role, pid: st.pid, port: st.port, startedAt: st.startedAt, profile } : { status: msg('cli.browser.status.holderNotRunning'), role, profile };
  }
  if (action === 'start') {
    const st = await browser.startDaemon({ role });
    return { status: msg('cli.browser.status.holderRunning'), role, pid: st.pid, port: st.port, startedAt: st.startedAt, profile, window: st.minimized === false ? msg('cli.browser.window.visible') : msg('cli.browser.window.minimized', { command: `browser${flag} show` }) };
  }
  if (action === 'show' || action === 'hide') {
    const done = await browser.setDaemonWindow(action === 'show' ? 'normal' : 'minimized', { role });
    if (action === 'show') return { status: msg('cli.browser.status.windowShown'), role, next: msg('cli.browser.next.minimize', { command: `browser${flag} hide` }) };
    return { status: done ? msg('cli.browser.status.windowMinimized') : msg('cli.browser.status.holderNotRunning'), role };
  }
  const stopped = await browser.stopDaemon({ role });
  return { status: stopped ? msg('cli.browser.status.holderStopped') : msg('cli.browser.status.holderWasNotRunning'), role };
}

/** `session --donor`: вход аккаунта донора проверяется на странице его проекта; редактор не открывается, запись в слое запрещена. */
async function cmdDonorSession(values, browser, waitSec) {
  const session = await browser.open({ role: 'donor' });
  try {
    let state;
    let loggedIn = false;
    try {
      state = await browser.openProject(session, { layers: [] });
    } catch (e) {
      if (e.code !== 'SESSION_LOST') throw e;
      log.info('session', 'no donor session - sign in in the open browser window', { waitSec });
      if (waitSec <= 0) throw e;
      await browser.waitForLogin(session, null, { timeoutMs: waitSec * 1000, target: 'project' });
      state = await browser.openProject(session, { layers: [] });
      loggedIn = true;
    }
    return {
      status: msg('cli.session.status.donorAlive'),
      role: 'donor',
      projectid: state.projectid,
      loggedIn,
      profile: session.profileDir,
      note: msg('cli.session.note.donorReadOnly'),
    };
  } finally {
    await browser.close(session);
  }
}

async function cmdSession(values) {
  const browser = await import('./lib/browser.mjs');
  const waitSec = values.wait !== undefined ? Number(values.wait) : 600;
  if (values.donor) return cmdDonorSession(values, browser, waitSec);
  const session = await browser.open();
  try {
    let state;
    let loggedIn = false;
    try {
      state = await browser.openEditor(session, values.page);
    } catch (e) {
      if (e.code !== 'SESSION_LOST') throw e;
      log.info('session', 'no session - sign in in the open browser window', { waitSec });
      if (waitSec <= 0) throw e;
      await browser.waitForLogin(session, values.page, { timeoutMs: waitSec * 1000 });
      state = await browser.openEditor(session, values.page);
      loggedIn = true;
    }
    return {
      status: msg('cli.session.status.alive'),
      pageid: state.pageid,
      title: state.title,
      records: state.records,
      layers: state.layers.map((l) => msg('cli.session.layer', { name: l.name, bytes: l.bytes })),
      loggedIn,
      profile: session.profileDir,
      protectedPages: protectedPages(),
    };
  } finally {
    await browser.close(session);
  }
}

/** `donor map`: метки карты сайта ↔ страницы донора, без сети. */
async function donorMap(values) {
  const { mapDonorPages } = await import('./donor-map.mjs');
  const { getProjectIdFor } = await import('./lib/config.mjs');
  const r = mapDonorPages({ slug: values.slug, donorProjectId: getProjectIdFor('donor') });
  const blocking = r.unmatched.filter((u) => u.code !== 'missing');
  const summary = {
    status: msg('cli.donor.status.mapped', { slug: values.slug, matched: r.matched.length, unmatched: r.unmatched.length }),
    matched: r.matched.slice(0, 20).map((m) => `${m.label} → ${m.donorPageid} (${m.by})`),
    unmatched: r.unmatched.map((u) => msg('cli.donor.labelReason', { label: u.label, reason: u.reason })),
    path: r.path,
    exitCode: blocking.length ? EXIT.REFUSED : EXIT.OK,
  };
  if (values.json) summary.matchedFull = r.matched;
  return summary;
}

/** Слои сессии донора для `donor copy`: чтение состава и буфер; tilda-copy/upload там не нужны. */
const DONOR_LAYERS = ['tilda-zero', 'tilda-page', 'tilda-donor'];

/**
 * `donor copy`: перенос блоков страницы донора на приёмник через буфер аккаунта донора.
 * Единственная команда под входом донора, меняющая тестовый проект — запускается по явному
 * «делай» владельца. Две сессии: тестовая (снимки, удаление при --replace, сверка) и донора
 * (копирование в буфер, вставка с allow-списком только на приёмник).
 */
async function donorCopy(values) {
  const { readSite, resolveSource } = await import('./lib/reference-store.mjs');
  const dc = await import('./donor-copy.mjs');
  const browser = await import('./lib/browser.mjs');
  let source = values.from;
  let target = values.to;
  let label = null;
  let entryRole = null;
  let donorTitle = null;
  let alias = null;
  if (values.source) {
    const site = readSite(values.slug);
    const entry = site && resolveSource(site, values.source);
    if (!entry) return { status: msg('cli.donor.status.copyLabelNotFound', { label: values.source, slug: values.slug }), exitCode: EXIT.REFUSED };
    label = entry.label;
    entryRole = entry.role ?? null;
    donorTitle = entry.donorTitle ?? null;
    // Адрес страницы донора для приёмника; нет перечня донора — перенос идёт без адреса.
    try {
      const { getProjectIdFor } = await import('./lib/config.mjs');
      const { readDonorPages } = await import('./donor-map.mjs');
      const da = await import('./donor-aliases.mjs');
      const found = da.donorAliasFor(entry, da.byPageid(readDonorPages(getProjectIdFor('donor'))));
      alias = found.alias ?? null;
      if (found.reason) log.debug('donor', 'target alias is not set', { label, reason: messageText(found.reason) });
    } catch (e) {
      log.warn('donor', 'donor alias is not determined - copying without an alias', { label, error: String(e.message || e).slice(0, 160) });
    }
    source ??= entry.donorPageid;
    target ??= entry.pageid;
    if (!source) return { status: msg('cli.donor.status.copyNoDonorPageid', { label, command: `donor map --slug ${values.slug}` }), exitCode: EXIT.REFUSED };
    if (!target) return { status: msg('cli.donor.status.copyNoPageid', { label, command: `reference pages --slug ${values.slug} --create` }), exitCode: EXIT.REFUSED };
  }
  source = String(source);
  target = String(target);
  if (source === target) return { status: msg('cli.donor.status.copySameSourceTarget'), exitCode: EXIT.USAGE };
  if (protectedPages().includes(target)) return { status: msg(dc.COPY_REASONS.protectedTarget, { id: target }), exitCode: EXIT.REFUSED };
  log.info('donor', 'copy', { label, source, target, replace: values.replace, dryRun: values['dry-run'] });
  const test = await browser.open({ role: 'test' });
  let donor;
  try {
    donor = await browser.open({ role: 'donor' });
    const drivers = {
      test: {
        call: (fn, a = [], o = {}) => withLoginHint(browser.call(test.page, fn, a, o), browser.LOGIN_HINTS.test),
        openEditor: (p) => withLoginHint(browser.openEditor(test, p, { layers: CYCLE_LAYERS }), browser.LOGIN_HINTS.test),
        setWritable: async () => {},
        editorState: () => browser.editorState(test.page),
        // Заголовок пишется со страницы проекта (без перезагрузки редактора), затем редактор открывается снова.
        setTitle: async (pageid, title) => {
          const ops = await import('./page-ops.mjs');
          await browser.openProject(test, { layers: ['tilda-project'] });
          const d = { callWithResponse: (fn, a, o) => browser.callWithResponse(test.page, fn, a, o) };
          const r = await ops.setPageTitle(d, pageid, title, { protectedIds: protectedPages() });
          await browser.openEditor(test, pageid, { layers: [] });
          return r;
        },
        // Адрес приёмника читается перечнем страниц проекта (тот же запрос, что page list).
        pageAlias: async (pageid) => {
          const { listPages } = await import('./page-list.mjs');
          const { resolveProjectId } = await import('./lib/config.mjs');
          await browser.openProject(test, { layers: ['tilda-project'] });
          const d = { call: (fn, a = []) => browser.call(test.page, fn, a, { attempts: 1 }) };
          const r = await listPages(d, { projectid: resolveProjectId(), protectedIds: protectedPages() });
          return r.pages.find((p) => String(p.pageid) === String(pageid))?.alias ?? '';
        },
        setAlias: async (pageid, value) => {
          const ops = await import('./page-ops.mjs');
          await browser.openProject(test, { layers: ['tilda-project'] });
          const d = { callWithResponse: (fn, a, o) => browser.callWithResponse(test.page, fn, a, o) };
          return ops.setPageAlias(d, pageid, value, { protectedIds: protectedPages() });
        },
      },
      donor: { call: (fn, a = [], o = {}) => withLoginHint(browser.call(donor.page, fn, a, o), browser.LOGIN_HINTS.donor), openEditor: (p) => withLoginHint(browser.openEditor(donor, p, { layers: DONOR_LAYERS }), browser.LOGIN_HINTS.donor), setWritable: (l) => browser.setWritablePages(donor.page, l) },
    };
    const r = await dc.copyDonorPage(drivers, { sourcePageid: source, targetPageid: target, replace: values.replace, dryRun: values['dry-run'], protectedPages: protectedPages(), label, role: entryRole, donorTitle, alias });
    const summary = { label, source: r.source, target: r.target, blocks: r.blocks };
    if (r.dryRun) {
      const onTarget = r.before ? msg('cli.donor.dryRunTarget', { before: r.before, replace: msg(values.replace ? 'cli.donor.yes' : 'cli.donor.no') }) : '';
      return { status: msg('cli.donor.status.dryRun', { blocks: r.blocks, target: onTarget }), ...summary, plan: r.plan.steps.join(' → ') };
    }
    const next = label ? cliHint(`donor verify --slug ${values.slug} --source ${label}`) : undefined;
    return {
      status: r.ok ? msg('cli.donor.status.copied', { pasted: r.pasted }) : msg('cli.donor.status.copyOrderMismatch', { pasted: r.pasted, blocks: r.blocks }),
      ...summary,
      replaced: r.replaced,
      record: r.record,
      ...(r.title ? { title: r.title } : {}),
      ...(r.alias ? { alias: r.alias } : {}),
      ...(r.ok ? {} : { expected: r.verify.expected.join(','), actual: r.verify.actual.join(','), hiddenMismatch: r.verify.hiddenMismatch }),
      ...(next ? { next } : {}),
      exitCode: r.ok ? EXIT.OK : EXIT.REFUSED,
    };
  } finally {
    if (donor) await browser.close(donor);
    await browser.close(test);
  }
}

/**
 * `donor aliases`: адреса страниц копии как у страниц донора. Только тестовая сессия:
 * вход донора не нужен — адреса донора берутся из файла `donor pages`. Окно настроек открывается
 * на свежей странице проекта перед каждой записью (после отказа окно остаётся открытым).
 */
async function donorAliases(values) {
  const da = await import('./donor-aliases.mjs');
  const { getProjectIdFor, resolveProjectId } = await import('./lib/config.mjs');
  const dryRun = Boolean(values['dry-run']);
  const browser = dryRun ? null : await import('./lib/browser.mjs');
  const session = dryRun ? null : await browser.open({ role: 'test' });
  try {
    const driver = {
      callWithResponse: async (fn, a, o) => {
        await browser.openProject(session, { layers: ['tilda-project'] });
        return browser.callWithResponse(session.page, fn, a, o);
      },
    };
    const r = await da.assignDonorAliases(driver, { slug: values.slug, donorProjectId: getProjectIdFor('donor'), testProjectId: resolveProjectId(), protectedIds: protectedPages(), dryRun });
    const skipped = r.skipped.map((s) => msg('cli.donor.labelReason', { label: s.label, reason: s.reason }));
    if (r.dryRun) {
      return { status: msg('cli.donor.status.aliasesDryRun', { todo: r.todo.length, skipped: r.skipped.length }), todo: r.todo.map((x) => x.label).join(', '), skipped, next: cliHint(`donor aliases --slug ${values.slug}`) };
    }
    return {
      status: msg('cli.donor.status.aliasesWritten', { assigned: r.assigned.length, todo: r.todo.length, skipped: r.skipped.length, failed: r.failed.length, stopped: r.stopped ? msg('cli.donor.stoppedAfterFailures') : '' }),
      assigned: r.assigned.map((a) => a.label).join(', '),
      skipped,
      ...(r.failed.length ? { failed: r.failed.map((f) => `${f.label}: ${f.code} ${f.reason}`) } : {}),
      next: cliHint('page list'),
      exitCode: r.failed.length ? EXIT.REFUSED : EXIT.OK,
    };
  } finally {
    if (session) await browser.close(session);
  }
}

/**
 * `donor links`: ссылки на домен донора → относительные пути на страницы копии. Только
 * тестовая сессия: свежие снимки страницы метки, план по снимкам, затем обычный цикл apply
 * (снимки, запись, перечитывание, verify). Пути страниц копии — файл `page list` (после `donor aliases`).
 */
async function donorLinks(values) {
  const { readSite, resolveSource, readManifest } = await import('./lib/reference-store.mjs');
  const dl = await import('./donor-links.mjs');
  const { readPageList } = await import('./donor-aliases.mjs');
  const { readDonorPages } = await import('./donor-map.mjs');
  const { resolveProjectId, getProjectIdFor } = await import('./lib/config.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const site = readSite(values.slug);
  const entry = site && resolveSource(site, values.source);
  if (!entry) return { status: msg('cli.donor.status.linksLabelNotFound', { label: values.source, slug: values.slug }), exitCode: EXIT.REFUSED };
  if (!entry.pageid) return { status: msg('cli.donor.status.linksNoPageid', { label: entry.label }), exitCode: EXIT.REFUSED };
  const pageid = String(entry.pageid);
  if (protectedPages().includes(pageid)) return { status: msg('cli.donor.status.linksPageProtected', { pageid }), exitCode: EXIT.REFUSED };
  const manifest = readManifest(values.slug);
  if (!manifest?.url) return { status: msg('cli.donor.status.linksNoReferenceUrl', { slug: values.slug }), exitCode: EXIT.REFUSED };
  const hosts = dl.donorHosts(manifest.url);
  const testPages = readPageList(resolveProjectId());
  const knownPaths = dl.knownPathsFrom(testPages);
  // Ссылки `/page<ID донора>.html` → страницы копии по парам карты.
  const donorLinks = dl.donorPageLinks(site, testPages, readDonorPages(getProjectIdFor('donor')));
  log.info('donor', 'links', { label: entry.label, pageid, knownPaths: knownPaths.size, donorLinks: donorLinks.size, dryRun: values['dry-run'] });
  return withEditor({ ...values, page: pageid }, async (driver, { cycle }) => {
    const inv = await cycle.inventory(driver, pageid);
    const targets = inv.map((r) => ({ kind: String(r.tplid) === '396' ? 'zero' : 'record', page: pageid, recordid: String(r.recordid) }));
    await cycle.snapshotBlocks(driver, targets, { source: 'tilda donor links' });
    const r = dl.buildLinkRewritePlan(pageid, { hosts, knownPaths, donorLinks, recordids: inv.map((x) => String(x.recordid)) });
    const base = {
      label: entry.label,
      pageid,
      ...staleLine(r.skippedStale),
      ...(r.unchanged.length ? { unchanged: r.unchanged.map((u) => `${u.recordid}.${u.field}: ${u.reason}`) } : {}),
      ...(r.skippedForm.length ? { forms: r.skippedForm.map((x) => `${x.recordid}.${x.field}: ${x.reason}`) } : {}),
    };
    if (!r.plan.ops.length) return { status: msg('cli.donor.status.linksNothing', { unchanged: r.unchanged.length, forms: r.skippedForm.length }), ...base };
    const out = join(plansDir(), `donor-links-${values.slug}-${entry.label}.json`);
    const outSlash = out.replace(/\\/g, '/');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ _: `Donor domain links to relative paths, label ${entry.label}; built by tilda.mjs donor links`, ...r.plan }, null, 2)}\n`, 'utf8');
    if (values['dry-run']) {
      return { status: msg('cli.donor.status.linksDryRun', { changed: r.changed, ops: r.plan.ops.length }), ...base, plan: outSlash, next: cliHint(`donor links --slug ${values.slug} --source ${entry.label}`) };
    }
    const a = await cycle.apply(driver, r.plan, { planPath: out });
    const summary = planSummary(a, { plan: outSlash });
    summary.status = a.verify.length ? msg('cli.donor.status.linksRewrittenMismatch', { verify: a.verify.length }) : msg('cli.donor.status.linksRewritten', { changed: r.changed });
    summary.journal = a.journal ? a.journal.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/') : null;
    return { ...summary, ...base, exitCode: a.verify.length ? EXIT.REFUSED : EXIT.OK };
  });
}

/**
 * `donor check`: проверки после переноса по меткам слепка. Только чтение тестового
 * проекта: на каждой метке свежий инвентарь и снимки блоков, вид страницы, HTML-блоки; итог —
 * `reports/checks.json` и раздел проверок в `reports/transfer-summary.md`.
 */
async function donorCheck(values) {
  const { readSite, readManifest } = await import('./lib/reference-store.mjs');
  const dc = await import('./donor-check.mjs');
  const { donorHosts } = await import('./donor-links.mjs');
  const { readPageList } = await import('./donor-aliases.mjs');
  const { readDonorPages } = await import('./donor-map.mjs');
  const { resolveProjectId, getProjectIdFor } = await import('./lib/config.mjs');
  const site = readSite(values.slug);
  if (!site) return { status: msg('cli.donor.status.checkNoSite', { slug: values.slug }), exitCode: EXIT.REFUSED };
  const manifest = readManifest(values.slug);
  if (!manifest?.url) return { status: msg('cli.donor.status.checkNoReferenceUrl', { slug: values.slug }), exitCode: EXIT.REFUSED };
  const labels = values.source ? String(values.source).split(',').map((l) => l.trim()).filter(Boolean) : null;
  const openLabel = (entry, fn) => {
    const pageid = String(entry.pageid);
    return withEditor({ ...values, page: pageid }, async (driver, { cycle }) => fn({
      // Свежий инвентарь и снимки живых блоков: formmsgurl ищется по снимкам на диске.
      listRecords: async () => {
        const inv = await cycle.inventory(driver, pageid);
        const targets = inv.map((r) => ({ kind: String(r.tplid) === '396' ? 'zero' : 'record', page: pageid, recordid: String(r.recordid) }));
        await cycle.snapshotBlocks(driver, targets, { source: 'tilda donor check' });
        return inv;
      },
      pageHtml: () => driver.pageHtml(),
      readRecord: (recordid) => driver.call('readRecordSnapshot', [pageid, recordid]),
    }));
  };
  const r = await dc.runDonorCheck(openLabel, {
    slug: values.slug,
    site,
    donorPages: readDonorPages(getProjectIdFor('donor')),
    testPages: readPageList(resolveProjectId()),
    referenceHost: new URL(manifest.url).hostname,
    hosts: donorHosts(manifest.url),
    labels,
    lang: values.uiLang,
  });
  const rel = (p) => p.replace(/\\/g, '/').replace(/^.*site-reference\//, 'site-reference/');
  const { auditKindMessage } = await import('./reference-site.mjs');
  return {
    status: msg('cli.donor.status.checked', {
      labels: r.labels.length - r.failed,
      failed: r.failed,
      violations: r.linkViolations,
      map: msg(r.map.ok ? 'cli.donor.checkMapComplete' : 'cli.donor.checkMapIncomplete'),
      index: msg(r.index.ok ? 'cli.donor.checkIndexOk' : 'cli.donor.checkIndexWrong'),
    }),
    violations: r.labels.flatMap((l) => (l.violations ?? []).map((v) => msg('cli.donor.violationLine', { label: l.label, kind: auditKindMessage(v.kind), count: v.count }))).slice(0, 20),
    ...(r.failed ? { failed: r.labels.filter((l) => l.error).map((l) => msg('cli.donor.labelReason', { label: l.label, reason: msg(dc.CHECK_REASONS.failed, l.errorParams) })) } : {}),
    htmlBlocks: r.labels.reduce((n, l) => n + (l.htmlBlocks ?? []).filter((b) => b.placeholder || b.hosts.length).length, 0),
    forms: r.labels.reduce((n, l) => n + (l.forms?.length ?? 0), 0),
    skipped: r.skipped.map((s) => msg('cli.donor.labelReason', { label: s.label, reason: dc.checkReasonMessage(s) })),
    manual: r.manual.length,
    checks: rel(r.checksPath),
    summary: rel(r.summaryPath),
    next: !r.index.ok && r.index.fix
      ? msg('cli.donor.checkNextFixIndex', { command: cliHint(r.index.fix), slug: values.slug })
      : msg('cli.donor.checkNextManual'),
    exitCode: r.exitCode ? EXIT.REFUSED : EXIT.OK,
  };
}

/** `donor style` без --apply: оформление и шрифты донора под его входом → donor-style.json. */
async function donorStyleCapture(values) {
  const ds = await import('./donor-style.mjs');
  const browser = await import('./lib/browser.mjs');
  const session = await browser.open({ role: 'donor' });
  try {
    await browser.openProject(session, { layers: ['tilda-project'] });
    const driver = { readProjectStyle: () => withLoginHint(browser.call(session.page, 'readProjectStyle', [], { attempts: 1 }), browser.LOGIN_HINTS.donor) };
    const r = await ds.captureDonorStyle(driver, { slug: values.slug });
    const shown = Object.fromEntries(Object.entries(r.values).filter(([k]) => k !== 'myfonts_json'));
    return {
      status: msg('cli.donor.status.styleCaptured', { fonts: r.fonts.length, values: Object.keys(shown).length }),
      fonts: r.fonts.map((f) => msg('cli.donor.fontWeights', { name: f.name, weights: Object.keys(f.files).length })),
      values: shown,
      path: r.path,
      next: cliHint(`donor style --slug ${values.slug} --apply --confirm`),
    };
  } finally {
    await browser.close(session);
  }
}

/** `donor style --apply --confirm`: шрифты и оформление донора → тестовый проект с записью для отката. */
async function donorStyleApply(values) {
  if (!values.confirm) {
    log.warn('donor', 'donor style --apply without --confirm - refused before the browser', {});
    return { status: msg('cli.donor.status.styleNeedsConfirm'), exitCode: EXIT.REFUSED };
  }
  const ds = await import('./donor-style.mjs');
  const ps = await import('./project-style.mjs');
  const browser = await import('./lib/browser.mjs');
  const { resolveProjectId } = await import('./lib/config.mjs');
  const session = await browser.open({ role: 'test' });
  try {
    const openFonts = async () => {
      await browser.openProjectSettings(session);
      await session.page.getByText('Шрифты', { exact: true }).first().click();
      await session.page.waitForTimeout(1500);
    };
    const ui = ps.playwrightStyleUi(session.page, browser);
    const hint = browser.LOGIN_HINTS.test;
    const driver = {
      readProjectStyle: async () => { await withLoginHint(openFonts(), hint); return browser.call(session.page, 'readProjectStyle', [], { attempts: 1 }); },
      uploadProjectFont: (args) => browser.call(session.page, 'uploadProjectFont', [args], { attempts: 1 }),
      setProjectStyle: (v) => ui.setProjectStyle(v),
      reload: () => withLoginHint(browser.openProjectSettings(session), hint),
    };
    const r = await ds.applyDonorStyle(driver, { slug: values.slug, projectid: resolveProjectId(), confirmed: true, confirm: ps.STYLE_CONFIRM });
    const out = {
      fontsUploaded: r.fonts.uploaded,
      fontsPresent: r.fonts.present,
      changed: r.changed,
      skipped: r.skipped.map((s) => msg('cli.donor.keyReason', { key: s.key, reason: s.reason })),
      notMatched: r.notMatched,
      otherChanged: r.otherChanged,
      record: r.record,
      next: cliHint(`donor verify --slug ${values.slug} --source P00`),
    };
    const failed = r.notMatched.length || r.otherChanged.length;
    const nothing = !r.fonts.uploaded.length && !r.changed.length;
    let status;
    if (failed) {
      const detail = r.otherChanged.length ? msg('cli.donor.styleOtherChanged', { keys: r.otherChanged.join(', ') }) : msg('cli.donor.styleNotMatched', { keys: r.notMatched.join(', ') });
      status = msg('cli.donor.status.styleWrittenButDiffers', { detail });
    } else if (nothing) {
      status = msg('cli.donor.status.styleUnchanged', { skipped: r.skipped.length });
    } else {
      status = msg('cli.donor.status.styleApplied', { fonts: r.fonts.uploaded.length, changed: r.changed.length, skipped: r.skipped.length });
    }
    return { status, ...out, ...(failed ? { exitCode: EXIT.REFUSED } : {}) };
  } finally {
    await browser.close(session);
  }
}

/**
 * `donor verify --slug --source [--width]`: состав, разметка и кадры сборки — в сессии редактора;
 * кадр референса — отдельной сессией после неё (lock команды на профиль); затем доклад.
 */
async function donorVerify(values) {
  const target = await labelPage(values, 'verify');
  if (target.refusal) return target.refusal;
  const dv = await import('./donor-verify.mjs');
  const shotMod = await import('./shot.mjs');
  const { readSite, resolveSource } = await import('./lib/reference-store.mjs');
  const widths = shotMod.parseWidths(values.width);
  const label = values.source;
  const data = await withEditor({ ...values, page: target.pageid }, async (driver, { cycle }) => dv.collectTransferData({
    listRecords: () => driver.call('listRecords', []),
    pageRawHtml: () => driver.pageRawHtml(),
    shot: (o) => cycle.shot(driver, target.pageid, o),
    readRecord: (recordid) => driver.call('readRecordSnapshot', [target.pageid, recordid]),
  }, { slug: values.slug, label, pageid: target.pageid, widths, lang: values.uiLang }));
  const entry = resolveSource(readSite(values.slug), label);
  let referenceShots = null;
  let referenceNote = null;
  if (entry?.url) {
    const ref = await import('./reference.mjs');
    try {
      referenceShots = await ref.shotReference({ slug: values.slug, source: label, widths });
    } catch (e) {
      if (e.code !== 'REFERENCE_UNAVAILABLE') throw e;
      referenceNote = msg('report.transfer.noteReferenceUnavailable', { error: e.message });
      log.warn('donor', 'reference frame not captured', { label, error: e.message });
    }
  } else {
    referenceNote = msg('report.transfer.noteHeaderFooter');
  }
  const r = dv.finishTransferReport(data, referenceShots, { slug: values.slug, referenceNote, lang: values.uiLang });
  return {
    status: msg('cli.donor.status.verified', {
      label,
      composition: msg(r.composition.equal ? 'cli.donor.compositionSame' : 'cli.donor.compositionDiffers'),
      markup: Math.round(r.markup.meanScore * 100),
      widths: widths.join('/'),
    }),
    label,
    pageid: target.pageid,
    composition: dv.compositionReasons(r.composition).slice(0, 10),
    heights: r.heights.map((h) => msg('cli.donor.heightLine', { width: h.width, built: h.built ?? '—', reference: h.reference ?? '—' })),
    report: r.report,
    shots: { built: r.shots.built, reference: r.shots.reference },
    next: msg('cli.donor.verifyNext'),
    exitCode: r.exitCode,
  };
}

/**
 * SESSION_LOST из конкретной сессии получает подсказку, в какой держатель входить. Открытие
 * страниц (openProject/openEditor/openProjectSettings) уже называет держатель по роли — второй
 * раз подсказка не дописывается; нужна для `browser.call`, которому роль неизвестна.
 */
function withLoginHint(promise, hint) {
  return promise.catch((e) => {
    if (e?.code === 'SESSION_LOST' && e.key !== 'browser.lib.sessionLostRole' && !e.hint) {
      e.hint = hint;
      log.debug('session', '[FIX] sign-in hint added', { hint: messageText(hint) });
    }
    throw e;
  });
}

/**
 * Команда `donor`: перенос через кабинет донора. Сессия донора открывается ролью `donor`
 * (свой держатель, allow-список записи пуст — проект донора только читается).
 */
async function cmdDonor(values, positionals) {
  const action = positionals[0];
  log.debug('donor', 'action', { action, slug: values.slug });
  if (action === 'map') return donorMap(values);
  if (action === 'copy') return donorCopy(values);
  if (action === 'style') return values.apply ? donorStyleApply(values) : donorStyleCapture(values);
  if (action === 'verify') return donorVerify(values);
  if (action === 'aliases') return donorAliases(values);
  if (action === 'links') return donorLinks(values);
  if (action === 'check') return donorCheck(values);
  if (action === 'pages') {
    const browser = await import('./lib/browser.mjs');
    const { getProjectIdFor } = await import('./lib/config.mjs');
    const session = await browser.open({ role: 'donor' });
    try {
      await browser.openProject(session, { layers: ['tilda-project'] });
      const driver = { call: (fn, args = []) => withLoginHint(browser.call(session.page, fn, args, { attempts: 1 }), browser.LOGIN_HINTS.donor) };
      const r = await pageList(driver, values, { projectid: getProjectIdFor('donor'), protectedIds: [], titles: false });
      return { ...r, role: 'donor', note: msg('cli.donor.pagesReadOnly') };
    } finally {
      await browser.close(session);
    }
  }
  log.error('donor', `action ${action} is not implemented yet`, { exitCode: EXIT.REFUSED });
  return { status: msg('cli.donor.status.notImplemented', { action }), exitCode: EXIT.REFUSED };
}

/** Хвост итога `reference fetch` про sitemap.xml (только при --sitemap). */
function sitemapNote(sitemap) {
  if (!sitemap) return '';
  return sitemap.status === 200 ? msg('cli.reference.sitemap.found', { found: sitemap.found }) : msg('cli.reference.sitemap.unavailable', { status: sitemap.status });
}

async function cmdReference(values, positionals) {
  const ref = await import('./reference.mjs');
  const action = positionals[0];
  if (action === 'fetch') {
    const r = await ref.fetchReference({
      url: values.url,
      slug: values.slug,
      follow: values.follow,
      sitemap: values.sitemap,
      max: values.max ? Number(values.max) : undefined,
      delayMs: values.delay ? Number(values.delay) : undefined,
      settleMs: values.settle ? Number(values.settle) : undefined,
      images: values.images,
    });
    return {
      status: msg('cli.reference.status.fetched', { slug: r.slug, pages: r.pages, fetched: r.fetched, skipped: r.skipped, failed: r.failed, pending: r.pending, sitemap: sitemapNote(r.sitemap) }),
      ...r,
      ...(r.pending > 0 ? { next: msg('cli.reference.next.repeatFetch') } : {}),
      exitCode: r.failed ? EXIT.REFUSED : EXIT.OK,
    };
  }
  if (action === 'structure') {
    const r = await ref.structureReference({ slug: values.slug });
    return { status: msg('cli.reference.status.structureRebuilt', { pages: r.pages }), ...r };
  }
  if (action === 'pages') return cmdReferencePages(values);
  if (action === 'audit') return cmdReferenceAudit(values);
  if (action === 'project') return cmdReferenceProject(values);
  if (action === 'compare') return cmdReferenceCompare(values);
  if (action === 'plan' && values.update) return cmdReferenceUpdate(values);
  if (action === 'shot') {
    const { parseWidths } = await import('./shot.mjs');
    const r = await ref.shotReference({ slug: values.slug, source: values.source, widths: parseWidths(values.width) });
    const blocks = r.widths.map((w) => w.records).join('/');
    return {
      status: msg('cli.reference.status.shot', { label: r.label, widths: r.widths.map((w) => w.width).join(', '), blocks, files: r.files }),
      dir: r.dir,
      widths: r.widths.map((w) => msg('cli.reference.widthRow', { width: w.width, height: w.height, records: w.records, files: w.files })),
    };
  }
  const gen = await import('./reference-plan.mjs');
  const r = gen.generateReferencePlan({ slug: values.slug, source: values.source, page: values.page, out: values.out, styles: values.styles, substitutes: gen.parseSubstitutes(values.substitute), zone: values.zone });
  const parts = {
    label: r.label ? ' ' + r.label : '',
    ops: r.ops,
    blocks: r.blocks - r.zoneFiltered,
    zone: r.zone,
    links: r.label ? msg('cli.reference.plan.links', { rewritten: r.links.rewritten, kept: r.links.kept }) : '',
    subs: r.substituted.length ? msg('cli.reference.plan.subs', { count: r.substituted.length }) : '',
    noStyles: values.styles === false ? msg('cli.reference.plan.noStyles') : '',
  };
  const status = r.skipped.length ? msg('cli.reference.status.planSkipped', { ...parts, skipped: r.skipped.length }) : msg('cli.reference.status.planWritten', parts);
  return {
    status,
    path: r.path,
    ops: r.ops,
    blocks: r.blocks,
    zone: r.zone,
    zoneFiltered: r.zoneFiltered,
    links: r.links,
    ...(r.settings ? { settings: r.settings } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
    skipped: r.skipped.slice(0, 20),
    unmapped: r.unmapped.slice(0, 20),
    unmappedTotal: r.unmapped.length,
    next: cliHint(`apply --plan ${r.path} --dry-run`),
    exitCode: r.skipped.length ? EXIT.REFUSED : EXIT.OK,
  };
}

/**
 * `reference project`: оформление проекта референса из его CSS. Без `--apply` —
 * только разбор (держатель без сессии Tilda); с `--apply --confirm` — запись через форму настроек
 * тестового проекта; без `--confirm` — отказ до браузера.
 */
async function cmdReferenceProject(values) {
  if (values.apply && !values.confirm) {
    log.warn('reference', 'reference project --apply without --confirm - refused before the browser', {});
    return { status: msg('cli.reference.status.projectNeedsConfirm'), exitCode: EXIT.REFUSED };
  }
  const ps = await import('./project-style.mjs');
  const lib = await import('./lib/project-style.mjs');
  const browser = await import('./lib/browser.mjs');
  const { readFileSync } = await import('node:fs');
  const session = await browser.open(values.apply ? {} : { protectedPages: [] });
  try {
    const css = await ps.fetchProjectCss(session, { slug: values.slug });
    const style = lib.projectStyleFromCss(readFileSync(css.path, 'utf8'));
    let presets = null;
    let driver = null;
    if (values.apply) {
      const openFonts = async () => {
        await browser.openProjectSettings(session);
        await session.page.getByText('Шрифты', { exact: true }).first().click();
        await session.page.waitForTimeout(1500);
      };
      const ui = ps.playwrightStyleUi(session.page, browser);
      driver = {
        readProjectStyle: async () => {
          await openFonts();
          return browser.call(session.page, 'readProjectStyle', [], { attempts: 1 });
        },
        setProjectStyle: (v) => ui.setProjectStyle(v),
        reload: () => browser.openProjectSettings(session),
      };
      presets = (await driver.readProjectStyle()).presets;
    }
    const desired = lib.desiredProjectSettings(style, { presets });
    const stylePath = ps.writeProjectStyle(values.slug, { at: new Date().toISOString(), ...desired, fonts: desired.fonts.map((f) => ({ family: f.family, weight: f.weight })) });
    const base = {
      css: msg('cli.reference.cssBytes', { bytes: css.bytes }),
      fonts: desired.fonts.map((f) => `${f.family} ${f.weight}`),
      values: desired.values,
      fontAliases: desired.fontAliases,
      undecided: desired.undecided.map((u) => lib.projectReasonMessage(u)),
      path: stylePath,
    };
    if (!values.apply) {
      return { status: msg('cli.reference.status.projectCaptured', { values: Object.keys(desired.values).length, fonts: desired.fonts.length }), ...base };
    }
    const { resolveProjectId } = await import('./lib/config.mjs');
    const r = await ps.applyProjectStyle(driver, { desired, confirmed: true, confirm: ps.STYLE_CONFIRM, projectid: resolveProjectId() });
    const out = { ...base, changed: r.changed, otherChanged: r.otherChanged, record: r.record, next: cliHint('page list') };
    if (r.otherChanged.length) return { status: msg('cli.reference.status.projectOtherChanged', { settings: r.otherChanged.join(', ') }), ...out, exitCode: EXIT.REFUSED };
    return { status: r.changed.length ? msg('cli.reference.status.projectWritten', { changed: r.changed.join(', ') }) : msg('cli.reference.status.projectUnchanged'), ...out };
  } finally {
    await browser.close(session);
  }
}

/** Страница метки из site.json или итог-отказ. */
async function labelPage(values, action) {
  const { readSite, resolveSource } = await import('./lib/reference-store.mjs');
  const entry = resolveSource(readSite(values.slug), values.source);
  if (!entry || !entry.pageid) return { refusal: { status: msg('cli.reference.status.noPageid', { command: `reference ${action}`, source: values.source, slug: values.slug }), exitCode: EXIT.REFUSED } };
  return { pageid: String(entry.pageid) };
}

/** Причины строки сверки как список `Message` через `; `; у строки без `reasonItems` — записанные тексты. */
function compareReasonsMessage(row) {
  const items = Array.isArray(row.reasonItems)
    ? row.reasonItems.map((i) => {
      const reason = msg('report.compareReason.' + i.code, i.params);
      return i.count > 1 ? msg('cli.reference.reasonCount', { reason, count: i.count }) : reason;
    })
    : (row.reasons ?? []);
  return items.reduce((joined, item) => (joined === null ? item : msg('cli.reference.joinList', { head: joined, tail: item })), null);
}

/** Строка итога `reference compare` для блока: не собран или доля совпавших признаков с причинами. */
function compareRowMessage(x) {
  if (x.notBuilt) return msg('cli.reference.compareRowNotBuilt', { order: x.order, tplid: x.tplid });
  const percent = Math.round(x.score * 100);
  const reasons = compareReasonsMessage(x);
  return reasons === null ? msg('cli.reference.compareRow', { order: x.order, tplid: x.tplid, percent }) : msg('cli.reference.compareRowReasons', { order: x.order, tplid: x.tplid, percent, reasons });
}

/** `reference compare`: поблочная сверка разметки собранной страницы метки с референсом. */
async function cmdReferenceCompare(values) {
  if (values.published && !values.url) return { status: msg('cli.reference.status.compareNeedsUrl'), exitCode: EXIT.USAGE };
  const target = await labelPage(values, 'compare');
  if (target.refusal) return target.refusal;
  const cmp = await import('./reference-compare.mjs');
  const browser = await import('./lib/browser.mjs');
  return withEditor({ ...values, page: target.pageid }, async (driver, { session }) => {
    const d = {
      pageRawHtml: () => driver.pageRawHtml(),
      publishedHtml: async (url) => {
        const page = await browser.openBackgroundPage(session.context);
        try {
          const resp = await page.goto(url, { waitUntil: 'load' });
          return { url, html: resp ? await resp.text() : '' };
        } finally {
          await page.close().catch(() => {});
        }
      },
    };
    const r = await cmp.compareReferencePage(d, { slug: values.slug, label: values.source, published: values.published, url: values.url, lang: values.uiLang });
    return {
      status: msg('cli.reference.status.compareDone', { label: r.label, blocks: r.blocks, pairs: r.pairs, refOnly: r.refOnly, builtOnly: r.builtOnly, mean: Math.round(r.meanScore * 100) }),
      path: r.path,
      report: r.report,
      rows: r.rows.slice(0, 20).map(compareRowMessage),
    };
  });
}

/** `reference plan --update`: дописывание уже собранной страницы метки. */
async function cmdReferenceUpdate(values) {
  const target = await labelPage(values, 'plan --update');
  if (target.refusal) return target.refusal;
  const upd = await import('./reference-update.mjs');
  return withEditor({ ...values, page: target.pageid }, async (driver) => {
    const r = await upd.updateReferencePlan(driver, { slug: values.slug, label: values.source, pageid: target.pageid, out: values.out, styles: values.styles });
    return {
      status: msg('cli.reference.status.updatePlan', { label: r.label, ops: r.ops, fields: r.fields, lists: r.lists, created: r.created, reasons: r.unmapped.length }),
      path: r.path,
      unmapped: r.unmapped.slice(0, 20),
      next: cliHint(`apply --plan ${r.path} --dry-run`),
    };
  });
}

/** `reference audit`: ссылки вида собранной страницы метки; pageid — из site.json. */
async function cmdReferenceAudit(values) {
  const siteMod = await import('./reference-site.mjs');
  const { readSite, resolveSource } = await import('./lib/reference-store.mjs');
  const { resolveProjectId } = await import('./lib/config.mjs');
  const entry = resolveSource(readSite(values.slug), values.source);
  if (!entry || !entry.pageid) {
    return { status: msg('cli.reference.status.noPageid', { command: 'reference audit', source: values.source, slug: values.slug }), exitCode: EXIT.REFUSED };
  }
  return withEditor({ ...values, page: entry.pageid }, async (driver) => {
    const r = await siteMod.auditPage(driver, { slug: values.slug, label: values.source, projectid: resolveProjectId() });
    return {
      status: msg('cli.reference.status.audit', { label: r.label, total: r.total, internal: r.internal, violations: r.violations.length }),
      path: r.path,
      violations: r.violations.slice(0, 20).map((v) => msg('cli.reference.violationRow', { kind: siteMod.auditKindMessage(v.kind), path: v.path, count: v.count })),
      exitCode: r.violations.length ? EXIT.REFUSED : EXIT.OK,
    };
  });
}

/** Строки карты сайта для итога: только метки, роли и pageid — без имён слепка и адресов. */
function siteList(site) {
  return site.pages.map((p) => msg('cli.reference.siteRow', { label: p.label, role: p.role, pageid: p.pageid ?? '—', missing: p.missing ? msg('cli.reference.notInSnapshot') : '' })).slice(0, 40);
}

async function cmdReferencePages(values) {
  const siteMod = await import('./reference-site.mjs');
  if (values.create) return createReferencePages(siteMod, values);
  const r = siteMod.syncSite({ slug: values.slug });
  const content = r.site.pages.filter((p) => p.role === 'content' && !p.missing).length;
  const withPageid = r.site.pages.filter((p) => p.pageid).length;
  return {
    status: msg('cli.reference.status.siteMap', { slug: values.slug, pages: content, header: r.header ? msg('cli.reference.yes') : msg('cli.reference.no'), footer: r.footer ? msg('cli.reference.yes') : msg('cli.reference.no'), created: withPageid, total: r.site.pages.length }),
    path: r.path,
    added: r.added,
    missing: r.missing,
    list: siteList(r.site),
  };
}

/** `reference pages --create`: пустые страницы для записей карты без pageid, по одной, без повторов вызова. */
async function createReferencePages(siteMod, values) {
  const { resolveProjectId } = await import('./lib/config.mjs');
  const { readSite } = await import('./lib/reference-store.mjs');
  const browser = await import('./lib/browser.mjs');
  const session = await browser.open();
  try {
    await browser.openProject(session, { layers: ['tilda-project'] });
    // attempts: 1 — повтор createPage после сбоя мог бы создать лишнюю страницу без метки.
    const driver = {
      call: (fn, args = []) => browser.call(session.page, fn, args, { attempts: 1 }),
      callWithResponse: (fn, args, opts) => browser.callWithResponse(session.page, fn, args, opts),
    };
    let r;
    try {
      r = await siteMod.createSitePages(driver, { slug: values.slug, projectid: resolveProjectId(), delayMs: values.delay ? Number(values.delay) : undefined });
    } catch (e) {
      if (!e.left) throw e;
      return {
        status: msg('cli.reference.status.pagesPartial', { created: e.created.length, left: e.left.length, reason: e.key ? msg(e.key, e.params) : e.message }),
        code: e.code,
        left: e.left,
        path: e.path,
        list: siteList(readSite(values.slug)),
        exitCode: EXIT.REFUSED,
      };
    }
    return {
      status: msg('cli.reference.status.pagesCreated', { created: r.created.length, existing: r.skipped.length, left: r.left.length, titleFailed: r.titleFailed?.length ? msg('cli.reference.titleFailed', { pages: r.titleFailed.join(', ') }) : '' }),
      path: r.path,
      list: siteList(readSite(values.slug)),
      exitCode: r.left.length ? EXIT.REFUSED : EXIT.OK,
    };
  } finally {
    await browser.close(session);
  }
}

async function cmdCatalog(values, positionals) {
  const cat = await import('./catalog.mjs');
  if (positionals[0] === 'list') {
    const rows = cat.listCatalog();
    return { status: msg('cli.catalog.status.list', { templates: rows.length, unavailable: rows.filter((r) => !r.available).length }), dir: cat.catalogDir(), rows: rows.slice(0, 40) };
  }
  const tplids = values.tplid ? values.tplid.split(',') : cat.tplidsFromSlug(values.slug);
  if (!tplids.length) throw new UsageError(msg('cli.usage.catalogNoTplids', { command: `catalog ${positionals[0]}` }));
  if (positionals[0] === 'calibrate') {
    const cal = await import('./calibrate.mjs');
    return withEditor(values, async (driver) => {
      const r = await cal.calibrateCatalog(driver, {
        pageid: values.page,
        tplids,
        force: values.force,
        delayMs: values.delay ? Number(values.delay) : undefined,
        batch: values.batch ? Number(values.batch) : undefined,
        pauseS: values.pause ? Number(values.pause) : undefined,
      });
      await driver.reload();
      return {
        status: msg('cli.catalog.status.calibrated', { calibrated: r.calibrated.length, skipped: r.skipped.length, failed: r.failed.length, previews: r.previews }),
        ...r,
        exitCode: r.failed.length ? EXIT.REFUSED : EXIT.OK,
      };
    });
  }
  // Драйвер цикла пробрасывает opts в browser.call — addRecord/deleteRecord идут с { attempts: 1 }.
  return withEditor(values, async (driver) => {
    const r = await cat.captureCatalog(driver, { pageid: values.page, tplids, delayMs: values.delay ? Number(values.delay) : undefined, force: values.force });
    await driver.reload();
    return {
      status: msg('cli.catalog.status.captured', { captured: r.captured.length, unavailable: r.unavailable.length, skipped: r.skipped.length, failed: r.failed.length }),
      ...r,
      exitCode: r.failed.length ? EXIT.REFUSED : EXIT.OK,
    };
  });
}

/**
 * Выполнить команду. `ctx` — изменяемый контекст вызывающего: сюда `run` кладёт выбранный язык,
 * чтобы `main` перевёл и ошибку, случившуюся уже после выбора языка.
 */
export async function run(argv, ctx = {}) {
  const parsed = parseCli(argv);
  const { cmd, positionals } = parsed;
  let { values } = parsed;
  // Справка идёт до resolveLang: она печатается и при неверном TILDA_LANG.
  if (cmd === 'help') {
    console.log(usage(peekLang(argv)));
    return EXIT.OK;
  }
  const resolved = resolveLang({ flag: values.lang });
  ctx.lang = resolved.lang;
  log.debug('run', 'language', { lang: ctx.lang, source: resolved.source });
  // doctor идёт до applySite: битая или ещё не созданная папка сайта — результат проверки, а не ранняя ConfigError.
  if (cmd === 'doctor') {
    const { runDoctor, formatReport, renderReport } = await import('./doctor.mjs');
    const report = await runDoctor({ site: values.site });
    console.log(values.json ? JSON.stringify(renderReport(report, ctx.lang), null, 2) : formatReport(report, ctx.lang));
    return report.status === 'fail' ? EXIT.REFUSED : EXIT.OK;
  }
  // setup тоже до applySite: папки сайта ещё может не быть, а окружение он не использует.
  if (cmd === 'setup') {
    const summary = await runSetup({ site: values.site, project: values.project, agent: values.agent, lang: values.lang });
    console.log(formatSummary(summary, values.json, ctx.lang));
    return EXIT.OK;
  }
  const site = applySite({ flag: values.site });
  // .env сайта мог задать TILDA_LANG: язык выбирается заново.
  ctx.lang = resolveLang({ flag: values.lang }).lang;
  log.debug('run', 'language after site', { lang: ctx.lang });
  warnRepoEnv();
  log.debug('run', 'site', { site: site?.siteDir ?? null });
  const stageOnline = cmd === 'stage' && positionals[0] === 'apply';
  const catalogOnline = cmd === 'catalog' && (positionals[0] === 'capture' || positionals[0] === 'calibrate');
  const referenceOnline = cmd === 'reference' && ((positionals[0] === 'pages' && values.create) || positionals[0] === 'audit' || positionals[0] === 'compare' || (positionals[0] === 'project' && values.apply) || (positionals[0] === 'plan' && values.update));
  const donorSession = cmd === 'session' && values.donor;
  // donor verify работает только с тестовым проектом — конфигурация донора ему не нужна.
  const donorVerifyOnline = cmd === 'donor' && positionals[0] === 'verify';
  if (values.donor || (cmd === 'donor' && !donorVerifyOnline)) {
    // Конфигурация донора проверяется до браузера: отказ — раньше создания каталога профиля.
    // donor copy пишет в тестовый проект — нужны оба проекта и TILDA_PROTECTED_PAGES;
    // donor check только читает тестовый проект, но в его держателе и с перечнем донора — тоже оба.
    // donor aliases/links/check держатель донора не открывают: нужен ID донора (перечень его
    // страниц на диске), но не профиль TILDA_DONOR_BROWSER_PROFILE.
    const { requireDonorConfig } = await import('./lib/config.mjs');
    const browser = await import('./lib/browser.mjs');
    const writesTest = cmd === 'donor' && (positionals[0] === 'copy' || positionals[0] === 'aliases' || positionals[0] === 'links' || positionals[0] === 'check' || (positionals[0] === 'style' && values.apply));
    const withProfile = !(cmd === 'donor' && ['aliases', 'links', 'check'].includes(positionals[0]));
    log.debug('main', '[FIX] donor configuration', { action: positionals[0], withTest: writesTest, withProfile });
    requireDonorConfig({ testProfile: browser.profileDir('test'), withTest: writesTest, withProfile });
  }
  if ((ONLINE_COMMANDS.has(cmd) && !donorSession) || stageOnline || catalogOnline || referenceOnline || donorVerifyOnline) requireOnlineConfig();

  const planProvidesPage = ['apply', 'verify', 'preview', 'rollback', 'promote'].includes(cmd);
  const pageNoTarget = cmd === 'page' && ['create', 'list', 'role'].includes(positionals[0]);
  // catalog capture требует явный --page (проверено в parseCli), catalog list страницы не ждёт.
  // reference страницу по умолчанию не получает никогда: plan по имени требует явный --page
  // (parseCli), по метке pageid берётся из site.json. session --donor входит на странице проекта.
  if (!values.page && !planProvidesPage && !pageNoTarget && !donorSession && cmd !== 'browser' && cmd !== 'catalog' && cmd !== 'reference' && cmd !== 'donor') {
    const defaultPage = getDefaultPage();
    if (!defaultPage) throw new UsageError(msg('cli.usage.needPage', { command: cmd }));
    values = { ...values, page: defaultPage };
  }
  log.debug('run', 'command', { cmd, page: values.page, plan: values.plan, dryRun: values['dry-run'], donor: values.donor });
  if (NOT_IMPLEMENTED.has(cmd)) {
    log.error('run', `command ${cmd} is not implemented`, { exitCode: EXIT.REFUSED });
    console.log(formatSummary({ status: msg('cli.main.status.notImplemented'), command: cmd }, values.json, ctx.lang));
    return EXIT.REFUSED;
  }
  const handlers = { browser: cmdBrowser, session: cmdSession, inventory: cmdInventory, snapshot: cmdSnapshot, apply: cmdApply, verify: cmdVerify, rollback: cmdRollback, journal: cmdJournal, find: cmdFind, replace: cmdReplace, upload: cmdUpload, preview: cmdPreview, shot: cmdShot, links: cmdLinks, map: cmdMap, page: cmdPage, promote: cmdPromote, stage: cmdStage, reference: cmdReference, catalog: cmdCatalog, donor: cmdDonor };
  // Язык вывода нужен обработчикам, которые пишут доклады в файлы: они передают его генераторам явно.
  values = { ...values, uiLang: ctx.lang };
  const summary = await handlers[cmd](values, positionals);
  const code = summary.exitCode ?? EXIT.OK;
  delete summary.exitCode;
  console.log(formatSummary(summary, values.json, ctx.lang));
  return code;
}

/** `.env` в корне репозитория больше не читается: данные и настройки сайта живут в папке сайта. */
function warnRepoEnv() {
  const file = join(repoRoot(), '.env');
  if (existsSync(file)) log.warn('main', '.env in the repository root is not read - move it to the site folder and run with --site <folder>', { file: file.replace(/\\/g, '/') });
}

async function main() {
  const argv = process.argv.slice(2);
  const ctx = {};
  let code;
  try {
    code = await run(argv, ctx);
  } catch (e) {
    code = exitCodeFor(e);
    const lang = ctx.lang ?? peekLang(argv);
    // В журнал идёт английский message (и ключ), перевод — только в stdout.
    log.error('main', `${e.code || e.name}: ${e.message}`, { exitCode: code, key: e.key });
    if (e instanceof UsageError || e.name === 'UsageError') {
      console.log(`${render(lang, msg('cli.main.usageError'))}: ${renderError(lang, e)}`);
      console.log('');
      console.log(usage(lang));
    } else {
      const summary = { status: msg('cli.main.status.error'), code: e.code || e.name };
      if (e.key) summary.key = e.key;
      summary.message = renderError(lang, e);
      if (e.hint) summary.hint = e.hint;
      console.log(formatSummary(summary, false, lang));
    }
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
