// Браузерный слой: Zero Block (тип 396). Выполняется ВНУТРИ страницы редактора
// https://tilda.ru/page/?pageid=<pageid>&projectid=<projectid> через Playwright MCP:
//   browser_evaluate  function = <содержимое этого файла целиком>
// Файл — одна стрелочная функция: она ставит API на window.__tilda и возвращает статус.
// Дальше вызовы: browser_evaluate function = `async () => window.__tilda.getZero(window.pageid, '<recordid>')`
//
// Схема проверена на живом проекте 2026-09-02:
//   POST /zero/get/     comm=getzerocode&pageid&recordid                                → JSON модели
//   POST /zero/submit/  comm=savezerocode&pageid&recordid&onlythisfield=code&fromzero=yes&code=<JSON> → "OK"
//
// Публикации здесь нет и быть не должно. Куки подставляет браузер (credentials: 'include').
() => {
  const T = (window.__tilda = window.__tilda || {});
  const LOG = (level, fn, msg, data) => console[level](`[tilda-zero.${fn}] ${msg}`, data === undefined ? '' : JSON.stringify(data));

  // Страницы, в которые писать запрещено. Скилл может дополнить: window.__tilda.protectedPages.push('…')
  T.protectedPages = Array.isArray(T.protectedPages) ? T.protectedPages : null;
  // Allow-список записи (сессия донора): null — списка нет, массив — писать только в эти страницы.
  T.writablePages = Array.isArray(T.writablePages) ? T.writablePages : null;
  // Поля формы модели Zero Block не пишутся никогда: копия FORM_FIELDS из
  // scripts/lib/form-fields.mjs прежнего состава — флаг formContent на Zero Block не действует.
  T.FORM_FIELDS = ['receivers', 'receivers_names', 'inputs', 'formmsgurl']; // formname разрешён с 2026-09-21 (подпись заявки)

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

  const elemIds = (model) =>
    Object.keys(model)
      .filter((k) => /^\d+$/.test(k))
      .map((k) => model[k] && model[k].elem_id);

  /** Инвентарь блоков страницы по DOM редактора. zeroIndex — порядковый номер среди Zero Block (с 1). */
  T.listRecords = () => {
    const all = [...document.querySelectorAll('[data-record-type]')].filter((el) => /^record\d+$/.test(el.id));
    let zeroIndex = 0;
    const list = all.map((el, i) => {
      const tplid = el.getAttribute('data-record-type');
      const isZero = tplid === '396';
      if (isZero) zeroIndex += 1;
      return {
        order: i + 1,
        recordid: el.id.replace(/^record/, ''),
        tplid,
        zeroIndex: isZero ? zeroIndex : null,
        // Скрытый блок помечен в DOM редактора атрибутом off="y".
        hidden: el.getAttribute('off') === 'y',
        preview: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    });
    LOG('info', 'listRecords', 'инвентарь собран', { records: list.length, zero: zeroIndex, hidden: list.filter((r) => r.hidden).length, pageid: window.pageid });
    return list;
  };

  /** Читает модель Zero Block. */
  T.getZero = async (pageid, recordid) => {
    pageid = String(pageid || window.pageid);
    LOG('debug', 'getZero', 'запрос', { pageid, recordid });
    const { text } = await post('/zero/get/', { comm: 'getzerocode', pageid, recordid });
    let model;
    try {
      model = JSON.parse(text);
    } catch (e) {
      LOG('error', 'getZero', 'ответ не JSON', { pageid, recordid, head: text.slice(0, 120) });
      throw new Error(`BAD_JSON getzerocode ${recordid}`);
    }
    LOG('debug', 'getZero', 'модель получена', { recordid, keys: Object.keys(model).length, elemIds: elemIds(model) });
    return model;
  };

  /** Изменились ли поля формы между текущей моделью на сервере и той, что уходит в запись. */
  const formFieldChanges = (before, after) => {
    const out = [];
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})].filter((k) => /^\d+$/.test(k)));
    for (const key of keys) {
      // Элемент удалён целиком (removeElement) — структурная правка, не запись полей формы (2026-09-21).
      if (before && before[key] && !(after && after[key])) continue;
      const a = (before && before[key]) || {};
      const b = (after && after[key]) || {};
      for (const field of T.FORM_FIELDS) if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) out.push(`${key}.${field}`);
    }
    return out;
  };

  /**
   * Пишет модель Zero Block. Возвращает 'OK', иначе бросает ошибку с телом ответа.
   * Guard'ы: `<script` в сериализованной модели — отказ; изменение полей формы относительно
   * текущей модели на сервере — отказ FORM_FIELD_REJECTED. opts.allowFormFields — только
   * для copyZero: копия переносит поля формы источника как есть (это не правка получателей).
   */
  T.saveZero = async (pageid, recordid, model, opts = {}) => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'saveZero');
    if (!model || typeof model !== 'object') throw new Error('saveZero: модель должна быть объектом');
    const code = typeof model === 'string' ? model : JSON.stringify(model);
    if (/<script/i.test(code)) {
      LOG('error', 'saveZero', 'отказ: модель содержит <script', { pageid, recordid });
      throw new Error('SCRIPT_REJECTED: модель содержит <script');
    }
    if (!opts.allowFormFields) {
      const current = await T.getZero(pageid, recordid);
      const changed = formFieldChanges(current, model);
      if (changed.length) {
        LOG('warn', 'saveZero', 'отказ: запись меняет поля формы', { pageid, recordid, changed, path: 'saveZero' });
        throw new Error(`FORM_FIELD_REJECTED ${recordid}: ${changed.join(', ')}`);
      }
    } else {
      LOG('warn', 'saveZero', 'поля формы переносятся как есть (копия блока)', { pageid, recordid });
    }
    LOG('debug', 'saveZero', 'запись', { pageid, recordid, keys: Object.keys(model).length, elemIds: elemIds(model), bytes: code.length });
    const { text, status } = await post('/zero/submit/', {
      comm: 'savezerocode', pageid, recordid, onlythisfield: 'code', fromzero: 'yes', code,
    });
    if (text.trim() !== 'OK') {
      LOG('error', 'saveZero', 'ответ не OK', { pageid, recordid, status, body: text.slice(0, 200) });
      throw new Error(`SAVE_FAILED savezerocode ${recordid}: ${text.slice(0, 200)}`);
    }
    LOG('info', 'saveZero', 'OK', { pageid, recordid });
    return 'OK';
  };

  /**
   * Скрыть или показать блок целиком. Серверная команда `offrecord` — переключатель
   * (источник: window.tp__offRecord в редакторе, 2026-09-03), поэтому текущее состояние
   * берётся из атрибута off="y|n" элемента #record<recordid>, и запрос идёт только при
   * расхождении. Возвращает {before, after, toggled}.
   */
  T.setBlockHidden = async (pageid, recordid, hidden) => {
    pageid = String(pageid || window.pageid);
    assertWritable(pageid, 'setBlockHidden');
    const want = hidden === true || hidden === 'y' ? 'y' : 'n';
    const el = document.getElementById(`record${recordid}`);
    if (!el) {
      LOG('error', 'setBlockHidden', 'блок не найден в DOM редактора', { recordid });
      throw new Error(`NO_RECORD_IN_DOM ${recordid}`);
    }
    const before = el.getAttribute('off') === 'y' ? 'y' : 'n';
    if (before === want) {
      LOG('info', 'setBlockHidden', 'уже в нужном состоянии, запрос не нужен', { recordid, hidden: want });
      return { before, after: want, toggled: false };
    }
    const { text, status } = await post('/page/submit/', { comm: 'offrecord', pageid, recordid });
    const answer = text.trim();
    // Ответ редактора: '', 'y', 'n', 'on', 'off'; иное — текст ошибки.
    if (!['', 'y', 'n', 'on', 'off'].includes(answer)) {
      LOG('error', 'setBlockHidden', 'ответ не распознан', { recordid, status, body: answer.slice(0, 200) });
      throw new Error(`SAVE_FAILED offrecord ${recordid}: ${answer.slice(0, 200)}`);
    }
    const after = answer === '' ? want : answer === 'y' || answer === 'off' ? 'y' : 'n';
    el.setAttribute('off', after);
    if (after !== want) {
      LOG('error', 'setBlockHidden', 'состояние после переключения не совпало с ожидаемым', { recordid, want, after, answer });
      throw new Error(`TOGGLE_MISMATCH ${recordid}: хотели ${want}, получили ${after}`);
    }
    LOG('info', 'setBlockHidden', 'OK', { pageid, recordid, before, after });
    return { before, after, toggled: true };
  };

  /**
   * Копирует Zero Block с одной страницы на другую: создаёт пустой блок 396 и пишет в него
   * модель источника целиком. Модель переносится побайтно, включая elem_id (проверено 2026-09-09).
   * Читать чужую страницу из открытого редактора можно — та же проверка.
   *
   * Требует установленного tilda-page.js (оттуда addRecord и deleteRecord).
   * Если запись модели сорвалась, созданный блок удаляется; не удалился — ERROR с recordid.
   */
  T.copyZero = async (srcPageid, srcRecordid, dstPageid, afterid = '') => {
    srcPageid = String(srcPageid);
    dstPageid = String(dstPageid || window.pageid);
    assertWritable(dstPageid, 'copyZero');
    if (typeof T.addRecord !== 'function') {
      LOG('error', 'copyZero', 'нет T.addRecord: установите scripts/browser/tilda-page.js', {});
      throw new Error('NO_ADD_RECORD: сначала установите tilda-page.js');
    }
    const model = await T.getZero(srcPageid, srcRecordid);
    const { recordid } = await T.addRecord(dstPageid, '396', afterid);
    try {
      await T.saveZero(dstPageid, recordid, model, { allowFormFields: true });
    } catch (e) {
      LOG('error', 'copyZero', 'модель не записалась, удаляю созданный блок', { dstPageid, recordid, error: String(e.message).slice(0, 160) });
      try {
        await T.deleteRecord(dstPageid, recordid);
      } catch (delErr) {
        LOG('error', 'copyZero', 'созданный блок остался на странице, убрать вручную', { dstPageid, recordid, error: String(delErr.message).slice(0, 120) });
      }
      throw e;
    }
    LOG('info', 'copyZero', 'Zero Block скопирован', { srcPageid, srcRecordid, dstPageid, recordid, keys: Object.keys(model).length, elems: elemIds(model).length });
    return { recordid, tplid: '396', keys: Object.keys(model).length, elemIds: elemIds(model) };
  };

  LOG('info', 'install', 'API установлен', { pageid: window.pageid, projectid: window.projectid, protectedPages: T.protectedPages });
  return { installed: ['listRecords', 'getZero', 'saveZero', 'setBlockHidden', 'copyZero'], pageid: window.pageid, projectid: window.projectid };
}
