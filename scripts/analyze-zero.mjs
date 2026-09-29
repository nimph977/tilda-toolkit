/**
 * Краткая статистика по опубликованной странице: число записей, типы,
 * для каждого Zero Block — число элементов, высота артборда, максимальный z-index.
 *
 * Запуск: node scripts/analyze-zero.mjs <путь.html>
 * Пример: node scripts/analyze-zero.mjs 200002
 */
import { splitRecords, countByType, zeroSummary, resolveHtmlArg, readHtml, ZERO_TYPE } from './lib/html-blocks.mjs';
import { createLogger } from './lib/log.mjs';

const log = createLogger('analyze-zero');

const path = resolveHtmlArg(process.argv);
const blocks = splitRecords(readHtml(path));

console.log(`Всего записей на странице: ${blocks.length}`);
const byType = countByType(blocks);
console.log('По типам:', byType.map(([t, n]) => `${t}:${n}`).join('  '));
log.info('main', 'разбор завершён', { path, records: blocks.length, types: byType.length });

console.log(`\n=== Zero Block (${ZERO_TYPE}) — состав ===`);
for (const b of blocks.filter((x) => x.type === ZERO_TYPE)) {
  const s = zeroSummary(b);
  const composition = Object.entries(s.typeCounts).sort((a, c) => c[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(' ');
  console.log(
    `rec${b.recid}  элементов=${String(s.elemIds.length).padStart(3)}  высота=${String(s.height).padStart(4)}  z-max=${String(s.zMax).padStart(3)}  ${composition}`
  );
  const texts = [...b.chunk.matchAll(/<div class="tn-atom"[^>]*>([^<]{4,60})</g)].map((m) => m[1].trim()).slice(0, 2);
  if (texts.length) console.log(`         текст: ${texts.join(' | ').slice(0, 90)}`);
}
