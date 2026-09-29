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
import { baselineDir } from './lib/paths.mjs';

const log = createLogger('page-role');

/** Маркер подтверждения — тот же, что в scripts/browser/tilda-project.js (T.ROLE_CONFIRM). */
export const ROLE_CONFIRM = 'назначить';
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
    super(message);
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
 * Ошибки проверки запрошенных ролей по списку опций страницы настроек.
 * NOT_IN_OPTIONS — страницы нет в списке (главная проекта или страница другого проекта);
 * SAME_PAGE — шапка и подвал одна страница, либо главная совпадает с текущей шапкой или подвалом.
 * Пустое значение шапки и подвала («снять») допустимо всегда; главную снять нельзя.
 */
export function validateRoles({ header, footer, index }, settings) {
  const errors = [];
  const check = (value, options, label) => {
    if (value === undefined || value === '') return;
    if (!Array.isArray(options) || !options.includes(String(value))) {
      errors.push(`NOT_IN_OPTIONS: страницы ${value} нет в списке ${label} — главная проекта или страница другого проекта`);
    }
  };
  check(header, settings.headerOptions, 'шапок');
  check(footer, settings.footerOptions, 'подвалов');
  if (header && footer && String(header) === String(footer)) errors.push('SAME_PAGE: шапка и подвал — одна страница');
  if (index !== undefined) {
    if (index === '') {
      errors.push('NOT_IN_OPTIONS: главную страницу снять нельзя — укажите pageid');
    } else {
      if (!Array.isArray(settings.indexOptions) || !settings.indexOptions.includes(String(index))) {
        errors.push(`NOT_IN_OPTIONS: страницы ${index} нет в списке главных — страница другого проекта или вкладка «Главная страница» не открыта`);
      }
      const role = [[settings.headerpageid, 'шапка'], [settings.footerpageid, 'подвал']].find(([id]) => id && String(id) === String(index));
      if (role) errors.push(`SAME_PAGE: страница ${index} — ${role[1]} проекта, главной она быть не может`);
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

/** Команда отката: для главной — прежняя главная; главной не было — снять её командой нельзя. */
function rollbackFor(before, indexMode) {
  if (!indexMode) return `page role --header ${orNone(before.headerpageid)} --footer ${orNone(before.footerpageid)} --confirm`;
  return before.indexpageid
    ? `page role --index ${before.indexpageid} --confirm`
    : 'главной до назначения не было — снять её командой нельзя: настройки сайта, «Главное» → «Главная страница»';
}

/**
 * Назначить роли. `driver` — `{ call, callWithResponse, reload }` над страницей настроек проекта
 * (для `index` — вкладка `ss_menu_index`). `protectedIds` — защищённые страницы: главной их не
 * назначить и не снять с роли главной.
 * @returns {Promise<{changed: boolean, before: object, after: object, otherChanged: string[], record: string|null, rollback: string}>}
 */
export async function assignPageRoles(driver, { header, footer, index, confirmed, projectid, protectedIds = [], recordDir, now = () => new Date() } = {}) {
  if (confirmed !== true) {
    log.warn('assignPageRoles', 'назначение без подтверждения — отказ до обращения к браузеру');
    throw new PageRoleError('ROLE_NOT_CONFIRMED', 'page role: нужен --confirm — назначение меняет шапку, подвал или главную всего сайта');
  }
  const indexMode = index !== undefined;
  if (indexMode && (header !== undefined || footer !== undefined)) {
    log.error('assignPageRoles', 'главная вместе с шапкой или подвалом — отказ', { header, footer, index });
    throw new PageRoleError('ROLE_INVALID', 'главная назначается отдельно от шапки и подвала: поля на разных вкладках настроек');
  }
  const fields = indexMode ? INDEX_FIELDS : HEADER_FIELDS;
  const pick = (s) => pickFields(s, fields);
  const before = await driver.call('readProjectSettings');
  log.info('assignPageRoles', 'роли до', pick(before));
  const errors = validateRoles({ header, footer, index }, before);
  if (errors.length) {
    log.error('assignPageRoles', 'роли не прошли проверку', { errors });
    throw new PageRoleError('ROLE_INVALID', errors.join('; '));
  }
  const requested = indexMode
    ? { indexpageid: String(index) }
    : {
        headerpageid: header === undefined ? before.headerpageid : String(header),
        footerpageid: footer === undefined ? before.footerpageid : String(footer),
      };
  const rollback = rollbackFor(before, indexMode);
  if (fields.every((f) => requested[f] === before[f])) {
    log.info('assignPageRoles', 'роли уже такие — запись не нужна', requested);
    return { changed: false, before: pick(before), after: pick(before), otherChanged: [], record: null, rollback };
  }
  if (indexMode) {
    const guard = new Set(protectedIds.map(String));
    const hit = [requested.indexpageid, before.indexpageid].find((id) => id && guard.has(String(id)));
    if (hit) {
      log.error('assignPageRoles', 'главная затрагивает защищённую страницу — отказ до записи', { pageid: hit });
      throw new PageRoleError('PROTECTED_PAGE', `страница ${hit} защищена (TILDA_PROTECTED_PAGES): главную с ней не меняем`);
    }
  }

  const dir = recordDir || join(baselineDir(), 'project-settings', String(projectid));
  mkdirSync(dir, { recursive: true });
  const at = now().toISOString();
  const record = join(dir, `${at.replace(/[:.]/g, '-')}.json`);
  const entry = { projectid: String(projectid), at, before: pick(before), requested };
  writeFileSync(record, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  log.debug('assignPageRoles', 'запись для отката', { record });

  const args = indexMode
    ? { indexpageid: requested.indexpageid, confirm: ROLE_CONFIRM }
    : { headerpageid: header === undefined ? undefined : requested.headerpageid, footerpageid: footer === undefined ? undefined : requested.footerpageid, confirm: ROLE_CONFIRM };
  const r = await driver.callWithResponse('setPageRoles', [args], { urlPart: '/projects/submit/', bodyPart: 'comm=saveprojectsettings' });
  if (String(r.text ?? '').trim() !== 'OK') {
    log.error('assignPageRoles', 'сервер ответил не OK', { status: r.status, bytes: String(r.text ?? '').length });
    throw new PageRoleError('SAVE_FAILED', `настройки не сохранены: сервер ответил не OK (HTTP ${r.status}); запись для отката: ${record}`);
  }
  log.info('assignPageRoles', 'роли записаны', requested);

  await driver.reload();
  const after = await driver.call('readProjectSettings');
  if (fields.some((f) => after[f] !== requested[f])) {
    log.error('assignPageRoles', 'роли после записи не совпали', { requested, after: pick(after) });
    const got = indexMode ? `главная ${after.indexpageid || '—'}` : `шапка ${after.headerpageid || '—'}, подвал ${after.footerpageid || '—'}`;
    throw new PageRoleError('ROLE_NOT_APPLIED', `после сохранения роли не совпали с запрошенными: ${got}`);
  }
  const ignore = indexMode ? [...fields, ...INDEX_DERIVED] : fields;
  const otherChanged = diffFingerprints(before.fingerprints, after.fingerprints, ignore);
  const counted = (s) => s.count - ignore.filter((n) => Object.hasOwn(s.fingerprints ?? {}, n)).length;
  if (counted(after) !== counted(before)) otherChanged.push(`<число настроек ${before.count} → ${after.count}>`);
  if (otherChanged.length) log.warn('assignPageRoles', 'изменились другие настройки', { names: otherChanged });
  writeFileSync(record, JSON.stringify({ ...entry, after: pick(after), otherChanged }, null, 2) + '\n', 'utf8');
  return { changed: true, before: pick(before), after: pick(after), otherChanged, record, rollback };
}
