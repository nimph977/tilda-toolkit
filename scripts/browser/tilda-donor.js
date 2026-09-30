// Браузерный слой: перенос блоков через буфер аккаунта.
// Выполняется ВНУТРИ страницы редактора через page.evaluate (scripts/lib/browser.mjs).
// Требует tilda-zero.js (listRecords) и tilda-page.js (T.assertWritable).
//
// Протокол прочитан 2026-09-24 из t-page-all.min.js (класс множественного выделения
// window.tp_multiselect: copyRecords/pasteRecords; tp__fetch → tc__fetch → td__encodeData;
// toString, только чтение):
//
//   POST /page/submit/  comm=copyselectedrecords_tobuf&pageid=<src>&selects[0]=<recordid>&selects[1]=…  → "OK"
//        selects — массив recordid в порядке следования на странице (редактор сортирует по DOM);
//        td__encodeData кодирует массив как selects[<индекс>]=<значение> (PHP-стиль);
//        лимит редактора — 200 записей за одно копирование (warning_too_much_blocks);
//        csrf не передаётся (как и у copyrecord_tobuf); после OK редактор пишет в localStorage
//        только отметку времени tp_record_copy_<projectid> — сам буфер живёт на сервере, в аккаунте.
//   POST /page/submit/  comm=pasterecord_frombuf&pageid=<dst>&recordid=<после какого|пусто>&with_code=yes
//        → JSON: массив объектов [{html, csslibs, jslibs, css?, js?}, …] — по одному на вставленную запись,
//        в порядке копирования; при одной записи сервер может отдать один объект (tp__addNewBlocksToPage
//        оборачивает объект в массив). recordid пустой — вставка в конец страницы; иначе после recordid.
//        В html каждой записи: <div id="rec<N>" class="record" recordid="<N>" data-record-type="<tplid>" off="y|n" …>.
//        Ответ "" — «пустой ответ» (редактор бросает ошибку); {"error": …} — отказ сервера.
//   Одиночные аналоги (уже в tilda-page.js copyRecordViaBuffer): copyrecord_tobuf {pageid, recordid} → "OK";
//        pasterecord_frombuf {pageid, afterid, beforeid} — старая форма без with_code.
//   Ограничения: буфер один на аккаунт (перезаписывается следующим копированием); вставка в другой
//        аккаунт невозможна — потому донор и тестовый проект должны быть доступны одному входу.
//
// Копирование в буфер источник не меняет (проверено пробой: состав донора до/после совпадает),
// поэтому assertWritable зовётся только для приёмника в pasteFromBuffer. В сессии донора
// T.writablePages = [] — вставка возможна лишь после setWritablePages([приёмник]) из Node.
() => {
  const T = (window.__tilda = window.__tilda || {});
  const LOG = (level, fn, msg, data) => console[level](`[tilda-donor.${fn}] ${msg}`, data === undefined ? '' : JSON.stringify(data));
  const COPY_LIMIT = 200;

  const requireApi = (names, fn) => {
    const missing = names.filter((n) => typeof T[n] !== 'function');
    if (missing.length) {
      LOG('error', fn, 'browser layer parts are not installed', { missing });
      throw new Error(`NO_API ${missing.join(',')}: install tilda-zero.js and tilda-page.js`);
    }
  };

  const looksLikeHtml = (text) => /^\s*<|<html|<!doctype/i.test(text.slice(0, 300));

  /** Тело в формате td__encodeData: массивы — как selects[0]=…&selects[1]=… */
  const encode = (params) => {
    const out = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) value.forEach((v, i) => out.append(`${key}[${i}]`, String(v)));
      else out.append(key, String(value));
    }
    return out.toString();
  };

  const post = async (url, params, fn) => {
    const body = encode(params);
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    const text = await r.text();
    if (looksLikeHtml(text)) {
      const head = text.slice(0, 12);
      LOG('error', fn, 'SESSION_LOST: got HTML instead of data (<!--tlp--> = login page, <!--tpbaa--> = another account)', { url, status: r.status, head });
      throw new Error(`SESSION_LOST ${url} status=${r.status} head=${JSON.stringify(head)}`);
    }
    return { status: r.status, text };
  };

  /** Чистая: записи из разметки ответа вставки в порядке появления — [{ recordid, tplid, hidden: 'y'|'n' }]. */
  T.parsePastedHtml = (html) => {
    const text = String(html || '');
    const records = [];
    const re = /id="rec(\d+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const window_ = text.slice(m.index, m.index + 600);
      const tplid = (window_.match(/data-record-type="(\d+)"/) || [])[1] || '';
      const hidden = (window_.match(/\boff="([yn])"/) || [])[1] || 'n';
      records.push({ recordid: m[1], tplid, hidden });
    }
    return records;
  };

  /** Копирование перечисленных записей страницы-источника в буфер аккаунта. Источник не меняется. */
  T.copySelectedToBuffer = async (pageid, recordids) => {
    requireApi(['listRecords', 'assertWritable'], 'copySelectedToBuffer');
    pageid = String(pageid);
    if (!Array.isArray(recordids) || recordids.length === 0) throw new Error('COPY_NO_RECORDS: nothing to copy');
    const selects = recordids.map(String);
    if (selects.length > COPY_LIMIT) LOG('warn', 'copySelectedToBuffer', 'more records than the editor limit', { count: selects.length, limit: COPY_LIMIT });
    LOG('debug', 'copySelectedToBuffer', 'request', { pageid, count: selects.length });
    const { text, status } = await post('/page/submit/', { comm: 'copyselectedrecords_tobuf', pageid, selects }, 'copySelectedToBuffer');
    if (text.trim() !== 'OK') {
      LOG('error', 'copySelectedToBuffer', 'copyselectedrecords_tobuf is not OK', { pageid, status, body: text.slice(0, 200) });
      throw new Error(`COPY_TO_BUF_FAILED ${pageid}: ${text.slice(0, 200)}`);
    }
    LOG('info', 'copySelectedToBuffer', 'copied to the account buffer', { pageid, count: selects.length });
    return { pageid, count: selects.length };
  };

  /** Вставка буфера аккаунта на приёмник: в конец страницы (afterid пустой) или после записи afterid. */
  T.pasteFromBuffer = async (dstPageid, afterid = '') => {
    requireApi(['listRecords', 'assertWritable'], 'pasteFromBuffer');
    dstPageid = String(dstPageid);
    T.assertWritable(dstPageid, 'pasteFromBuffer');
    LOG('debug', 'pasteFromBuffer', 'request', { dstPageid, afterid: afterid || '' });
    const { text, status } = await post('/page/submit/', { comm: 'pasterecord_frombuf', pageid: dstPageid, recordid: afterid || '', with_code: 'yes' }, 'pasteFromBuffer');
    if (!text.trim()) throw new Error(`PASTE_FAILED ${dstPageid}: empty response`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      LOG('error', 'pasteFromBuffer', 'response is not JSON', { dstPageid, status, head: text.slice(0, 120) });
      throw new Error(`BAD_JSON pasteFromBuffer ${dstPageid}`);
    }
    if (json && !Array.isArray(json) && json.error) {
      LOG('error', 'pasteFromBuffer', 'pasterecord_frombuf returned an error', { dstPageid, status, error: json.error });
      throw new Error(`PASTE_FAILED ${dstPageid}: ${json.error}`);
    }
    const items = Array.isArray(json) ? json : [json];
    const html = items.map((it) => String((it && it.html) || '')).join('');
    const records = T.parsePastedHtml(html);
    if (!records.length) {
      LOG('error', 'pasteFromBuffer', 'no records in the response', { dstPageid, status, items: items.length, htmlBytes: html.length });
      throw new Error(`PASTE_FAILED ${dstPageid}: no records in the response`);
    }
    LOG('info', 'pasteFromBuffer', 'pasted', { dstPageid, pasted: records.length, htmlBytes: html.length });
    return { records, htmlBytes: html.length };
  };

  return { installed: ['parsePastedHtml', 'copySelectedToBuffer', 'pasteFromBuffer'] };
}
