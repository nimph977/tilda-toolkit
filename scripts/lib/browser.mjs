/**
 * Слой собственного браузера.
 *
 * Chrome с постоянным профилем (`<папка сайта>/.browser-profile/`) держит отдельный фоновый процесс
 * (`browser-daemon.mjs`): браузер открывается один раз и живёт между командами — сессионная
 * кука Тильды не переживает перезапуск Chrome (проверено 2026-09-11), а частые
 * старты браузера роняли сессию. Каждая команда подключается к нему по CDP (`connectOverCDP`)
 * и по завершении только отключается. Без держателя `open()` поднимает его сам.
 * Окно стартует свёрнутым и разворачивается на время входа человека либо по `browser show`.
 *
 * Код браузерного слоя `scripts/browser/*.js` читается с диска и подаётся в страницу
 * `page.evaluate` — через контекст агента он не проходит, сами файлы не меняются
 * (каждый файл — одно стрелочное выражение, здесь оно оборачивается в вызов).
 *
 * Экспорт:
 *   open(opts) → session               подключиться к держателю (поднять при нужде) или запустить свой Chrome;
 *                                       opts.role = 'test' (по умолчанию) | 'donor' — свой профиль и ID проекта
 *   sessionProject(role, env)           ID проекта роли или null (держатель и reference fetch живут без .env)
 *   openEditor(session, pageid, opts)   открыть редактор и поставить слои заново
 *   installLayers(page, names, opts)    подать scripts/browser/<name>.js в страницу; opts.writablePages — allow-список записи
 *   setWritablePages(page, list)        разрешить запись в перечисленные страницы (сессия донора пишет только так)
 *   call(page, fn, args, opts)          вызвать window.__tilda.<fn>(...args) с ретраем
 *   captureRequests(page, filter, file) перехват запросов редактора без кук
 *   waitForLogin(session, pageid, opts) ждать входа человека в открытом окне
 *   close(session)                      отключиться (держатель живёт) либо закрыть свой Chrome
 *   daemonStatus() / stopDaemon()       состояние и остановка держателя; startDaemon перед стартом сбрасывает
 *                                       масштаб tilda.ru в Preferences профиля (browser-profile.mjs)
 *   setDaemonWindow(state)              показать окно держателя ('normal') или свернуть ('minimized')
 *
 * Чистые части (детектор SESSION_LOST, задержка ретрая, выражение вызова, фильтр перехвата,
 * вырезание кук) вынесены отдельными функциями и покрыты тестами без сети.
 *
 * Куки, PHPSESSID и прочие секреты в логи не попадают ни на одном уровне: логируются только
 * имена функций, размеры и статусы.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createLogger } from './log.mjs';
import { repoRoot, protectedPages, testProfileDir, assertOutsideRepo } from './paths.mjs';
import { resetTildaZoom } from './browser-profile.mjs';
import { resolveProjectIdFor, getProjectIdFor, getDonorProfile, requireDonorConfig, PROJECT_ROLES } from './config.mjs';

const log = createLogger('browser');

/** Lock владельца Chrome: держатель либо команда, запустившая свой браузер. */
export const LOCK_FILE = 'tilda.lock';
/** Lock одной команды, подключённой к держателю: две команды на одной странице несовместимы. */
export const COMMAND_LOCK_FILE = 'command.lock';
/** Описание держателя: { pid, port, startedAt } — пишет browser-daemon.mjs. */
export const DAEMON_FILE = 'daemon.json';

/** Ошибка слоя с машиночитаемым кодом: SESSION_LOST, BROWSER_LOCKED, TIMEOUT, CALL_FAILED, LAYER_NOT_FOUND. */
export class BrowserError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Чистые функции
// ---------------------------------------------------------------------------

export function editorUrl(pageid, projectid, role = 'test') {
  const configuredProject = resolveProjectIdFor(role, projectid);
  return `https://tilda.ru/page/?pageid=${pageid}&projectid=${configuredProject}`;
}

/** Страница проекта (список страниц) — нужна `page create`, когда в проекте ещё нет ни одной страницы. */
export function projectUrl(projectid, role = 'test') {
  return `https://tilda.ru/projects/?projectid=${resolveProjectIdFor(role, projectid)}`;
}

/**
 * Страница настроек проекта на вкладке `tab` (проба 2026-09-23): без хэша открывается
 * `#tab=ss_menu_main`, где select#headerpageid нет. Главная страница — select#indexpageid на
 * подвкладке `#tab=ss_menu_index` вкладки «Главное» (проба 2026-09-24), шапки и подвала там нет.
 */
export function projectSettingsUrl(projectid, role = 'test', tab = 'ss_menu_header') {
  return `https://tilda.ru/projects/settings/?projectid=${resolveProjectIdFor(role, projectid)}#tab=${tab}`;
}

/** Select, по которому видно, что вкладка настроек открыта и форма готова. */
export const SETTINGS_TAB_SELECT = { ss_menu_header: '#headerpageid', ss_menu_index: '#indexpageid' };

/** Каталог профиля Chrome по роли: тестовый — `TILDA_BROWSER_PROFILE` или `<папка сайта>/.browser-profile`, донор — только `TILDA_DONOR_BROWSER_PROFILE`; внутри репозитория — отказ. */
export function profileDir(role = 'test') {
  if (role === 'donor') return assertOutsideRepo(resolve(getDonorProfile()), 'TILDA_DONOR_BROWSER_PROFILE');
  if (role !== 'test') getProjectIdFor(role); // бросает ConfigError на неизвестную роль
  return testProfileDir();
}

/**
 * ID проекта роли для поля session.projectid — без исключения: держатель (browser-daemon.mjs)
 * и `reference fetch|shot` поднимают сессию без TILDA_PROJECT_ID. Заданная, но невалидная
 * переменная всё же бросает ConfigError — молчать о ней нельзя.
 */
export function sessionProject(role = 'test', env = process.env) {
  const { projectVar } = PROJECT_ROLES[role] ?? {};
  if (!projectVar) getProjectIdFor(role, env);
  return env[projectVar] ? getProjectIdFor(role, env) : null;
}

/** Список защищённых страниц для сессии: у донора запрет задаёт allow-список, TILDA_PROTECTED_PAGES может быть не задана. */
function sessionGuard(role, opts) {
  if (opts.protectedPages) return opts.protectedPages;
  return role === 'donor' ? [] : protectedPages();
}

export function layerPath(name) {
  const file = name.endsWith('.js') ? name : `${name}.js`;
  return resolve(repoRoot(), 'scripts', 'browser', file);
}

/** Файл слоя — одно стрелочное выражение (SKILL.md, шаг 1); чтобы получить результат, его надо вызвать. */
export function wrapLayer(code) {
  return `(\n${code}\n)()`;
}

/**
 * Признаки потерянной сессии Тильды (browser-channel.md «Если сессии нет»):
 * адрес ушёл на /404/pagenotpublished/ или на страницу логина; в ответе API — HTML вместо
 * JSON; в тексте ошибки браузерного слоя — SESSION_LOST.
 */
/** Куда входить при потере сессии: у донора свой держатель и своя команда входа. */
export const LOGIN_HINTS = { test: 'тестовый держатель: session', donor: 'держатель донора: session --donor' };

/** Текст SESSION_LOST с подсказкой входа для роли держателя. */
export function sessionLostMessage(role = 'test') {
  return `Сессии Тильды нет: войдите в открытом окне браузера и повторите команду (${LOGIN_HINTS[role] ?? LOGIN_HINTS.test})`;
}

export function isSessionLost({ url = '', body = '', error = '' } = {}) {
  if (/\/404\/pagenotpublished\/?/.test(url)) return true;
  if (/tilda\.(cc|ru)\/login\/?/.test(url)) return true;
  if (/SESSION_LOST/.test(String(error))) return true;
  const head = String(body).slice(0, 300);
  if (/^\s*<|<html|<!doctype/i.test(head)) return true;
  return false;
}

/** Ошибки, которые повторять бессмысленно: сессии нет, страница защищена, аргументы неверны. */
export function isRetryable(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  if (/SESSION_LOST|PROTECTED_PAGE|WRITE_NOT_ALLOWED|FORM_FIELD_REJECTED|BROWSER_LOCKED|LAYER_NOT_FOUND|NO_LAYER_FUNCTION/.test(text)) return false;
  if (/NO_RECORD_IN_DOM|NO_ADD_RECORD|BAD_JSON|SAVE_FAILED|TOGGLE_MISMATCH|COPY_TO_BUF_FAILED|PASTE_FAILED|COPY_NO_RECORDS|NO_API/.test(text)) return false;
  return true;
}

/** Пауза перед повтором после попытки `attempt` (с 1): base × factor^(attempt-1), не больше max. */
export function retryDelayMs(attempt, { base = 1000, factor = 2, max = 15000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt должен быть ≥ 1, получено ${attempt}`);
  return Math.min(max, Math.round(base * factor ** (attempt - 1)));
}

/** Выражение вызова функции слоя — для отладочных `*.call.js` и для логов. */
export function buildCallExpression(fn, args = []) {
  if (!/^[A-Za-z_$][\w$]*$/.test(fn)) throw new TypeError(`недопустимое имя функции слоя: ${fn}`);
  if (!Array.isArray(args)) throw new TypeError('args должен быть массивом');
  const list = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(', ');
  return `async () => window.__tilda.${fn}(${list})`;
}

/** Фильтр перехвата: подстрока, RegExp, функция (url, request) → boolean, либо массив любых из них. */
export function matchesCapture(url, filter, request) {
  if (filter === undefined || filter === null || filter === '') return true;
  if (Array.isArray(filter)) return filter.some((f) => matchesCapture(url, f, request));
  if (typeof filter === 'function') return Boolean(filter(url, request));
  if (filter instanceof RegExp) return filter.test(url);
  if (typeof filter === 'string') return url.includes(filter);
  throw new TypeError(`неподдерживаемый фильтр перехвата: ${typeof filter}`);
}

const COOKIE_KEY = /^(cookie|set-cookie|cookie2|authorization)$/i;
const SECRET_IN_TEXT = /(PHPSESSID|Tildaupload_UPLOADKEY|tildasid)=([^;&\s"']+)/gi;

/**
 * Копия записи перехвата без кук: заголовки Cookie/Set-Cookie/Authorization удаляются на любой
 * глубине, значения вида PHPSESSID=… в строках заменяются на PHPSESSID=<redacted>.
 */
export function stripCookies(value) {
  if (typeof value === 'string') return value.replace(SECRET_IN_TEXT, '$1=<redacted>');
  if (Array.isArray(value)) return value.map(stripCookies);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (COOKIE_KEY.test(k)) continue;
      out[k] = stripCookies(v);
    }
    return out;
  }
  return value;
}

/** Есть ли живой процесс с таким pid (для распознавания протухшего lock). */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function acquireLock(dir, name = LOCK_FILE, what = 'браузер') {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, name);
  if (existsSync(file)) {
    const info = readJsonSafe(file);
    if (isPidAlive(info.pid) && info.pid !== process.pid) {
      log.error('open', `${what} уже занят другим процессом`, { lock: file, pid: info.pid, startedAt: info.startedAt });
      throw new BrowserError('BROWSER_LOCKED', `${what} уже занят процессом ${info.pid} (${info.startedAt}); дождитесь его или удалите ${file}`);
    }
    log.warn('open', 'найден протухший lock, перезаписываю', { lock: file, pid: info.pid });
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  log.debug('open', 'lock взят', { lock: file, pid: process.pid });
  return file;
}

function releaseLock(file) {
  try {
    if (!existsSync(file)) return;
    unlinkSync(file);
    log.debug('close', 'lock снят', { lock: file });
  } catch (e) {
    log.warn('close', 'lock не удалился', { lock: file, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Браузер
// ---------------------------------------------------------------------------

/** Описание держателя из daemon.json, если процесс жив; иначе null. */
export function daemonStatus(dir = profileDir()) {
  const file = resolve(dir, DAEMON_FILE);
  if (!existsSync(file)) return null;
  const info = readJsonSafe(file);
  if (!isPidAlive(info.pid) || !info.port) {
    log.debug('daemonStatus', 'daemon.json протух', { file, pid: info.pid });
    return null;
  }
  return { ...info, file };
}

/** Порт CDP из файла DevToolsActivePort, который Chrome кладёт в каталог профиля. */
export function readDevToolsPort(dir) {
  const file = resolve(dir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Запустить свой Chrome в этом процессе (режим owned). Используется держателем и как запасной
 * путь при TILDA_BROWSER_DAEMON=0.
 */
export async function launchOwned(opts = {}) {
  const role = opts.role ?? 'test';
  const dir = opts.profileDir ? resolve(opts.profileDir) : profileDir(role);
  const channel = opts.channel ?? 'chrome';
  const headless = opts.headless ?? false;
  const guard = sessionGuard(role, opts);
  const projectid = sessionProject(role);
  const writablePages = role === 'donor' ? [] : null;
  // Окно стартует свёрнутым, чтобы не забирать фокус и мышь у человека; разворачивается только
  // на время входа (waitForLogin). TILDA_BROWSER_VISIBLE=1 — держать окно на экране.
  const minimized = opts.minimized ?? process.env.TILDA_BROWSER_VISIBLE !== '1';
  const lockFile = acquireLock(dir);
  log.debug('launchOwned', 'старт браузера', { profileDir: dir, channel, headless, minimized, cdpPort: Boolean(opts.cdpPort) });
  let context;
  try {
    // `chromiumSandbox: true` — Playwright не добавляет `--no-sandbox`, плашки «неподдерживаемый флаг»
    // в окне нет.
    context = await chromium.launchPersistentContext(dir, {
      channel,
      headless,
      chromiumSandbox: true,
      viewport: null,
      args: [
        '--window-size=1440,960',
        // За экраном: окно не мелькает при старте; setWindowState('normal') возвращает его на экран.
        ...(minimized ? ['--window-position=-32000,-32000'] : []),
        // Держатель открывает TCP-порт CDP, чтобы команды подключались через connectOverCDP.
        ...(opts.cdpPort ? [`--remote-debugging-port=${opts.cdpPort === true ? 0 : opts.cdpPort}`] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (e) {
    releaseLock(lockFile);
    log.error('launchOwned', 'браузер не запустился', { channel, error: e.message });
    throw e;
  }
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultNavigationTimeout(opts.navigationTimeoutMs ?? 60_000);
  const session = { mode: 'owned', context, page, profileDir: dir, lockFile, protectedPages: guard, layers: new Set(), minimized, role, projectid, writablePages };
  context.on('close', () => releaseLock(lockFile));
  if (minimized) await setWindowState(session, 'minimized');
  log.info('launchOwned', 'браузер поднят', { role, projectid, profileDir: dir, channel, sandbox: true, protectedPages: guard, writablePages, window: minimized ? 'свёрнуто' : 'на экране' });
  return session;
}

/** Подключиться к работающему держателю по CDP. Браузер при отключении не закрывается. */
export async function attach(daemon, opts = {}) {
  const role = opts.role ?? 'test';
  const dir = opts.profileDir ? resolve(opts.profileDir) : profileDir(role);
  const guard = sessionGuard(role, opts);
  const projectid = sessionProject(role);
  const writablePages = role === 'donor' ? [] : null;
  const lockFile = acquireLock(dir, COMMAND_LOCK_FILE, 'браузер держателя (другая команда)');
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${daemon.port}`, { timeout: opts.connectTimeoutMs ?? 15_000 });
  } catch (e) {
    releaseLock(lockFile);
    log.error('attach', 'не удалось подключиться к держателю', { port: daemon.port, pid: daemon.pid, error: e.message });
    throw new BrowserError('CALL_FAILED', `держатель браузера (pid ${daemon.pid}, порт ${daemon.port}) не отвечает: ${e.message}`);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultNavigationTimeout(opts.navigationTimeoutMs ?? 60_000);
  const session = { mode: 'attached', browser, context, page, profileDir: dir, lockFile, protectedPages: guard, layers: new Set(), minimized: daemon.minimized !== false, daemon, role, projectid, writablePages };
  log.info('attach', 'подключено к держателю браузера', { role, projectid, profileDir: dir, pid: daemon.pid, port: daemon.port, startedAt: daemon.startedAt, protectedPages: guard, writablePages });
  return session;
}

/**
 * Запустить держателя браузера отдельным процессом (scripts/lib/browser-daemon.mjs) и дождаться
 * daemon.json. Процесс отвязан от текущего и переживает его завершение.
 */
export async function startDaemon({ profileDir: dirOpt, role = 'test', timeoutMs = 45_000 } = {}) {
  // Для донора конфигурация обязательна и проверяется до создания каталога профиля.
  if (role === 'donor') requireDonorConfig({ testProfile: profileDir('test') });
  const dir = dirOpt ? resolve(dirOpt) : profileDir(role);
  const alive = daemonStatus(dir);
  if (alive) {
    log.info('startDaemon', 'держатель уже запущен', { role, pid: alive.pid, port: alive.port });
    return alive;
  }
  mkdirSync(dir, { recursive: true });
  // Держатель не запущен — файл Preferences можно править: масштаб tilda.ru искажает все кадры.
  const zoom = resetTildaZoom(dir);
  if (zoom.removed.length) log.info('startDaemon', 'масштаб Tilda в профиле сброшен', { role, removed: zoom.removed, backup: zoom.backup });
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'browser-daemon.mjs');
  const logFile = resolve(dir, 'daemon.log');
  const out = openSync(logFile, 'a');
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, TILDA_BROWSER_PROFILE: dir },
  });
  child.unref();
  closeSync(out);
  log.info('startDaemon', 'держатель запускается', { role, profileDir: dir, pid: child.pid, script, log: logFile });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const st = daemonStatus(dir);
    if (st) {
      log.info('startDaemon', 'держатель готов', { pid: st.pid, port: st.port });
      return st;
    }
    if (!isPidAlive(child.pid)) break;
  }
  log.error('startDaemon', 'держатель не поднялся', { log: logFile });
  throw new BrowserError('CALL_FAILED', `держатель браузера не поднялся за ${Math.round(timeoutMs / 1000)} с — смотрите ${logFile}`);
}

/** Остановить держателя: закрыть Chrome по CDP; процесс держателя завершится сам. */
export async function stopDaemon({ profileDir: dirOpt, role = 'test' } = {}) {
  const dir = dirOpt ? resolve(dirOpt) : profileDir(role);
  const st = daemonStatus(dir);
  if (!st) {
    log.info('stopDaemon', 'держатель не запущен', { role, profileDir: dir });
    return false;
  }
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${st.port}`, { timeout: 10_000 });
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    await browser.close().catch(() => {});
  } catch (e) {
    log.warn('stopDaemon', 'по CDP не закрылся, завершаю процесс', { pid: st.pid, error: e.message });
    try {
      process.kill(st.pid);
    } catch {
      /* уже мёртв */
    }
  }
  const deadline = Date.now() + 15_000;
  while (isPidAlive(st.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  for (const f of [DAEMON_FILE, LOCK_FILE, COMMAND_LOCK_FILE]) {
    const file = resolve(dir, f);
    if (existsSync(file) && !isPidAlive(readJsonSafe(file).pid)) unlinkSync(file);
  }
  log.info('stopDaemon', 'держатель остановлен', { pid: st.pid, alive: isPidAlive(st.pid) });
  return true;
}

/**
 * Получить сессию браузера. По умолчанию — подключение к держателю (при нужде он поднимается);
 * TILDA_BROWSER_DAEMON=0 или opts.daemon=false — свой Chrome в этом процессе (закроется в close).
 * Возвращает session: { mode, context, page, profileDir, lockFile, protectedPages, layers, minimized,
 * role, projectid, writablePages }. Для роли `donor` конфигурация `TILDA_DONOR_*` обязательна — это
 * единственное место, где она проверяется до подключения.
 */
export async function open(opts = {}) {
  const role = opts.role ?? 'test';
  if (role === 'donor') requireDonorConfig({ testProfile: profileDir('test') });
  const useDaemon = opts.daemon ?? process.env.TILDA_BROWSER_DAEMON !== '0';
  log.debug('open', 'сессия', { role, daemon: useDaemon });
  if (!useDaemon) return launchOwned({ ...opts, role });
  const dir = opts.profileDir ? resolve(opts.profileDir) : profileDir(role);
  const st = daemonStatus(dir) ?? (await startDaemon({ profileDir: dir, role }));
  return attach(st, { ...opts, role });
}

/**
 * Состояние окна браузера через CDP Browser.setWindowBounds: 'minimized' — в панель задач,
 * 'normal' — на экран (с возвратом с позиции за экраном) и на передний план.
 */
export async function setWindowState(session, state) {
  const { page } = session;
  try {
    const cdp = await session.context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const bounds = state === 'normal' ? { windowState: 'normal', left: 80, top: 60, width: 1440, height: 960 } : { windowState: state };
    // Из свёрнутого состояния Chrome не принимает координаты — сначала normal, потом bounds.
    if (state === 'normal') await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
    await cdp.detach();
    if (state === 'normal') await page.bringToFront();
    log.debug('setWindowState', 'окно переключено', { state });
    return true;
  } catch (e) {
    log.warn('setWindowState', 'не удалось переключить окно', { state, error: e.message });
    return false;
  }
}

/**
 * Показать окно держателя человеку ('normal') или свернуть обратно ('minimized') — `browser show|hide`.
 * [FIX] Держатель стартует за экраном (-32000,-32000) и свёрнутым, Windows запоминает эту позицию
 * как место восстановления: клик в панели задач разворачивал окно вне экрана. Chrome не принимает
 * координаты свёрнутого окна (left/top молча игнорируются, проверено 2026-09-23), поэтому позицию
 * при старте не поправить без показа окна — её возвращает на экран setWindowState('normal').
 * Блокировку команд не берёт: окно можно показать и во время работы другой команды.
 */
export async function setDaemonWindow(state, { profileDir: dirOpt, role = 'test' } = {}) {
  const dir = dirOpt ? resolve(dirOpt) : profileDir(role);
  const st = daemonStatus(dir) ?? (state === 'normal' ? await startDaemon({ profileDir: dir, role }) : null);
  if (!st) {
    log.info('setDaemonWindow', 'держатель не запущен — сворачивать нечего', { state, role });
    return false;
  }
  log.debug('setDaemonWindow', '[FIX] переключение окна держателя', { state, pid: st.pid, port: st.port });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${st.port}`, { timeout: 15_000 });
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const ok = await setWindowState({ context, page }, state);
    if (!ok) throw new BrowserError('CALL_FAILED', `окно держателя не переключилось в ${state} — смотрите лог уровня warn`);
    log.info('setDaemonWindow', state === 'normal' ? '[FIX] окно держателя на экране' : '[FIX] окно держателя свёрнуто', { pid: st.pid });
    return true;
  } finally {
    await browser.close().catch((e) => log.warn('setDaemonWindow', 'отключение от держателя не удалось', { error: e.message }));
  }
}

/**
 * Открыть в держателе дополнительную вкладку, не показывая окно человеку: Chrome разворачивает
 * свёрнутое окно при создании вкладки — сразу сворачиваем обратно. Для прогонов и проб, которым
 * нужна своя страница рядом с редактором (`layout-sweep`), — правило AGENTS.md «окно держателя
 * всегда свёрнуто» (2026-09-21).
 */
export async function openBackgroundPage(context) {
  const page = await context.newPage();
  await setWindowState({ context, page }, 'minimized');
  return page;
}

/**
 * Завершить работу с сессией. Подключение к держателю — только отключиться, Chrome и сессия
 * Тильды остаются; свой Chrome — закрыть. Lock снимается в обоих случаях.
 */
export async function close(session) {
  if (!session) return;
  try {
    if (session.mode === 'attached') await session.browser.close();
    else await session.context.close();
  } finally {
    releaseLock(session.lockFile);
  }
  log.info('close', session.mode === 'attached' ? 'отключено от держателя, браузер живёт' : 'браузер закрыт', { profileDir: session.profileDir });
}

/**
 * Открыть страницу проекта (список страниц) и поставить слои. Нужна командам уровня проекта
 * в проекте без страниц (`page create`); редактор при этом не открывается.
 */
export async function openProject(session, { layers = ['tilda-project'], projectid } = {}) {
  const { page } = session;
  const role = session.role ?? 'test';
  const url = projectUrl(projectid, role);
  log.debug('openProject', 'навигация', { url, role });
  await page.goto(url, { waitUntil: 'load' });
  if (isSessionLost({ url: page.url() })) {
    log.error('openProject', '[FIX] SESSION_LOST', { url: page.url(), role, hint: LOGIN_HINTS[role] });
    throw new BrowserError('SESSION_LOST', sessionLostMessage(role), { url: page.url() });
  }
  await page.waitForFunction(() => document.readyState === 'complete' && typeof getCSRF === 'function' && Boolean(window.projectid), null, { timeout: 30_000 });
  const projectOnPage = await page.evaluate(() => String(window.projectid));
  const wanted = String(resolveProjectIdFor(role, projectid));
  if (projectOnPage !== wanted) {
    log.error('openProject', 'открыт другой проект', { role, wanted, got: projectOnPage });
    throw new BrowserError('CALL_FAILED', `открыт проект ${projectOnPage} вместо ${wanted}`);
  }
  const installed = await installLayers(page, layers, { protectedPages: session.protectedPages, writablePages: session.writablePages });
  installed.forEach((l) => session.layers.add(l.name));
  log.info('openProject', 'страница проекта открыта, сессия жива', { role, projectid: projectOnPage, layers: installed.map((l) => l.name) });
  return { projectid: projectOnPage, url: page.url(), layers: installed };
}

/**
 * Страница настроек проекта (по умолчанию вкладка «Шапка и подвал») со слоем `tilda-project` — для
 * `page role`. На ней есть getCSRF() и window.projectid (проба 2026-09-23).
 */
export async function openProjectSettings(session, { layers = ['tilda-project'], projectid, tab = 'ss_menu_header' } = {}) {
  const { page } = session;
  const role = session.role ?? 'test';
  const selector = SETTINGS_TAB_SELECT[tab];
  if (!selector) throw new BrowserError('CALL_FAILED', `неизвестная вкладка настроек: ${tab}`);
  const url = projectSettingsUrl(projectid, role, tab);
  log.debug('openProjectSettings', 'навигация', { url, role, tab });
  // Смена только хэша не перезагружает страницу — открываем с нуля, чтобы форма взяла свежие значения.
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load' });
  if (isSessionLost({ url: page.url() })) {
    log.error('openProjectSettings', '[FIX] SESSION_LOST', { url: page.url(), role, hint: LOGIN_HINTS[role] });
    throw new BrowserError('SESSION_LOST', sessionLostMessage(role), { url: page.url() });
  }
  await page.waitForSelector(selector, { state: 'attached', timeout: 30_000 });
  const projectOnPage = await page.evaluate(() => String(window.projectid || new URLSearchParams(location.search).get('projectid') || ''));
  const wanted = String(resolveProjectIdFor(role, projectid));
  if (projectOnPage !== wanted) {
    log.error('openProjectSettings', 'открыт другой проект', { role, wanted, got: projectOnPage });
    throw new BrowserError('CALL_FAILED', `открыты настройки проекта ${projectOnPage} вместо ${wanted}`);
  }
  const installed = await installLayers(page, layers, { protectedPages: session.protectedPages, writablePages: session.writablePages });
  installed.forEach((l) => session.layers.add(l.name));
  log.info('openProjectSettings', 'страница настроек открыта', { role, projectid: projectOnPage, tab });
  return { projectid: projectOnPage, layers: installed };
}

/** Состояние страницы редактора: pageid/projectid из window, адрес, признак потерянной сессии. */
export async function editorState(page) {
  const url = page.url();
  let state = { pageid: '', projectid: '', title: '', records: 0 };
  try {
    state = await page.evaluate(() => ({
      pageid: String(window.pageid || ''),
      projectid: String(window.projectid || ''),
      title: document.title,
      records: document.querySelectorAll('[data-record-type]').length,
    }));
  } catch (e) {
    log.debug('editorState', 'evaluate не удался', { url, error: e.message });
  }
  const lost = isSessionLost({ url }) || !state.pageid;
  return { url, ...state, sessionLost: lost };
}

/**
 * Подать слои scripts/browser/<name>.js в страницу. Файл читается с диска Node-ом; порядок
 * важен (tilda-copy.js требует tilda-zero.js и tilda-page.js). Повторная установка безопасна.
 * `protectedPages` — список защищённых (по умолчанию из TILDA_PROTECTED_PAGES); `writablePages` —
 * allow-список записи: null — списка нет (как раньше), массив — слой пишет только в перечисленные
 * страницы, а операции уровня проекта запрещены целиком (сессия донора).
 */
export async function installLayers(page, names = ['tilda-zero'], { protectedPages: guard, writablePages = null } = {}) {
  const configuredProtectedPages = guard ?? protectedPages();
  const writable = Array.isArray(writablePages) ? writablePages.map(String) : null;
  const installed = [];
  for (const name of names) {
    const path = layerPath(name);
    if (!existsSync(path)) {
      log.error('installLayers', 'файл слоя не найден', { name, path });
      throw new BrowserError('LAYER_NOT_FOUND', `слой ${name} не найден: ${path}`);
    }
    const code = readFileSync(path, 'utf8');
    log.debug('installLayers', 'установка слоя', { name: basename(path), bytes: Buffer.byteLength(code) });
    const result = await page.evaluate(wrapLayer(code));
    log.debug('installLayers', 'слой установлен', { name: basename(path), result });
    installed.push({ name: basename(path, '.js'), bytes: Buffer.byteLength(code), result });
  }
  // Защита живой главной дублируется в браузерном слое, как и в Node (protectedPages);
  // allow-список записи — там же (T.writablePages), см. assertWritable в tilda-page.js/tilda-zero.js.
  const guards = await page.evaluate(({ pages, writable }) => {
    const T = (window.__tilda = window.__tilda || {});
    T.protectedPages = [...pages];
    T.writablePages = writable === null ? null : [...writable];
    return { protectedPages: T.protectedPages, writablePages: T.writablePages };
  }, { pages: configuredProtectedPages, writable });
  log.debug('installLayers', 'защита в слое выставлена', guards);
  return installed;
}

/**
 * Заменить allow-список записи в браузерном слое: в сессии донора запись запрещена целиком, пока
 * команда явно не перечислит страницы (например, страницу-приёмник в тестовом проекте).
 * Пишет WARN с меткой времени.
 */
export async function setWritablePages(page, list) {
  const result = await page.evaluate((pages) => {
    const T = (window.__tilda = window.__tilda || {});
    T.writablePages = [...pages];
    return T.writablePages;
  }, list.map(String));
  log.warn('setWritablePages', 'allow-список записи заменён', { writablePages: result, at: new Date().toISOString() });
  return result;
}

/**
 * Заменить (не объединить) список защищённых страниц в браузерном слое. Нужно только для явного
 * снятия защиты на один вызов (`promote --unprotect`): слои держат живую главную
 * в списке по умолчанию, и installLayers её не убирает. Пишет WARN с меткой времени.
 */
export async function setProtectedPages(page, list) {
  const result = await page.evaluate((pages) => {
    const T = (window.__tilda = window.__tilda || {});
    T.protectedPages = [...pages];
    return T.protectedPages;
  }, list.map(String));
  log.warn('setProtectedPages', 'список защищённых страниц в браузерном слое заменён', { protectedPages: result, at: new Date().toISOString() });
  return result;
}

/**
 * Открыть редактор страницы и поставить слои заново: window.__tilda пропадает вместе со
 * страницей при любой навигации (SKILL.md, шаг 1). При потерянной сессии — SESSION_LOST
 * с понятным текстом, а не стектрейс.
 */
/**
 * Дождаться, пока редактор дорисует блоки: после события load страница ещё пуста, записи
 * `[data-record-type]` появляются позже (проверено пробой 2026-09-11: на domcontentloaded 0 блоков
 * из 40). Готовность — readyState complete, есть #allrecords и число блоков не меняется два
 * опроса подряд (пустая страница даёт стабильный 0).
 */
export async function waitForEditorReady(page, { timeoutMs = 30_000, pollMs = 700 } = {}) {
  await page.waitForFunction(
    () => document.readyState === 'complete' && Boolean(window.pageid) && Boolean(document.querySelector('#allrecords')),
    null,
    { timeout: timeoutMs },
  );
  const deadline = Date.now() + timeoutMs;
  let prev = -1;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    const count = await page.evaluate(() => document.querySelectorAll('[data-record-type]').length);
    if (count === prev) {
      log.debug('waitForEditorReady', 'блоки дорисованы', { records: count });
      return count;
    }
    prev = count;
  }
  log.warn('waitForEditorReady', 'число блоков не стабилизировалось, продолжаю', { records: prev, timeoutMs });
  return prev;
}

export async function openEditor(session, pageid, { layers = ['tilda-zero'], projectid } = {}) {
  const { page } = session;
  const role = session.role ?? 'test';
  const url = editorUrl(pageid, projectid, role);
  log.debug('openEditor', 'навигация', { url, role });
  await page.goto(url, { waitUntil: 'load' });
  if (!isSessionLost({ url: page.url() })) await waitForEditorReady(page);
  const state = await editorState(page);
  if (state.sessionLost) {
    log.error('openEditor', '[FIX] SESSION_LOST', { url: state.url, pageid: String(pageid), role, hint: LOGIN_HINTS[role] });
    throw new BrowserError('SESSION_LOST', sessionLostMessage(role), { url: state.url });
  }
  if (state.pageid !== String(pageid)) {
    log.error('openEditor', 'редактор открыл другую страницу', { wanted: String(pageid), got: state.pageid });
    throw new BrowserError('CALL_FAILED', `редактор открыл страницу ${state.pageid} вместо ${pageid}`);
  }
  const installed = await installLayers(page, layers, { protectedPages: session.protectedPages, writablePages: session.writablePages });
  installed.forEach((l) => session.layers.add(l.name));
  log.info('openEditor', 'редактор открыт, сессия жива', { role, pageid: state.pageid, records: state.records, layers: installed.map((l) => l.name) });
  return { ...state, layers: installed };
}

/**
 * Ждать, пока человек войдёт в Тильду в открытом окне: открыть страницу логина и опрашивать
 * редактор, пока не появится window.pageid. Пароль не запрашивается и не передаётся.
 * `target: 'project'` — признак входа проверяется на странице проекта (window.projectid), страница
 * не нужна: так входит аккаунт донора, у которого редактор открывать незачем.
 */
export async function waitForLogin(session, pageid, { timeoutMs = 10 * 60_000, pollMs = 5_000, projectid, target = 'editor' } = {}) {
  const { page } = session;
  const role = session.role ?? 'test';
  const deadline = Date.now() + timeoutMs;
  log.info('waitForLogin', 'сессии нет — войдите в Тильду в открытом окне браузера', { role, target, timeoutMs });
  await page.goto('https://tilda.cc/login/', { waitUntil: 'domcontentloaded' });
  // Окно человеку нужно только здесь: развернуть на время входа, после входа свернуть обратно.
  if (session.minimized) await setWindowState(session, 'normal');
  const hide = async () => {
    if (session.minimized) await setWindowState(session, 'minimized');
  };
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    // Пока человек на странице логина — не дёргать её навигацией, иначе ввод пропадёт.
    if (/tilda\.(cc|ru)\/login/.test(page.url())) continue;
    const url = target === 'project' ? projectUrl(projectid, role) : editorUrl(pageid, projectid, role);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      log.debug('waitForLogin', 'навигация не удалась, жду дальше', { error: e.message });
      continue;
    }
    if (target === 'project') {
      const projectOnPage = isSessionLost({ url: page.url() }) ? '' : await page.evaluate(() => String(window.projectid || '')).catch(() => '');
      if (projectOnPage) {
        log.info('waitForLogin', 'вход выполнен, страница проекта открыта', { role, projectid: projectOnPage });
        await hide();
        return { url: page.url(), projectid: projectOnPage };
      }
    } else {
      const state = await editorState(page);
      if (!state.sessionLost) {
        log.info('waitForLogin', 'вход выполнен, сессия жива', { role, pageid: state.pageid });
        await hide();
        return state;
      }
    }
    await page.goto('https://tilda.cc/login/', { waitUntil: 'domcontentloaded' });
  }
  await hide();
  log.error('waitForLogin', 'вход не выполнен за отведённое время', { timeoutMs });
  throw new BrowserError('SESSION_LOST', `вход в Тильду не выполнен за ${Math.round(timeoutMs / 1000)} с`);
}

/**
 * Одна попытка вызова функции слоя. Аргументы передаёт Playwright (сериализация JSON) —
 * модель блока не превращается в строку кода.
 */
async function callOnce(page, fn, args, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BrowserError('TIMEOUT', `вызов ${fn} не завершился за ${timeoutMs} мс`)), timeoutMs);
  });
  try {
    return await Promise.race([
      page.evaluate(async ({ fn, args }) => {
        const T = window.__tilda;
        if (!T || typeof T[fn] !== 'function') throw new Error(`NO_LAYER_FUNCTION ${fn}: слой не установлен`);
        return T[fn](...args);
      }, { fn, args }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Вызвать window.__tilda.<fn>(...args) с ретраем (основание — обрыв на 6-м блоке
 * из 40). SESSION_LOST и отказы слоя не повторяются. Возвращает результат;
 * журнал попыток пишется в opts.journal (массив), если передан.
 */
export async function call(page, fn, args = [], opts = {}) {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const journal = Array.isArray(opts.journal) ? opts.journal : [];
  const argBytes = Buffer.byteLength(JSON.stringify(args ?? []));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now();
    try {
      log.debug('call', 'вызов', { fn, attempt, argBytes });
      const result = await callOnce(page, fn, args, timeoutMs);
      const resultBytes = Buffer.byteLength(JSON.stringify(result ?? null));
      log.debug('call', 'ответ', { fn, attempt, resultBytes, ms: Date.now() - started });
      journal.push({ fn, attempt, ok: true, ms: Date.now() - started, resultBytes });
      return result;
    } catch (e) {
      const message = String(e.message || e);
      journal.push({ fn, attempt, ok: false, ms: Date.now() - started, error: message.slice(0, 200) });
      if (isSessionLost({ url: page.url(), error: message })) {
        log.error('call', 'SESSION_LOST', { fn, attempt });
        throw new BrowserError('SESSION_LOST', 'Сессии Тильды нет: войдите в открытом окне браузера и повторите команду', { fn });
      }
      if (!isRetryable(e) || attempt === attempts) {
        log.error('call', 'вызов не удался', { fn, attempt, error: message.slice(0, 200) });
        if (e instanceof BrowserError) throw e;
        throw new BrowserError('CALL_FAILED', `${fn}: ${message}`, { fn, attempt });
      }
      const delay = retryDelayMs(attempt, opts.retry);
      log.warn('call', 'ошибка, повтор', { fn, attempt, nextAttempt: attempt + 1, delayMs: delay, error: message.slice(0, 200) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new BrowserError('CALL_FAILED', `${fn}: попытки исчерпаны`);
}

/**
 * Вызов функции слоя, которая сама запускает запрос страницы (клик «Сохранить»), с ожиданием
 * ответа этого запроса: признак — подстрока адреса и подстрока тела. Тело запроса (csrf, значения
 * настроек) не логируется и не возвращается; ответ — статус и первые 200 символов. Один вызов
 * (`attempts: 1`): повтор мог бы сохранить настройки дважды.
 */
export async function callWithResponse(page, fn, args = [], { urlPart, bodyPart, timeoutMs = 30_000 } = {}) {
  log.debug('callWithResponse', 'ожидание ответа', { fn, urlPart });
  const wait = page.waitForResponse((r) => r.url().includes(urlPart) && (r.request().postData() || '').includes(bodyPart), { timeout: timeoutMs });
  // Отказ ожидания до вызова не должен всплыть как необработанный.
  wait.catch(() => {});
  const result = await call(page, fn, args, { attempts: 1 });
  let resp;
  try {
    resp = await wait;
  } catch (e) {
    log.error('callWithResponse', 'нет ответа сервера', { fn, urlPart, timeoutMs, error: String(e.message || e).slice(0, 120) });
    throw new BrowserError('CALL_FAILED', `настройки не сохранены: нет ответа сервера за ${Math.round(timeoutMs / 1000)} с`, { fn });
  }
  const text = (await resp.text()).slice(0, 200);
  log.info('callWithResponse', 'ответ получен', { fn, status: resp.status(), bytes: text.length });
  return { result, status: resp.status(), text };
}

/**
 * Перехват запросов редактора через page.on('request'/'response'). Пишет в файл JSON-массив
 * записей { ts, method, url, postData, status, contentType, body } без кук — заменяет
 * scripts/browser/capture-submits.js (тот видел только XMLHttpRequest, редактор ходит через fetch).
 * @param {import('playwright-core').Page} page
 * @param {string|RegExp|Function|Array} filter  см. matchesCapture
 * @param {string} outFile  путь файла; переписывается после каждого ответа
 * @returns {{ records: object[], stop: () => object[] }}
 */
export function captureRequests(page, filter, outFile, { maxBodyBytes = 512 * 1024 } = {}) {
  const records = [];
  const pending = new Map();
  const inflight = new Set();
  const flush = () => {
    mkdirSync(resolve(outFile, '..'), { recursive: true });
    writeFileSync(outFile, JSON.stringify(records, null, 2));
  };
  const onRequest = (request) => {
    const url = request.url();
    if (!matchesCapture(url, filter, request)) return;
    const postData = request.postData() || '';
    const record = stripCookies({
      ts: new Date().toISOString(),
      method: request.method(),
      url,
      postData: postData.slice(0, maxBodyBytes),
      postBytes: Buffer.byteLength(postData),
      status: null,
    });
    pending.set(request, record);
    records.push(record);
    log.debug('captureRequests', 'запрос', { method: record.method, url, postBytes: record.postBytes });
  };
  const readResponse = async (response, record) => {
    record.status = response.status();
    const headers = response.headers();
    record.contentType = headers['content-type'] || '';
    if (headers['retry-after']) record.retryAfter = headers['retry-after'];
    record.setCookie = Boolean(headers['set-cookie']);
    try {
      const body = await response.text();
      record.body = stripCookies(body.slice(0, maxBodyBytes));
      record.bodyBytes = Buffer.byteLength(body);
    } catch (e) {
      record.body = '';
      record.bodyError = e.message;
    }
    flush();
    log.debug('captureRequests', 'ответ', { url: record.url, status: record.status, bodyBytes: record.bodyBytes });
  };
  const onResponse = (response) => {
    const record = pending.get(response.request());
    if (!record) return;
    pending.delete(response.request());
    // Тело ответа читается асинхронно; stop() дожидается всех незакрытых ответов.
    const job = readResponse(response, record).finally(() => inflight.delete(job));
    inflight.add(job);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  log.info('captureRequests', 'перехват включён', { outFile, filter: String(filter) });
  return {
    records,
    async stop({ settleMs = 5_000 } = {}) {
      page.off('request', onRequest);
      page.off('response', onResponse);
      const deadline = Date.now() + settleMs;
      while ((inflight.size > 0 || pending.size > 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (pending.size > 0) log.warn('captureRequests', 'ответы не дождались', { withoutResponse: pending.size });
      flush();
      log.info('captureRequests', 'перехват выключен', { outFile, records: records.length });
      return records;
    },
  };
}
