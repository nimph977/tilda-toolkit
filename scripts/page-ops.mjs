/**
 * Операции уровня страницы: дубль, пустая страница, публикация,
 * инструкция удаления. Транспорт — драйвер цикла (`driver.call(fn, args)` поверх слоя
 * scripts/browser/tilda-project.js); разбор ответов — чистые функции, проверяемые без сети.
 *
 * Публикация (AGENTS.md): выполняется только по явной команде пользователя и никогда
 * как побочный эффект. Guard двойной — здесь (до обращения к драйверу) и в браузерном слое
 * (до отправки запроса); ни один не ослабляется. Удаление страниц не автоматизируется —
 * CLI печатает человеку пошаговую инструкцию.
 */
import { createLogger } from './lib/log.mjs';
import { editorUrl } from './lib/browser.mjs';
import { parseNumericId, resolveProjectId } from './lib/config.mjs';

const log = createLogger('page-ops');

/** Маркер подтверждения публикации — копия в браузерном слое (T.PUBLISH_CONFIRM). */
export const PUBLISH_CONFIRM = 'опубликовать';
export const BLANK_EXAMPLE_PAGE = '1231';

export class PageOpError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'PageOpError';
    this.code = code;
    Object.assign(this, data);
  }
}

/**
 * Разбор ответа dublicatepage / addnewpagedublicateexample: новый pageid строкой из цифр;
 * «you created maximum» — исчерпан лимит страниц тарифа; иное — отказ с дословным текстом.
 */
export function parseNewPageResponse(text, { comm = 'dublicatepage' } = {}) {
  const value = String(text ?? '').trim();
  if (/^\d+$/.test(value)) return { pageid: value };
  if (/you created maximum/i.test(value)) {
    log.error('parseNewPageResponse', 'исчерпан лимит страниц', { comm, text: value.slice(0, 200) });
    throw new PageOpError('PAGE_LIMIT', `Тильда: исчерпан лимит страниц тарифа (${comm}): ${value.slice(0, 200)}`, { text: value });
  }
  log.error('parseNewPageResponse', 'ответ не похож на pageid', { comm, text: value.slice(0, 200) });
  throw new PageOpError('PAGE_CREATE_FAILED', `${comm}: ожидался pageid, получено «${value.slice(0, 200)}»`, { text: value });
}

/**
 * Разбор ответа pagepublish: JSON {link, linkstr, wslink, customdomain}. Ошибки — подстроки,
 * которые различает сам редактор (TPPublishModal.prototype.publish, прочитано 2026-09-11).
 */
export function parsePublishResponse(text) {
  const value = String(text ?? '').trim();
  let json = null;
  try {
    json = JSON.parse(value);
  } catch {
    json = null;
  }
  if (json && typeof json === 'object') {
    if (json.link || json.linkstr || json.wslink) {
      return { link: json.link || json.linkstr || '', wslink: json.wslink || '', customdomain: json.customdomain || '', raw: json };
    }
    if (json.error || json.errors) {
      throw new PageOpError('PUBLISH_FAILED', `Тильда отказала в публикации: ${JSON.stringify(json.error || json.errors).slice(0, 200)}`, { text: value });
    }
  }
  if (/manual restriction for publishing/i.test(value)) throw new PageOpError('PUBLISH_BANNED', `публикация запрещена вручную администрацией Тильды: ${value.slice(0, 200)}`, { text: value });
  if (/restriction for publishing/i.test(value)) throw new PageOpError('PUBLISH_BANNED', `публикация ограничена: ${value.slice(0, 200)}`, { text: value });
  if (/err_technical_maintenance/i.test(value)) throw new PageOpError('PUBLISH_UNAVAILABLE', 'публикация временно недоступна (технические работы Тильды)', { text: value });
  if (/work on server/i.test(value)) throw new PageOpError('PUBLISH_SERVER_ERROR', `ошибка сервера Тильды при публикации: ${value.slice(0, 200)}`, { text: value });
  throw new PageOpError('PUBLISH_FAILED', `pagepublish: неожиданный ответ «${value.slice(0, 200)}»`, { text: value });
}

/** Дубль страницы: источник только читается (это шаг бэкапа живой главной при накате `promote`). */
/** Способ записи заголовка — решение пробы (шапка tilda-project.js): форма окна настроек. */
export const TITLE_WRITE_MODE = 'form';
export const TITLE_MAX = 120;

/**
 * Заголовок страницы по записи карты сайта: `<метка> <имя донора | имя страницы | шапка/подвал>`,
 * не длиннее TITLE_MAX. Чистая.
 */
export function pageTitleFor(entry = {}) {
  const { label = '', role, name, donorTitle } = entry;
  const tail = donorTitle || name || (role === 'header' ? 'шапка' : role === 'footer' ? 'подвал' : '');
  return `${label} ${tail}`.trim().slice(0, TITLE_MAX);
}

/**
 * Записать заголовок страницы. Защищённые страницы — отказ до драйвера. Драйвер:
 * `callWithResponse(fn, args, { urlPart, bodyPart })` — форма шлёт запрос сама, ответ ловит Node.
 */
export async function setPageTitle(driver, pageid, title, { protectedIds = [] } = {}) {
  const id = parseNumericId(pageid, 'pageid');
  const text = String(title ?? '').trim();
  if (!text) throw new PageOpError('TITLE_EMPTY', 'заголовок страницы пуст');
  if (protectedIds.map(String).includes(id)) {
    log.error('setPageTitle', 'страница защищена — отказ до драйвера', { pageid: id });
    throw new PageOpError('PROTECTED_PAGE', `страница ${id} защищена (TILDA_PROTECTED_PAGES)`, { pageid: id });
  }
  log.debug('setPageTitle', 'запись заголовка', { pageid: id, length: text.length, mode: TITLE_WRITE_MODE });
  const r = await driver.callWithResponse('setPageTitle', [id, text], { urlPart: '/projects/submit/', bodyPart: 'comm=savepagesettings' });
  const answer = String(r?.text ?? '').trim();
  if (answer !== 'OK' && answer !== '') {
    log.error('setPageTitle', 'ответ не OK', { pageid: id, status: r?.status, body: answer.slice(0, 120) });
    throw new PageOpError('TITLE_NOT_SAVED', `заголовок страницы ${id} не сохранён: ${answer.slice(0, 120)}`, { pageid: id, text: answer });
  }
  log.info('setPageTitle', 'заголовок записан', { pageid: id, length: text.length });
  return { pageid: id, title: text };
}

/**
 * Допустимый адрес страницы после приведения (проба, tc__clearPageAlias редактора):
 * латиница в нижнем регистре, цифры, "-", "_", "/" только между частями. Редактор молча выбросил
 * бы остальные символы и сохранил другой адрес — инструмент отказывает до запроса.
 */
export const ALIAS_RE = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
/** Ответ savepagesettings на адрес другой страницы проекта (проба: «Указанный адрес страницы уже занят»). */
const ALIAS_TAKEN_RE = /уже занят|already (?:taken|in use|exists)/i;

/** Адрес к виду поля редактора: без ведущих и завершающих "/", нижний регистр. Чистая. */
export function normalizePageAlias(alias) {
  return String(alias ?? '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

/**
 * Записать адрес страницы (поле alias окна настроек). Неверный адрес и защищённая страница —
 * отказ до драйвера; ответ «занят» — ALIAS_TAKEN; иной ответ не OK — ALIAS_NOT_SAVED.
 */
export async function setPageAlias(driver, pageid, alias, { protectedIds = [] } = {}) {
  const id = parseNumericId(pageid, 'pageid');
  const value = normalizePageAlias(alias);
  if (!ALIAS_RE.test(value)) {
    log.error('setPageAlias', 'адрес не подходит — отказ до драйвера', { pageid: id, length: value.length });
    throw new PageOpError('ALIAS_INVALID', `адрес страницы ${id} пуст или содержит недопустимые символы (допустимы a-z, 0-9, "-", "_", "/")`, { pageid: id });
  }
  if (protectedIds.map(String).includes(id)) {
    log.error('setPageAlias', 'страница защищена — отказ до драйвера', { pageid: id });
    throw new PageOpError('PROTECTED_PAGE', `страница ${id} защищена (TILDA_PROTECTED_PAGES)`, { pageid: id });
  }
  log.debug('setPageAlias', 'запись адреса', { pageid: id, alias: value });
  const r = await driver.callWithResponse('setPageAlias', [id, value], { urlPart: '/projects/submit/', bodyPart: 'comm=savepagesettings' });
  const answer = String(r?.text ?? '').trim();
  if (ALIAS_TAKEN_RE.test(answer)) {
    log.warn('setPageAlias', 'адрес занят другой страницей проекта', { pageid: id });
    throw new PageOpError('ALIAS_TAKEN', `адрес страницы ${id} занят другой страницей проекта`, { pageid: id, text: answer });
  }
  if (answer !== 'OK' && answer !== '') {
    log.error('setPageAlias', 'ответ не OK', { pageid: id, status: r?.status, body: answer.slice(0, 120) });
    throw new PageOpError('ALIAS_NOT_SAVED', `адрес страницы ${id} не сохранён: ${answer.slice(0, 120)}`, { pageid: id, text: answer });
  }
  log.info('setPageAlias', 'адрес записан', { pageid: id });
  return { pageid: id, alias: value };
}

export async function duplicatePage(driver, pageid) {
  const source = String(pageid);
  log.debug('duplicatePage', 'запрос дубля', { source });
  const r = await driver.call('duplicatePage', [source]);
  const { pageid: created } = parseNewPageResponse(r.text, { comm: 'dublicatepage' });
  log.info('duplicatePage', `создан дубль ${created}`, { source, created, editor: editorUrl(created) });
  return { source, pageid: created, editor: editorUrl(created) };
}

/** Пустая страница из шаблона «Пустая страница» (examplepageid=1231). */
export async function createPage(driver, { projectid, examplepageid = BLANK_EXAMPLE_PAGE } = {}) {
  projectid = resolveProjectId(projectid);
  log.debug('createPage', 'запрос пустой страницы', { projectid, examplepageid });
  const r = await driver.call('createPage', [String(projectid), String(examplepageid)]);
  const { pageid: created } = parseNewPageResponse(r.text, { comm: 'addnewpagedublicateexample' });
  log.info('createPage', `создана страница ${created}`, { projectid, created, editor: editorUrl(created) });
  return { projectid: String(projectid), pageid: created, editor: editorUrl(created) };
}

/**
 * Публикация страницы. Без opts.confirmed === true — отказ PUBLISH_NOT_CONFIRMED до обращения
 * к драйверу (ни одного запроса в Тильду). Слой браузера повторяет ту же проверку по маркеру.
 */
export async function publishPage(driver, pageid, opts = {}) {
  const id = String(pageid || '');
  if (!id) throw new PageOpError('PUBLISH_NO_PAGE', 'publish: страница не указана — нужен явный --page <pageid>');
  if (opts.confirmed !== true) {
    log.warn('publishPage', 'публикация без подтверждения — отказ до обращения к браузеру', { pageid: id });
    throw new PageOpError('PUBLISH_NOT_CONFIRMED', `публикация страницы ${id} требует явного подтверждения: повторите команду с --confirm`, { pageid: id });
  }
  log.debug('publishPage', 'запрос публикации', { pageid: id });
  const r = await driver.call('publishPage', [id, PUBLISH_CONFIRM]);
  const parsed = parsePublishResponse(r.text);
  log.info('publishPage', `страница ${id} опубликована`, { pageid: id, link: parsed.link, wslink: parsed.wslink });
  return { pageid: id, ...parsed };
}

/** Удаление страниц — вне автоматизации: пошаговая инструкция человеку. */
export function deletePageInstructions(pageid, { projectid } = {}) {
  projectid = resolveProjectId(projectid);
  const id = String(pageid);
  return [
    `Удаление страницы ${id} делает человек (правило AGENTS.md: удаление и перенос страниц вне автоматизации).`,
    `1. Открой список страниц проекта: https://tilda.ru/projects/?projectid=${projectid}`,
    `2. Найди страницу ${id} (ссылка редактора: ${editorUrl(id, projectid)}), проверь заголовок и что это не живая главная.`,
    '3. Меню страницы (⋯ или шестерёнка) → «Удалить» → подтверди.',
    `4. Проверь, что страницы нет в списке; локальные снимки <папка сайта>/site-baseline/*/${id}/ можно оставить как историю.`,
  ];
}
