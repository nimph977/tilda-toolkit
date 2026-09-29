// Браузерный слой: стандартные блоки и T123 (тип 131). Выполняется ВНУТРИ страницы редактора
// через Playwright MCP: browser_evaluate function = <содержимое этого файла целиком>.
// Ставит API на window.__tilda (совместно с tilda-zero.js) и возвращает статус.
//
// Адаптировано из class TildaPage в JHamidun/claude-skill-tilda
// (MIT, коммит 31eefb5; см. THIRD_PARTY_NOTICES.md), строки 173–235. Метод publish() намеренно
// не перенесён: публикация — отдельное действие с явным подтверждением.
//
//   POST /page/edit/    comm=editrecordsettings&pageid&recordid&tab=settings   → JSON {record, tpl}
//   POST /page/submit/  comm=saverecord&pageid&recordid&onlythisfield=<f>&<f>=<v> → "OK"
//   T123:               comm=saverecord&pageid&projectid&recordid&code=<html>  → "OK"  (без onlythisfield!)
//   POST /page/submit/  comm=addnewrecord&pageid&afterid&beforeid&tplid&with_code → JSON {html, jslibs, csslibs, tplid}
//   POST /page/submit/  comm=deleterecord&pageid&recordid                      → "OK" или пустой ответ
//
// Создание и копирование блоков проверены 2026-09-09. Значения полей приходят HTML-encoded, а saverecord
// кодирует их сам — при копировании значение декодируется, иначе выходит двойное кодирование.
() => {
  const T = (window.__tilda = window.__tilda || {});
  const LOG = (level, fn, msg, data) => console[level](`[tilda-page.${fn}] ${msg}`, data === undefined ? '' : JSON.stringify(data));
  const T123_LIMIT = 25 * 1024;

  T.protectedPages = Array.isArray(T.protectedPages) ? T.protectedPages : null;
  // Allow-список записи (сессия донора): null — списка нет, массив — писать только в эти страницы.
  T.writablePages = Array.isArray(T.writablePages) ? T.writablePages : null;
  // Поля формы. Копия списков из scripts/lib/form-fields.mjs: получатели и `inputs` не
  // пишутся никогда; `formmsgurl` — только с opts.allowFormContent (сборка по референсу).
  T.FORM_LOCKED_FIELDS = ['receivers', 'receivers_names', 'inputs'];
  T.FORM_CONTENT_FIELDS = ['formmsgurl'];
  T.FORM_FIELDS = [...T.FORM_LOCKED_FIELDS, ...T.FORM_CONTENT_FIELDS]; // formname разрешён с 2026-09-21 (подпись заявки)
  const isForbiddenFormField = (name, opts = {}) => T.FORM_LOCKED_FIELDS.includes(String(name)) || (T.FORM_CONTENT_FIELDS.includes(String(name)) && opts.allowFormContent !== true);

  const looksLikeHtml = (text) => /^\s*<|<html|<!doctype/i.test(text.slice(0, 300));

  const post = async (url, params) => {
    const body = new URLSearchParams(params).toString();
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    const text = await r.text();
    if (looksLikeHtml(text)) {
      const head = text.slice(0, 12);
      LOG('error', 'post', 'SESSION_LOST: вместо данных пришёл HTML (<!--tlp--> = страница логина, <!--tpbaa--> = чужой аккаунт)', { url, status: r.status, head });
      throw new Error(`SESSION_LOST ${url} status=${r.status} head=${JSON.stringify(head)}`);
    }
    return { status: r.status, text };
  };

  const assertWritable = (pageid, fn) => {
    if (!Array.isArray(T.protectedPages)) throw new Error('CONFIG_ERROR protected pages are not configured');
    if (T.protectedPages.includes(String(pageid))) {
      LOG('error', fn, 'запись в защищённую страницу запрещена', { pageid, protectedPages: T.protectedPages });
      throw new Error(`PROTECTED_PAGE ${pageid}`);
    }
    if (Array.isArray(T.writablePages) && !T.writablePages.includes(String(pageid))) {
      LOG('error', fn, 'запись разрешена только в явно перечисленные страницы', { pageid, writablePages: T.writablePages });
      throw new Error(`WRITE_NOT_ALLOWED ${pageid}`);
    }
  };
  // Наружу — для слоёв, которые пишут своими запросами (tilda-donor.js).
  T.assertWritable = assertWritable;

  const parseJson = (text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      LOG('error', ctx.fn, 'ответ не JSON', { ...ctx, head: text.slice(0, 120) });
      throw new Error(`BAD_JSON ${ctx.fn} ${ctx.recordid}`);
    }
  };

  /** Декодирует HTML-сущности (поля записи приходят закодированными). */
  const decodeEntities = (s) => {
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    return ta.value;
  };

  /** Настройки блока. tab: 'settings' (по умолчанию) или 'content'. */
  T.getRecord = async (pageid, recordid, tab = 'settings') => {
    pageid = String(pageid || window.pageid);
    LOG('debug', 'getRecord', 'запрос', { pageid, recordid, tab });
    const { text } = await post('/page/edit/', { comm: 'editrecordsettings', pageid, recordid, tab });
    const json = parseJson(text, { fn: 'getRecord', pageid, recordid });
    const rec = json.record || {};
    LOG('info', 'getRecord', 'получено', { recordid, tplid: rec.tplid, fields: Object.keys(rec).length, hasTpl: 'tpl' in json });
    return json;
  };

  /**
   * Схема вкладки «Настройки» шаблона: все поля шаблона из
   * `tpl.fields` (в том числе пустые), общие поля записи и тип, варианты, ключи JSON каждого поля
   * по словарю редактора `edrec__drawUI__getFieldObj` с поправками шаблона `tpl.replaces`.
   * Подписи и картинки вариантов не возвращаются — калибровке нужны только значения.
   */
  T.readSettingsSchema = async (pageid, recordid) => {
    pageid = String(pageid || window.pageid);
    const j = await T.getRecord(pageid, recordid, 'settings');
    if (typeof window.edrec__drawUI__getFieldObj !== 'function') {
      LOG('error', 'readSettingsSchema', 'словарь полей редактора не найден', { recordid });
      throw new Error('NO_FIELD_DICTIONARY: словарь полей редактора не найден');
    }
    const tpl = j.tpl || {};
    const record = j.record || {};
    const names = String(tpl.fields || '').split(',').map((s) => s.trim()).filter((s) => s && !/^\|.*\|$/.test(s));
    for (const n of ['margintop', 'marginbottom', 'screenmin', 'screenmax']) if (!names.includes(n)) names.push(n);
    for (const n of Object.keys(record)) if (!names.includes(n) && !T.RECORD_SKIP_FIELDS.includes(n)) names.push(n);
    let replaces = [];
    try {
      replaces = typeof tpl.replaces === 'string' ? JSON.parse(tpl.replaces || '[]') : tpl.replaces || [];
    } catch (e) {
      LOG('warn', 'readSettingsSchema', 'tpl.replaces не JSON, поправки шаблона не учтены', { recordid, error: String(e.message).slice(0, 80) });
    }
    if (!Array.isArray(replaces)) replaces = Object.values(replaces || {});
    const describe = (name) => {
      let o = window.edrec__drawUI__getFieldObj(name) || {};
      const rep = replaces.find((r) => r && r.field === name);
      if (rep && typeof window.edrec__combineUIWithReplace === 'function') o = window.edrec__combineUIWithReplace(o, rep) || o;
      return {
        name,
        type: String(o.type || ''),
        options: Array.isArray(o.options) ? o.options.filter((x) => x && !x.del).map((x) => String(x.v ?? '')) : null,
        jsonFields: Array.isArray(o.json_fields) ? o.json_fields.map(String) : null,
        mobile: o.mobile || null,
        desktop: o.desktop || null,
      };
    };
    const fields = names.map(describe);
    for (const f of [...fields]) {
      if (f.mobile && !fields.some((x) => x.name === f.mobile)) fields.push({ ...describe(f.mobile), type: f.type, options: f.options, desktop: f.name });
    }
    LOG('info', 'readSettingsSchema', 'схема прочитана', { tplid: record.tplid, fields: fields.length, replaces: replaces.length });
    return { tplid: String(record.tplid || ''), fields };
  };

  /** Записывает одно поле стандартного блока. Несколько полей — только по очереди. */
  T.saveField = async (pageid, recordid, field, value, opts = {}) => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'saveField');
    if (!field || field === 'code') throw new Error('saveField: для code используйте saveT123Code');
    if (T.FORM_CONTENT_FIELDS.includes(String(field)) && opts.allowFormContent === true) LOG('warn', 'saveField', 'поле формы пропущено по флагу formContent', { recordid, field });
    if (isForbiddenFormField(field, opts)) {
      LOG('warn', 'saveField', 'отказ: поле формы не пишется', { recordid, field, path: 'saveField' });
      throw new Error(`FORM_FIELD_REJECTED ${field}`);
    }
    if (/<script/i.test(String(value))) {
      LOG('error', 'saveField', 'отказ: значение содержит <script', { recordid, field });
      throw new Error('SCRIPT_REJECTED');
    }
    LOG('debug', 'saveField', 'запись', { pageid, recordid, field, bytes: String(value).length });
    const { text, status } = await post('/page/submit/', {
      comm: 'saverecord', pageid, recordid, onlythisfield: field, [field]: value,
    });
    if (text.trim() !== 'OK') {
      LOG('error', 'saveField', 'ответ не OK', { pageid, recordid, field, status, body: text.slice(0, 200) });
      throw new Error(`SAVE_FAILED saverecord ${recordid}.${field}: ${text.slice(0, 200)}`);
    }
    LOG('info', 'saveField', 'OK', { pageid, recordid, field });
    return 'OK';
  };

  /**
   * Полный saverecord без onlythisfield — так редактор сохраняет блоки-списки:
   * fields — массив {name, value} в порядке формы содержимого (повторяющиеся имена допустимы),
   * тело собирается здесь и уходит одним запросом. Guard'ы: защищённая страница, поля формы
   * `<script` в любом значении. Возвращает 'OK'.
   */
  T.saveRecordFull = async (pageid, recordid, fields, opts = {}) => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'saveRecordFull');
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('saveRecordFull: нужен массив полей {name, value}');
    const names = fields.map((f) => String(f.name));
    const forbidden = names.filter((n) => isForbiddenFormField(n, opts));
    const allowed = names.filter((n) => T.FORM_CONTENT_FIELDS.includes(n) && opts.allowFormContent === true);
    if (allowed.length) LOG('warn', 'saveRecordFull', 'поля формы пропущены по флагу formContent', { recordid, fields: allowed });
    if (forbidden.length) {
      LOG('warn', 'saveRecordFull', 'отказ: поля формы не пишутся', { recordid, fields: forbidden, path: 'saveRecordFull' });
      throw new Error(`FORM_FIELD_REJECTED ${forbidden.join(', ')}`);
    }
    if (fields.some((f) => /<script/i.test(String(f.value)))) {
      LOG('error', 'saveRecordFull', 'отказ: значение содержит <script', { recordid });
      throw new Error('SCRIPT_REJECTED');
    }
    const params = new URLSearchParams();
    for (const f of fields) if (f.name !== 'comm' && f.name !== 'pageid' && f.name !== 'recordid') params.append(f.name, f.value == null ? '' : String(f.value));
    params.append('recordid', recordid);
    params.append('pageid', pageid);
    params.append('comm', 'saverecord');
    const body = params.toString();
    LOG('debug', 'saveRecordFull', 'запись', { pageid, recordid, fields: fields.length, bytes: body.length, head: body.slice(0, 200) });
    if (body.length > 100 * 1024) LOG('warn', 'saveRecordFull', 'тело больше 100 КБ', { bytes: body.length });
    const r = await fetch('/page/submit/', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
    const text = await r.text();
    if (/^\s*<|<html|<!doctype/i.test(text.slice(0, 300))) {
      LOG('error', 'saveRecordFull', 'SESSION_LOST: вместо данных пришёл HTML', { recordid, status: r.status });
      throw new Error(`SESSION_LOST /page/submit/ status=${r.status}`);
    }
    if (text.trim() !== 'OK') {
      LOG('error', 'saveRecordFull', 'ответ не OK', { pageid, recordid, status: r.status, body: text.slice(0, 200) });
      throw new Error(`SAVE_FAILED saverecord ${recordid}: ${text.slice(0, 200)}`);
    }
    LOG('info', 'saveRecordFull', 'OK', { pageid, recordid, fields: fields.length, bytes: body.length });
    return 'OK';
  };

  /**
   * Полный порядок блоков страницы: saverecordssort принимает список sorts[i] всех
   * recordid, а не пару «переставь X после Y». Перед отправкой порядок сверяется с DOM редактора:
   * другой состав — отказ STALE_INVENTORY (список, снятый до чужой вставки, затёр бы её).
   * Ответ — пустая строка или 'OK'.
   */
  T.saveRecordsSort = async (pageid, order) => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'saveRecordsSort');
    if (!Array.isArray(order) || order.length === 0) throw new Error('saveRecordsSort: нужен полный список recordid');
    const dom = [...document.querySelectorAll('[data-record-type]')].filter((el) => /^record\d+$/.test(el.id)).map((el) => el.id.replace(/^record/, ''));
    const want = order.map(String);
    const a = [...dom].sort().join(',');
    const b = [...want].sort().join(',');
    if (a !== b) {
      LOG('error', 'saveRecordsSort', 'STALE_INVENTORY: состав блоков в списке не совпал с DOM редактора', { dom: dom.length, order: want.length });
      throw new Error(`STALE_INVENTORY: в DOM ${dom.length} блоков, в списке ${want.length}, состав отличается`);
    }
    const params = new URLSearchParams({ comm: 'saverecordssort', pageid });
    want.forEach((id, i) => params.append(`sorts[${i}]`, id));
    LOG('debug', 'saveRecordsSort', 'запись порядка', { pageid, blocks: want.length, before: dom.join(',').slice(0, 200), after: want.join(',').slice(0, 200) });
    const { text, status } = await post('/page/submit/', Object.fromEntries(params));
    const answer = text.trim();
    if (answer !== '' && answer !== 'OK') {
      LOG('error', 'saveRecordsSort', 'ответ не OK', { pageid, status, body: answer.slice(0, 200) });
      throw new Error(`SAVE_FAILED saverecordssort: ${answer.slice(0, 200)}`);
    }
    LOG('info', 'saveRecordsSort', 'OK', { pageid, blocks: want.length });
    return 'OK';
  };

  /**
   * Предпросмотр блока без записи: тело как у полного saverecord, но comm=previewrecord —
   * сервер отдаёт {html} блока с подставленными значениями и ничего не сохраняет (проверено
   * обратным чтением 2026-09-11). При render предпросмотр подставляется в DOM редактора вместо
   * текущего .r (для скриншота); restorePreview возвращает исходный DOM.
   */
  T.__previewBackup = T.__previewBackup || {};
  T.previewRecord = async (pageid, recordid, fields, opts = {}) => {
    pageid = String(pageid || window.pageid);
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('previewRecord: нужен массив полей {name, value}');
    if (fields.some((f) => /<script/i.test(String(f.value)))) throw new Error('SCRIPT_REJECTED');
    const params = new URLSearchParams();
    for (const f of fields) if (!['comm', 'pageid', 'recordid'].includes(f.name)) params.append(f.name, f.value == null ? '' : String(f.value));
    params.append('recordid', recordid);
    params.append('pageid', pageid);
    params.append('comm', 'previewrecord');
    const body = params.toString();
    LOG('debug', 'previewRecord', 'запрос', { pageid, recordid, fields: fields.length, bytes: body.length, head: body.slice(0, 200) });
    const r = await fetch('/page/submit/', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
    const text = await r.text();
    if (/^\s*<|<html|<!doctype/i.test(text.slice(0, 300))) throw new Error(`SESSION_LOST /page/submit/ status=${r.status}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      LOG('error', 'previewRecord', 'ответ не JSON', { recordid, status: r.status, head: text.slice(0, 160) });
      throw new Error(`PREVIEW_FAILED ${recordid}: ${text.slice(0, 160)}`);
    }
    if (!json || typeof json.html !== 'string') {
      LOG('error', 'previewRecord', 'в ответе нет html', { recordid, status: r.status, body: text.slice(0, 200) });
      throw new Error(`PREVIEW_FAILED ${recordid}: ${text.slice(0, 200)}`);
    }
    let rendered = false;
    if (opts.render) {
      const wrapper = document.getElementById(`record${recordid}`);
      const current = wrapper && wrapper.querySelector('.r');
      const tpl = document.createElement('template');
      tpl.innerHTML = json.html.trim();
      const fresh = tpl.content.querySelector('.r');
      if (wrapper && current && fresh) {
        if (!T.__previewBackup[recordid]) T.__previewBackup[recordid] = current;
        current.replaceWith(fresh);
        rendered = true;
      } else {
        LOG('warn', 'previewRecord', 'не удалось подставить предпросмотр в DOM', { recordid, wrapper: Boolean(wrapper), current: Boolean(current), fresh: Boolean(fresh) });
      }
    }
    LOG('info', 'previewRecord', 'предпросмотр получен, записи не было', { pageid, recordid, htmlBytes: json.html.length, rendered });
    return { htmlBytes: json.html.length, rendered, html: opts.withHtml ? json.html : undefined };
  };

  /** Вернуть исходный DOM блока после предпросмотра. */
  T.restorePreview = (recordid) => {
    const original = T.__previewBackup[recordid];
    if (!original) return false;
    const wrapper = document.getElementById(`record${recordid}`);
    const current = wrapper && wrapper.querySelector('.r');
    if (current) current.replaceWith(original);
    delete T.__previewBackup[recordid];
    LOG('debug', 'restorePreview', 'исходный DOM возвращён', { recordid });
    return true;
  };

  /** Код блока T123 в декодированном виде. */
  T.getT123Code = async (pageid, projectid, recordid) => {
    pageid = String(pageid || window.pageid);
    projectid = String(projectid || window.projectid);
    const { text } = await post('/page/edit/', { pageid, projectid, recordid });
    const json = parseJson(text, { fn: 'getT123Code', pageid, recordid });
    const encoded = (json.record && json.record.code) || '';
    const code = decodeEntities(encoded);
    LOG('debug', 'getT123Code', 'код получен', { recordid, tplid: json.record && json.record.tplid, encodedBytes: encoded.length, bytes: code.length });
    return { code, tplid: json.record && json.record.tplid };
  };

  /** Пишет код T123. Без onlythisfield — иначе запись ломается. Лимит 25 КБ. */
  T.saveT123Code = async (pageid, projectid, recordid, html) => {
    pageid = String(pageid || window.pageid);
    projectid = String(projectid || window.projectid);
    assertWritable(pageid, 'saveT123Code');
    if (html.length > T123_LIMIT) {
      LOG('error', 'saveT123Code', 'код больше лимита', { recordid, bytes: html.length, limit: T123_LIMIT });
      throw new Error(`TOO_MUCH_DATA ${html.length} > ${T123_LIMIT}`);
    }
    LOG('debug', 'saveT123Code', 'запись', { pageid, recordid, bytes: html.length });
    const { text, status } = await post('/page/submit/', { comm: 'saverecord', pageid, projectid, recordid, code: html });
    if (text.trim() !== 'OK') {
      LOG('error', 'saveT123Code', 'ответ не OK', { recordid, status, body: text.slice(0, 200) });
      throw new Error(`SAVE_FAILED T123 ${recordid}: ${text.slice(0, 200)}`);
    }
    LOG('info', 'saveT123Code', 'OK', { pageid, recordid });
    return 'OK';
  };

  /**
   * Поля, которые при копировании блока не переносятся: служебные (их ставит сама Тильда)
   * и отвергаемые командой saverecord — ответ «Wrong onlythisfield name» (проверено 2026-09-09
   * для slideqty и formactiontype, 2026-09-03 для off).
   */
  T.RECORD_SKIP_FIELDS = ['id', 'recordid', 'pageid', 'tplid', 'projectid', 'slideqty', 'formactiontype', 'off'];

  /**
   * Создаёт блок на странице. afterid — recordid блока, после которого вставить;
   * пустая строка означает «в конец страницы». Возвращает {recordid, tplid}.
   */
  T.addRecord = async (pageid, tplid, afterid = '') => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'addRecord');
    // Логика редактора (tp__addRecord): with_code нужен, только пока шаблон не подключён к странице.
    const withCode = typeof window.tp__checkBlockAvailabilityOnPage === 'function' && window.tp__checkBlockAvailabilityOnPage(Number(tplid)) ? '' : 'yes';
    LOG('debug', 'addRecord', 'создание блока', { pageid, tplid, afterid, withCode });
    const { text, status } = await post('/page/submit/', {
      comm: 'addnewrecord', pageid, afterid: afterid || '', beforeid: '', tplid: String(tplid), with_code: withCode,
    });
    const json = parseJson(text, { fn: 'addRecord', pageid, recordid: '(новый)' });
    if (json.error) {
      // Текст ошибки нужен наверху: «You do not have access to this block» — шаблон недоступен
      // (тариф или служебный шаблон вроде меню 770), каталог помечает его available: false.
      LOG('warn', 'addRecord', 'Тильда отказала', { pageid, tplid, status, error: String(json.error).slice(0, 120) });
      throw new Error(`ADD_FAILED addnewrecord tpl=${tplid}: ${json.error}`);
    }
    const recordid = ((json.html || '').match(/recordid="(\d+)"/) || [])[1];
    if (!recordid) {
      LOG('error', 'addRecord', 'в ответе нет recordid', { pageid, tplid, status, head: String(json.html).slice(0, 120) });
      throw new Error(`ADD_FAILED addnewrecord tpl=${tplid}: recordid не найден`);
    }
    LOG('info', 'addRecord', 'блок создан', { pageid, tplid, afterid: afterid || '(в конец)', recordid });
    return { recordid, tplid: String(tplid) };
  };

  /** Удаляет блок. Ответ Тильды: 'OK' или пустая строка. */
  T.deleteRecord = async (pageid, recordid) => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'deleteRecord');
    const { text, status } = await post('/page/submit/', { comm: 'deleterecord', pageid, recordid });
    const answer = text.trim();
    if (!['', 'ok', 'OK'].includes(answer)) {
      LOG('error', 'deleteRecord', 'ответ не OK', { pageid, recordid, status, body: answer.slice(0, 200) });
      throw new Error(`DELETE_FAILED deleterecord ${recordid}: ${answer.slice(0, 200)}`);
    }
    LOG('info', 'deleteRecord', 'блок удалён', { pageid, recordid });
    return 'OK';
  };

  /**
   * Содержательные поля блока: обе вкладки (`content` и `settings`), без служебных и пустых.
   * Значения декодированы — в таком виде их и принимает saverecord.
   */
  T.readRecordFields = async (pageid, recordid) => {
    const content = (await T.getRecord(pageid, recordid, 'content')).record || {};
    const settings = (await T.getRecord(pageid, recordid, 'settings')).record || {};
    const merged = { ...settings, ...content };
    const fields = {};
    for (const [name, value] of Object.entries(merged)) {
      if (T.RECORD_SKIP_FIELDS.includes(name)) continue;
      if (value === '' || value === null || value === undefined) continue;
      fields[name] = decodeEntities(String(value));
    }
    LOG('debug', 'readRecordFields', 'поля прочитаны', { pageid, recordid, fields: Object.keys(fields).length });
    return fields;
  };

  /**
   * Снимок стандартного блока для site-baseline/records/<pageid>/<recordid>.json.
   *
   * `record` — объединение обеих вкладок в том виде, как их отдаёт Тильда (HTML-encoded):
   * копирование переносит поля и `content`, и `settings`, поэтому снимок обязан содержать оба
   * набора, иначе сверка не заметит потерю оформления. `tabs` показывает, откуда какое поле.
   */
  T.readRecordSnapshot = async (pageid, recordid) => {
    const content = await T.getRecord(pageid, recordid, 'content');
    const settings = await T.getRecord(pageid, recordid, 'settings');
    const record = { ...(settings.record || {}), ...(content.record || {}) };
    LOG('info', 'readRecordSnapshot', 'снимок собран', { pageid, recordid, tplid: record.tplid, fields: Object.keys(record).length });
    return {
      record,
      tpl: content.tpl || settings.tpl,
      tabs: { content: Object.keys(content.record || {}), settings: Object.keys(settings.record || {}) },
    };
  };

  /**
   * Копирует стандартный блок целиком через буфер редактора: `copyrecord_tobuf` на странице
   * источника, `pasterecord_frombuf` на странице приёмника — та же функция «Копировать» /
   * «Вставить блок», которой человек пользуется в редакторе. Нужна потому, что `addnewrecord`
   * для части шаблонов (проверено на tplid 835, 2026-09-09) отвечает
   * `{"error":"You do not have access to this block"}`: новый блок такого шаблона из каталога
   * на тарифе не создаётся, а уже существующий блок человек вставляет из буфера вручную.
   * Дополнительно перенос через буфер даёт все поля разом (сверено 63/63 на блоке 835, отличался
   * только служебный `lid` внутри `list` — Тильда переприсваивает id элементов списка), тогда как
   * `copyRecord` по одному полю теряет часть полей с ответом `Wrong onlythisfield name`. Это и есть
   * основной способ переноса стандартного блока для `copyBlock`; `copyRecord` остаётся как
   * запасной путь и для явного переноса отдельных полей.
   */
  T.copyRecordViaBuffer = async (srcPageid, srcRecordid, dstPageid, afterid = '') => {
    srcPageid = String(srcPageid);
    dstPageid = String(dstPageid || window.pageid);
    assertWritable(dstPageid, 'copyRecordViaBuffer');
    const toBuf = await post('/page/submit/', { comm: 'copyrecord_tobuf', pageid: srcPageid, recordid: srcRecordid });
    if (toBuf.text.trim() !== 'OK') {
      LOG('error', 'copyRecordViaBuffer', 'copyrecord_tobuf не OK', { srcPageid, srcRecordid, body: toBuf.text.slice(0, 200) });
      throw new Error(`COPY_TO_BUF_FAILED ${srcRecordid}: ${toBuf.text.slice(0, 200)}`);
    }
    const { text, status } = await post('/page/submit/', { comm: 'pasterecord_frombuf', pageid: dstPageid, afterid: afterid || '', beforeid: '' });
    const json = parseJson(text, { fn: 'copyRecordViaBuffer', pageid: dstPageid, recordid: '(новый)' });
    if (json.error) {
      LOG('error', 'copyRecordViaBuffer', 'pasterecord_frombuf вернул ошибку', { dstPageid, status, error: json.error });
      throw new Error(`PASTE_FAILED ${srcRecordid} → ${dstPageid}: ${json.error}`);
    }
    const html = String(json.html || '');
    const recordid = (html.match(/recordid="(\d+)"/) || [])[1];
    const tplid = (html.match(/data-record-type="(\d+)"/) || [])[1];
    // Вставка через буфер переносит видимость блока источника (в отличие от addRecord,
    // который всегда создаёт видимый блок) — читаем её из ответа, чтобы не переключать вслепую.
    const hidden = (html.match(/\boff="([yn])"/) || [])[1] || 'n';
    if (!recordid) {
      LOG('error', 'copyRecordViaBuffer', 'в ответе нет recordid', { dstPageid, status, head: html.slice(0, 120) });
      throw new Error(`PASTE_FAILED ${srcRecordid} → ${dstPageid}: recordid не найден`);
    }
    LOG('info', 'copyRecordViaBuffer', 'блок скопирован через буфер', { srcPageid, srcRecordid, dstPageid, recordid, tplid, hidden });
    return { recordid, tplid: tplid || '', hidden, written: null, skipped: [] };
  };

  /**
   * Копирует стандартный блок с одной страницы на другую: создаёт блок того же типа
   * и переносит поля по одному. Чужую страницу из открытого редактора читать можно —
   * проверено 2026-09-09. Если запись сорвалась, созданный блок удаляется, чтобы на
   * приёмнике не оставалось полупустых блоков; не удалился — ERROR с recordid для ручной уборки.
   * Запасной путь, если буфер (`copyRecordViaBuffer`) недоступен для конкретного случая.
   */
  T.copyRecord = async (srcPageid, srcRecordid, dstPageid, tplid, afterid = '') => {
    srcPageid = String(srcPageid);
    dstPageid = String(dstPageid || window.pageid);
    assertWritable(dstPageid, 'copyRecord');
    const fields = await T.readRecordFields(srcPageid, srcRecordid);
    const { recordid } = await T.addRecord(dstPageid, tplid, afterid);
    const written = [];
    const skipped = [];
    try {
      for (const [name, value] of Object.entries(fields)) {
        if (name === 'code') {
          await T.saveT123Code(dstPageid, window.projectid, recordid, value);
          written.push(name);
          continue;
        }
        try {
          await T.saveField(dstPageid, recordid, name, value);
          written.push(name);
        } catch (e) {
          // Отдельное поле может быть отвергнуто шаблоном — блок из-за этого не бракуем,
          // расхождение поймает сверка на стороне Node.
          LOG('warn', 'copyRecord', 'поле не записалось', { recordid, field: name, error: String(e.message).slice(0, 120) });
          skipped.push({ field: name, error: String(e.message).slice(0, 120) });
        }
      }
    } catch (e) {
      LOG('error', 'copyRecord', 'запись сорвалась, удаляю созданный блок', { dstPageid, recordid, error: String(e.message).slice(0, 160) });
      try {
        await T.deleteRecord(dstPageid, recordid);
      } catch (delErr) {
        LOG('error', 'copyRecord', 'созданный блок остался на странице, убрать вручную', { dstPageid, recordid, error: String(delErr.message).slice(0, 120) });
      }
      throw e;
    }
    LOG('info', 'copyRecord', 'блок скопирован', { srcPageid, srcRecordid, dstPageid, recordid, tplid, written: written.length, skipped: skipped.length });
    return { recordid, tplid: String(tplid), written, skipped };
  };

  LOG('info', 'install', 'API установлен', { pageid: window.pageid, projectid: window.projectid });
  return {
    installed: ['getRecord', 'readSettingsSchema', 'saveField', 'saveRecordFull', 'saveRecordsSort', 'previewRecord', 'restorePreview', 'getT123Code', 'saveT123Code', 'addRecord', 'deleteRecord', 'readRecordFields', 'readRecordSnapshot', 'copyRecord'],
    pageid: window.pageid,
    projectid: window.projectid,
  };
}
