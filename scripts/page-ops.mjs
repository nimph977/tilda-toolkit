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
import { attachMessage, messageText, msg } from './lib/i18n.mjs';
import { editorUrl } from './lib/browser.mjs';
import { parseNumericId, resolveProjectId } from './lib/config.mjs';

const log = createLogger('page-ops');

/** Маркер подтверждения публикации — копия в браузерном слое (T.PUBLISH_CONFIRM). */
export const PUBLISH_CONFIRM = 'publish';
export const BLANK_EXAMPLE_PAGE = '1231';

export class PageOpError extends Error {
  constructor(code, message, data = {}) {
    super(messageText(message));
    attachMessage(this, message);
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
    log.error('parseNewPageResponse', 'page limit exhausted', { comm, text: value.slice(0, 200) });
    throw new PageOpError('PAGE_LIMIT', msg('pageOps.pageLimit', { comm, text: value.slice(0, 200) }), { text: value });
  }
  log.error('parseNewPageResponse', 'response does not look like a pageid', { comm, text: value.slice(0, 200) });
  throw new PageOpError('PAGE_CREATE_FAILED', msg('pageOps.createFailed', { comm, text: value.slice(0, 200) }), { text: value });
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
      throw new PageOpError('PUBLISH_FAILED', msg('pageOps.publishRefused', { details: JSON.stringify(json.error || json.errors).slice(0, 200) }), { text: value });
    }
  }
  if (/manual restriction for publishing/i.test(value)) throw new PageOpError('PUBLISH_BANNED', msg('pageOps.publishBannedManual', { text: value.slice(0, 200) }), { text: value });
  if (/restriction for publishing/i.test(value)) throw new PageOpError('PUBLISH_BANNED', msg('pageOps.publishRestricted', { text: value.slice(0, 200) }), { text: value });
  if (/err_technical_maintenance/i.test(value)) throw new PageOpError('PUBLISH_UNAVAILABLE', msg('pageOps.publishUnavailable'), { text: value });
  if (/work on server/i.test(value)) throw new PageOpError('PUBLISH_SERVER_ERROR', msg('pageOps.publishServerError', { text: value.slice(0, 200) }), { text: value });
  throw new PageOpError('PUBLISH_FAILED', msg('pageOps.publishUnexpected', { text: value.slice(0, 200) }), { text: value });
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
  if (!text) throw new PageOpError('TITLE_EMPTY', msg('pageOps.titleEmpty'));
  if (protectedIds.map(String).includes(id)) {
    log.error('setPageTitle', 'page is protected - refused before the driver', { pageid: id });
    throw new PageOpError('PROTECTED_PAGE', msg('pageOps.protectedPage', { id }), { pageid: id });
  }
  log.debug('setPageTitle', 'writing title', { pageid: id, length: text.length, mode: TITLE_WRITE_MODE });
  const r = await driver.callWithResponse('setPageTitle', [id, text], { urlPart: '/projects/submit/', bodyPart: 'comm=savepagesettings' });
  const answer = String(r?.text ?? '').trim();
  if (answer !== 'OK' && answer !== '') {
    log.error('setPageTitle', 'response not OK', { pageid: id, status: r?.status, body: answer.slice(0, 120) });
    throw new PageOpError('TITLE_NOT_SAVED', msg('pageOps.titleNotSaved', { id, text: answer.slice(0, 120) }), { pageid: id, text: answer });
  }
  log.info('setPageTitle', 'title written', { pageid: id, length: text.length });
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
    log.error('setPageAlias', 'alias is not valid - refused before the driver', { pageid: id, length: value.length });
    throw new PageOpError('ALIAS_INVALID', msg('pageOps.aliasInvalid', { id }), { pageid: id });
  }
  if (protectedIds.map(String).includes(id)) {
    log.error('setPageAlias', 'page is protected - refused before the driver', { pageid: id });
    throw new PageOpError('PROTECTED_PAGE', msg('pageOps.protectedPage', { id }), { pageid: id });
  }
  log.debug('setPageAlias', 'writing alias', { pageid: id, alias: value });
  const r = await driver.callWithResponse('setPageAlias', [id, value], { urlPart: '/projects/submit/', bodyPart: 'comm=savepagesettings' });
  const answer = String(r?.text ?? '').trim();
  if (ALIAS_TAKEN_RE.test(answer)) {
    log.warn('setPageAlias', 'alias is taken by another page of the project', { pageid: id });
    throw new PageOpError('ALIAS_TAKEN', msg('pageOps.aliasTaken', { id }), { pageid: id, text: answer });
  }
  if (answer !== 'OK' && answer !== '') {
    log.error('setPageAlias', 'response not OK', { pageid: id, status: r?.status, body: answer.slice(0, 120) });
    throw new PageOpError('ALIAS_NOT_SAVED', msg('pageOps.aliasNotSaved', { id, text: answer.slice(0, 120) }), { pageid: id, text: answer });
  }
  log.info('setPageAlias', 'alias written', { pageid: id });
  return { pageid: id, alias: value };
}

export async function duplicatePage(driver, pageid) {
  const source = String(pageid);
  log.debug('duplicatePage', 'duplicate requested', { source });
  const r = await driver.call('duplicatePage', [source]);
  const { pageid: created } = parseNewPageResponse(r.text, { comm: 'dublicatepage' });
  log.info('duplicatePage', `duplicate created ${created}`, { source, created, editor: editorUrl(created) });
  return { source, pageid: created, editor: editorUrl(created) };
}

/** Пустая страница из шаблона «Пустая страница» (examplepageid=1231). */
export async function createPage(driver, { projectid, examplepageid = BLANK_EXAMPLE_PAGE } = {}) {
  projectid = resolveProjectId(projectid);
  log.debug('createPage', 'blank page requested', { projectid, examplepageid });
  const r = await driver.call('createPage', [String(projectid), String(examplepageid)]);
  const { pageid: created } = parseNewPageResponse(r.text, { comm: 'addnewpagedublicateexample' });
  log.info('createPage', `page created ${created}`, { projectid, created, editor: editorUrl(created) });
  return { projectid: String(projectid), pageid: created, editor: editorUrl(created) };
}

/**
 * Публикация страницы. Без opts.confirmed === true — отказ PUBLISH_NOT_CONFIRMED до обращения
 * к драйверу (ни одного запроса в Тильду). Слой браузера повторяет ту же проверку по маркеру.
 */
export async function publishPage(driver, pageid, opts = {}) {
  const id = String(pageid || '');
  if (!id) throw new PageOpError('PUBLISH_NO_PAGE', msg('pageOps.publishNoPage'));
  if (opts.confirmed !== true) {
    log.warn('publishPage', 'publishing without confirmation - refused before touching the browser', { pageid: id });
    throw new PageOpError('PUBLISH_NOT_CONFIRMED', msg('pageOps.publishNotConfirmed', { id }), { pageid: id });
  }
  log.debug('publishPage', 'publish requested', { pageid: id });
  const r = await driver.call('publishPage', [id, PUBLISH_CONFIRM]);
  const parsed = parsePublishResponse(r.text);
  log.info('publishPage', `page ${id} published`, { pageid: id, link: parsed.link, wslink: parsed.wslink });
  return { pageid: id, ...parsed };
}

/** Удаление страниц — вне автоматизации: пошаговая инструкция человеку (список `Message`). */
export function deletePageInstructions(pageid, { projectid } = {}) {
  projectid = resolveProjectId(projectid);
  const id = String(pageid);
  return [
    msg('pageOps.deleteStepIntro', { id }),
    msg('pageOps.deleteStepList', { url: `https://tilda.ru/projects/?projectid=${projectid}` }),
    msg('pageOps.deleteStepFind', { id, editorUrl: editorUrl(id, projectid) }),
    msg('pageOps.deleteStepMenu'),
    msg('pageOps.deleteStepCheck', { id }),
  ];
}
