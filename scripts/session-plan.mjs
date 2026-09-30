/**
 * Режим реплик: правки из разговора копятся в один план
 * `<папка сайта>/plans/session-<ISO>-<pageid>.json`, на каждую реплику — `prepare` без записи и
 * локальный diff (ноль запросов в Тильду), запись всего разом по явной команде пользователя.
 *
 *   openSession(pageid)          → текущий незакрытый план страницы или новый
 *   stageOp(session, op)         → добавить операцию: тот же адрес и та же операция → замена
 *                                  (WARN), несовместимые операции по одному адресу → STAGE_CONFLICT
 *   diffSession(session)         → prepare во временный каталог + список изменений, без сети
 *   markApplied(session, at)     → план закрыт; следующий stage откроет новый
 *   dropSession(session)         → файл удалён
 *
 * Одиночная срочная правка по-прежнему идёт обычным `apply --plan` — накопление не обязательно.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { attachMessage, messageText, msg } from './lib/i18n.mjs';
import { baselineDir, plansDir, protectedPages } from './lib/paths.mjs';
import { prepare } from './apply-plan.mjs';

const log = createLogger('session-plan');

export const SESSION_PREFIX = 'session-';
/** Виды операций плана — ровно один на операцию (skills/tilda-manager/references/plan-schema.md). */
export const OP_KINDS = ['set', 'field', 'listSet', 'blockSet', 'blockHidden', 'duplicateElement', 'removeElement', 'gallerySet', 'moveBlock', 'setOrder', 'addZero', 'addRecord', 'newRecord'];

export class StageError extends Error {
  constructor(code, message, data = {}) {
    super(messageText(message));
    attachMessage(this, message);
    this.name = 'StageError';
    this.code = code;
    Object.assign(this, data);
  }
}

export function sessionDir(opts = {}) {
  return opts.dir ? resolve(opts.dir) : plansDir();
}

export function sessionName(pageid, at = new Date()) {
  return `${SESSION_PREFIX}${at.toISOString().replace(/[:.]/g, '-')}-${pageid}`;
}

/** Вид операции: единственный ключ из OP_KINDS; отсутствие или два сразу — ошибка формы. */
export function opKind(op) {
  const kinds = OP_KINDS.filter((k) => op && op[k] !== undefined);
  if (kinds.length === 0) throw new StageError('BAD_OP', msg('stage.opKindNone', { kinds: OP_KINDS.join(', ') }));
  if (kinds.length > 1) throw new StageError('BAD_OP', msg('stage.opKindMany', { kinds: OP_KINDS.join(', '), found: kinds.join(', ') }));
  return kinds[0];
}

/** Проверка формы операции до постановки в план (без снимков и сети). */
export function validateOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw new StageError('BAD_OP', msg('stage.opNotObject'));
  const kind = opKind(op);
  const needsBlock = !['setOrder', 'addZero', 'addRecord', 'newRecord'].includes(kind);
  if (needsBlock && (!op.block || (op.block.recordid === undefined && op.block.zeroIndex === undefined))) throw new StageError('BAD_OP', msg('stage.opNeedsBlock', { kind }));
  const needsElem = ['set', 'duplicateElement', 'removeElement', 'gallerySet'].includes(kind);
  if (needsElem && (!op.elem || typeof op.elem !== 'object')) throw new StageError('BAD_OP', msg('stage.opNeedsElem', { kind }));
  if (kind === 'set' && (typeof op.set !== 'object' || !Object.keys(op.set).length)) throw new StageError('BAD_OP', msg('stage.opSetNeedsFields'));
  if (kind === 'field' && (!op.field || !op.field.name)) throw new StageError('BAD_OP', msg('stage.opFieldNeedsName'));
  return kind;
}

/** Адрес операции — блок плюс элемент (или сам блок), без учёта вида операции. */
export function opAddress(op) {
  const kind = opKind(op);
  if (kind === 'setOrder') return 'order';
  if (kind === 'addZero' || kind === 'addRecord') return `create:${op.id || ''}:${JSON.stringify((op[kind] || {}).source || {})}`;
  if (kind === 'newRecord') return `create:${op.id || ''}:new:${(op.newRecord || {}).tplid ?? ''}`;
  const block = op.block.recordid !== undefined ? `rec:${op.block.recordid}` : `zero#${op.block.zeroIndex}`;
  if (kind === 'moveBlock') return `${block}|move`;
  if (kind === 'blockHidden' || kind === 'blockSet' || kind === 'listSet' || kind === 'field') return `${block}|${kind === 'field' ? `field:${op.field.name}` : kind === 'blockSet' ? 'blockSet' : kind === 'listSet' ? 'list' : 'hidden'}`;
  return `${block}|elem:${JSON.stringify(op.elem)}`;
}

/** Несовместимые пары по одному адресу: отказ, а не тихая замена. */
const INCOMPATIBLE = [['removeElement', 'set'], ['removeElement', 'duplicateElement'], ['removeElement', 'gallerySet'], ['set', 'duplicateElement']];
function incompatible(a, b) {
  return INCOMPATIBLE.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeSession(session, opts = {}) {
  const dir = sessionDir(opts);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session.name}.json`);
  writeFileSync(path, JSON.stringify(session, null, 2) + '\n', 'utf8');
  log.debug('writeSession', 'plan written', { path, ops: session.ops.length });
  return path;
}

/** Все планы реплик страницы, новые первыми: [{path, session}]. */
export function listSessions(pageid, opts = {}) {
  const dir = sessionDir(opts);
  if (!existsSync(dir)) return [];
  const suffix = `-${pageid}.json`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(SESSION_PREFIX) && f.endsWith(suffix))
    .sort()
    .reverse()
    .map((f) => ({ path: join(dir, f), session: readJson(join(dir, f)) }));
}

/** Текущий незакрытый план страницы либо новый (создаётся при первом stage). */
export function openSession(pageid, opts = {}) {
  const page = String(pageid);
  if (protectedPages().includes(page)) throw new StageError('PROTECTED_PAGE', msg('stage.protectedPage', { page }));
  const open = listSessions(page, opts).find((s) => !s.session.applied);
  if (open) {
    log.debug('openSession', 'open plan found', { path: open.path, ops: open.session.ops.length });
    return open;
  }
  const at = opts.at || new Date();
  const session = { page, name: sessionName(page, at), createdAt: at.toISOString(), applied: null, ops: [] };
  const path = writeSession(session, opts);
  log.info('openSession', 'new replica plan', { path });
  return { path, session };
}

/**
 * Поставить операцию в план. Возвращает { action: 'added'|'replaced', index }.
 * Тот же адрес и тот же вид: `set` сливается по полям (новые значения поверх старых, WARN на
 * перезаписанное поле), прочие виды заменяются целиком (WARN). Несовместимые виды — STAGE_CONFLICT.
 */
export function stageOp(session, op) {
  const kind = validateOp(op);
  const address = opAddress(op);
  const idx = session.ops.findIndex((x) => opAddress(x) === address);
  if (idx === -1) {
    session.ops.push(op);
    log.info('stageOp', `operation added (${kind})`, { address, ops: session.ops.length });
    return { action: 'added', index: session.ops.length - 1, kind, address };
  }
  const prev = session.ops[idx];
  const prevKind = opKind(prev);
  if (incompatible(prevKind, kind)) {
    log.error('stageOp', 'incompatible operations for one address', { address, prev: prevKind, next: kind });
    throw new StageError('STAGE_CONFLICT', msg('stage.conflict', { address, prevKind, kind }), { address, prev: prevKind, next: kind });
  }
  if (prevKind === 'set' && kind === 'set') {
    const overwritten = Object.keys(op.set).filter((f) => f in prev.set && JSON.stringify(prev.set[f]) !== JSON.stringify(op.set[f]));
    if (overwritten.length) log.warn('stageOp', 'fields were already in the plan - overwritten', { address, fields: overwritten });
    session.ops[idx] = { ...prev, ...op, set: { ...prev.set, ...op.set } };
    log.info('stageOp', 'operation merged with the previous one', { address, fields: Object.keys(op.set) });
    return { action: 'replaced', index: idx, kind, address, overwritten };
  }
  log.warn('stageOp', 'operation for the same address replaced entirely', { address, prev: prevKind, next: kind });
  session.ops[idx] = op;
  return { action: 'replaced', index: idx, kind, address, overwritten: [prevKind] };
}

/** Одна строка на изменение — для diff и итога apply: строка-описание или `Message` (для описаний с текстом). */
export function describePayloads(payloads) {
  return payloads.flatMap((p) =>
    p.kind === 'zero'
      ? (p.changes || []).map((c) => `${p.recordid}[${c.key}].${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
      : p.kind === 'record'
        ? [`${p.recordid}.${p.field} → ${JSON.stringify(String(p.value)).slice(0, 80)}`]
        : p.kind === 'list'
          ? (p.changes || []).map((c) => `${p.recordid} list ${c.op}${c.lid ? ` ${c.lid}` : ''}${c.field ? ` .${c.field}` : ''}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
          : p.kind === 'sort'
            ? (p.moves || []).map((m) => msg('stage.change.position', { recordid: m.recordid, from: m.from, to: m.to }))
            : p.kind === 'block'
              ? [`${p.recordid} blockHidden → ${p.hidden}`]
              : p.mode === 'new'
                ? [msg('stage.change.createFromFields', { id: p.id, tplid: p.tplid, fields: (p.fields || []).length })]
                : [msg('stage.change.createFromSource', { id: p.id, page: p.source.page, recordid: p.source.recordid, tplid: p.tplid })],
  );
}

/**
 * Локальный diff: prepare во временный каталог (payload страницы не трогается),
 * ноль запросов в Тильду. Нет снимка блока → ошибка prepare (NO_SNAPSHOT): снять `snapshot`.
 */
export function diffSession(session, opts = {}) {
  const baseDir = opts.baseDir || baselineDir();
  const out = opts.out || join(baseDir, 'incoming', 'stage-payload');
  const plan = { page: session.page, ops: session.ops, resStrategy: session.resStrategy };
  if (!session.ops.length) return { ops: 0, payloads: 0, changes: [] };
  const payloads = prepare(plan, { baseDir, out, emitCalls: false });
  const changes = describePayloads(payloads);
  log.info('diffSession', `plan has ${session.ops.length} operations, changes ${changes.length}, not applied`, { payloads: payloads.length });
  return { ops: session.ops.length, payloads: payloads.length, changes };
}

export function markApplied(session, at = new Date().toISOString(), opts = {}) {
  session.applied = at;
  return writeSession(session, opts);
}

export function dropSession(path) {
  if (!existsSync(path)) throw new StageError('NO_SESSION', msg('stage.noSession', { path }));
  rmSync(path);
  log.info('dropSession', 'replica plan removed', { path });
  return path;
}

/** Разбор операции из аргумента команды: JSON-строка либо путь к файлу с операцией или планом. */
export function parseOpArgument(arg) {
  const text = String(arg || '').trim();
  if (!text) throw new StageError('BAD_OP', msg('stage.opRequired'));
  let value;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      value = JSON.parse(text);
    } catch (e) {
      throw new StageError('BAD_OP', msg('stage.opBadJson', { error: e.message }));
    }
  } else {
    if (!existsSync(text)) throw new StageError('BAD_OP', msg('stage.opFileNotFound', { path: text }));
    value = readJson(text);
  }
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.ops)) return value.ops;
  return [value];
}
