/**
 * Оформление проекта референса → настройки тестового проекта. Шрифты, веса и цвета заголовков, текста и ссылок референса есть только
 * в CSS проекта (`tilda-blocks-page<id>.min.css`) — он читается как опубликованный файл через
 * фоновую вкладку держателя и сохраняется в слепок (`<slug>/project.css`).
 *
 * Запись — тем же путём, что кабинет (итог пробы 4, 2026-09-23): страница настроек проекта,
 * вкладка «Шрифты» — кнопка пресета и списки весов, вкладка «Цвета и стили» — ввод цвета с
 * клавиатуры, кнопка «Сохранить изменения» (запрос `saveprojectsettings` со всеми настройками).
 * Значение, выставленное скриптом, форма цветов не отправляет, поэтому элементы формы ведёт
 * Playwright (`ui`), а не код страницы. Свои шрифты не переносятся (ветка C′): выбирается пресет
 * Tilda с тем же начертанием. Защита тройная, как у `page role`: CLI `--confirm`, параметр
 * `confirmed`, слово `STYLE_CONFIRM`; запись для отката — до отправки; после — перечитывание и
 * сравнение отпечатков остальных настроек.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { baselineDir } from './lib/paths.mjs';
import { readManifest, refPaths, snapshotFile } from './lib/reference-store.mjs';
import { attachMessage, messageText, msg } from './lib/i18n.mjs';
import { projectCssUrl, PROJECT_STYLE_KEYS, weightFromLabel } from './lib/project-style.mjs';
import { diffFingerprints } from './page-role.mjs';

const log = createLogger('project-style');

/** Слово подтверждения записи оформления проекта. */
export const STYLE_CONFIRM = 'apply-style';

export class ProjectStyleError extends Error {
  constructor(code, message, extra = {}) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'ProjectStyleError';
    this.code = code;
    this.exitCode = 1;
    Object.assign(this, extra);
  }
}

/** Файлы оформления проекта в слепке. */
export function projectStylePaths(slug, opts = {}) {
  const { root } = refPaths(slug, opts);
  return { css: join(root, 'project.css'), style: join(root, 'project-style.json') };
}

/**
 * Прочитать CSS проекта референса: адрес — из `<link>` главной страницы слепка, файл — через
 * фоновую вкладку держателя (как `reference shot`). Адрес не выводится: в лог — только размер.
 */
export async function fetchProjectCss(session, { slug }, opts = {}, deps = {}) {
  const manifest = readManifest(slug, opts);
  if (!manifest) throw new ProjectStyleError('NO_MANIFEST', msg('projectStyle.noManifest', { slug }));
  const first = (manifest.pages ?? []).find((p) => p.status === 'ok' && p.file);
  if (!first) throw new ProjectStyleError('NO_PAGES', msg('projectStyle.noPages', { slug }));
  const html = readFileSync(snapshotFile(refPaths(slug, opts), first.file), 'utf8');
  const url = projectCssUrl(html);
  if (!url) throw new ProjectStyleError('NO_CSS', msg('projectStyle.noCss'));
  const browser = deps.browser || (await import('./lib/browser.mjs'));
  const page = await browser.openBackgroundPage(session.context);
  let css;
  try {
    const resp = await page.goto(url, { waitUntil: 'load' });
    if (!resp || !resp.ok()) throw new ProjectStyleError('CSS_UNAVAILABLE', msg('projectStyle.cssUnavailable', { status: resp ? resp.status() : '—' }));
    css = await resp.text();
  } finally {
    await page.close().catch(() => {});
  }
  const { css: path } = projectStylePaths(slug, opts);
  writeFileSync(path, css, 'utf8');
  log.info('fetchProjectCss', 'CSS проекта сохранён', { bytes: css.length });
  return { path, bytes: css.length };
}

/** Путь записи для отката. */
function recordPath(projectid, now, opts = {}) {
  const dir = join(opts.baseDir || baselineDir(), 'project-settings', String(projectid));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${now.replace(/[:.]/g, '-')}-style.json`);
}

/**
 * Записать оформление проекта. `driver`: `readProjectStyle()` (значения ключей оформления,
 * отпечатки всех настроек, пресеты шрифтов), `setProjectStyle(values)` (форма → «Сохранить
 * изменения», ответ сервера) и `reload()`.
 * @returns {Promise<{ changed: string[], otherChanged: string[], record: string|null, fonts: 'C′', notApplied: string[] }>}
 */
export async function applyProjectStyle(driver, { desired, confirmed = false, confirm, projectid, now = new Date().toISOString() }, opts = {}) {
  if (!confirmed || confirm !== STYLE_CONFIRM) {
    log.warn('applyProjectStyle', 'запись оформления без подтверждения — отказ до браузера');
    throw new ProjectStyleError('STYLE_NOT_CONFIRMED', msg('projectStyle.notConfirmed'));
  }
  const before = await driver.readProjectStyle();
  const requested = {};
  for (const [key, value] of Object.entries(desired.values ?? {})) {
    if (!PROJECT_STYLE_KEYS.includes(key)) continue;
    if (sameValue(key, before.values[key], value)) continue;
    requested[key] = value;
  }
  const changedKeys = Object.keys(requested);
  if (!changedKeys.length) {
    log.info('applyProjectStyle', 'оформление уже как у референса — записи нет', {});
    return { changed: [], otherChanged: [], record: null, fonts: 'C′', notApplied: [] };
  }
  const record = recordPath(projectid ?? 'project', now, opts);
  const entry = { at: now, before: before.values, requested };
  writeFileSync(record, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  log.info('applyProjectStyle', 'запись для отката сохранена', { record, keys: changedKeys });
  const res = await driver.setProjectStyle(requested);
  if (String(res?.text ?? '').trim() !== 'OK') {
    throw new ProjectStyleError('SAVE_FAILED', msg('projectStyle.saveFailed', { text: String(res?.text ?? '').slice(0, 60), record }), { record });
  }
  await driver.reload();
  const after = await driver.readProjectStyle();
  // Вес шрифта форма хранит значением выбранного варианта: у Montserrat Semibold 600 — это `''`.
  const expected = { ...requested, ...(res?.chosen ?? {}) };
  const notApplied = changedKeys.filter((k) => !sameValue(k, after.values[k], expected[k]));
  const otherChanged = diffFingerprints(before.fingerprints, after.fingerprints, [...PROJECT_STYLE_KEYS, 'gf_fonts']);
  entry.chosen = res?.chosen ?? {};
  entry.after = after.values;
  entry.otherChanged = otherChanged;
  entry.notApplied = notApplied;
  writeFileSync(record, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  log.info('applyProjectStyle', 'оформление записано', { changed: changedKeys, notApplied, otherChanged: otherChanged.length });
  if (notApplied.length) {
    throw new ProjectStyleError('STYLE_NOT_APPLIED', msg('projectStyle.notApplied', { notApplied: notApplied.join(', '), record }), { record, notApplied, otherChanged });
  }
  return { changed: changedKeys, otherChanged, record, fonts: 'C′', notApplied };
}

/**
 * Совпадение значения настройки: шрифт — по имени без пробелов и регистра (`Tilda Sans` ↔
 * `TildaSans`), цвет — без регистра, вес — пустое значение формы означает вес шрифта по умолчанию
 * и сравнивается как есть.
 */
export function sameValue(key, actual, wanted) {
  const a = String(actual ?? '');
  const w = String(wanted ?? '');
  if (/font$/.test(key)) return a.replace(/[\s_-]/g, '').toLowerCase() === w.replace(/[\s_-]/g, '').toLowerCase();
  if (/color$/.test(key)) return a.toLowerCase() === w.toLowerCase();
  return a === w;
}

/**
 * Элементы формы настроек через Playwright (итог пробы 4): пресет шрифта — кнопка карточки
 * «Заголовки: <шрифт> Текст: <шрифт>»; вес — `select#<ключ>` по значению или по подписи варианта;
 * цвет — ввод с клавиатуры в `input#<ключ>` и уход фокуса. После — «Сохранить изменения» и ответ
 * `saveprojectsettings`.
 */
export function playwrightStyleUi(page, browser) {
  const openTab = async (title) => {
    await page.getByText(title, { exact: true }).first().click();
    await page.waitForTimeout(1500);
  };
  return {
    async setProjectStyle(values) {
      const submitted = [];
      const chosen = {};
      const fontKeys = ['headlinefont', 'textfont'].filter((k) => k in values);
      const weightKeys = ['headlinefontweight', 'textfontweight', 'textfontsize'].filter((k) => k in values);
      const colorKeys = ['headlinecolor', 'textcolor', 'linkcolor', 'bgcolor'].filter((k) => k in values);
      if (fontKeys.length || weightKeys.length) {
        await openTab('Шрифты');
        const preset = values.headlinefont ?? values.textfont;
        if (preset) {
          const clicked = await page.evaluate((name) => {
            const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
            const b = [...document.querySelectorAll('button')].find((x) => /Выбрать|Выбрано/.test(x.textContent || '') && norm(x.parentElement?.parentElement?.innerText || '').includes(`Заголовки: ${name} Текст: ${name}`));
            if (!b) return false;
            b.scrollIntoView();
            b.click();
            return true;
          }, preset);
          if (!clicked) throw new ProjectStyleError('NO_PRESET', msg('projectStyle.noPreset', { preset }));
          await page.waitForTimeout(1000);
          submitted.push(...fontKeys);
        }
        for (const key of weightKeys) {
          const options = await page.evaluate((id) => {
            const el = document.getElementById(id);
            return el ? [...el.options].map((o) => ({ value: o.value, label: o.textContent.trim() })) : null;
          }, key);
          if (!options) throw new ProjectStyleError('NO_CONTROL', msg('projectStyle.noControl', { key }));
          const want = String(values[key]);
          const hit = options.find((o) => o.value === want) ?? options.find((o) => String(weightFromLabel(o.label) ?? '') === want) ?? options.find((o) => o.label.replace(/px$/, '') === want.replace(/px$/, ''));
          if (!hit) throw new ProjectStyleError('NO_OPTION', msg('projectStyle.noOption', { key, want }));
          await page.locator(`#${key}`).selectOption(hit.value);
          chosen[key] = hit.value;
          submitted.push(key);
        }
      }
      if (colorKeys.length) {
        await openTab('Цвета и стили');
        for (const key of colorKeys) {
          const el = page.locator(`#${key}`);
          await el.click();
          await el.fill('');
          if (values[key]) await el.pressSequentially(String(values[key]), { delay: 20 });
          await el.press('Enter');
          await el.press('Tab');
          await page.mouse.click(5, 5);
          await page.waitForTimeout(300);
          submitted.push(key);
        }
      }
      log.info('setProjectStyle', 'форма заполнена, сохранение', { submitted });
      // Кнопка в шапке формы появляется не сразу после ввода — ждём, пока станет видна.
      await page.locator('button[type="submit"]', { hasText: 'Сохранить изменения' }).first().waitFor({ state: 'visible', timeout: 10000 });
      const saved = await browser.callWithResponse(page, 'clickSaveSettings', [], { urlPart: '/projects/submit/', bodyPart: 'comm=saveprojectsettings' });
      return { submitted, chosen, status: saved.status, text: saved.text };
    },
  };
}

/** Итоговый JSON желаемых настроек в слепке (для `reference plan`: замена семейства шрифта). */
export function writeProjectStyle(slug, data, opts = {}) {
  const { style } = projectStylePaths(slug, opts);
  writeFileSync(style, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return style;
}

/** Прочитать `project-style.json` слепка или null. */
export function readProjectStyle(slug, opts = {}) {
  const { style } = projectStylePaths(slug, opts);
  if (!existsSync(style)) return null;
  return JSON.parse(readFileSync(style, 'utf8'));
}
