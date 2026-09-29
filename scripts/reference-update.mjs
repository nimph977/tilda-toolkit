/**
 * `reference plan --source <метка> --update` — план дописывания уже собранной страницы метки:
 * план сборки по метке сравнивается с живыми блоками
 * страницы (`listRecords` + `readRecordFields`), результат — операции `field`/`listSet`/`newRecord`
 * в `scripts/plans/reference-<slug>-<метка>-update.json`. Блоки не пересоздаются, `pageid` не меняется.
 * Драйвер приходит снаружи — модуль не импортирует `lib/browser.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { repoRoot } from './lib/paths.mjs';
import { buildUpdateOps } from './lib/plan-update.mjs';
import { prepareReferencePlan } from './reference-plan.mjs';
import { normalizeFieldValue } from './apply-plan.mjs';

const log = createLogger('reference-update');

/** Пауза между чтениями блоков — темп чтений цикла (`READ_DELAY_MS`). */
export const UPDATE_READ_DELAY_MS = 2500;

/**
 * @param {{ call: Function }} driver
 * @param {{ slug: string, label: string, pageid: string, out?: string, styles?: boolean, baseDir?: string, catalogDir?: string, sleep?: Function, delayMs?: number }} params
 */
export async function updateReferencePlan(driver, { slug, label, pageid, out, styles = true, baseDir, catalogDir, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = UPDATE_READ_DELAY_MS }) {
  const { plan, built } = prepareReferencePlan({ slug, source: label, baseDir, catalogDir, styles });
  const records = await driver.call('listRecords', []);
  const visible = records.filter((r) => !r.hidden && r.hidden !== 'y');
  const live = [];
  for (const [i, r] of visible.entries()) {
    if (i > 0) await sleep(delayMs);
    const fields = await driver.call('readRecordFields', [pageid, r.recordid]);
    live.push({ recordid: String(r.recordid), tplid: String(r.tplid ?? r.type ?? ''), fields });
  }
  const upd = buildUpdateOps(plan.ops, live, { normalize: normalizeFieldValue });
  const updatePlan = { page: String(pageid), name: `reference:${slug}/${label}:update`, startAfter: upd.startAfter, ops: upd.ops };
  const path = out || join(repoRoot(), 'scripts', 'plans', `reference-${slug}-${label}-update.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(updatePlan, null, 2) + '\n', 'utf8');
  const unmapped = [...upd.unmapped, ...(built.unmapped ?? [])];
  log.info('updateReferencePlan', 'план дописывания', { label, ops: upd.ops.length, fields: upd.stats.fields, lists: upd.stats.lists, created: upd.stats.created, unmapped: unmapped.length });
  return { label, path, ops: upd.ops.length, fields: upd.stats.fields, lists: upd.stats.lists, created: upd.stats.created, unmapped };
}
