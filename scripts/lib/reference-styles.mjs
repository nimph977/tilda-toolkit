/**
 * Оформление блока из опубликованной разметки Tilda: отступы (`t-rec_pt_NN`/`t-rec_pb_NN`,
 * инлайн `padding-*`), фон (`data-bg-color`, инлайн `background-color`) и типографика из правил
 * `#rec<id> .t<N>__<часть>{…}` внутри `<style>` записи. Только регулярные выражения над chunk
 * записи — без DOM, сети и вычисленных стилей (все нужные значения Tilda пишет в разметку).
 *
 * Ключи `*_typo`, которые принимает сервер (проба на черновой, 2026-09-22): все шесть —
 * `color`, `fontsize`, `fontweight`, `uppercase`, `lineheight`, `widthpx`. Обратно Tilda
 * раскладывает их в правило `#rec<id> .t<N>__<часть>`: `color`, `font-weight`, `text-transform`
 * и `max-width` — в базовое правило, `font-size` и `line-height` — в `@media (min-width:900px)`.
 * Поэтому правила в `min-width`-медиазапросах читаются наравне с базовыми, а `max-width`
 * (мобильные переопределения) отбрасываются: иначе мобильный кегль перекрыл бы десктопный.
 */
import { createLogger } from './log.mjs';

const log = createLogger('reference-styles');

/** Ключи JSON поля `<часть>_typo`, которые переносятся (проверено пробой: сервер принимает все). */
export const TYPO_KEYS = ['color', 'fontsize', 'fontweight', 'uppercase', 'lineheight', 'widthpx'];
/** Часть класса `.tNNN__<часть>` → семейство поля `<семейство>_typo`. */
export const TYPO_PARTS = { title: 'title', descr: 'descr', subtitle: 'subtitle', uptitle: 'subtitle', text: 'text', title2: 'title2', descr2: 'descr2' };

const OPEN_TAG_RE = /^\s*<div\b[^>]*>/i;
const PT_CLASS_RE = /\bt-rec_pt_(\d+)\b/;
const PB_CLASS_RE = /\bt-rec_pb_(\d+)\b/;
const PT_INLINE_RE = /padding-top:\s*(\d+)px/i;
const PB_INLINE_RE = /padding-bottom:\s*(\d+)px/i;
const BG_ATTR_RE = /\bdata-bg-color="([^"]+)"/i;
const BG_INLINE_RE = /background-color:\s*([^;"]+)/i;
const TYPO_RULE_RE = /#rec\d+\s+\.t\d+__(title2|descr2|title|descr|subtitle|uptitle|text)\s*\{([^}]*)\}/gi;
const NARROW_MEDIA_RE = /@media[^{]*max-width[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi;
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` → `#aabbcc`, регистр нижний; не hex (`rgba`, `transparent`, градиент) → null. */
export function normalizeHex(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!HEX_RE.test(v)) return null;
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

/** `{ color, fontsize, fontweight, uppercase, lineheight, widthpx }` из тела CSS-правила; пустой объект, если ничего не распознано. */
export function typoFromDeclarations(body) {
  const out = {};
  for (const decl of String(body ?? '').split(';')) {
    const [prop, ...rest] = decl.split(':');
    const value = rest.join(':').trim().replace(/\s*!important$/i, '');
    switch ((prop || '').trim().toLowerCase()) {
      case 'color': {
        const hex = normalizeHex(value);
        if (hex) out.color = hex;
        break;
      }
      case 'font-size':
        if (/^\d+px$/.test(value)) out.fontsize = value;
        break;
      case 'font-weight':
        if (/^[1-9]00$/.test(value)) out.fontweight = value;
        else if (value === 'bold') out.fontweight = '700';
        break;
      case 'text-transform':
        if (value === 'uppercase') out.uppercase = 'uppercase';
        break;
      case 'line-height':
        if (/^\d+(\.\d+)?(px)?$/.test(value)) out.lineheight = value;
        break;
      case 'max-width':
        if (/^\d+px$/.test(value)) out.widthpx = value;
        break;
      default:
        break;
    }
  }
  return Object.fromEntries(Object.entries(out).filter(([k]) => TYPO_KEYS.includes(k)));
}

/**
 * Оформление одной записи.
 * @param {string} chunk  разметка одной записи из splitRecords
 * @returns {{ paddingTop: string|null, paddingBottom: string|null, bgColor: string|null, typo: Record<string, object> }}
 */
export function extractBlockStyles(chunk) {
  const text = String(chunk ?? '');
  const open = (text.match(OPEN_TAG_RE) || [''])[0];
  const px = (classRe, inlineRe) => {
    const m = open.match(classRe) || open.match(inlineRe);
    return m ? `${m[1]}px` : null;
  };

  const bgAttr = open.match(BG_ATTR_RE);
  const bgInline = open.match(BG_INLINE_RE);
  const bgRaw = bgAttr ? bgAttr[1] : bgInline ? bgInline[1] : null;
  const bgColor = bgRaw ? normalizeHex(bgRaw) : null;
  if (bgRaw && !bgColor) log.warn('extractBlockStyles', 'background not carried over: value is not hex', { raw: String(bgRaw).trim().slice(0, 30) });

  const typo = {};
  for (const m of text.replace(NARROW_MEDIA_RE, ' ').matchAll(TYPO_RULE_RE)) {
    const family = TYPO_PARTS[m[1].toLowerCase()];
    const parsed = typoFromDeclarations(m[2]);
    if (family && Object.keys(parsed).length) typo[family] = { ...(typo[family] || {}), ...parsed };
  }

  const styles = { paddingTop: px(PT_CLASS_RE, PT_INLINE_RE), paddingBottom: px(PB_CLASS_RE, PB_INLINE_RE), bgColor, typo };
  log.debug('extractBlockStyles', 'block styles', { paddingTop: styles.paddingTop, paddingBottom: styles.paddingBottom, bgColor: styles.bgColor, typo: Object.keys(typo) });
  return styles;
}
