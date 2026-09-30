/**
 * Оформление и свой шрифт донора → тестовый проект (`donor style`).
 * Чтение: `getsitesettings` донора под его входом → `<слепок>/donor-style.json`.
 * Запись (`--apply --confirm`): шрифты донора загружаются в тестовый проект под теми же именами
 * ссылками на файлы донора на CDN, назначаются шрифтом заголовков/текста флажками
 * формы загрузки, остальные ключи оформления пишутся через `applyProjectStyle` с записью для
 * отката. Переносятся только ключи, которые умеет писать форма настроек (`FORM_WRITABLE_KEYS`);
 * прочие — в `skipped` с причиной, и они не считаются расхождением при повторе.
 *
 * Адреса файлов шрифтов в логи не пишутся (в них домен CDN и путь проекта донора); в файле
 * слепка (вне git) они допустимы — они нужны загрузке.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { refPaths } from './lib/reference-store.mjs';
import { attachMessage, messageText, msg } from './lib/i18n.mjs';
import { PROJECT_STYLE_KEYS } from './lib/project-style.mjs';
import { applyProjectStyle, sameValue, STYLE_CONFIRM } from './project-style.mjs';

const log = createLogger('donor-style');

export const DONOR_STYLE_FILE = 'donor-style.json';

/** Ключи, которые заполняет форма настроек (`playwrightStyleUi.setProjectStyle`). */
export const FORM_WRITABLE_KEYS = ['headlinefont', 'textfont', 'headlinefontweight', 'textfontweight', 'textfontsize', 'headlinecolor', 'textcolor', 'linkcolor', 'bgcolor'];

/**
 * Причины пропуска ключа оформления: имя → ключ словаря. В результате причина — `Message`, рядом
 * её имя в `code`; в файл слепка причина пишется английским текстом.
 */
export const STYLE_REASONS = {
  formCannot: 'donorStyle.reason.formCannot',
  assignedAtUpload: 'donorStyle.reason.assignedAtUpload',
};

export class DonorStyleError extends Error {
  constructor(code, message, data = {}) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'DonorStyleError';
    this.code = code;
    this.exitCode = 1;
    Object.assign(this, data);
  }
}

export function donorStylePath(slug, opts) {
  return join(refPaths(slug, opts).root, DONOR_STYLE_FILE);
}

/**
 * Чистая: myfonts_json (строка JSON или объект) → [{ name, files: { '<вес>': '<url>', 'woff2_<вес>': '<url>' } }].
 * Формат — шапка tilda-project.js: [{ f_name, f_100…f_900, f_vf, f_woff2_*, cnt }]. Пусто/битый → [].
 */
export function parseMyFonts(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (e) {
      log.warn('parseMyFonts', 'myfonts_json не разобран', { error: e.message, bytes: raw.length });
      return [];
    }
  }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = Object.values(list);
  if (!Array.isArray(list)) return [];
  const fonts = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.f_name ?? '').trim();
    if (!name) continue;
    const files = {};
    for (const [k, v] of Object.entries(item)) {
      const m = k.match(/^f_(woff2_)?(\d{3}|vf)$/);
      if (!m || !v) continue;
      files[`${m[1] ?? ''}${m[2]}`] = String(v);
    }
    fonts.push({ name, files });
  }
  log.debug('parseMyFonts', 'шрифты разобраны', { fonts: fonts.map((f) => `${f.name}: ${Object.keys(f.files).length}`) });
  return fonts;
}

export function writeDonorStyle(slug, data, opts) {
  const path = donorStylePath(slug, opts);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  log.debug('writeDonorStyle', 'записано', { path: path.replace(/\\/g, '/'), keys: Object.keys(data.values ?? {}).length, fonts: (data.fonts ?? []).length });
  return path.replace(/\\/g, '/');
}

export function readDonorStyle(slug, opts) {
  const path = donorStylePath(slug, opts);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Оркестратор чтения под входом донора: readProjectStyle → values + fonts → donor-style.json. */
export async function captureDonorStyle(driver, { slug, baseDir, now = new Date().toISOString() }) {
  const style = await driver.readProjectStyle();
  const values = style?.values ?? {};
  const fonts = parseMyFonts(values.myfonts_json);
  const path = writeDonorStyle(slug, { at: now, values, fonts }, baseDir ? { baseDir } : undefined);
  log.info('captureDonorStyle', 'оформление донора снято', { fonts: fonts.length, keys: Object.keys(values).length });
  return { values, fonts, path };
}

/** Какие шрифты донора загружать: `present`, если в проекте уже есть то же имя с тем же набором весов. */
export function fontsToUpload(donorFonts, testFonts) {
  const upload = [];
  const present = [];
  for (const f of donorFonts ?? []) {
    const same = (testFonts ?? []).find((t) => t.name === f.name && JSON.stringify(Object.keys(t.files).sort()) === JSON.stringify(Object.keys(f.files).sort()));
    (same ? present : upload).push(f);
  }
  return { upload, present };
}

/** Ответ editprojectfontsupload: "OK" — успех; JSON с error или любой другой текст — отказ. */
export function parseFontUploadResponse(text) {
  const t = String(text ?? '').trim();
  if (t === 'OK') return { ok: true, message: 'OK' };
  if (/^\s*</.test(t)) return { ok: false, message: msg('donorStyle.fontUploadHtml') };
  try {
    const json = JSON.parse(t);
    return { ok: false, message: String(json?.error ?? t).slice(0, 200) };
  } catch {
    return { ok: false, message: t.slice(0, 200) || msg('donorStyle.fontUploadEmpty') };
  }
}

/**
 * Загрузка недостающих шрифтов донора в тестовый проект. driver: readProjectStyle, uploadProjectFont, reload.
 * @returns {{ uploaded: string[], present: string[], after: object[] }}
 */
export async function applyDonorFonts(driver, { projectid, fonts, headlinefont, textfont }) {
  const before = parseMyFonts((await driver.readProjectStyle())?.values?.myfonts_json);
  const { upload, present } = fontsToUpload(fonts, before);
  log.info('applyDonorFonts', 'план шрифтов', { upload: upload.map((f) => f.name), present: present.map((f) => f.name) });
  for (const f of upload) {
    const r = await driver.uploadProjectFont({ projectid, name: f.name, files: f.files, asHeadline: f.name === headlinefont, asText: f.name === textfont });
    const parsed = parseFontUploadResponse(r?.text);
    if (!parsed.ok) throw new DonorStyleError('FONT_UPLOAD_FAILED', msg('donorStyle.fontUploadFailed', { font: f.name, message: parsed.message }), { font: f.name });
    log.info('applyDonorFonts', 'шрифт загружен', { name: f.name, weights: Object.keys(f.files).length });
  }
  if (!upload.length) return { uploaded: [], present: present.map((f) => f.name), after: before };
  await driver.reload();
  const after = parseMyFonts((await driver.readProjectStyle())?.values?.myfonts_json);
  const missing = fontsToUpload(upload, after).upload.map((f) => f.name);
  if (missing.length) throw new DonorStyleError('FONT_NOT_APPLIED', msg('donorStyle.fontNotApplied', { missing: missing.join(', ') }), { missing });
  log.info('applyDonorFonts', 'загружено', { uploaded: upload.map((f) => f.name), present: present.map((f) => f.name) });
  return { uploaded: upload.map((f) => f.name), present: present.map((f) => f.name), after };
}

/**
 * Желаемые настройки из значений донора: только ключи формы; шрифты, назначенные при загрузке,
 * пропускаются. Пустые значения сохраняются (пустой цвет = «по умолчанию»).
 * @returns {{ values: object, skipped: [{ key, code, reason: Message }] }}
 */
export function desiredFromDonor(values, { uploadedFonts = [] } = {}) {
  const out = {};
  const skipped = [];
  for (const key of PROJECT_STYLE_KEYS) {
    if (!FORM_WRITABLE_KEYS.includes(key)) {
      skipped.push({ key, code: 'formCannot', reason: msg(STYLE_REASONS.formCannot) });
      continue;
    }
    const value = values?.[key] ?? '';
    if ((key === 'headlinefont' || key === 'textfont') && uploadedFonts.includes(String(value))) {
      skipped.push({ key, code: 'assignedAtUpload', reason: msg(STYLE_REASONS.assignedAtUpload) });
      continue;
    }
    out[key] = String(value);
  }
  return { values: out, skipped };
}

/**
 * Запись оформления донора в тестовый проект: подтверждение → шрифты → настройки формы → сверка.
 * driver: readProjectStyle, uploadProjectFont, setProjectStyle, reload.
 */
export async function applyDonorStyle(driver, { slug, projectid, confirmed = false, confirm, baseDir, now = new Date().toISOString() }) {
  if (!confirmed || confirm !== STYLE_CONFIRM) {
    log.warn('applyDonorStyle', 'запись оформления без подтверждения — отказ до записи');
    throw new DonorStyleError('STYLE_NOT_CONFIRMED', msg('donorStyle.notConfirmed'));
  }
  const opts = baseDir ? { baseDir } : undefined;
  const style = readDonorStyle(slug, opts);
  if (!style) throw new DonorStyleError('NO_DONOR_STYLE', msg('donorStyle.noDonorStyle', { slug }));
  const donorFonts = style.fonts ?? [];
  const fonts = await applyDonorFonts(driver, { projectid, fonts: donorFonts, headlinefont: style.values.headlinefont, textfont: style.values.textfont });
  const desired = desiredFromDonor(style.values, { uploadedFonts: donorFonts.map((f) => f.name) });
  const r = await applyProjectStyle(driver, { desired: { values: desired.values }, confirmed, confirm, projectid, now }, opts);
  const after = await driver.readProjectStyle();
  const assigned = ['headlinefont', 'textfont'].filter((k) => donorFonts.some((f) => f.name === String(style.values[k])));
  const checkKeys = [...Object.keys(desired.values), ...assigned];
  const notMatched = checkKeys.filter((k) => !sameValue(k, after?.values?.[k], style.values[k]));
  writeDonorStyle(slug, { ...style, skipped: desired.skipped.map((x) => ({ key: x.key, code: x.code, reason: messageText(x.reason) })), appliedAt: now }, opts);
  log.info('applyDonorStyle', 'итог', { uploaded: fonts.uploaded, present: fonts.present, changed: r.changed, otherChanged: r.otherChanged.length, skipped: desired.skipped.map((s) => s.key), notMatched });
  return { fonts, changed: r.changed, otherChanged: r.otherChanged, record: r.record, skipped: desired.skipped, notMatched };
}
