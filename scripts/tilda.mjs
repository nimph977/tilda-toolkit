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
import { protectedPages, plansDir, repoRoot } from './lib/paths.mjs';
import { applySite, cliHint } from './lib/site.mjs';
import { getDefaultPage, requireOnlineConfig } from './lib/config.mjs';
import { isLabel } from './lib/reference-store.mjs';
import { SETUP_AGENTS, runSetup } from './setup.mjs';

const log = createLogger('tilda');

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
  help: { type: 'boolean', short: 'h', default: false },
};

/** Команды, у которых допустим флаг --donor (держатель и вход аккаунта донора). */
export const DONOR_FLAG_COMMANDS = ['browser', 'session'];

/** Ошибка разбора аргументов → код выхода 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = EXIT.USAGE;
  }
}

export function usage() {
  return [
    'Использование: node scripts/tilda.mjs --site <папка сайта> <команда> [флаги]',
    '',
    'Команды: ' + COMMANDS.join(', '),
    '  browser start|stop|status|show|hide — держатель браузера (по умолчанию команды поднимают его сами); show — окно на экран, hide — свернуть; --donor — держатель донора (профиль TILDA_DONOR_BROWSER_PROFILE)',
    '  session --donor [--wait <сек>]  вход аккаунта донора в его держателе: окно показывается только на время входа; проект донора только читается',
    '  page duplicate|create|publish|delete|list|role|title — дубль, пустая страница, публикация (--page <id> --confirm), инструкция удаления, перечень страниц проекта, шапка, подвал и главная проекта, заголовок страницы',
    '  page title --page <id> --title <текст>  заголовок страницы в кабинете (окно настроек страницы; защищённые страницы — отказ до запроса)',
    '  --header <id|none> --footer <id|none>  page role: страницы-шапка и страница-подвал проекта (только с --confirm)',
    '  page role --index <pageid> --confirm  главная страница проекта (отдельно от шапки и подвала; защищённые страницы — отказ)',
    "  stage '<json>' | stage --plan <файл> | stage diff|apply|drop|list — накопительный план реплик и его локальный diff",
    '  reference fetch|structure|pages|plan|shot|audit — слепок референс-сайта через держатель, структура страниц, карта сайта, план сборки (--url --slug; plan: --source --page <черновая>), снимок и проверка ссылок',
    '  reference shot --slug <слепок> --source <метка> [--width 1440,320]  снимок страницы референса той же механикой, что shot',
    '  reference audit --slug <слепок> --source <метка>  ссылки собранной страницы: нет домена референса, /page<id>.html есть в page list',
    '  reference pages   карта сайта: метки P00…, HDR, FTR ↔ страницы слепка и новые pageid (site.json)',
    '  reference project --slug <слепок> [--apply --confirm]  шрифты и цвета проекта референса → настройки тестового проекта (запись только с --apply --confirm)',
    '  reference compare --slug <слепок> --source <метка> [--published --url <адрес>]  поблочная сверка разметки собранной страницы с референсом, доклад reports/<метка>.auto.md',
    '  catalog capture|list — эталонные поля шаблонов: снять на черновой странице (--page --slug|--tplid) или показать снятое',
    '  donor pages|map|copy|style|verify|aliases|links — перенос через кабинет донора: перечень страниц донора под его входом, карта меток ↔ страницы донора (--slug), копирование страницы через буфер, шрифт и оформление донора, сверка, адреса страниц копии, перепись ссылок донора',
    '  donor map --slug <слепок>  метки карты сайта ↔ страницы донора по адресам и ролям (site.json: donorPageid); без сети; сначала donor pages',
    '  donor copy --slug <слепок> --source <метка> | --from <pageid донора> --to <pageid> [--replace] [--dry-run]  перенос блоков страницы донора на приёмник через буфер аккаунта донора (действие под входом донора — по явному «делай» владельца)',
    '  donor style --slug <слепок> [--apply --confirm]  оформление и свой шрифт донора → donor-style.json; с --apply --confirm — в тестовый проект (шрифт ссылками на файлы донора, цвета и веса через форму, запись для отката как у reference project)',
    '  donor aliases --slug <слепок> [--dry-run]  адреса страниц копии как у страниц донора (файлы donor pages и page list; шапка, подвал и главная пропускаются, занятый адрес не отбирается)',
    '  donor links --slug <слепок> --source <метка> [--dry-run]  ссылки донора (домен, /page<ID донора>.html, в т. ч. на *.tilda.ws) → пути на страницы копии (только адрес ссылки; поля форм не меняются; снимок до, verify после)',
    '  donor check --slug <слепок> [--source P01,P02]  проверки после переноса по меткам: ссылки (домен донора, относительные адреса, страницы донора по ID), HTML-блоки, formmsgurl, полнота карты, главная; итог — раздел сводки',
    '  donor verify --slug <слепок> --source <метка> [--width 1440,320]  состав блоков против слепка, сверка разметки, кадры сборки и референса, доклад reports/<метка>.transfer.md',
    '  catalog calibrate --page <черновая> --slug|--tplid [--force] [--delay мс] [--batch n] [--pause с]  карта «значение настройки → разметка» по предпросмотру (временный блок создаётся и удаляется)',
    '  doctor [--site <папка>] [--json] — проверить Node.js, зависимости, Chrome, git, папку сайта, .env и скилл; только проверяет и печатает команды исправления',
    '  setup [--site <папка>] [--project <ID>] [--agent claude|codex|all] — создать папку сайта и .env из .env.example (существующий .env не перезаписывается), поставить скилл tilda-manager в папку агента внутри репозитория',
    '',
    'Флаги:',
    '  --site <папка>    папка сайта вне репозитория: .env, site-baseline, site-reference, .browser-profile, plans (или TILDA_SITE_DIR); без неё команды с данными сайта отказывают с кодом 2',
    '  --page <pageid>   страница (иначе TILDA_DEFAULT_PAGE, если команда требует страницу)',
    '  --plan <файл>     план операций JSON (apply, verify)',
    '  --out <путь>      куда положить результат',
    '  --json            итог в stdout как JSON',
    '  --dry-run         ничего не писать в Тильду',
    '  --wait <сек>      session: сколько ждать входа человека (по умолчанию 600)',
    '  --agent <имя>     setup: claude, codex или all',
    '  --project <ID>    setup: ID проекта Tilda для нового .env',
    '  --donor           browser/session: держатель и вход аккаунта донора (TILDA_DONOR_PROJECT_ID, TILDA_DONOR_BROWSER_PROFILE)',
    '  --replace         donor copy: удалить блоки приёмника после снимков и перенести заново',
    '  --emit-calls      apply: дополнительно писать отладочные *.call.js для browser_evaluate',
    '  --width <список>  shot: ширины через запятую (по умолчанию 1440,320)',
    '  --links           shot: заодно проверить ссылки и картинки',
    '  --no-open         map: не открывать карту в просмотрщике (по умолчанию открывается)',
    '  --confirm         page publish: явное подтверждение публикации (без него — отказ до запроса)',
    '  --from/--to       promote: рабочая копия и живая страница (обе обязательны)',
    '  --unprotect       promote: снять защиту живой страницы на этот вызов (иначе отказ на шаге 4)',
    '  --batch/--delay/--pause  promote: темп полных снимков — чтений в пачке (10), мс между чтениями (2500), с между пачками и снимками (60)',
    '  --url <адрес>     reference fetch: страница референса, с которой начинается обход',
    '  --slug <имя>      reference: имя слепка в TILDA_REFERENCE_DIR (латиница, цифры, дефис)',
    '  --source <имя|метка>  reference plan: имя страницы из слепка или метка карты сайта (P07, HDR, FTR — страница, зона и замены из site.json)',
    '  --zone all|content|header|footer  reference plan по имени страницы: собрать только зону (по метке — из site.json)',
    '  --no-styles       reference plan: не переносить оформление (отступы, фон, типографика)',
    '  --update          reference plan: дописать уже собранную страницу метки операциями field/listSet (без пересоздания блоков)',
    '  --apply           reference project: записать оформление в настройки тестового проекта (нужен --confirm)',
    '  --published       reference compare: сверять опубликованную страницу по --url (адрес даёт владелец)',
    '  --substitute <a>=<b>  reference plan: собирать блоки шаблона a шаблоном b (недоступное меню 770 → доступный шаблон меню); можно повторять или через запятую',
    '  --follow          reference fetch: идти по внутренним ссылкам того же сайта',
    '  --sitemap         reference fetch: добавить в очередь страницы из sitemap.xml того же сайта',
    '  --create          reference pages: создать в проекте недостающие страницы карты (пустые, по одной, пауза --delay мс, 3000)',
    '  --max <n>         reference fetch: страниц за запуск (по умолчанию 20); остаток очереди сохраняется и снимается повторным запуском',
    '  --images          reference fetch: скачать картинки блоков в images/',
    '  --delay/--settle  reference fetch: мс между страницами (2500) и ожидание после загрузки (1500)',
    '  --tplid <список>  catalog capture: шаблоны через запятую вместо --slug (например 796,702); --delay — мс между эталонами (2500)',
    '  --force           catalog capture: переснять уже снятые шаблоны',
    '',
    'rollback <запись>   откат по записи журнала: node scripts/tilda.mjs --site <папка сайта> rollback <папка сайта>/site-baseline/journal/<pageid>/<файл>.json',
    '',
    'Коды выхода: 0 успех, 1 расхождение/отказ, 2 аргументы, 3 сессии нет.',
    '',
    'Запуск из любой папки: node <путь-к-репо>/scripts/tilda.mjs --site <папка сайта> …; .env из корня репозитория не читается. Каталог шаблонов — TILDA_CATALOG_DIR (общий для всех сайтов).',
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
    throw new UsageError(e.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { cmd: 'help', values, positionals: [] };
  const [cmd, ...rest] = positionals;
  if (!cmd) throw new UsageError('не указана команда');
  if (!COMMANDS.includes(cmd)) throw new UsageError(`неизвестная команда: ${cmd}`);
  if (['apply', 'verify', 'preview'].includes(cmd) && !values.plan) throw new UsageError(`${cmd}: нужен --plan <файл>`);
  if (cmd === 'browser' && !BROWSER_ACTIONS.includes(rest[0])) throw new UsageError(`browser: нужно действие ${BROWSER_ACTIONS.join('|')}`);
  if (values.donor && !DONOR_FLAG_COMMANDS.includes(cmd)) throw new UsageError(cmd === 'donor' ? 'donor: флаг --donor не нужен — роль задаёт сама команда' : `--donor допустим только у ${DONOR_FLAG_COMMANDS.join(' и ')}`);
  if (cmd === 'donor') {
    if (!DONOR_ACTIONS.includes(rest[0])) throw new UsageError(`donor: нужно действие ${DONOR_ACTIONS.join('|')}`);
    if ((rest[0] === 'map' || rest[0] === 'style' || rest[0] === 'verify' || rest[0] === 'aliases' || rest[0] === 'links' || rest[0] === 'check') && !values.slug) throw new UsageError(`donor ${rest[0]}: нужен --slug <имя-слепка>`);
    if (rest[0] === 'verify' && !isLabel(values.source)) throw new UsageError('donor verify: нужен --source <метка карты сайта> (P00…, HDR, FTR)');
    if (rest[0] === 'links' && !isLabel(values.source)) throw new UsageError('donor links: нужен --source <метка карты сайта> (P00…, HDR, FTR)');
    if (rest[0] === 'check' && values.source !== undefined && !String(values.source).split(',').every((l) => isLabel(l.trim()))) {
      throw new UsageError('donor check: --source — метки карты сайта через запятую (P00,P01,HDR)');
    }
    if (rest[0] === 'copy') {
      if (!values.slug) throw new UsageError('donor copy: нужен --slug <имя-слепка>');
      if (values.source !== undefined && !isLabel(values.source)) throw new UsageError(`donor copy: --source ждёт метку карты сайта (P00…, HDR, FTR), получено ${values.source}`);
      if (values.source === undefined && (!values.from || !values.to)) throw new UsageError('donor copy: нужен --source <метка> либо оба --from <pageid донора> и --to <pageid>');
      for (const k of ['from', 'to']) if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(`donor copy: --${k} должен быть числом, получено ${values[k]}`);
      if (values.from !== undefined && values.from === values.to) throw new UsageError('donor copy: --from и --to совпадают');
      if (values.replace && values.source === undefined && !values.to) throw new UsageError('donor copy: --replace требует приёмник (--source или --to)');
    }
  }
  if (cmd === 'session' && values.donor && values.page !== undefined) throw new UsageError('session --donor: страница не нужна — вход проверяется на странице проекта донора');
  if (cmd === 'page' && !PAGE_ACTIONS.includes(rest[0])) throw new UsageError(`page: нужно действие ${PAGE_ACTIONS.join('|')}`);
  if (cmd === 'page' && rest[0] === 'publish' && values.page === undefined) throw new UsageError('page publish: нужен явный --page <pageid> — страница по умолчанию не подставляется');
  if (cmd === 'page' && rest[0] === 'title') {
    if (values.page === undefined) throw new UsageError('page title: нужен явный --page <pageid> — страница по умолчанию не подставляется');
    if (!values.title || !String(values.title).trim()) throw new UsageError('page title: нужен --title <текст>');
  }
  if (cmd === 'page' && rest[0] === 'role') {
    if (values.header === undefined && values.footer === undefined && values.index === undefined) throw new UsageError('page role: нужен --header <id|none>, --footer <id|none> или --index <pageid>');
    for (const k of ['header', 'footer']) if (values[k] !== undefined && !/^(\d+|none)$/.test(values[k])) throw new UsageError(`page role: --${k} ждёт pageid или none, получено ${values[k]}`);
    if (values.index !== undefined) {
      if (!/^\d+$/.test(values.index)) throw new UsageError(`page role: --index ждёт pageid (главную снять нельзя), получено ${values.index}`);
      if (values.header !== undefined || values.footer !== undefined) throw new UsageError('page role: --index назначается отдельно от --header/--footer — поля на разных вкладках настроек');
    }
  }
  if (cmd === 'stage' && !values.plan && !rest[0]) throw new UsageError(`stage: нужна операция (JSON-строка или файл), --plan <файл> либо действие ${STAGE_ACTIONS.join('|')}`);
  if (cmd === 'promote') {
    if (!values.plan && !rest.length) throw new UsageError('promote: нужен --plan <план> (и, при необходимости, ещё планы позиционно)');
    if (!values.from || !values.to) throw new UsageError('promote: нужны --from <копия> и --to <живая>');
    if (!/^\d+$/.test(values.from) || !/^\d+$/.test(values.to)) throw new UsageError('promote: --from и --to должны быть числами');
    if (values.from === values.to) throw new UsageError('promote: --from и --to совпадают');
    for (const k of ['batch', 'delay', 'pause']) if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(`promote: --${k} должен быть целым числом, получено ${values[k]}`);
  }
  if (cmd === 'reference') {
    if (!REFERENCE_ACTIONS.includes(rest[0])) throw new UsageError(`reference: нужно действие ${REFERENCE_ACTIONS.join('|')}`);
    if (!values.slug) throw new UsageError('reference: нужен --slug <имя-слепка> (латиница, цифры, дефис)');
    if (rest[0] === 'fetch' && !values.url) throw new UsageError('reference fetch: нужен --url <адрес страницы референса>');
    if ((rest[0] === 'shot' || rest[0] === 'audit' || rest[0] === 'compare' || (rest[0] === 'plan' && values.update)) && !isLabel(values.source)) throw new UsageError(`reference ${rest[0]}: нужен --source <метка карты сайта> (P00…), имена страниц слепка не принимаются`);
    if (rest[0] === 'plan' && !values.source) throw new UsageError('reference plan: нужен --source <имя страницы из слепка> или метка карты сайта (--source P07)');
    if (rest[0] === 'plan' && values.page === undefined && !isLabel(values.source)) throw new UsageError('reference plan: нужен явный --page <черновая страница> — страница по умолчанию не подставляется; или метка карты сайта: --source P07');
    if (rest[0] === 'plan' && values.zone !== undefined) {
      if (!REFERENCE_ZONES.includes(values.zone)) throw new UsageError(`reference plan: --zone ждёт ${REFERENCE_ZONES.join('|')}, получено ${values.zone}`);
      if (isLabel(values.source)) throw new UsageError('reference plan: зона задаётся ролью метки в site.json');
    }
    for (const k of ['max', 'delay', 'settle']) if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(`reference: --${k} должен быть целым числом, получено ${values[k]}`);
    if (rest[0] === 'plan' && values.substitute) {
      for (const pair of values.substitute.flatMap((s) => s.split(','))) {
        if (!/^\d+=\d+$/.test(pair.trim())) throw new UsageError(`reference plan: --substitute ждёт пары <tplid>=<tplid>, получено ${pair}`);
      }
    }
  }
  if (cmd === 'catalog') {
    if (!CATALOG_ACTIONS.includes(rest[0])) throw new UsageError(`catalog: нужно действие ${CATALOG_ACTIONS.join('|')}`);
    if (rest[0] === 'capture' || rest[0] === 'calibrate') {
      const act = `catalog ${rest[0]}`;
      if (values.page === undefined) throw new UsageError(`${act}: нужен явный --page <черновая страница> — страница по умолчанию не подставляется`);
      if (!values.slug && !values.tplid) throw new UsageError(`${act}: нужен --slug <слепок> или --tplid <список через запятую>`);
      if (values.tplid !== undefined && !/^\d+(,\d+)*$/.test(values.tplid)) throw new UsageError(`${act}: --tplid должен быть списком чисел через запятую, получено ${values.tplid}`);
      for (const k of ['delay', 'batch', 'pause']) {
        if (values[k] !== undefined && !/^\d+$/.test(values[k])) throw new UsageError(`${act}: --${k} должен быть целым числом, получено ${values[k]}`);
      }
    }
  }
  if (cmd === 'doctor' && rest.length) throw new UsageError('doctor: лишние аргументы');
  if (cmd !== 'setup' && (values.agent !== undefined || values.project !== undefined)) throw new UsageError('--agent и --project — только для setup');
  if (cmd === 'setup') {
    if (rest.length) throw new UsageError('setup: лишние аргументы');
    if (values.site !== undefined && !values.site.trim()) throw new UsageError('--site: пустое значение');
    if (values.site === undefined && values.agent === undefined) throw new UsageError('setup: нужен --site <папка сайта> и/или --agent claude|codex|all');
    if (values.agent !== undefined && !SETUP_AGENTS.includes(values.agent)) throw new UsageError('--agent: claude, codex или all');
    if (values.project !== undefined && values.site === undefined) throw new UsageError('--project нужен вместе с --site');
  }
  if (cmd === 'rollback' && !rest[0]) throw new UsageError('rollback: нужен путь к записи журнала (<папка сайта>/site-baseline/journal/<pageid>/<файл>.json)');
  if (cmd === 'find' && !rest[0]) throw new UsageError('find: нужна строка для поиска');
  if (cmd === 'upload' && !rest[0]) throw new UsageError('upload: нужен путь к файлу');
  if (cmd === 'replace' && rest.length < 2) throw new UsageError('replace: нужны две строки — что и на что заменить');
  if (values.page !== undefined && !/^\d+$/.test(values.page)) throw new UsageError(`--page должен быть числом, получено ${values.page}`);
  if (values.wait !== undefined && !/^\d+$/.test(values.wait)) throw new UsageError(`--wait должен быть числом секунд, получено ${values.wait}`);
  return { cmd, values: { ...values, pageExplicit: values.page !== undefined }, positionals: rest };
}

/** Код выхода по ошибке: SESSION_LOST → 3, ошибка аргументов → 2, остальное → 1. */
export function exitCodeFor(error) {
  if (!error) return EXIT.OK;
  if (error.exitCode !== undefined) return error.exitCode;
  if (error.code === 'SESSION_LOST') return EXIT.SESSION_LOST;
  return EXIT.REFUSED;
}

/** Короткий итог для stdout: текст не длиннее ~20 строк либо JSON по --json. */
export function formatSummary(summary, asJson) {
  if (asJson) return JSON.stringify(summary, null, 2);
  const lines = Object.entries(summary).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
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
      status: 'инвентарь снят',
      pageid: values.page,
      records: list.length,
      zero: list.filter((r) => r.zeroIndex).length,
      hidden: list.filter((r) => r.hidden).map((r) => r.recordid),
      path: `<папка сайта>/site-baseline/records/${values.page}/_inventory.json`,
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
      if (wanted && targets.length !== wanted.size) throw new Error(`не все recordid найдены в инвентаре: ${[...wanted].filter((id) => !targets.some((t) => t.recordid === id)).join(', ')}`);
    }
    const saved = await cycle.snapshotBlocks(driver, targets, { source: 'tilda snapshot' });
    return { status: 'снимки сняты', pageid: values.page, blocks: saved.length, zero: saved.filter((s) => s.kind === 'zero').length, records: saved.filter((s) => s.kind === 'record').length, backups: saved.filter((s) => s.backup).length };
  });
}

function planSummary(r, values) {
  const diff = (r.diff || []).slice(0, 12).map((d) =>
    d.create ? (d.source ? `создать ${d.create} ← ${d.source} (tpl ${d.tplid})` : `создать ${d.create} из полей (tpl ${d.tplid}, полей ${d.fields})`)
      : d.blockHidden !== undefined ? `${d.recordid}: блок ${d.blockHidden === 'y' ? 'скрыть' : 'показать'}`
      : d.list ? `${d.recordid} список: ${d.list} ${d.lid || ''}${d.field ? '.' + d.field : ''}${d.to !== undefined && typeof d.to !== 'object' ? ` → ${JSON.stringify(d.to).slice(0, 60)}` : ''}`
      : d.sort ? `${d.recordid}: позиция ${d.from + 1} → ${d.to + 1}`
        : `${d.recordid}${d.key ? `[${d.key}]` : ''}.${d.field}: ${JSON.stringify(d.from ?? '')} → ${JSON.stringify(d.to)}`.slice(0, 160),
  );
  return {
    status: r.dryRun ? 'dry-run, записи не было' : r.verify.length ? `verify: ${r.verify.length} расхождений` : 'записано, verify: 0 расхождений',
    pageid: r.pageid,
    plan: values.plan,
    ops: r.ops,
    payloads: r.payloads,
    written: r.written,
    created: r.created.map((c) => `${c.id} → ${c.recordid}${c.zeroIndex ? ` (zero#${c.zeroIndex})` : ''}`),
    uploads: (r.uploads || []).length,
    diff,
    verify: r.verify.slice(0, 5),
    layout: r.layout ? (r.shots && r.shots.length ? `геометрия менялась — скриншоты сняты (${r.shots.length})` : `геометрия менялась — скриншот не снят${r.shotError ? ': ' + r.shotError : ''}`) : 'нет',
    shots: (r.shots || []).map((f) => f.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')),
    ms: r.ms,
  };
}

async function cmdApply(values) {
  const cycleMod = await import('./cycle.mjs');
  const plan = cycleMod.readPlan(values.plan);
  if (values.pageExplicit && String(plan.page) !== String(values.page)) throw new UsageError(`--page ${values.page} не совпадает с page плана ${plan.page}`);
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
  if (values.pageExplicit && String(record.page) !== String(values.page)) throw new UsageError(`--page ${values.page} не совпадает со страницей записи журнала ${record.page}`);
  values = { ...values, page: String(record.page), plan: positionals[0] };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.rollback(driver, positionals[0], { dryRun: values['dry-run'] });
    const summary = planSummary(r, values);
    summary.status = r.dryRun ? 'dry-run отката, записи не было' : r.verify.length ? `откат: verify ${r.verify.length} расхождений` : `откат ${r.ops} операций, verify: 0`;
    summary.rollbackOf = r.rollbackOf;
    summary.skipped = r.skipped.map((x) => `${x.kind}:${x.recordid || x.id}${x.field ? '.' + x.field : ''} — ${x.reason}`);
    summary.journal = r.journal ? r.journal.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/') : null;
    if (r.verify.length) summary.exitCode = EXIT.REFUSED;
    return summary;
  });
}

/** Строка итога о пропущенных снимках удалённых блоков; пусто, если пропусков нет. */
function staleLine(n) {
  return n > 0 ? { skippedStale: `${n} снимков удалённых блоков пропущено` } : {};
}

async function cmdFind(values, positionals) {
  const fr = await import('./find-replace.mjs');
  const { inventoryAgeMs } = await import('./apply-plan.mjs');
  const { baselineDir } = await import('./lib/paths.mjs');
  const r = fr.find(values.page, positionals[0]);
  const ageSec = Math.round(inventoryAgeMs(values.page, { baseDir: baselineDir() }) / 1000);
  return {
    status: `найдено ${r.hits.length} вхождений в ${new Set(r.hits.map((h) => h.recordid)).size} блоках (просмотрено ${r.blocks})`,
    pageid: values.page,
    needle: positionals[0],
    hits: r.hits.slice(0, 15).map((h) => `${h.kind} ${h.recordid}${h.elem_id ? ' elem ' + h.elem_id : h.lid ? ' lid ' + h.lid : ''} .${h.field}: ${JSON.stringify(fr.normalize(h.value)).slice(0, 80)}`),
    skippedForm: r.skippedForm.map((x) => `${x.kind} ${x.recordid} .${x.field} (поле формы — пропущено)`),
    ...staleLine(r.skippedStale),
    snapshotsAge: Number.isFinite(ageSec) ? `инвентарь снят ${ageSec} с назад; свежесть снимков — <папка сайта>/site-baseline/snapshots-index.json` : 'инвентаря нет — снимите snapshot',
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
    writeFileSync(out, JSON.stringify({ _: `Замена ${JSON.stringify(needle)} → ${JSON.stringify(replacement)} по снимкам страницы ${values.page}, собрано tilda.mjs replace`, ...r.plan }, null, 2) + '\n', 'utf8');
  }
  return {
    status: r.plan.ops.length ? `план замены: ${r.plan.ops.length} операций, ${r.replacements} замен — запись обычным apply` : 'вхождений нет, план не создан',
    pageid: values.page,
    plan: r.plan.ops.length ? outSlash : null,
    addresses: r.hits.slice(0, 15).map((h) => `${h.kind} ${h.recordid}${h.elem_id ? ' elem ' + h.elem_id : h.lid ? ' lid ' + h.lid : ''} .${h.field}`),
    skippedForm: r.skippedForm.map((x) => `${x.kind} ${x.recordid} .${x.field} (поле формы — не заменяется)`),
    ...staleLine(r.skippedStale),
    next: r.plan.ops.length ? `node scripts/tilda.mjs apply --plan ${outSlash}` : null,
  };
}

async function cmdUpload(values, positionals) {
  const up = await import('./upload.mjs');
  const file = up.validateFile(positionals[0]); // отказ до браузера и до CDN
  return withEditor(values, async (driver) => {
    const r = await up.upload(driver, file.path);
    return { status: `загружено ${r.file} → ${r.cdnUrl}`, bytes: r.bytes, width: r.width, height: r.height, uuid: r.uuid, image: r.image };
  });
}

async function cmdPreview(values) {
  const cycleMod = await import('./cycle.mjs');
  const plan = cycleMod.readPlan(values.plan);
  if (values.pageExplicit && String(plan.page) !== String(values.page)) throw new UsageError(`--page ${values.page} не совпадает с page плана ${plan.page}`);
  values = { ...values, page: String(plan.page) };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.preview(driver, plan, { shotsDir: values.out });
    return {
      status: `предпросмотр ${r.previews.length} блоков, записи не было`,
      pageid: r.pageid,
      plan: values.plan,
      shots: r.previews.map((p) => p.shot && p.shot.replace(/\\\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')).filter(Boolean),
      skipped: r.skipped.map((s) => `${s.recordid} (${s.kind}): ${s.reason}`),
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
      status: `скриншоты: ${r.files.length} файл(ов)`,
      pageid: r.pageid,
      widths: r.widths.map((w) => `${w.width} px: высота ${w.height}, блоков ${w.records}, файлов ${w.files.length}`),
      files: r.files.map((f) => f.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')),
    };
    if (r.links) {
      const s = lc.summarize(r.links.results);
      out.status += `; проверено адресов ${s.checked}, битых ссылок ${s.brokenLinks}, битых картинок ${s.brokenImages}`;
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
    return { status: `проверено адресов ${s.checked}: битых ссылок ${s.brokenLinks}, битых картинок ${s.brokenImages}, прочих ${s.brokenAssets}, предупреждений ${s.warnings}, внутренних ${s.internal}`, pageid: r.pageid, ...s, exitCode: s.brokenLinks || s.brokenImages || s.brokenAssets ? EXIT.REFUSED : EXIT.OK };
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
      status: `карта блоков: ${r.files.length} файл(ов), подписано ${r.drawn} из ${r.inventory}${values.open ? ', открыто в просмотрщике' : ''}`,
      pageid: r.pageid,
      widths: r.widths.map((w) => `${w.width} px: высота ${w.height}, подписано ${w.drawn}, не на виде ${w.labels.length - w.drawn}, файлов ${w.files.length}`),
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
    return { status: 'удаление страниц вне автоматизации — инструкция ниже', pageid: values.page, steps: ops.deletePageInstructions(values.page) };
  }
  if (action === 'role') return pageRole(values, ops);
  if (action === 'title') return pageTitle(values, ops);
  if (action === 'publish' && !values.confirm) {
    log.warn('page', 'публикация без --confirm — отказ до запроса браузера', { pageid: values.page });
    return { status: 'публикация не подтверждена: повторите команду с --confirm', pageid: values.page, exitCode: EXIT.REFUSED };
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
      return { status: `создан дубль ${r.pageid}`, source: r.source, pageid: r.pageid, title: st.title, records: st.records, editor: r.editor, note: 'страница не опубликована; снимок и сверку делает apply/verify, удаление — человек' };
    }
    if (action === 'create') {
      const r = await ops.createPage(driver);
      const st = await browser.openEditor(session, r.pageid, { layers: [] });
      return { status: `создана пустая страница ${r.pageid}`, pageid: r.pageid, title: st.title, records: st.records, editor: r.editor };
    }
    const r = await ops.publishPage(driver, values.page, { confirmed: values.confirm === true });
    return { status: `страница ${r.pageid} опубликована`, pageid: r.pageid, link: r.link, wslink: r.wslink, customdomain: r.customdomain, note: 'правки видны на проде с задержкой 1–5 минут (кэш CDN)' };
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
    log.warn('page', 'page role без --confirm — отказ до запроса браузера', { header: values.header, footer: values.footer, index: values.index });
    return { status: `page role: нужен --confirm — назначение меняет ${indexMode ? 'главную страницу сайта' : 'шапку/подвал всех страниц проекта'}`, exitCode: EXIT.REFUSED };
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
    const rollback = r.rollback.startsWith('page role') ? cliHint(r.rollback) : r.rollback;
    const base = { before: r.before, after: r.after, record: r.record, rollback, protectedAffected: protectedPages().length, next: cliHint('page list') };
    if (r.otherChanged.length) return { status: `назначено, но изменились другие настройки: ${r.otherChanged.join(', ')}`, ...base, otherChanged: r.otherChanged, exitCode: EXIT.REFUSED };
    const done = indexMode ? 'главная назначена' : 'шапка и подвал назначены';
    return { status: r.changed ? done : 'без изменений: роли уже такие', ...base };
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
  if (guard.includes(String(values.page))) return { status: `страница ${values.page} защищена (TILDA_PROTECTED_PAGES)`, exitCode: EXIT.REFUSED };
  const session = await browser.open();
  try {
    await browser.openProject(session, { layers: ['tilda-project'] });
    const driver = { callWithResponse: (fn, args, opts) => browser.callWithResponse(session.page, fn, args, opts) };
    const r = await ops.setPageTitle(driver, values.page, values.title, { protectedIds: guard });
    const st = await browser.openEditor(session, values.page, { layers: [] });
    // document.title редактора — «Tilda: <заголовок>»; в итоге — сам заголовок.
    return { status: `заголовок страницы ${r.pageid} записан`, pageid: r.pageid, title: String(st.title ?? '').replace(/^tilda:\s*/i, ''), next: cliHint('page list') };
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
  log.debug('page', 'список страниц', { projectid, out: outSlash, count: r.pages.length });
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ projectid, source: r.source, captured: new Date().toISOString(), pages: r.pages, skipped: r.skipped }, null, 2)}\n`);
  } catch (e) {
    log.error('page', 'перечень получен, но файл не записан', { out: outSlash, error: e.message });
    e.message = `перечень страниц получен, но не записан в ${outSlash}: ${e.message}`;
    throw e;
  }
  const summary = { projectid, source: r.source, pages: r.pages.length, path: outSlash };
  if (r.pages.length) {
    const protectedCount = r.pages.filter((p) => p.protected).length;
    const head = r.pages.slice(0, 5).map((p) => (titles ? `${p.pageid} ${p.title}` : `${p.pageid}${p.role ? ` (${p.role})` : ''}`)).join('; ');
    Object.assign(summary, { status: `страниц: ${r.pages.length} (защищённых: ${protectedCount})`, protected: protectedCount, preview: r.pages.length > 5 ? `${head}; … ещё ${r.pages.length - 5}` : head });
  } else if (r.emptyMarker) {
    summary.status = 'в проекте нет страниц';
  } else {
    Object.assign(summary, { status: 'список страниц не распознан', note: 'список страниц не распознан: разметка или ответ кабинета изменились', exitCode: EXIT.REFUSED });
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
    if (String(plan.page) !== values.from) throw new UsageError(`promote: план ${path} адресован странице ${plan.page}, а --from ${values.from}`);
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
    log.info('promote', 'режим снимков', { ...pace, betweenSnapshotsMs });
    const r = await promoteMod.promote({ browser, session, cycle, ops }, { plans, from: values.from, to: values.to, unprotect: values.unprotect, dryRun: values['dry-run'], pace, betweenSnapshotsMs });
    return {
      status: `накат на ${r.to} выполнен: планов ${r.applied.length}, verify 0; бэкап ${r.backup} (${r.backupName}) остаётся точкой возврата`,
      from: r.from,
      to: r.to,
      backup: r.backup,
      backupName: r.backupName,
      compare: `блоков ${r.compare.blocks}, ожидаемых различий ${r.compare.explained}, сверх плана 0`,
      applied: r.applied.map((a) => `${a.plan}: записано ${a.written}, verify ${a.verify}${a.created && a.created.length ? `, создано ${a.created.length}` : ''}${a.dryRun ? ' (dry-run)' : ''}`),
      journal: r.applied.map((a) => rel(a.journal)).filter(Boolean),
      report: rel(r.reportPath),
      capture: r.analysis ? `запросов к tilda.ru ${r.analysis.calls} за ${r.analysis.spanSec} с, максимум ${r.analysis.maxPerMinute} в минуту, обрывов нет` : null,
      note: 'страница не опубликована: публикация — отдельно, page publish --page <id> --confirm по явной команде',
    };
  } catch (e) {
    if (e && e.name === 'PromoteError' && e.report) {
      const a = e.report.analysis;
      const lost = a && a.firstLost;
      return {
        status: `останов на шаге ${e.code}: ${e.message}`,
        backup: e.report.backup,
        report: rel(e.report.reportPath),
        capture: a ? `запросов к tilda.ru ${a.calls} за ${a.spanSec} с, максимум ${a.maxPerMinute} в минуту${a.retryAfter ? `, Retry-After ${a.retryAfter}` : ''}` : null,
        firstLost: lost ? `запрос #${lost.index} через ${lost.sinceStartSec} с (${lost.url.replace(/^https:\/\/tilda\.ru/, '')}), статус ${lost.status}, маркер ${lost.marker || 'html без маркера'}; за 60 с до него ${lost.inLast60s} запросов, за 120 с ${lost.inLast120s}, за 300 с ${lost.inLast300s}` : null,
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
    return { status: all.length ? `планов реплик: ${all.length}` : 'планов реплик нет', pageid: values.page, sessions: all.slice(0, 10).map((x) => `${rel(x.path)}  ops ${x.session.ops.length}  ${x.session.applied ? `применён ${x.session.applied}` : 'открыт'}`) };
  }
  const open = sp.listSessions(values.page).find((x) => !x.session.applied);
  if (action === 'diff' || action === 'drop' || action === 'apply') {
    if (!open) return { status: 'открытого плана реплик нет — сначала stage <операция>', pageid: values.page, exitCode: EXIT.REFUSED };
    if (action === 'drop') {
      sp.dropSession(open.path);
      return { status: `план реплик сброшен (${open.session.ops.length} операций)`, pageid: values.page, plan: rel(open.path) };
    }
    if (action === 'diff') {
      const d = sp.diffSession(open.session);
      return { status: `в плане ${d.ops} операций, изменений ${d.changes.length}, не применено`, pageid: values.page, plan: rel(open.path), changes: d.changes.slice(0, 15), next: `node scripts/tilda.mjs stage apply --page ${values.page}` };
    }
    const plan = { page: open.session.page, name: open.session.name, resStrategy: open.session.resStrategy, ops: open.session.ops };
    return withEditor({ ...values, page: String(plan.page) }, async (driver, { cycle }) => {
      const r = await cycle.apply(driver, plan, { dryRun: values['dry-run'], emitCalls: values['emit-calls'], planPath: open.path });
      const summary = planSummary(r, { plan: rel(open.path) });
      summary.journal = rel(r.journal);
      if (r.verify.length) summary.exitCode = EXIT.REFUSED;
      else if (!r.dryRun) {
        sp.markApplied(open.session, new Date().toISOString());
        summary.status += '; план реплик закрыт';
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
    status: `в плане ${d.ops} операций (${results.filter((r) => r.action === 'added').length} новых, ${results.filter((r) => r.action === 'replaced').length} заменено), изменений ${d.changes.length}, не применено`,
    pageid: values.page,
    plan: rel(path),
    staged: results.map((r) => `${r.action === 'added' ? '+' : '~'} ${r.kind} @ ${r.address}${r.overwritten && r.overwritten.length ? ` (перезаписано: ${r.overwritten.join(', ')})` : ''}`),
    changes: d.changes.slice(0, 15),
    next: `node scripts/tilda.mjs stage apply --page ${values.page}  — записать всё разом; stage drop — сбросить`,
  };
}

async function cmdJournal(values) {
  const journalMod = await import('./journal.mjs');
  const list = journalMod.listRecords(values.page);
  return {
    status: list.length ? `записей: ${list.length}` : 'журнал пуст',
    pageid: values.page,
    records: list.slice(0, 15).map((r) => `${r.at}  ${r.plan.name}  блоков ${r.blocks.length}, записано ${r.written}, verify ${r.verify.length}${r.rollbackOf ? `  (откат ${r.rollbackOf})` : ''}  ${r.file.replace(/\\/g, '/').replace(/^.*site-baseline\//, 'site-baseline/')}`),
  };
}

async function cmdVerify(values) {
  const cycleMod = await import('./cycle.mjs');
  const plan = cycleMod.readPlan(values.plan);
  if (values.pageExplicit && String(plan.page) !== String(values.page)) throw new UsageError(`--page ${values.page} не совпадает с page плана ${plan.page}`);
  values = { ...values, page: String(plan.page) };
  return withEditor(values, async (driver, { cycle }) => {
    const r = await cycle.verifyPlan(driver, plan);
    return { status: r.verify.length ? `verify: ${r.verify.length} расхождений` : 'verify: 0 расхождений', pageid: r.pageid, plan: values.plan, blocks: r.blocks, verify: r.verify.slice(0, 5), exitCode: r.verify.length ? EXIT.REFUSED : EXIT.OK };
  });
}

async function cmdBrowser(values, positionals) {
  const browser = await import('./lib/browser.mjs');
  const action = positionals[0];
  const role = values.donor ? 'donor' : 'test';
  const profile = browser.profileDir(role);
  const flag = values.donor ? ' --donor' : '';
  log.debug('browser', 'действие', { action, role, profile });
  if (action === 'status') {
    const st = browser.daemonStatus(profile);
    return st ? { status: 'держатель запущен', role, pid: st.pid, port: st.port, startedAt: st.startedAt, profile } : { status: 'держатель не запущен', role, profile };
  }
  if (action === 'start') {
    const st = await browser.startDaemon({ role });
    return { status: 'держатель запущен', role, pid: st.pid, port: st.port, startedAt: st.startedAt, profile, window: st.minimized === false ? 'на экране' : `свёрнуто; показать — browser${flag} show` };
  }
  if (action === 'show' || action === 'hide') {
    const done = await browser.setDaemonWindow(action === 'show' ? 'normal' : 'minimized', { role });
    if (action === 'show') return { status: 'окно держателя на экране', role, next: `свернуть обратно — browser${flag} hide` };
    return { status: done ? 'окно держателя свёрнуто' : 'держатель не запущен', role };
  }
  const stopped = await browser.stopDaemon({ role });
  return { status: stopped ? 'держатель остановлен, браузер закрыт' : 'держатель не был запущен', role };
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
      log.info('session', 'сессии донора нет — войдите в открытом окне браузера', { waitSec });
      if (waitSec <= 0) throw e;
      await browser.waitForLogin(session, null, { timeoutMs: waitSec * 1000, target: 'project' });
      state = await browser.openProject(session, { layers: [] });
      loggedIn = true;
    }
    return {
      status: 'сессия донора жива',
      role: 'donor',
      projectid: state.projectid,
      loggedIn,
      profile: session.profileDir,
      note: 'проект донора только читается: запись в слое запрещена allow-списком',
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
      log.info('session', 'сессии нет — войдите в открытом окне браузера', { waitSec });
      if (waitSec <= 0) throw e;
      await browser.waitForLogin(session, values.page, { timeoutMs: waitSec * 1000 });
      state = await browser.openEditor(session, values.page);
      loggedIn = true;
    }
    return {
      status: 'сессия жива',
      pageid: state.pageid,
      title: state.title,
      records: state.records,
      layers: state.layers.map((l) => `${l.name} (${l.bytes} Б)`),
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
  const blocking = r.unmatched.filter((u) => !/missing/.test(u.reason));
  const summary = {
    status: `карта донора ${values.slug}: сопоставлено ${r.matched.length}, без пары ${r.unmatched.length}`,
    matched: r.matched.slice(0, 20).map((m) => `${m.label} → ${m.donorPageid} (${m.by})`),
    unmatched: r.unmatched.map((u) => `${u.label}: ${u.reason}`),
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
    if (!entry) return { status: `donor copy: метки ${values.source} нет в site.json слепка ${values.slug}`, exitCode: EXIT.REFUSED };
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
      if (found.reason) log.debug('donor', 'адрес приёмника не ставится', { label, reason: found.reason });
    } catch (e) {
      log.warn('donor', 'адрес донора не определён — перенос без адреса', { label, error: String(e.message || e).slice(0, 160) });
    }
    source ??= entry.donorPageid;
    target ??= entry.pageid;
    if (!source) return { status: `donor copy: у метки ${label} нет donorPageid — donor map --slug ${values.slug} или --from <pageid>`, exitCode: EXIT.REFUSED };
    if (!target) return { status: `donor copy: у метки ${label} нет pageid — reference pages --slug ${values.slug} --create или --to <pageid>`, exitCode: EXIT.REFUSED };
  }
  source = String(source);
  target = String(target);
  if (source === target) return { status: 'donor copy: источник и приёмник совпадают', exitCode: EXIT.USAGE };
  if (protectedPages().includes(target)) return { status: dc.COPY_REASONS.protectedTarget(target), exitCode: EXIT.REFUSED };
  log.info('donor', 'copy', { label, source, target, replace: values.replace, dryRun: values['dry-run'] });
  const test = await browser.open({ role: 'test' });
  let donor;
  try {
    donor = await browser.open({ role: 'donor' });
    const drivers = {
      test: {
        call: (fn, a = [], o = {}) => withLoginHint(browser.call(test.page, fn, a, o), 'тестовый держатель: session'),
        openEditor: (p) => withLoginHint(browser.openEditor(test, p, { layers: CYCLE_LAYERS }), 'тестовый держатель: session'),
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
      donor: { call: (fn, a = [], o = {}) => withLoginHint(browser.call(donor.page, fn, a, o), 'держатель донора: session --donor'), openEditor: (p) => withLoginHint(browser.openEditor(donor, p, { layers: DONOR_LAYERS }), 'держатель донора: session --donor'), setWritable: (l) => browser.setWritablePages(donor.page, l) },
    };
    const r = await dc.copyDonorPage(drivers, { sourcePageid: source, targetPageid: target, replace: values.replace, dryRun: values['dry-run'], protectedPages: protectedPages(), label, role: entryRole, donorTitle, alias });
    const summary = { label, source: r.source, target: r.target, blocks: r.blocks };
    if (r.dryRun) return { status: `dry-run: к переносу ${r.blocks} блоков${r.before ? ` (на приёмнике ${r.before}, --replace: ${values.replace ? 'да' : 'нет'})` : ''}`, ...summary, plan: r.plan.steps.join(' → ') };
    const next = label ? cliHint(`donor verify --slug ${values.slug} --source ${label}`) : undefined;
    return {
      status: r.ok ? `перенесено ${r.pasted} блоков, порядок совпал` : `перенесено ${r.pasted} из ${r.blocks}, порядок НЕ совпал`,
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
    const skipped = r.skipped.map((s) => `${s.label}: ${s.reason}`);
    if (r.dryRun) {
      return { status: `dry-run: к записи ${r.todo.length} адресов, пропущено ${r.skipped.length}`, todo: r.todo.map((t) => t.label).join(', '), skipped, next: cliHint(`donor aliases --slug ${values.slug}`) };
    }
    return {
      status: `адресов записано ${r.assigned.length} из ${r.todo.length}, пропущено ${r.skipped.length}, отказов ${r.failed.length}${r.stopped ? ' — остановлено после отказов подряд' : ''}`,
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
  if (!entry) return { status: `donor links: метки ${values.source} нет в site.json слепка ${values.slug}`, exitCode: EXIT.REFUSED };
  if (!entry.pageid) return { status: `donor links: у метки ${entry.label} нет pageid — страница не перенесена`, exitCode: EXIT.REFUSED };
  const pageid = String(entry.pageid);
  if (protectedPages().includes(pageid)) return { status: `donor links: страница ${pageid} защищена (TILDA_PROTECTED_PAGES)`, exitCode: EXIT.REFUSED };
  const manifest = readManifest(values.slug);
  if (!manifest?.url) return { status: `donor links: в слепке ${values.slug} нет адреса референса (reference.json)`, exitCode: EXIT.REFUSED };
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
    if (!r.plan.ops.length) return { status: `ссылок донора (домен, страницы по ID) для переписи нет (оставлено ${r.unchanged.length}, поля форм ${r.skippedForm.length})`, ...base };
    const out = join(plansDir(), `donor-links-${values.slug}-${entry.label}.json`);
    const outSlash = out.replace(/\\/g, '/');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ _: `Ссылки на домен донора → относительные пути, метка ${entry.label}; собрано tilda.mjs donor links`, ...r.plan }, null, 2)}\n`, 'utf8');
    if (values['dry-run']) {
      return { status: `dry-run: к переписи ${r.changed} ссылок в ${r.plan.ops.length} операциях`, ...base, plan: outSlash, next: cliHint(`donor links --slug ${values.slug} --source ${entry.label}`) };
    }
    const a = await cycle.apply(driver, r.plan, { planPath: out });
    const summary = planSummary(a, { plan: outSlash });
    summary.status = a.verify.length ? `ссылки переписаны, verify: ${a.verify.length} расхождений — восстановление: donor copy --replace и donor aliases` : `переписано ${r.changed} ссылок, verify: 0 расхождений`;
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
  if (!site) return { status: `donor check: карты сайта ${values.slug} нет — сначала reference pages --slug ${values.slug}`, exitCode: EXIT.REFUSED };
  const manifest = readManifest(values.slug);
  if (!manifest?.url) return { status: `donor check: в слепке ${values.slug} нет адреса референса (reference.json)`, exitCode: EXIT.REFUSED };
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
  });
  const rel = (p) => p.replace(/\\/g, '/').replace(/^.*site-reference\//, 'site-reference/');
  return {
    status: `проверки: меток ${r.labels.length - r.failed}, сбоев ${r.failed}, нарушений ссылок ${r.linkViolations}; карта ${r.map.ok ? 'полная' : 'неполная'}; главная ${r.index.ok ? 'верно' : 'не та'}`,
    violations: r.labels.flatMap((l) => (l.violations ?? []).map((v) => `${l.label}: ${v.kind} ×${v.count}`)).slice(0, 20),
    ...(r.failed ? { failed: r.labels.filter((l) => l.error).map((l) => `${l.label}: ${l.error}`) } : {}),
    htmlBlocks: r.labels.reduce((n, l) => n + (l.htmlBlocks ?? []).filter((b) => b.placeholder || b.hosts.length).length, 0),
    forms: r.labels.reduce((n, l) => n + (l.forms?.length ?? 0), 0),
    skipped: r.skipped.map((s) => `${s.label}: ${s.reason}`),
    manual: r.manual.length,
    checks: rel(r.checksPath),
    summary: rel(r.summaryPath),
    next: !r.index.ok && r.index.fix
      ? `${cliHint(r.index.fix)}, затем page list и повторный donor check --slug ${values.slug}`
      : 'HTML-блоки, formmsgurl и ручные пункты — назвать владельцу по разделу сводки',
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
    const driver = { readProjectStyle: () => withLoginHint(browser.call(session.page, 'readProjectStyle', [], { attempts: 1 }), 'держатель донора: session --donor') };
    const r = await ds.captureDonorStyle(driver, { slug: values.slug });
    const shown = Object.fromEntries(Object.entries(r.values).filter(([k]) => k !== 'myfonts_json'));
    return {
      status: `оформление донора снято: шрифтов ${r.fonts.length}, настроек ${Object.keys(shown).length}`,
      fonts: r.fonts.map((f) => `${f.name}: весов ${Object.keys(f.files).length}`),
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
    log.warn('donor', 'donor style --apply без --confirm — отказ до браузера', {});
    return { status: 'donor style --apply: нужен --confirm — оформление меняет вид всех страниц тестового проекта', exitCode: EXIT.REFUSED };
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
    const hint = 'тестовый держатель: session';
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
      skipped: r.skipped.map((s) => `${s.key}: ${s.reason}`),
      notMatched: r.notMatched,
      otherChanged: r.otherChanged,
      record: r.record,
      next: cliHint(`donor verify --slug ${values.slug} --source P00`),
    };
    const failed = r.notMatched.length || r.otherChanged.length;
    const nothing = !r.fonts.uploaded.length && !r.changed.length;
    const status = failed
      ? `оформление записано, но ${r.otherChanged.length ? `изменились другие настройки: ${r.otherChanged.join(', ')}` : `не совпали: ${r.notMatched.join(', ')}`}`
      : nothing ? `без изменений: оформление уже как у донора (пропущено ${r.skipped.length})` : `оформление донора записано: шрифтов загружено ${r.fonts.uploaded.length}, настроек изменено ${r.changed.length}, пропущено ${r.skipped.length}`;
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
  }, { slug: values.slug, label, pageid: target.pageid, widths }));
  const entry = resolveSource(readSite(values.slug), label);
  let referenceShots = null;
  let referenceNote = null;
  if (entry?.url) {
    const ref = await import('./reference.mjs');
    try {
      referenceShots = await ref.shotReference({ slug: values.slug, source: label, widths });
    } catch (e) {
      if (e.code !== 'REFERENCE_UNAVAILABLE') throw e;
      referenceNote = `страница референса недоступна: ${e.message}`;
      log.warn('donor', 'кадр референса не снят', { label, error: e.message });
    }
  } else {
    referenceNote = 'шапка/подвал видны на кадре P00';
  }
  const r = dv.finishTransferReport(data, referenceShots, { slug: values.slug, referenceNote });
  return {
    status: `сверка ${label}: состав ${r.composition.equal ? 'совпал' : 'НЕ совпал'}; разметка ${Math.round(r.markup.meanScore * 100)}%; кадры ${widths.join('/')} сняты`,
    label,
    pageid: target.pageid,
    composition: r.composition.reasons.slice(0, 10),
    heights: r.heights.map((h) => `${h.width}: сборка ${h.built ?? '—'}, референс ${h.reference ?? '—'}`),
    report: r.report,
    shots: { built: r.shots.built, reference: r.shots.reference },
    next: 'осмотреть кадры сборки и референса и заполнить «Вердикт агента» в докладе',
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
    if (e?.code === 'SESSION_LOST' && !String(e.message).includes(hint)) {
      e.message = `${e.message} (${hint})`;
      log.debug('session', '[FIX] подсказка входа добавлена', { hint });
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
  log.debug('donor', 'действие', { action, slug: values.slug });
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
      return { ...r, role: 'donor', note: 'страницы донора только читаются' };
    } finally {
      await browser.close(session);
    }
  }
  log.error('donor', `действие ${action} ещё не реализовано`, { exitCode: EXIT.REFUSED });
  return { status: `donor ${action}: ещё не реализовано`, exitCode: EXIT.REFUSED };
}

/** Хвост итога `reference fetch` про sitemap.xml (только при --sitemap). */
function sitemapNote(sitemap) {
  if (!sitemap) return '';
  return sitemap.status === 200 ? `, sitemap: найдено ${sitemap.found}` : `, sitemap: недоступен (HTTP ${sitemap.status})`;
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
      status: `слепок ${r.slug}: страниц ${r.pages}, снято ${r.fetched}, пропущено ${r.skipped}, ошибок ${r.failed}, в очереди ${r.pending}${sitemapNote(r.sitemap)}`,
      ...r,
      ...(r.pending > 0 ? { next: 'повторите ту же команду — очередь продолжится' } : {}),
      exitCode: r.failed ? EXIT.REFUSED : EXIT.OK,
    };
  }
  if (action === 'structure') {
    const r = await ref.structureReference({ slug: values.slug });
    return { status: `структура пересобрана: страниц ${r.pages}`, ...r };
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
      status: `референс ${r.label}: ширины ${r.widths.map((w) => w.width).join(', ')} — блоков ${blocks}, файлов ${r.files}`,
      dir: r.dir,
      widths: r.widths.map((w) => `${w.width} px: высота ${w.height}, блоков ${w.records}, файлов ${w.files}`),
    };
  }
  const gen = await import('./reference-plan.mjs');
  const r = gen.generateReferencePlan({ slug: values.slug, source: values.source, page: values.page, out: values.out, styles: values.styles, substitutes: gen.parseSubstitutes(values.substitute), zone: values.zone });
  const noStyles = values.styles === false ? ' (без оформления)' : '';
  const subs = r.substituted.length ? `, замен: ${r.substituted.length}` : '';
  const linksNote = r.label ? `, ссылок переписано ${r.links.rewritten}, оставлено ${r.links.kept}` : '';
  const body = `план${r.label ? ' ' + r.label : ''}: операций ${r.ops} из ${r.blocks - r.zoneFiltered} блоков зоны ${r.zone}${linksNote}${subs}${noStyles}`;
  const status = r.skipped.length ? `${body}; записан с пропусками: пропущено ${r.skipped.length}` : `${body}; записан`;
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
    log.warn('reference', 'reference project --apply без --confirm — отказ до браузера', {});
    return { status: 'reference project: нужен --confirm — оформление меняет вид всех страниц тестового проекта', exitCode: EXIT.REFUSED };
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
      css: `${css.bytes} байт`,
      fonts: desired.fonts.map((f) => `${f.family} ${f.weight}`),
      values: desired.values,
      fontAliases: desired.fontAliases,
      undecided: desired.undecided.map((u) => u.reason),
      path: stylePath,
    };
    if (!values.apply) {
      return { status: `оформление референса: настроек ${Object.keys(desired.values).length}, шрифтов ${desired.fonts.length}; запись — --apply --confirm`, ...base };
    }
    const { resolveProjectId } = await import('./lib/config.mjs');
    const r = await ps.applyProjectStyle(driver, { desired, confirmed: true, confirm: ps.STYLE_CONFIRM, projectid: resolveProjectId() });
    const out = { ...base, changed: r.changed, otherChanged: r.otherChanged, record: r.record, next: cliHint('page list') };
    if (r.otherChanged.length) return { status: `оформление записано, но изменились другие настройки: ${r.otherChanged.join(', ')}`, ...out, exitCode: EXIT.REFUSED };
    return { status: r.changed.length ? `оформление записано: ${r.changed.join(', ')}` : 'без изменений: оформление уже как у референса', ...out };
  } finally {
    await browser.close(session);
  }
}

/** Страница метки из site.json или итог-отказ. */
async function labelPage(values, action) {
  const { readSite, resolveSource } = await import('./lib/reference-store.mjs');
  const entry = resolveSource(readSite(values.slug), values.source);
  if (!entry || !entry.pageid) return { refusal: { status: `reference ${action}: у метки ${values.source} нет pageid — сначала reference pages --slug ${values.slug} --create`, exitCode: EXIT.REFUSED } };
  return { pageid: String(entry.pageid) };
}

/** `reference compare`: поблочная сверка разметки собранной страницы метки с референсом. */
async function cmdReferenceCompare(values) {
  if (values.published && !values.url) return { status: 'reference compare --published: нужен --url <адрес опубликованной страницы>', exitCode: EXIT.USAGE };
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
    const r = await cmp.compareReferencePage(d, { slug: values.slug, label: values.source, published: values.published, url: values.url });
    return {
      status: `сверка ${r.label}: блоков ${r.blocks}, в паре ${r.pairs}, не собрано ${r.refOnly}, лишних ${r.builtOnly}; средняя доля совпавших признаков ${Math.round(r.meanScore * 100)}%`,
      path: r.path,
      report: r.report,
      rows: r.rows.slice(0, 20).map((x) => (x.notBuilt ? `${x.order} ${x.tplid}: не собран` : `${x.order} ${x.tplid}: ${Math.round(x.score * 100)}% ${x.reasons.join('; ')}`)),
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
      status: `план дописывания ${r.label}: операций ${r.ops} (полей ${r.fields}, списков ${r.lists}, новых блоков ${r.created}); причин ${r.unmapped.length}`,
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
    return { status: `reference audit: у метки ${values.source} нет pageid — сначала reference pages --slug ${values.slug} --create`, exitCode: EXIT.REFUSED };
  }
  return withEditor({ ...values, page: entry.pageid }, async (driver) => {
    const r = await siteMod.auditPage(driver, { slug: values.slug, label: values.source, projectid: resolveProjectId() });
    return {
      status: `ссылки ${r.label}: всего ${r.total}, внутренних ${r.internal}, нарушений ${r.violations.length}`,
      path: r.path,
      violations: r.violations.slice(0, 20).map((v) => `${v.kind}: ${v.path} ×${v.count}`),
      exitCode: r.violations.length ? EXIT.REFUSED : EXIT.OK,
    };
  });
}

/** Строки карты сайта для итога: только метки, роли и pageid — без имён слепка и адресов. */
function siteList(site) {
  return site.pages.map((p) => `${p.label} ${p.role} ${p.pageid ?? '—'}${p.missing ? ' (нет в слепке)' : ''}`).slice(0, 40);
}

async function cmdReferencePages(values) {
  const siteMod = await import('./reference-site.mjs');
  if (values.create) return createReferencePages(siteMod, values);
  const r = siteMod.syncSite({ slug: values.slug });
  const content = r.site.pages.filter((p) => p.role === 'content' && !p.missing).length;
  const withPageid = r.site.pages.filter((p) => p.pageid).length;
  return {
    status: `карта сайта ${values.slug}: страниц ${content}, шапка ${r.header ? 'да' : 'нет'}, подвал ${r.footer ? 'да' : 'нет'}, создано ${withPageid} из ${r.site.pages.length}`,
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
        status: `страниц создано ${e.created.length}, осталось ${e.left.length}: ${e.message}`,
        code: e.code,
        left: e.left,
        path: e.path,
        list: siteList(readSite(values.slug)),
        exitCode: EXIT.REFUSED,
      };
    }
    return {
      status: `страниц создано ${r.created.length}, уже были ${r.skipped.length}, осталось ${r.left.length}${r.titleFailed?.length ? `, заголовок не записан: ${r.titleFailed.join(', ')}` : ''}`,
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
    return { status: `каталог: ${rows.length} шаблонов, недоступных ${rows.filter((r) => !r.available).length}`, dir: cat.catalogDir(), rows: rows.slice(0, 40) };
  }
  const tplids = values.tplid ? values.tplid.split(',') : cat.tplidsFromSlug(values.slug);
  if (!tplids.length) throw new UsageError(`catalog ${positionals[0]}: в слепке нет ни одного tplid — сначала reference fetch`);
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
        status: `калибровка: откалибровано ${r.calibrated.length}, пропущено ${r.skipped.length}, ошибок ${r.failed.length}, предпросмотров ${r.previews}`,
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
      status: `каталог: снято ${r.captured.length}, недоступно ${r.unavailable.length}, пропущено ${r.skipped.length}, ошибок ${r.failed.length}`,
      ...r,
      exitCode: r.failed.length ? EXIT.REFUSED : EXIT.OK,
    };
  });
}

export async function run(argv) {
  const parsed = parseCli(argv);
  const { cmd, positionals } = parsed;
  let { values } = parsed;
  if (cmd === 'help') {
    console.log(usage());
    return EXIT.OK;
  }
  // doctor идёт до applySite: битая или ещё не созданная папка сайта — результат проверки, а не ранняя ConfigError.
  if (cmd === 'doctor') {
    const { runDoctor, formatReport } = await import('./doctor.mjs');
    const report = await runDoctor({ site: values.site });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return report.status === 'fail' ? EXIT.REFUSED : EXIT.OK;
  }
  // setup тоже до applySite: папки сайта ещё может не быть, а окружение он не использует.
  if (cmd === 'setup') {
    const summary = await runSetup({ site: values.site, project: values.project, agent: values.agent });
    console.log(formatSummary(summary, values.json));
    return EXIT.OK;
  }
  const site = applySite({ flag: values.site });
  warnRepoEnv();
  log.debug('run', 'сайт', { site: site?.siteDir ?? null });
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
    log.debug('main', '[FIX] конфигурация донора', { action: positionals[0], withTest: writesTest, withProfile });
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
    if (!defaultPage) throw new UsageError(`${cmd}: нужен --page <pageid> или TILDA_DEFAULT_PAGE`);
    values = { ...values, page: defaultPage };
  }
  log.debug('run', 'команда', { cmd, page: values.page, plan: values.plan, dryRun: values['dry-run'], donor: values.donor });
  if (NOT_IMPLEMENTED.has(cmd)) {
    log.error('run', `команда ${cmd} не реализована`, { exitCode: EXIT.REFUSED });
    console.log(formatSummary({ status: 'не реализовано', command: cmd }, values.json));
    return EXIT.REFUSED;
  }
  const handlers = { browser: cmdBrowser, session: cmdSession, inventory: cmdInventory, snapshot: cmdSnapshot, apply: cmdApply, verify: cmdVerify, rollback: cmdRollback, journal: cmdJournal, find: cmdFind, replace: cmdReplace, upload: cmdUpload, preview: cmdPreview, shot: cmdShot, links: cmdLinks, map: cmdMap, page: cmdPage, promote: cmdPromote, stage: cmdStage, reference: cmdReference, catalog: cmdCatalog, donor: cmdDonor };
  const summary = await handlers[cmd](values, positionals);
  const code = summary.exitCode ?? EXIT.OK;
  delete summary.exitCode;
  console.log(formatSummary(summary, values.json));
  return code;
}

/** `.env` в корне репозитория больше не читается: данные и настройки сайта живут в папке сайта. */
function warnRepoEnv() {
  const file = join(repoRoot(), '.env');
  if (existsSync(file)) log.warn('main', '.env в корне репозитория не читается — перенесите его в папку сайта и запускайте с --site <папка>', { file: file.replace(/\\/g, '/') });
}

async function main() {
  let code;
  try {
    code = await run(process.argv.slice(2));
  } catch (e) {
    code = exitCodeFor(e);
    if (e instanceof UsageError) {
      log.error('main', e.message, { exitCode: code });
      console.log(usage());
    } else {
      log.error('main', `${e.code || e.name}: ${e.message}`, { exitCode: code });
      console.log(formatSummary({ status: 'ошибка', code: e.code || e.name, message: e.message }, false));
    }
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
