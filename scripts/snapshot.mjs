/**
 * Снимки блоков «до правки».
 *
 *   site-baseline/zero/<pageid>/<recordid>.json     — модель Zero Block
 *   site-baseline/records/<pageid>/<recordid>.json  — ответ editrecordsettings стандартного блока
 *   site-baseline/snapshots-index.json              — журнал: что, когда, откуда
 *
 * Перезапись существующего файла делается только после копирования старого
 * в <recordid>.<ISO-время>.json. Корень — TILDA_BASELINE_DIR или <репо>/site-baseline.
 *
 * CLI: node scripts/snapshot.mjs save <zero|record> <pageid> <recordid> <файл-с-данными.json> [источник]
 *      node scripts/snapshot.mjs import <файл-дампа.json>   — результат window.__tilda.snapshotPage()
 *      node scripts/snapshot.mjs list <pageid>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { ToolError } from './lib/tool-error.mjs';
import { msg } from './lib/i18n.mjs';
import { baselineDir } from './lib/paths.mjs';

const log = createLogger('snapshot');
const KIND_DIR = { zero: 'zero', record: 'records' };

function root(opts) {
  return (opts && opts.baseDir) || baselineDir();
}

export function snapshotPath({ kind, pageid, recordid }, opts) {
  if (!KIND_DIR[kind]) throw new ToolError('BAD_KIND', msg('snapshot.unknownKind', { kind }));
  return join(root(opts), KIND_DIR[kind], String(pageid), `${recordid}.json`);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function appendIndex(entry, opts) {
  const p = join(root(opts), 'snapshots-index.json');
  let list = [];
  if (existsSync(p)) {
    try {
      list = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      log.warn('appendIndex', 'index is damaged, starting over', { path: p, error: e.message });
    }
  }
  list.push(entry);
  writeFileSync(p, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

/**
 * Сохраняет снимок. Возвращает {path, backup} — backup задан, если старый файл был отодвинут.
 */
export function save({ kind, pageid, recordid, data, source = '' }, opts) {
  const path = snapshotPath({ kind, pageid, recordid }, opts);
  mkdirSync(join(path, '..'), { recursive: true });
  let backup = null;
  const json = JSON.stringify(data, null, 2) + '\n';
  if (existsSync(path)) {
    // Цикл apply переснимает блок при каждом запуске; неизменившийся снимок бэкапа не заслуживает.
    if (readFileSync(path, 'utf8') === json) {
      log.debug('save', 'snapshot unchanged, no backup needed', { path });
    } else {
      backup = path.replace(/\.json$/, `.${stamp()}.json`);
      copyFileSync(path, backup);
      log.info('save', 'old snapshot moved aside', { backup });
    }
  }
  writeFileSync(path, json, 'utf8');
  appendIndex({ kind, pageid: String(pageid), recordid: String(recordid), path: path.replace(root(opts), '').replace(/\\/g, '/'), at: new Date().toISOString(), source, bytes: json.length, backup: backup && basename(backup) }, opts);
  log.info('save', 'snapshot written', { path, bytes: json.length });
  return { path, backup };
}

export function load({ kind, pageid, recordid }, opts) {
  const path = snapshotPath({ kind, pageid, recordid }, opts);
  if (!existsSync(path)) {
    log.error('load', 'snapshot missing', { path });
    throw new ToolError('NO_SNAPSHOT', msg('snapshot.noSnapshot', { path }));
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  log.debug('load', 'snapshot read', { path, keys: Object.keys(data).length });
  return data;
}

/**
 * Раскладывает дамп страницы, снятый браузерным слоем (`window.__tilda.snapshotPage()`),
 * по снимкам блоков и инвентарю. Дамп: {pageid, inventory, zero: {recordid: модель},
 * records: {recordid: {record, tpl, tabs}}, errors}.
 *
 * Возвращает сводку {pageid, zero, records, inventory, errors}.
 */
export function importDump(dump, opts) {
  const pageid = String(dump.pageid);
  if (!pageid || pageid === 'undefined') throw new ToolError('BAD_DUMP', msg('snapshot.dumpNoPageid'));
  const source = `snapshotPage ${dump.at || ''}`.trim();
  let zero = 0;
  let records = 0;
  for (const [recordid, data] of Object.entries(dump.zero || {})) {
    save({ kind: 'zero', pageid, recordid, data, source }, opts);
    zero += 1;
  }
  for (const [recordid, data] of Object.entries(dump.records || {})) {
    save({ kind: 'record', pageid, recordid, data, source }, opts);
    records += 1;
  }
  let inventory = 0;
  if (Array.isArray(dump.inventory) && dump.inventory.length) {
    save({ kind: 'record', pageid, recordid: '_inventory', data: dump.inventory, source }, opts);
    inventory = dump.inventory.length;
  }
  const errors = (dump.errors || []).length;
  if (errors) log.error('importDump', 'some blocks were not read, no snapshots for them', { errors, first: dump.errors[0] });
  log.info('importDump', 'dump unpacked', { pageid, zero, records, inventory, errors });
  return { pageid, zero, records, inventory, errors };
}

/** Актуальные снимки страницы (без резервных копий с меткой времени). */
export function list(pageid, opts) {
  const out = [];
  for (const kind of Object.keys(KIND_DIR)) {
    const dir = join(root(opts), KIND_DIR[kind], String(pageid));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d+|_[a-z]+)\.json$/);
      if (m) out.push({ kind, recordid: m[1], path: join(dir, f) });
    }
  }
  log.debug('list', 'page snapshots', { pageid, count: out.length });
  return out;
}

// ---- CLI ----
if (process.argv[1]?.endsWith('snapshot.mjs')) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'save') {
    const [kind, pageid, recordid, file, source] = rest;
    if (!kind || !pageid || !recordid || !file) {
      log.error('cli', 'arguments missing', { usage: 'save <zero|record> <pageid> <recordid> <file.json> [source]' });
      process.exit(2);
    }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    console.log(JSON.stringify(save({ kind, pageid, recordid, data, source: source || basename(file) })));
  } else if (cmd === 'import') {
    const [file] = rest;
    if (!file) {
      log.error('cli', 'arguments missing', { usage: 'import <dump-file.json> — result of window.__tilda.snapshotPage()' });
      process.exit(2);
    }
    const dump = JSON.parse(readFileSync(file, 'utf8'));
    const summary = importDump(dump);
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.errors ? 1 : 0);
  } else if (cmd === 'list') {
    console.log(JSON.stringify(list(rest[0]), null, 2));
  } else if (cmd) {
    log.error('cli', 'unknown command', { cmd });
    process.exit(2);
  }
}
