/**
 * Назначение страницы-шапки и страницы-подвала проекта и главной страницы
 * проекта: одна команда вместо ручного шага владельца в
 * настройках сайта. Проверки до записи, запись через интерфейс настроек (слой `tilda-project`:
 * `setPageRoles`), перечитывание, сравнение остальных настроек по отпечаткам и запись для отката в
 * `TILDA_BASELINE_DIR/project-settings/<projectid>/`.
 *
 * Шапка и подвал — на вкладке `#tab=ss_menu_header`, главная — на `#tab=ss_menu_index`, поэтому
 * главная назначается отдельным запуском. Назначение меняет весь сайт, поэтому защита тройная: отказ
 * без `--confirm` в CLI, `ROLE_NOT_CONFIRMED` здесь и в слое браузера. Значения других настроек сюда
 * не приходят — только отпечатки (sha256, 16 символов); наружу выходят лишь имена изменившихся.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { attachMessage, messageText, msg } from './lib/i18n.mjs';
import { baselineDir } from './lib/paths.mjs';

const log = createLogger('page-role');

/** Маркер подтверждения — тот же, что в scripts/browser/tilda-project.js (T.ROLE_CONFIRM). */
export const ROLE_CONFIRM = 'assign';
const HEADER_FIELDS = ['headerpageid', 'footerpageid'];
const INDEX_FIELDS = ['indexpageid'];
export const ROLE_FIELDS = [...HEADER_FIELDS, ...INDEX_FIELDS];
/**
 * Служебный признак «главная не опубликована» (прогон 2026-09-24): ключ есть в getsitesettings, пока
 * главной назначена неопубликованная страница, и исчезает при опубликованной (46 → 45 настроек).
 * Форма его не пишет — при смене главной он не считается «другой настройкой».
 */
const INDEX_DERIVED = ['indexpagenotpublished'];

export class PageRoleError extends Error {
  constructor(code, message) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'PageRoleError';
    this.code = code;
    this.exitCode = 1;
  }
}

/** '--header 123' → '123'; 'none' → '' (снять); undefined → undefined (не менять). */
export function parseRoleArg(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === 'none' ? '' : s;
}

/**
 * Ошибки проверки запрошенных ролей по списку опций страницы настроек — сообщения (`Message`).
 * NOT_IN_OPTIONS — страницы нет в списке (главная проекта или страница другого проекта);
 * SAME_PAGE — шапка и подвал одна страница, либо главная совпадает с текущей шапкой или подвалом.
 * Пустое значение шапки и подвала («снять») допустимо всегда; главную снять нельзя.
 */
export function validateRoles({ header, footer, index }, settings) {
  const errors = [];
  const check = (value, options, notInList) => {
    if (value === undefined || value === '') return;
    if (!Array.isArray(options) || !options.includes(String(value))) errors.push(notInList(value));
  };
  check(header, settings.headerOptions, (value) => msg('pageRole.notInHeaders', { value }));
  check(footer, settings.footerOptions, (value) => msg('pageRole.notInFooters', { value }));
  if (header && footer && String(header) === String(footer)) errors.push(msg('pageRole.sameHeaderFooter'));
  if (index !== undefined) {
    if (index === '') {
      errors.push(msg('pageRole.indexRequired'));
    } else {
      if (!Array.isArray(settings.indexOptions) || !settings.indexOptions.includes(String(index))) {
        errors.push(msg('pageRole.notInIndexes', { value: index }));
      }
      if (settings.headerpageid && String(settings.headerpageid) === String(index)) errors.push(msg('pageRole.indexIsHeader', { value: index }));
      else if (settings.footerpageid && String(settings.footerpageid) === String(index)) errors.push(msg('pageRole.indexIsFooter', { value: index }));
    }
  }
  return errors;
}

/** Имена настроек, чьи отпечатки изменились, кроме ролей (`ignore`). */
export function diffFingerprints(before = {}, after = {}, ignore = ROLE_FIELDS) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((n) => !ignore.includes(n) && before[n] !== after[n]).sort();
}

const pickFields = (s, fields) => Object.fromEntries(fields.map((f) => [f, s[f]]));
const orNone = (v) => (v ? v : 'none');

/**
 * Откат: строка-команда (`page role …`); для главной — прежняя главная, а если главной не было,
 * снять её командой нельзя — тогда `Message` с объяснением для человека.
 */
function rollbackFor(before, indexMode) {
  if (!indexMode) return `page role --header ${orNone(before.headerpageid)} --footer ${orNone(before.footerpageid)} --confirm`;
  return before.indexpageid
    ? `page role --index ${before.indexpageid} --confirm`
    : msg('pageRole.noPreviousIndex');
}

/**
 * Назначить роли. `driver` — `{ call, callWithResponse, reload }` над страницей настроек проекта
 * (для `index` — вкладка `ss_menu_index`). `protectedIds` — защищённые страницы: главной их не
 * назначить и не снять с роли главной.
 * @returns {Promise<{changed: boolean, before: object, after: object, otherChanged: Array<string|Message>, record: string|null, rollback: string|Message}>}
 */
export async function assignPageRoles(driver, { header, footer, index, confirmed, projectid, protectedIds = [], recordDir, now = () => new Date() } = {}) {
  if (confirmed !== true) {
    log.warn('assignPageRoles', 'assignment without confirmation - refused before touching the browser');
    throw new PageRoleError('ROLE_NOT_CONFIRMED', msg('pageRole.notConfirmed'));
  }
  const indexMode = index !== undefined;
  if (indexMode && (header !== undefined || footer !== undefined)) {
    log.error('assignPageRoles', 'home page together with header or footer - refused', { header, footer, index });
    throw new PageRoleError('ROLE_INVALID', msg('pageRole.indexSeparate'));
  }
  const fields = indexMode ? INDEX_FIELDS : HEADER_FIELDS;
  const pick = (s) => pickFields(s, fields);
  const before = await driver.call('readProjectSettings');
  log.info('assignPageRoles', 'roles before', pick(before));
  const errors = validateRoles({ header, footer, index }, before);
  if (errors.length) {
    log.error('assignPageRoles', 'roles failed validation', { errors });
    // Несколько причин склеиваются вложенными сообщениями: «первая; вторая».
    throw new PageRoleError('ROLE_INVALID', errors.reduce((first, second) => msg('pageRole.invalidJoin', { first, second })));
  }
  const requested = indexMode
    ? { indexpageid: String(index) }
    : {
        headerpageid: header === undefined ? before.headerpageid : String(header),
        footerpageid: footer === undefined ? before.footerpageid : String(footer),
      };
  const rollback = rollbackFor(before, indexMode);
  if (fields.every((f) => requested[f] === before[f])) {
    log.info('assignPageRoles', 'roles already set - no write needed', requested);
    return { changed: false, before: pick(before), after: pick(before), otherChanged: [], record: null, rollback };
  }
  if (indexMode) {
    const guard = new Set(protectedIds.map(String));
    const hit = [requested.indexpageid, before.indexpageid].find((id) => id && guard.has(String(id)));
    if (hit) {
      log.error('assignPageRoles', 'home page touches a protected page - refused before writing', { pageid: hit });
      throw new PageRoleError('PROTECTED_PAGE', msg('pageRole.protectedPage', { hit }));
    }
  }

  const dir = recordDir || join(baselineDir(), 'project-settings', String(projectid));
  mkdirSync(dir, { recursive: true });
  const at = now().toISOString();
  const record = join(dir, `${at.replace(/[:.]/g, '-')}.json`);
  const entry = { projectid: String(projectid), at, before: pick(before), requested };
  writeFileSync(record, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  log.debug('assignPageRoles', 'rollback record', { record });

  const args = indexMode
    ? { indexpageid: requested.indexpageid, confirm: ROLE_CONFIRM }
    : { headerpageid: header === undefined ? undefined : requested.headerpageid, footerpageid: footer === undefined ? undefined : requested.footerpageid, confirm: ROLE_CONFIRM };
  const r = await driver.callWithResponse('setPageRoles', [args], { urlPart: '/projects/submit/', bodyPart: 'comm=saveprojectsettings' });
  if (String(r.text ?? '').trim() !== 'OK') {
    log.error('assignPageRoles', 'server response not OK', { status: r.status, bytes: String(r.text ?? '').length });
    throw new PageRoleError('SAVE_FAILED', msg('pageRole.saveFailed', { status: r.status, record }));
  }
  log.info('assignPageRoles', 'roles written', requested);

  await driver.reload();
  const after = await driver.call('readProjectSettings');
  if (fields.some((f) => after[f] !== requested[f])) {
    log.error('assignPageRoles', 'roles after writing do not match', { requested, after: pick(after) });
    const got = indexMode
      ? msg('pageRole.gotIndex', { index: after.indexpageid || '—' })
      : msg('pageRole.gotHeaderFooter', { header: after.headerpageid || '—', footer: after.footerpageid || '—' });
    throw new PageRoleError('ROLE_NOT_APPLIED', msg('pageRole.notApplied', { got }));
  }
  const ignore = indexMode ? [...fields, ...INDEX_DERIVED] : fields;
  const otherChanged = diffFingerprints(before.fingerprints, after.fingerprints, ignore);
  const counted = (s) => s.count - ignore.filter((n) => Object.hasOwn(s.fingerprints ?? {}, n)).length;
  if (counted(after) !== counted(before)) otherChanged.push(msg('pageRole.settingsCount', { before: before.count, after: after.count }));
  if (otherChanged.length) log.warn('assignPageRoles', 'other settings changed', { names: otherChanged.map(messageText) });
  // В файл записи для отката идёт английский текст, в итог команды — `Message`.
  writeFileSync(record, JSON.stringify({ ...entry, after: pick(after), otherChanged: otherChanged.map(messageText) }, null, 2) + '\n', 'utf8');
  return { changed: true, before: pick(before), after: pick(after), otherChanged, record, rollback };
}
