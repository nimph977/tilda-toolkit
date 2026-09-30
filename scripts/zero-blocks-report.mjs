/**
 * Отчёт по каждому Zero Block (тип 396) опубликованной страницы:
 * порядковый номер, recid, высота, состав элементов, признак формы, видимый текст.
 *
 * Запуск: node scripts/zero-blocks-report.mjs <путь.html>
 * Пример: node scripts/zero-blocks-report.mjs 200002
 */
import { splitRecords, zeroSummary, resolveHtmlArg, readHtml, ZERO_TYPE } from './lib/html-blocks.mjs';
import { createLogger } from './lib/log.mjs';

const log = createLogger('zero-blocks-report');

const path = resolveHtmlArg(process.argv);
const blocks = splitRecords(readHtml(path));
const zero = blocks.filter((b) => b.type === ZERO_TYPE);
log.info('main', 'Zero Blocks found', { path, zero: zero.length, records: blocks.length });

console.log(`Zero Blocks on the page: ${zero.length} of ${blocks.length} records\n`);

for (const b of zero) {
  const s = zeroSummary(b);
  const composition = Object.entries(s.typeCounts).sort((a, c) => c[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', ');
  console.log(`--- #${String(b.order).padStart(2)} on the page | rec${b.recid} | height ${s.height} | elements ${s.elemIds.length}${s.hasForm ? ' | FORM' : ''}`);
  console.log(`    composition: ${composition}`);
  console.log(`    text:${s.text.slice(0, 260)}${s.text.length > 260 ? '…' : ''}`);
  console.log();
}
