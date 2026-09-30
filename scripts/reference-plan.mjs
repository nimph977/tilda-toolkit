/**
 * Генератор плана сборки по референсу: структура страницы слепка × каталог шаблонов → операции
 * `newRecord` с текстами, ссылками кнопок, карточками и картинками с диска.
 *
 * Чистая логика без сети и браузера. Всё, что перенести нельзя, перечисляется в `skipped`
 * (блок целиком) и `unmapped` (отдельное поле) — пользователь дорабатывает такие места вручную.
 * Не переносятся: Zero Block, получатели заявок форм, скрипты HTML-блоков.
 * Тексты идут в форме `html` структуры: видимый текст и `<br>` на местах переносов строк.
 * Соцссылки (`soclinks`) переносятся для шаблонов с формой `{service, link}`, мессенджеры 898 —
 * элементами с `type` (`MESSENGER_LINK_RULES`). Строгая копия:
 * настройки — по карте влияния шаблона (`settingsFields`), кнопки карточек, поля формы
 * (`forminputs`, сообщение об успехе, `formmsgurl` с флагом `formContent`), код HTML-блока.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { messageText, msg } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { plansDir } from './lib/paths.mjs';
import { isLabel, readManifest, readSite, refPaths, resolveSource } from './lib/reference-store.mjs';
import { buildLinkIndex, LINK_REASONS, rewriteReferenceUrl } from './lib/reference-links.mjs';
import { escapeAttr } from './lib/reference-structure.mjs';
import { loadCatalogs, loadSettingsMap, tplidsFromStructure, ZERO_TPLID } from './catalog.mjs';
import { decodeSettings } from './lib/settings-decode.mjs';
import { RECORD_SKIP_FIELDS } from './lib/record-fields.mjs';

const log = createLogger('reference-plan');

/** Поле текста кнопки → поле её ссылки (номер кнопки сохраняется). */
export const LINK_FIELD_MAP = [
  [/^buttontitle(\d*)$/, 'buttonlink$1'],
  [/^btntext(\d*)$/, 'btnlink$1'],
];
/** Текстовые ключи карточки по умолчанию — для каталогов, снятых без `cardKeys`. */
export const CARD_TEXT_KEYS = ['li_title', 'li_descr'];
/** Ключи карточки, которые текстом не переносятся: картинки и служебные. */
export const CARD_NON_TEXT_KEYS = ['ls', 'loff', 'lid', 'li_img', 'li_img2', 'li_imgalt', 'li_link', 'li_linktarget'];

/**
 * Текстовые ключи карточки у шаблона: те, что каталог объявил в `cardKeys`, минус картинки и
 * служебные. Жёсткий список терял подписи (`li_text` у 686), поэтому источник — каталог;
 * каталог без `cardKeys` сохраняет прежнюю пару.
 */
export function cardTextKeys(cat) {
  const keys = (cat.cardKeys ?? []).filter((k) => /^li[_-]/.test(k) && !CARD_NON_TEXT_KEYS.includes(k));
  return keys.length ? keys : CARD_TEXT_KEYS;
}

/** Имя поля ссылки для поля текста кнопки, если шаблон его знает; иначе null. */
export function linkFieldFor(name, allowed) {
  for (const [re, replacement] of LINK_FIELD_MAP) {
    if (!re.test(name)) continue;
    const link = name.replace(re, replacement);
    return allowed.has(link) ? link : null;
  }
  return null;
}

/**
 * Поля, в которые можно писать ссылку кнопки. Каталог хранит только непустые поля снимка, а у
 * свежего блока `buttonlink` пуст (проба), поэтому источник — полный список
 * полей шаблона `tplFields` (`tpl.fields` ответа редактора); каталог без него — правило пары:
 * ссылка разрешена, если разрешён парный текст кнопки (запись страхует `verify`).
 */
export function linkAllowedFor(cat, allowed) {
  const out = new Set(allowed);
  for (const name of cat.linkFields ?? []) out.add(name);
  if (Array.isArray(cat.tplFields)) {
    for (const name of cat.tplFields) out.add(name);
    return out;
  }
  for (const name of allowed) {
    for (const [re, replacement] of LINK_FIELD_MAP) if (re.test(name)) out.add(name.replace(re, replacement));
  }
  return out;
}

/** Причины по кнопкам блока. */
export const BUTTON_REASONS = {
  noField: (slot) => ({ code: 'buttonNoField', reason: `button ${slot || '1'}: the template has no button text field` }),
  noLinkField: (slot) => ({ code: 'buttonNoLinkField', reason: `button ${slot || '1'}: the template does not store the button link — the text is transferred, the address is not` }),
  noText: (slot) => ({ code: 'buttonNoText', reason: `button ${slot || '1'}: the reference button has no text — not transferred` }),
};

/** Причины по фон-видео обложки. */
export const VIDEO_REASONS = {
  noField: { code: 'videoNoField', reason: 'background video: the template has no video field' },
  notTransferable: { code: 'videoNotTransferable', reason: 'background video: the video address was not obtained from the reference page (probe)' },
};

/**
 * Вид видео → поле шаблона (проба: `rutubeid` записан и показан в предпросмотре;
 * остальные имена — из `tpl.fields` обложки 213).
 */
export const VIDEO_FIELD_BY_KIND = {
  youtube: 'youtubeid',
  vimeo: 'vimeoid',
  rutube: 'rutubeid',
  vkvideo: 'vkvideoid',
  kinescope: 'kinescopeid',
  mp4: 'videomp4',
  webm: 'videowebm',
};

/** Причины пропуска для карточек списка. */
export const CARD_REASONS = {
  noLink: { code: 'cardNoLink', reason: 'card link: the template does not store li_link' },
  oneLink: (used) => ({ code: 'cardOneLink', reason: `second card link: a card has one address, taken from ${used}` }),
  noButton: { code: 'cardNoButton', reason: 'card button: the template has no li_buttontitle' },
};

/**
 * Пары `--substitute <от>=<к>` → объект замен; повтор ключа — последняя пара побеждает.
 * Валидность пар проверяет `parseCli` (UsageError до сети).
 */
export function parseSubstitutes(list = []) {
  const out = {};
  for (const pair of list.flatMap((s) => String(s).split(','))) {
    const [from, to] = pair.trim().split('=');
    if (from && to) out[from] = to;
  }
  return out;
}

/** Хосты соцсетей и мессенджеров — такие ссылки не пункты меню. */
export const SOCIAL_HOST_RE = /(^|\.)(wa\.me|t\.me|telegram\.me|instagram\.com|vk\.com|facebook\.com|youtube\.com|youtu\.be|ok\.ru|twitter\.com|x\.com|tiktok\.com)$/i;

/** Причины пропуска меню. */
export const MENU_REASONS = {
  noTarget: { code: 'menuNoTarget', reason: 'menu: the template has no menuitems or li_title/li_link list' },
  duplicate: (title) => ({ code: 'menuDuplicate', reason: `menu item "${title}" is repeated: the menu has one row per title, the address is not transferred` }),
};

/**
 * Пункты меню из ссылок блока: непустой текст, не соцсеть, без дублей текста.
 * Отброшенные дубли возвращаются отдельно: причину по ним пишет `menuFields`, и только там,
 * где меню действительно собирается, — иначе шум шёл бы по каждому блоку со ссылками.
 * `linkReason`/`linkText` — решение переписи адреса (`mapBlockLinks`), если адрес остался на референсе.
 * @returns {{ items: Array<{title: string, link: string, linkReason?: string, linkText?: string}>, duplicates: Array<{title: string, link: string}> }}
 */
export function menuItems(block) {
  const seen = new Set();
  const items = [];
  const duplicates = [];
  // [FIX] Ссылка кнопки блока — не пункт меню: кнопка переносится своим полем (`buttontitle`),
  // иначе в меню появлялся лишний пункт «Заказать расчет» (сверка P00, 2026-09-23).
  const buttonKeys = new Set((block.buttons ?? []).map((b) => `${String(b.text ?? '').trim()}\n${b.href ?? ''}`));
  for (const l of block.links ?? []) {
    const title = String(l.text ?? '').trim();
    if (!title) continue;
    if (buttonKeys.has(`${title}\n${l.href ?? ''}`)) {
      log.debug('menuItems', '[FIX] ссылка кнопки не идёт в пункты меню', { order: block.order });
      continue;
    }
    if (seen.has(title)) {
      duplicates.push({ title, link: l.href });
      continue;
    }
    let host = '';
    try {
      host = new URL(l.href).hostname;
    } catch {
      /* относительный или битый адрес — оставляем как пункт */
    }
    if (host && SOCIAL_HOST_RE.test(host)) continue;
    seen.add(title);
    const item = { title, link: l.href };
    if (l.linkReason) Object.assign(item, { linkCode: l.linkCode, linkReason: l.linkReason, linkText: l.linkText });
    items.push(item);
  }
  return { items, duplicates };
}

/**
 * Поля меню по каталогу: `menuitems` (JSON `{title, link, linktarget}`), если шаблон его хранит;
 * иначе карточки `li_title`/`li_link` — только для подменённого шаблона (`--substitute`).
 * @returns {{ fields: Array<{name: string, value: string}>, cards: object[] }}
 */
export function menuFields(block, cat, miss, { substituted = false } = {}) {
  const { items, duplicates } = menuItems(block);
  const content = new Set(cat.tabs?.content ?? []);
  const result = { fields: [], cards: [] };
  if (!items.length) return result;
  // Причины по отброшенным дублям пишутся только когда меню собирается: иначе они сыпались бы
  // и для блоков, которые целиком уходят в пропуски.
  const reportDuplicates = () => {
    for (const d of duplicates) miss({ field: 'menuitems', ...MENU_REASONS.duplicate(d.title), text: String(d.link ?? '').slice(0, 40) });
  };
  // Адрес пункта, оставшийся на референсе, получает причину только в собранном меню.
  const reportLinks = (field) => {
    for (const i of items) if (i.linkReason) miss({ field, code: i.linkCode, reason: i.linkReason, text: i.linkText });
  };

  if (content.has('menuitems')) {
    result.fields.push({ name: 'menuitems', value: JSON.stringify(items.map((i) => ({ title: i.title, link: i.link, linktarget: '' }))) });
    reportDuplicates();
    reportLinks('menuitems');
    return result;
  }
  if (substituted && content.has('list') && (cat.cardKeys ?? []).includes('li_title') && !(block.cards ?? []).length) {
    const withLink = (cat.cardKeys ?? []).includes('li_link');
    reportDuplicates();
    result.cards = items.map((i) => ({ li_title: i.title, li_descr: '', li_img: '', 'li-tubutton': '', li_imgalt: '', ...(withLink ? { li_link: i.link } : {}) }));
    if (withLink) reportLinks('li_link');
    else miss({ field: 'li_link', ...CARD_REASONS.noLink, text: String(items.length) });
    return result;
  }
  // Причина пишется только там, где меню ожидалось: у подменённого блока. Для обычных блоков
  // ссылки меню не считаются содержимым, и поведение остаётся прежним.
  if (substituted) miss({ field: 'menuitems', ...MENU_REASONS.noTarget, text: String(items.length) });
  return result;
}

/** Причины пропуска соцссылок — по каталогу: наличие поля и форма первого элемента `defaults.soclinks`. */
export const SOCLINKS_REASONS = {
  noField: { code: 'soclinksNoField', reason: 'social links: there is no soclinks field in the catalog' },
  shape: { code: 'soclinksShape', reason: 'social links: the soclinks format of the template is not supported' },
  messenger: (service) => ({ code: 'messengerUnsupported', reason: `messenger ${service}: the address is not converted into a soclinks element` }),
  messengerQuery: (service) => ({ code: 'messengerQuery', reason: `messenger ${service}: the element does not store address parameters (a ready message ?text=)` }),
};

/**
 * Адрес мессенджера → элемент `soclinks` шаблона 898 (итог пробы 5, 2026-09-23): telegram —
 * `type: username`, всё после `t.me/`; whatsapp — `type: tel`, цифры после `wa.me/`; телефон —
 * `tel` без `type`, всё после `tel:`.
 */
export const MESSENGER_LINK_RULES = [
  { service: 'telegram', hrefPattern: /^https?:\/\/(?:t\.me|telegram\.me)\/([^?#]+)/i, type: 'username', valueFrom: 'username' },
  { service: 'whatsapp', hrefPattern: /^https?:\/\/wa\.me\/(\d+)/i, type: 'tel', valueFrom: 'tel' },
  { service: 'phone', hrefPattern: /^tel:([^?#]+)/i, type: null, valueFrom: 'tel' },
];

/** Форма мессенджеров у стокового значения каталога: первый элемент `defaults.soclinks` имеет `type`. */
function messengerShape(cat) {
  try {
    const first = JSON.parse(String(cat.defaults?.soclinks ?? '[]'))[0];
    return Boolean(first && 'type' in first);
  } catch {
    return false;
  }
}

/** Поле `soclinks` мессенджеров 898 по `block.messengers`; null, если переносить нечего. */
export function messengerField(block, cat, miss) {
  const items = block.messengers ?? [];
  if (!items.length) return null;
  const services = items.map((i) => i.service);
  if (!new Set(cat.tabs?.content ?? []).has('soclinks')) {
    miss({ field: 'soclinks', ...SOCLINKS_REASONS.noField, text: services.join(',') });
    return null;
  }
  if (!messengerShape(cat)) {
    miss({ field: 'soclinks', ...SOCLINKS_REASONS.shape, text: services.join(',') });
    return null;
  }
  let stock = [];
  try {
    stock = JSON.parse(String(cat.defaults.soclinks));
  } catch {
    stock = [];
  }
  const out = [];
  for (const m of items) {
    const rule = MESSENGER_LINK_RULES.find((r) => r.service === m.service);
    const hit = rule ? String(m.href).match(rule.hrefPattern) : null;
    if (!hit) {
      miss({ field: 'soclinks', ...SOCLINKS_REASONS.messenger(m.service), text: m.service });
      continue;
    }
    if (/\?./.test(String(m.href))) miss({ field: 'soclinks', ...SOCLINKS_REASONS.messengerQuery(m.service), text: m.service });
    const title = stock.find((s) => s.service === m.service)?.title ?? m.service;
    const el = { service: m.service, title };
    if (rule.type) el.type = rule.type;
    el[rule.valueFrom] = decodeURIComponent(hit[1]);
    out.push(el);
  }
  log.debug('messengerField', 'мессенджеры', { services, mapped: out.length, missed: items.length - out.length });
  return out.length ? { name: 'soclinks', value: JSON.stringify(out) } : null;
}

/** Форма `[{service, link}]` у стокового значения каталога; иначе (мессенджеры 898: `type`/`username`) — false. */
export function soclinksShapeSupported(cat) {
  const raw = cat.defaults?.soclinks;
  if (raw === undefined || raw === null || raw === '') return true; // пустой сток — форма по умолчанию
  try {
    const first = JSON.parse(String(raw))[0];
    return !first || ('service' in first && 'link' in first && !('type' in first) && !('username' in first));
  } catch {
    return false;
  }
}

/** Поле `soclinks` по соцссылкам структуры; null, если переносить нечего. */
export function soclinksField(block, cat, miss) {
  const items = block.soclinks ?? [];
  if (!items.length) return null;
  const services = items.map((i) => i.service).join(',');
  if (!new Set(cat.tabs?.content ?? []).has('soclinks')) {
    miss({ field: 'soclinks', ...SOCLINKS_REASONS.noField, text: services });
    return null;
  }
  if (!soclinksShapeSupported(cat)) {
    miss({ field: 'soclinks', ...SOCLINKS_REASONS.shape, text: services });
    return null;
  }
  return { name: 'soclinks', value: JSON.stringify(items.map((i) => ({ service: i.service, link: i.href }))) };
}

/** Причины `unmapped` для оформления — по составу вкладки «Настройки» каталога. */
export const STYLE_REASONS = {
  margin: { code: 'spacing', reason: 'spacing: the margintop/marginbottom fields are not in the catalog' },
  background: { code: 'background', reason: 'background: there is no background field in the catalog' },
  typo: (family) => ({ code: 'typography', reason: `typography: the ${family}_typo field is not in the catalog` }),
};

/** [FIX] Причины по форме разделителя 796. */
export const SHAPE_REASONS = {
  unknown: { code: 'shapeUnknown', reason: 'divider shape not recognized — the stock shape of the template stays' },
  noField: { code: 'shapeNoField', reason: 'divider shape: the shapedividerstyle field is not in the catalog' },
};

/** [FIX] Настройка формы разделителя по `block.shape` (стиль из пути SVG референса). */
function shapeFields(b, allowed, miss) {
  if (!b.shape) return [];
  if (!b.shape.style) {
    miss({ field: 'shapedividerstyle', ...SHAPE_REASONS.unknown, text: b.shape.path ?? '' });
    return [];
  }
  if (!allowed.has('shapedividerstyle')) {
    miss({ field: 'shapedividerstyle', ...SHAPE_REASONS.noField, text: b.shape.style });
    return [];
  }
  log.debug('shapeFields', '[FIX] форма разделителя', { order: b.order, style: b.shape.style });
  return [{ name: 'shapedividerstyle', value: b.shape.style }];
}

/** Поля фона в порядке предпочтения (`color` намеренно не входит — у 296/217 это цвет линии). */
export const BACKGROUND_FIELDS = ['blockbackground', 'bgcolor'];

/**
 * Поля вкладки «Настройки» из `block.styles` по каталогу шаблона.
 * @returns {Array<{name: string, value: string}>}  miss(...) получает причины пропуска
 */
export function styleFields(block, cat, miss) {
  const styles = block.styles;
  if (!styles) return [];
  const settings = new Set(cat.tabs?.settings ?? []);
  const out = [];
  for (const [name, value] of [['margintop', styles.paddingTop], ['marginbottom', styles.paddingBottom]]) {
    if (!value) continue;
    if (settings.has(name)) out.push({ name, value });
    else miss({ field: name, ...STYLE_REASONS.margin, text: value });
  }
  if (styles.bgColor) {
    const bgField = BACKGROUND_FIELDS.find((n) => settings.has(n));
    if (bgField) out.push({ name: bgField, value: styles.bgColor });
    else miss({ field: 'background', ...STYLE_REASONS.background, text: styles.bgColor });
  }
  for (const [family, typo] of Object.entries(styles.typo ?? {})) {
    const name = `${family}_typo`;
    if (settings.has(name)) out.push({ name, value: JSON.stringify(typo) });
    else miss({ field: name, ...STYLE_REASONS.typo(family), text: Object.keys(typo).join(',') });
  }
  return out;
}

/** Лимит кода HTML-блока — как у `T.saveT123Code`. */
export const T123_CODE_LIMIT = 25 * 1024;

/** Причины по коду HTML-блока. */
export const CODE_REASONS = {
  tooLarge: { code: 'codeTooLarge', reason: 'HTML block: the code is larger than 25 KB' },
  scriptsRemoved: { code: 'codeScriptsRemoved', reason: 'HTML block: scripts are removed — writing them resets the Tilda session' },
};

/** Причины по форме блока. */
export const FORM_REASONS = {
  receivers: { code: 'formReceivers', reason: 'form: request recipients are a setting of the copy project, not transferred' },
  noSuccessUrl: { code: 'formNoSuccessUrl', reason: 'form: Tilda does not keep the redirect address after submitting' },
  inputUnknown: (type) => ({ code: 'formInputUnknown', reason: `form: field type ${type} is not recognized` }),
  noList: { code: 'formNoList', reason: 'form: the template has no forminputs field (the list of form fields)' },
  noField: (name) => ({ code: 'formNoField', reason: `form: the template has no ${name} field` }),
  noForm: { code: 'formNoForm', reason: 'form: the structure has no form breakdown — reference structure' },
};

/**
 * Типы полей ввода, которые переносятся элементом формы (итог пробы 3): у них вся настройка —
 * имя, подсказка, обязательность, маска и подпись. Списки, переключатели и прочее хранят
 * варианты отдельно — причина `inputUnknown`.
 */
export const FORM_INPUT_TYPES = ['nm', 'ph', 'em', 'ta', 'in'];

/**
 * Разметка поля ввода → ключи элемента `forminputs` (итог пробы 3, 2026-09-23): `name` → `li_nm` и
 * `li_name`, `placeholder` → `li_ph`, `data-tilda-req="1"` → `li_req=y`, `data-tilda-mask` →
 * `li_masktype=''` + `li_mask`, `.t-input-title` → `li_title`. `data-tilda-rule` выводится из типа.
 */
export const FORM_INPUT_MAP = {
  li_type: (x) => x.type,
  li_nm: (x) => x.name,
  li_name: (x) => x.name,
  li_ph: (x) => x.placeholder,
  li_req: (x) => (x.required ? 'y' : ''),
  li_title: (x) => x.title,
};

/** Элементы `forminputs` по разбору формы; `lid` не задаётся (его ставит apply). */
export function formCards(form, miss) {
  const out = [];
  (form?.inputs ?? []).forEach((x, i) => {
    if (!FORM_INPUT_TYPES.includes(x.type)) {
      miss({ card: i, field: 'forminputs', ...FORM_REASONS.inputUnknown(x.type || '?'), text: String(x.name ?? '').slice(0, 40) });
      return;
    }
    const el = Object.fromEntries(Object.entries(FORM_INPUT_MAP).map(([k, fn]) => [k, String(fn(x) ?? '')]));
    if (x.mask) {
      el.li_masktype = '';
      el.li_mask = x.mask;
    }
    out.push(el);
  });
  log.debug('formCards', 'поля формы', { inputs: (form?.inputs ?? []).length, mapped: out.length });
  return out;
}

/** Причины по полям «Настроек», перенесённым картой влияния. */
export const SETTINGS_REASONS = {
  noMap: { code: 'settingsNoMap', reason: 'settings: the template is not calibrated — catalog calibrate' },
  noFeatures: { code: 'settingsNoFeatures', reason: 'settings: the structure has no features — reference structure' },
  substituted: (from, to) => ({ code: 'settingsSubstituted', reason: `settings: template ${from} is replaced by ${to} — only spacing, background and typography are transferred` }),
  undecided: (why) => ({ code: 'settingsUndecided', reason: `settings: the value is not recognized by the map (${why})` }),
  unexplained: { code: 'settingsUnexplained', reason: 'settings: markup features without a field — the number is in text' },
};

/** Причины по полям, картинкам и карточкам, которых нет в каталоге шаблона или файла картинки. */
export const FIELD_REASONS = {
  notInCatalog: { code: 'fieldNotInCatalog', reason: 'the field is not in the catalog' },
  linkWithoutField: { code: 'linkWithoutField', reason: 'a link without a link field' },
  imageNoField: { code: 'imageNoField', reason: 'an image without imgfield' },
  imageFieldNotInCatalog: { code: 'imageFieldNotInCatalog', reason: 'the image field is not in the catalog' },
  imageNotFetched: { code: 'imageNotFetched', reason: 'the image file is not downloaded: reference fetch --images' },
  cardsNoList: { code: 'cardsNoList', reason: 'cards without a list field' },
  cardFieldNotTransferred: { code: 'cardFieldNotTransferred', reason: 'the card field is not transferred' },
  cardImageNotFetched: { code: 'cardImageNotFetched', reason: 'the card image file is not downloaded' },
};

/** Причины пропуска блока целиком (`skipped[]`). */
export const SKIP_REASONS = {
  noTplid: { code: 'noTplid', reason: 'block without tplid' },
  zeroBlock: { code: 'zeroBlock', reason: 'Zero Block is not supported' },
  catalogMissing: { code: 'catalogMissing', reason: 'catalog not captured: catalog capture' },
  substituteCatalogMissing: (tplid) => ({ code: 'substituteCatalogMissing', reason: `substitute catalog not captured: catalog capture --tplid ${tplid}` }),
  templateUnavailable: { code: 'templateUnavailable', reason: 'template is unavailable on the plan — pass --substitute <tplid>=<available one>' },
  substituteUnavailable: { code: 'substituteUnavailable', reason: 'substitute template is unavailable on the plan' },
  contentOutsideFields: { code: 'contentOutsideFields', reason: 'content outside field= — not transferred' },
  noTransferableFields: { code: 'noTransferableFields', reason: 'no transferable fields' },
};

/**
 * Замена своего шрифта референса пресетом Tilda в JSON-полях настроек (`*_typo`, `button_styles`:
 * ключ `fontfamily`): иначе блок ссылается на шрифт, которого в проекте нет.
 * `aliases` — `fontAliases` из `project-style.json` слепка (`reference project`).
 */
export function applyFontAliases(fields, aliases = {}) {
  const map = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v]));
  if (!Object.keys(map).length) return fields;
  return fields.map((f) => {
    if (!/^\s*\{/.test(String(f.value))) return f;
    let o;
    try {
      o = JSON.parse(f.value);
    } catch {
      return f;
    }
    const to = typeof o.fontfamily === 'string' ? map[o.fontfamily.replace(/^['"]|['"]$/g, '').toLowerCase()] : undefined;
    if (!to) return f;
    log.debug('applyFontAliases', 'семейство заменено пресетом', { field: f.name, to });
    return { ...f, value: JSON.stringify({ ...o, fontfamily: to }) };
  });
}

/** Поля, которые надёжно читаются из классов записи и добираются правилами, если карта их не решила. */
const RULE_FALLBACK_FIELDS = new Set(['margintop', 'marginbottom', ...BACKGROUND_FIELDS]);

/**
 * Поля «Настроек» блока: по карте влияния исходного шаблона, иначе правилами
 * `styleFields` с одной причиной, почему не картой. Причина пишется, только если калибровка
 * вообще используется (`explain`: в плане есть хоть одна карта) — без калибровки план остаётся
 * прежним и не зашумляется строкой «не откалиброван» у каждого блока.
 * @returns {{ fields: Array<{name, value}>, byMap: boolean, decoded: number, undecided: number, unexplained: number }}
 */
export function settingsFields(b, { cat, map, sourceTplid, tplid, isSubstituted, miss, explain = true }) {
  const why = isSubstituted ? SETTINGS_REASONS.substituted(sourceTplid, tplid) : !map ? SETTINGS_REASONS.noMap : !Array.isArray(b.features) ? SETTINGS_REASONS.noFeatures : null;
  if (why) {
    if (explain) miss({ field: null, ...why });
    return { fields: styleFields(b, cat, miss), byMap: false, decoded: 0, undecided: 0, unexplained: 0 };
  }
  const decoded = decodeSettings(b.features, map, cat.defaults ?? {});
  const known = new Set(Object.keys(map.schema ?? map.fields ?? {}));
  const fields = Object.entries(decoded.values).filter(([name]) => known.has(name)).map(([name, value]) => ({ name, value }));
  const taken = new Set(fields.map((f) => f.name));
  // Отступы и фон, не решённые картой, берутся из классов записи (правила styleFields).
  for (const f of styleFields(b, cat, () => {})) {
    if (RULE_FALLBACK_FIELDS.has(f.name) && !taken.has(f.name)) {
      fields.push(f);
      taken.add(f.name);
    }
  }
  for (const u of decoded.undecided) miss({ field: u.field, ...SETTINGS_REASONS.undecided(u.reason), ...(u.key ? { text: u.key } : {}) });
  if (decoded.unexplained.length) miss({ field: null, ...SETTINGS_REASONS.unexplained, text: String(decoded.unexplained.length) });
  log.debug('settingsFields', 'настройки по карте', { order: b.order, tplid, decoded: fields.length, undecided: decoded.undecided.length, unexplained: decoded.unexplained.length });
  return { fields, byMap: true, decoded: fields.length, undecided: decoded.undecided.length, unexplained: decoded.unexplained.length };
}

/** `href` тегов `<a>` внутри html поля (значение атрибута в двойных кавычках, как пишет структура). */
const HTML_HREF_RE = /(<a\b[^>]*?\shref=")([^"]*)(")/gi;

function unescapeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** Адреса ссылок внутри html поля. */
function htmlHrefs(html) {
  if (!html || !html.includes('<a')) return [];
  return [...html.matchAll(HTML_HREF_RE)].map((m) => unescapeAttr(m[2]));
}

/** [FIX] html поля с переписанными адресами ссылок; `onReason` — для адреса, оставленного на референсе. */
function rewriteHtmlLinks(html, decide, onReason) {
  if (!html || !html.includes('<a')) return html;
  return html.replace(HTML_HREF_RE, (_, pre, raw, post) => {
    const r = decide(unescapeAttr(raw));
    if (r.reason) onReason(r);
    return pre + escapeAttr(r.value) + post;
  });
}

/** Все исходные адреса блока: поля (и ссылки внутри них), ссылки, карточки, кнопки. */
function blockHrefs(b) {
  const out = [];
  for (const f of b.fields ?? []) {
    if (f.href) out.push(f.href);
    out.push(...htmlHrefs(f.html));
  }
  for (const l of b.links ?? []) if (l.href) out.push(l.href);
  for (const c of b.cards ?? []) for (const h of Object.values(c.hrefs ?? {})) if (h) out.push(h);
  for (const btn of b.buttons ?? []) if (btn.href) out.push(btn.href);
  return out;
}

/** Число уникальных адресов блока с `origin` референса — счёт для режима без переписи. */
function countReferenceLinks(b, origin) {
  if (!origin) return 0;
  const seen = new Set();
  for (const h of blockHrefs(b)) {
    try {
      if (new URL(h).origin === origin) seen.add(h);
    } catch {
      /* '#…', 'tel:' и т.п. — не адрес референса */
    }
  }
  return seen.size;
}

/**
 * Копия блока с переписанными адресами: fields[].href, links[].href, cards[].hrefs, buttons[].href.
 * Причины по полям, карточкам (только адрес, который уходит в `li_link`) и кнопкам пишет сам через
 * `miss`; у `links[]` решение кладётся на элемент (`linkReason`, `linkText`) — причину пишет
 * `menuFields`, только если меню собирается. Ссылки внутри html полей и карточек переписываются
 * в самом html ([FIX]).
 * @returns {{ block: object, decided: Map<string, object>, linksOnly: Set<string> }} решения по
 *   уникальным исходным адресам блока и адреса, известные только из `links[]` (не из полей, карточек
 *   и кнопок). Счёт «переписано/оставлено» делает вызывающий по готовой операции — `countBlockLinks`.
 */
export function mapBlockLinks(b, links, miss) {
  const decided = new Map();
  const fromContent = new Set();
  const decide = (href, source = 'content') => {
    if (source === 'content') fromContent.add(href);
    if (!decided.has(href)) decided.set(href, rewriteReferenceUrl(href, links));
    return decided.get(href);
  };
  const fields = (b.fields ?? []).map((f) => {
    const html = rewriteHtmlLinks(f.html, decide, (r) => miss({ field: f.name, code: r.code, reason: r.reason, text: r.text }));
    if (!f.href) return html === f.html ? f : { ...f, html };
    const r = decide(f.href);
    if (r.reason) miss({ field: f.name, code: r.code, reason: r.reason, text: r.text });
    return { ...f, html, href: r.value };
  });
  const linkList = (b.links ?? []).map((l) => {
    if (!l.href) return l;
    const r = decide(l.href, 'links');
    return r.reason ? { ...l, href: r.value, linkCode: r.code, linkReason: r.reason, linkText: r.text } : { ...l, href: r.value };
  });
  const cards = (b.cards ?? []).map((c, i) => {
    const html = Object.fromEntries(Object.entries(c.html ?? {}).map(([key, value]) => [key, rewriteHtmlLinks(value, decide, (r) => miss({ card: i, field: key, code: r.code, reason: r.reason, text: r.text }))]));
    const entries = Object.entries(c.hrefs ?? {});
    if (!entries.length) return c.html ? { ...c, html } : c;
    const hrefs = {};
    entries.forEach(([key, href], n) => {
      const r = decide(href);
      if (r.reason && n === 0) miss({ card: i, field: 'li_link', code: r.code, reason: r.reason, text: r.text });
      hrefs[key] = r.value;
    });
    return { ...c, ...(c.html ? { html } : {}), hrefs };
  });
  const buttons = (b.buttons ?? []).map((btn) => {
    if (!btn.href) return btn;
    const r = decide(btn.href);
    if (r.reason && btn.text) miss({ field: 'buttontitle' + btn.slot, code: r.code, reason: r.reason, text: r.text });
    return { ...btn, href: r.value };
  });
  const linksOnly = new Set([...decided.keys()].filter((href) => !fromContent.has(href)));
  return { block: { ...b, fields, links: linkList, cards, buttons }, decided, linksOnly };
}

/** Путь адреса без домена (для причины); неразборчивый адрес — как есть, обрезанный. */
function pathOf(href) {
  try {
    return new URL(href).pathname.slice(0, 40);
  } catch {
    return String(href).slice(0, 40);
  }
}

/**
 * [FIX] Счёт ссылок блока по готовой операции: «переписано» и «оставлено» — только адреса, которые
 * лежат в полях или карточках операции (раньше считались все решения, и ссылка, вырезанная из
 * текста, попадала в «переписано»). Адрес референса, известный только из `links[]` и не попавший в
 * операцию, получает причину `outsideFields`, если его не взяло меню блока (`menuBuilt`: у меню
 * свои причины — дубли, нет поля).
 * @returns {{ rewritten: number, kept: number, lost: {field: null, reason: string, text: string}[] }}
 */
export function countBlockLinks(record, decided, linksOnly, { menuBuilt = false } = {}) {
  const out = JSON.stringify(record ?? {});
  const has = (value) => {
    if (typeof value !== 'string' || !value) return false;
    const json = JSON.stringify(value).slice(1, -1);
    return out.includes(json) || out.includes(JSON.stringify(escapeAttr(value)).slice(1, -1));
  };
  let rewritten = 0;
  let kept = 0;
  const lost = [];
  for (const [href, r] of decided) {
    if (!r.changed && !r.reason) continue;
    if (has(r.value)) {
      if (r.changed) rewritten += 1;
      else kept += 1;
      continue;
    }
    if (linksOnly.has(href) && !menuBuilt) lost.push({ field: null, ...LINK_REASONS.outsideFields, text: pathOf(href) });
  }
  return { rewritten, kept, lost };
}

/**
 * План операций по структуре страницы.
 * @param {object} structure   `structure/<name>.json` слепка
 * @param {object} ctx         { page, slug, catalogs: {tplid → запись каталога}, imageMap: {src → файл},
 *                               startAfter, styles, substitutes: {tplid источника → tplid замены},
 *                               zone: 'all'|'content'|'header'|'footer', links: null | {origin, pageUrl, index},
 *                               label: метка карты сайта для имени плана }
 * @returns {{ plan: object, skipped: object[], unmapped: object[], substituted: object[], zoneFiltered: number, links: object }}
 */
export function buildReferencePlan(structure, { page, slug, catalogs, settingsMaps = {}, fontAliases = {}, imageMap = {}, startAfter = '', styles = true, substitutes = {}, zone = 'all', links = null, label = null }) {
  const ops = [];
  const skipped = [];
  const unmapped = [];
  const substituted = [];
  const settingsTotals = { decoded: 0, undecided: 0, unexplained: 0, byMap: 0, byRules: 0 };
  const mapsInUse = Object.values(settingsMaps ?? {}).some(Boolean);
  let styledTotal = 0;
  let buttonsTotal = 0;
  let videosTotal = 0;
  let zoneFiltered = 0;
  const linkTotals = { rewritten: 0, kept: 0, referenceLinks: 0 };
  let referenceOrigin = null;
  if (!links) {
    try {
      referenceOrigin = new URL(structure.url).origin;
    } catch {
      referenceOrigin = null;
    }
  }

  for (const b of structure.blocks ?? []) {
    if (zone !== 'all' && (b.zone ?? 'content') !== zone) {
      zoneFiltered += 1;
      continue;
    }
    // Замена шаблона объявляется владельцем явно (`--substitute`); таблиц соответствий в коде нет.
    const sourceTplid = String(b.tplid || '');
    const tplid = substitutes[sourceTplid] ?? sourceTplid;
    const isSubstituted = tplid !== sourceTplid;
    const skip = (why) => skipped.push({ order: b.order, tplid, ...why });
    const miss = (entry) => unmapped.push({ order: b.order, tplid, ...entry });
    // Причины и счётчики переписи ссылок фиксируются, только если блок строится (правило
    // «Choosing one value…»): у блока, ушедшего в пропуски, адреса в план не попадают.
    const linkMisses = [];
    let linkDecisions = null;
    let menuBuilt = false;
    let blockButtons = 0;
    let blockVideos = 0;
    // Счётчики записанного — только у блока, который действительно ушёл в план, и только по
    // адресам, которые лежат в его операции ([FIX] countBlockLinks).
    const commitLinks = (record) => {
      unmapped.push(...linkMisses.map((e) => ({ order: b.order, tplid, ...e })));
      if (linkDecisions) {
        const counted = countBlockLinks(record, linkDecisions.decided, linkDecisions.linksOnly, { menuBuilt });
        linkTotals.rewritten += counted.rewritten;
        linkTotals.kept += counted.kept;
        unmapped.push(...counted.lost.map((e) => ({ order: b.order, tplid, ...e })));
        log.debug('buildReferencePlan', '[FIX] ссылки блока в операции', { order: b.order, rewritten: counted.rewritten, kept: counted.kept, lost: counted.lost.length, decided: linkDecisions.decided.size });
      }
      if (!links) linkTotals.referenceLinks += countReferenceLinks(b, referenceOrigin);
      buttonsTotal += blockButtons;
      videosTotal += blockVideos;
    };
    if (!tplid || tplid === '?') {
      skip(SKIP_REASONS.noTplid);
      continue;
    }
    if (tplid === ZERO_TPLID) {
      skip(SKIP_REASONS.zeroBlock);
      continue;
    }
    const cat = catalogs[tplid];
    if (!cat) {
      skip(isSubstituted ? SKIP_REASONS.substituteCatalogMissing(tplid) : SKIP_REASONS.catalogMissing);
      continue;
    }
    if (cat.available === false) {
      skip(isSubstituted ? SKIP_REASONS.substituteUnavailable : SKIP_REASONS.templateUnavailable);
      continue;
    }
    // Замена засчитывается только после того, как шаблон-замена прошёл проверки: иначе итог
    // команды сообщал бы «замен: N» про блоки, которые на деле ушли в пропуски.
    if (isSubstituted) {
      log.info('buildReferencePlan', 'замена шаблона', { order: b.order, from: sourceTplid, to: tplid });
      substituted.push({ order: b.order, from: sourceTplid, to: tplid });
    }
    let block = b;
    if (links) {
      linkDecisions = mapBlockLinks(b, links, (e) => linkMisses.push(e));
      block = linkDecisions.block;
    }

    // HTML-блок: код без <script> одной операцией newRecord с полем code.
    if (b.code && tplid === '131') {
      if (b.code.code.length > T123_CODE_LIMIT) {
        skip(CODE_REASONS.tooLarge);
        continue;
      }
      if (b.code.scripts > 0) miss({ field: 'code', ...CODE_REASONS.scriptsRemoved, text: String(b.code.scripts) });
      const t123 = { tplid: '131', fields: [], code: b.code.code };
      ops.push({ id: `b${b.order}`, newRecord: t123, hidden: 'n' });
      commitLinks(t123);
      log.debug('buildReferencePlan', 'HTML-блок', { order: b.order, bytes: b.code.code.length, scripts: b.code.scripts });
      continue;
    }

    // [FIX] Снимок свежего блока не отдаёт пустые поля (у 480 пуст `buttontitle`), поэтому состав
    // полей шаблона — вкладки каталога плюс полный список `tplFields` (сверка P00, 2026-09-23).
    // Очистка стоковых значений по-прежнему идёт только по вкладке «Контент».
    const allowed = new Set([...(cat.tabs?.content ?? []), ...(cat.tabs?.settings ?? []), ...(cat.tplFields ?? [])]);
    if (cat.tplFields?.length) log.debug('buildReferencePlan', '[FIX] поля шаблона с tplFields', { order: b.order, tplid, tabs: (cat.tabs?.content ?? []).length + (cat.tabs?.settings ?? []).length, tplFields: cat.tplFields.length });
    const linkAllowed = linkAllowedFor(cat, allowed);
    const tplFields = new Set(cat.tplFields ?? []);
    const fields = [];
    const images = [];
    const cards = [];
    const push = (name, value) => {
      const existing = fields.find((f) => f.name === name);
      if (existing) existing.value = value;
      else fields.push({ name, value });
    };

    for (const f of block.fields ?? []) {
      if (allowed.has(f.name)) push(f.name, f.html ?? f.text);
      else miss({ field: f.name, ...FIELD_REASONS.notInCatalog, text: String(f.text ?? '').slice(0, 40) });
      if (!f.href) continue;
      const lf = linkFieldFor(f.name, linkAllowed);
      if (lf) push(lf, f.href);
      else miss({ field: f.name, ...FIELD_REASONS.linkWithoutField, text: String(f.href).slice(0, 40) });
    }

    // Кнопки без field=: текст и ссылка в поля кнопки по слоту; поле с field= главнее.
    let buttonsWritten = 0;
    for (const btn of block.buttons ?? []) {
      const title = 'buttontitle' + btn.slot;
      if ((block.fields ?? []).some((f) => f.name === title)) continue;
      if (!btn.text) {
        miss({ field: title, ...BUTTON_REASONS.noText(btn.slot) });
        continue;
      }
      if (!allowed.has(title)) {
        miss({ field: title, ...BUTTON_REASONS.noField(btn.slot), text: btn.text.slice(0, 40) });
        continue;
      }
      push(title, btn.html || btn.text);
      buttonsWritten += 1;
      if (!btn.href) continue;
      const lf = linkFieldFor(title, linkAllowed);
      if (lf) push(lf, btn.href);
      else miss({ field: title, ...BUTTON_REASONS.noLinkField(btn.slot), text: String(btn.href).slice(0, 40) });
    }
    if ((block.buttons ?? []).length) log.debug('buildReferencePlan', 'кнопки блока', { order: b.order, written: buttonsWritten, total: block.buttons.length });
    blockButtons = buttonsWritten;

    // Фон-видео: адрес видео — в поле шаблона по виду; адрес не логируется.
    if (block.video) {
      const vf = VIDEO_FIELD_BY_KIND[block.video.kind];
      if (vf && (allowed.has(vf) || tplFields.has(vf))) {
        push(vf, block.video.url);
        blockVideos = 1;
      } else {
        miss({ field: vf ?? 'video', ...VIDEO_REASONS.noField, text: block.video.kind });
      }
      log.debug('buildReferencePlan', 'видео блока', { order: b.order, kind: block.video.kind, field: vf ?? null });
    }

    for (const im of block.images ?? []) {
      if (!im.field) {
        miss({ field: null, ...FIELD_REASONS.imageNoField });
        continue;
      }
      if (!allowed.has(im.field)) {
        miss({ field: im.field, ...FIELD_REASONS.imageFieldNotInCatalog });
        continue;
      }
      const file = imageMap[im.src];
      if (file) images.push({ field: im.field, file });
      else miss({ field: im.field, ...FIELD_REASONS.imageNotFetched });
    }

    // Соцссылки — содержимое блока: с ними блок 212 проходит путь создания, а не пропуска.
    // Мессенджеры 898 — своя форма элементов soclinks с `type`.
    const soc = (block.messengers ?? []).length ? messengerField(block, cat, miss) : soclinksField(block, cat, miss);
    if (soc) push(soc.name, soc.value);

    // Пункты меню — тоже содержимое: блок 794 перестаёт быть пропуском.
    const menu = menuFields(block, cat, miss, { substituted: isSubstituted });
    menuBuilt = menu.fields.length > 0 || menu.cards.length > 0;
    for (const f of menu.fields) push(f.name, f.value);
    if (menu.cards.length) cards.push(...menu.cards);

    // `linkhook` — служебное поле, а не содержимое: оно есть у всплывающих форм (702) и галереи
    // (746), у которых переносимых полей нет и которые обязаны остаться в `skipped`. Поэтому его,
    // как и стили, дописываем после проверки содержимого, а не здесь.
    const hookFields = b.linkhook && allowed.has('linkhook') ? [{ name: 'linkhook', value: b.linkhook }] : [];

    if ((block.cards ?? []).length) {
      if (!allowed.has('list')) {
        miss({ field: 'list', ...FIELD_REASONS.cardsNoList });
      } else {
        const textKeys = cardTextKeys(cat);
        log.debug('buildReferencePlan', 'текстовые ключи карточек', { order: b.order, tplid, textKeys });
        block.cards.forEach((c, i) => {
          const card = { li_title: '', li_descr: '', li_img: '', 'li-tubutton': '', li_imgalt: '' };
          for (const k of textKeys) card[k] = c.html?.[k] ?? c.fields?.[k] ?? '';
          for (const k of Object.keys(c.fields ?? {})) {
            if (textKeys.includes(k)) continue;
            miss({ card: i, field: k, ...(k === 'li_buttontitle' ? CARD_REASONS.noButton : FIELD_REASONS.cardFieldNotTransferred) });
          }
          // Ссылка карточки уходит внутри `list` ключом `li_link` — сервер его сохраняет
          // (проба на черновой, 2026-09-22). Хранит ли его шаблон, знает каталог (`cardKeys`).
          // Карточка хранит один адрес (`li_link`), поэтому берётся первая ссылка; остальные
          // получают свою причину — молчаливая потеря нарушала бы таксономию пропусков.
          const hrefEntries = Object.entries(c.hrefs ?? {});
          const [usedKey, href] = hrefEntries[0] ?? [];
          if (href) {
            if ((cat.cardKeys ?? []).includes('li_link')) card.li_link = href;
            else miss({ card: i, field: 'li_link', ...CARD_REASONS.noLink, text: String(href).slice(0, 40) });
          }
          for (const [key, extra] of hrefEntries.slice(1)) {
            miss({ card: i, field: key, ...CARD_REASONS.oneLink(usedKey), text: String(extra).slice(0, 40) });
          }
          const src = c.images?.li_img;
          if (src && imageMap[src]) images.push({ card: i, field: 'li_img', file: imageMap[src] });
          else if (src) miss({ card: i, field: 'li_img', ...FIELD_REASONS.cardImageNotFetched });
          cards.push(card);
        });
      }
    }

    // Форма: поля ввода — полем forminputs, сообщение об успехе, адрес перехода
    // (formmsgurl, только с флагом formContent); получатели заявок не переносятся никогда.
    let formContent = false;
    if (b.hasForm) {
      const form = b.form ?? null;
      if (!form) {
        miss({ field: null, ...FORM_REASONS.noForm });
      } else {
        const items = formCards(form, miss);
        if (items.length) {
          if (allowed.has('forminputs')) push('forminputs', JSON.stringify(items));
          else miss({ field: 'forminputs', ...FORM_REASONS.noList, text: String(items.length) });
        }
        for (const [name, value] of [['formtitlesuccess', form.successTitle], ['formmsgsuccess', form.successMessage]]) {
          if (!value) continue;
          if (allowed.has(name)) push(name, value);
          else miss({ field: name, ...FORM_REASONS.noField(name), text: String(value).slice(0, 40) });
        }
        if (form.successUrl) {
          let url = form.successUrl;
          if (links) {
            const r = rewriteReferenceUrl(url, links);
            url = r.value;
            if (r.reason) miss({ field: 'formmsgurl', code: r.code, reason: r.reason, text: r.text });
          }
          if (allowed.has('formmsgurl')) {
            push('formmsgurl', url);
            formContent = true;
          } else miss({ field: 'formmsgurl', ...FORM_REASONS.noField('formmsgurl'), text: pathOf(url) });
        }
      }
      miss({ field: 'receivers', ...FORM_REASONS.receivers });
    }

    // Оформление считается до очистки стоковых, но дописывается в поля последним: стили сами по
    // себе блок не создают (пустой блок без содержимого остаётся пропуском или разделителем).
    // Форма разделителя — не «оформление» из --no-styles: без неё 796 рисует чужую фигуру.
    // Настройки — по карте влияния исходного шаблона, иначе правилами styleFields.
    const settingsMisses = [];
    const settings = styles
      ? settingsFields(b, { cat, map: settingsMaps[sourceTplid] ?? null, sourceTplid, tplid, isSubstituted, miss: (e) => settingsMisses.push(e), explain: mapsInUse })
      : { fields: [], byMap: false, decoded: 0, undecided: 0, unexplained: 0 };
    const shape = shapeFields(b, allowed, miss);
    const styled = [...applyFontAliases(settings.fields, fontAliases).filter((f) => !shape.some((s) => s.name === f.name)), ...shape];
    const commitSettings = () => {
      for (const e of settingsMisses) miss(e);
      if (!styles) return;
      if (settings.byMap) settingsTotals.byMap += 1;
      else settingsTotals.byRules += 1;
      settingsTotals.decoded += settings.decoded;
      settingsTotals.undecided += settings.undecided;
      settingsTotals.unexplained += settings.unexplained;
    };

    // [FIX] Поля вкладки «Контент», которых у референса нет, иначе остаются со стоковыми значениями
    // шаблона Tilda («Get your lesson», картинка обложки): пишем их пустой строкой по каталогу
    // (2026-09-22, приёмка сборки). Вкладка «Настройки» (цвета, отступы) не трогается.
    const blanked = [];
    if (fields.length || cards.length || images.length) {
      const present = new Set([...fields.map((f) => f.name), ...images.filter((im) => im.card === undefined).map((im) => im.field)]);
      for (const name of cat.tabs?.content ?? []) {
        if (RECORD_SKIP_FIELDS.has(name) || name === 'list' || present.has(name)) continue;
        if (cards.length && (name === 'btitle' || name === 'bdescr')) continue; // войдут в поля списка
        const stock = cat.defaults?.[name];
        if (stock === undefined || stock === null || stock === '') continue;
        // Картинку голым `<поле>=` сервер не сбрасывает — только флагом `<поле>-del=yes`
        // (isFieldControl в редакторе: img, img_alt, img-del, img-tuinfo-*; проверено 2026-09-22).
        if (/^https?:\/\//.test(String(stock)) && /img|image|logo|icon/i.test(name)) push(`${name}-del`, 'yes');
        else push(name, '');
        blanked.push(name);
      }
      if (blanked.length) log.debug('buildReferencePlan', '[FIX] стоковые поля очищены', { order: b.order, tplid, fields: blanked });
    }

    if (fields.length === 0 && cards.length === 0 && images.length === 0) {
      // [FIX] Разделитель/отступ (у шаблона во вкладке «Контент» только служебные поля) создаётся
      // пустым — иначе теряются расстояния между секциями (2026-09-22, приёмка). Блоки, у которых
      // содержимое есть, но не легло в поля (меню, галерея, соцсети), остаются пропуском.
      const contentFields = (cat.tabs?.content ?? []).filter((name) => !RECORD_SKIP_FIELDS.has(name));
      if (contentFields.length === 0 && !b.hasForm) {
        const divider = { tplid, fields: [...styled, ...hookFields] };
        ops.push({ id: `b${b.order}`, newRecord: divider, hidden: 'n' });
        commitLinks(divider);
        commitSettings();
        log.debug('buildReferencePlan', '[FIX] разделитель без полей создаётся пустым', { order: b.order, tplid });
        continue;
      }
      skip(contentFields.length ? SKIP_REASONS.contentOutsideFields : SKIP_REASONS.noTransferableFields);
      continue;
    }
    fields.push(...styled, ...hookFields);
    const op = { id: `b${b.order}`, newRecord: { tplid, fields } };
    if (formContent) op.formContent = 'reference';
    if (cards.length) op.newRecord.cards = cards;
    if (images.length) op.newRecord.images = images;
    op.hidden = 'n';
    ops.push(op);
    commitLinks(op.newRecord);
    commitSettings();
    const breaks = fields.filter((f) => String(f.value).includes('<br>')).length;
    styledTotal += styled.length;
    log.debug('buildReferencePlan', 'блок', { order: b.order, tplid, fields: fields.length, images: images.length, cards: cards.length, blanked: blanked.length, breaks, styled: styled.length, soclinks: (b.soclinks ?? []).length });
  }

  // По метке имя страницы слепка в план и логи не попадает.
  const source = label ?? structure.name;
  const plan = { page: String(page), name: `reference:${slug}/${source}`, startAfter: String(startAfter || ''), ops };
  const linkSummary = links ? { rewritten: linkTotals.rewritten, kept: linkTotals.kept } : { rewritten: 0, kept: 0, referenceLinks: linkTotals.referenceLinks };
  log.info('buildReferencePlan', 'план построен', { page: String(page), source, ops: ops.length, skipped: skipped.length, unmapped: unmapped.length, styles, styled: styledTotal, substituted: substituted.length, zone, zoneFiltered, buttons: buttonsTotal, videos: videosTotal, settings: settingsTotals, ...linkSummary });
  return { plan, skipped, unmapped, substituted, zoneFiltered, links: linkSummary, buttons: buttonsTotal, videos: videosTotal, settings: settingsTotals };
}

export function planFileName(slug, source, page) {
  return `reference-${slug}-${source}-${page}.json`;
}

function planError(message, code, exitCode) {
  return new ToolError(code, message, { exitCode });
}

/**
 * Параметры сборки по метке карты сайта: структура-источник, зона, страница, замены, перепись ссылок.
 * `HDR`/`FTR` собираются из шапки/подвала `P00` (они одинаковы на всех страницах референса).
 */
export function resolveLabelSource({ slug, source, page, zone, substitutes, baseDir }) {
  const site = readSite(slug, { baseDir });
  if (!site) throw planError(msg('referencePlan.noSite', { slug }), 'NO_SITE', 1);
  const entry = resolveSource(site, source);
  if (!entry) throw planError(msg('referencePlan.unknownLabel', { source, slug }), 'UNKNOWN_LABEL', 2);
  if (entry.missing) throw planError(msg('referencePlan.labelMissing', { source, slug }), 'LABEL_MISSING', 1);
  if (zone !== undefined && zone !== null) throw planError(msg('referencePlan.zoneWithLabel'), 'ZONE_WITH_LABEL', 2);
  let origin = entry;
  if (entry.role !== 'content') {
    origin = resolveSource(site, 'P00');
    if (!origin || origin.missing || origin.role !== 'content') origin = site.pages.find((p) => p.role === 'content' && !p.missing);
    if (!origin) throw planError(msg('referencePlan.noStructureInSite', { slug, source }), 'NO_STRUCTURE', 1);
  }
  const pageid = page ?? entry.pageid;
  if (!pageid) throw planError(msg('referencePlan.noPageid', { source, slug }), 'NO_PAGEID', 1);
  if (page && entry.pageid && String(page) !== String(entry.pageid)) {
    throw planError(msg('referencePlan.pageMismatch', { page, source, pageid: entry.pageid }), 'PAGE_MISMATCH', 2);
  }
  const manifest = readManifest(slug, { baseDir });
  if (!manifest) throw planError(msg('referencePlan.noManifest', { slug }), 'NO_MANIFEST', 1);
  return {
    structureName: origin.name,
    zone: entry.role,
    page: String(pageid),
    substitutes: { ...(site.substitutes ?? {}), ...substitutes },
    links: { origin: new URL(manifest.url).origin, pageUrl: origin.url, index: buildLinkIndex(site) },
  };
}

/**
 * Собрать план по слепку и каталогу и записать его в файл (по умолчанию `<папка сайта>/plans/`).
 * `source` — имя страницы слепка (разовая сборка) или метка карты сайта (`P07`, `HDR`, `FTR`):
 * по метке зона, страница, замены и перепись ссылок берутся из `site.json`.
 */
export function generateReferencePlan(params) {
  const { slug, source, out } = params;
  const { plan, built, resolved, structure, byLabel } = prepareReferencePlan(params);
  const { skipped, unmapped, substituted, zoneFiltered, links, settings } = built;
  const subs = resolved.substitutes;
  for (const from of Object.keys(subs)) {
    if (!substituted.some((x) => x.from === from)) log.warn('generateReferencePlan', 'замена указана, но блоков такого шаблона в зоне нет', { from, to: subs[from] });
  }
  let hint;
  const zones = structure.counts?.zones;
  if (!byLabel && resolved.zone === 'all' && (zones?.header || zones?.footer)) {
    hint = msg('referencePlan.hint.headerFooter');
    log.warn('generateReferencePlan', messageText(hint), { header: zones.header, footer: zones.footer });
  }

  const path = out || join(plansDir(), planFileName(slug, source, resolved.page));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  log.info('generateReferencePlan', 'план записан', { path, ops: plan.ops.length, blocks: structure.blocks.length, zone: resolved.zone, zoneFiltered });
  const result = { path, ops: plan.ops.length, blocks: structure.blocks.length, skipped, unmapped, substituted, zone: resolved.zone, zoneFiltered, links, settings };
  if (byLabel) result.label = source;
  if (hint) result.hint = hint;
  return result;
}

/** src → абсолютный путь картинки: план исполняется из любой текущей папки. */
export function absoluteImageMap(images, snapshotRoot) {
  return Object.fromEntries(Object.entries(images ?? {}).map(([src, rel]) => [src, resolve(snapshotRoot, rel)]));
}

/**
 * Сборка плана по слепку и каталогу без записи файла: общая основа
 * `generateReferencePlan`, сверки (`reference compare`) и дописывания (`reference plan --update`).
 * @returns {{ plan: object, built: object, resolved: object, structure: object, byLabel: boolean }}
 */
export function prepareReferencePlan({ slug, source, page, startAfter, baseDir, catalogDir, styles = true, substitutes = {}, zone }) {
  const byLabel = isLabel(source);
  const resolved = byLabel
    ? resolveLabelSource({ slug, source, page, zone, substitutes, baseDir })
    : { structureName: source, zone: zone ?? 'all', page, substitutes, links: null };
  const paths = refPaths(slug, { baseDir });
  const structPath = join(paths.structure, `${resolved.structureName}.json`);
  if (!existsSync(structPath)) {
    throw planError(msg('referencePlan.structureNotFound', { name: byLabel ? source : resolved.structureName, slug }), 'NO_STRUCTURE', 1);
  }
  const structure = JSON.parse(readFileSync(structPath, 'utf8'));
  const manifest = readManifest(slug, { baseDir });
  const imageMap = absoluteImageMap(manifest?.images, paths.root);
  const subs = resolved.substitutes;
  const tplids = tplidsFromStructure(structure);
  const catalogs = loadCatalogs([...tplids, ...Object.values(subs)], { baseDir: catalogDir });
  const settingsMaps = Object.fromEntries(tplids.map((t) => [t, loadSettingsMap(t, { baseDir: catalogDir })]));
  // Замена своего шрифта пресетом — из разбора оформления проекта (`reference project`), если он есть.
  const stylePath = join(paths.root, 'project-style.json');
  const fontAliases = existsSync(stylePath) ? JSON.parse(readFileSync(stylePath, 'utf8')).fontAliases ?? {} : {};
  const built = buildReferencePlan(structure, {
    page: resolved.page, slug, catalogs, settingsMaps, fontAliases, imageMap, startAfter, styles, substitutes: subs,
    zone: resolved.zone, links: resolved.links, label: byLabel ? source : null,
  });
  return { plan: built.plan, built, resolved, structure, byLabel };
}
