/**
 * Декодирует HTML-сущности так же, как textarea в браузерном слое: `editrecordsettings`
 * отдаёт значения закодированными, а `saverecord` кодирует их сам (проверено 2026-09-09).
 * Сверять поля можно только после приведения обеих сторон к одному виду.
 */
export function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
