// Браузерный слой: сборка страницы из блоков другой страницы. Выполняется ВНУТРИ страницы
// редактора приёмника через Playwright MCP: browser_evaluate function = <этот файл целиком>.
// Требует уже установленных tilda-zero.js и tilda-page.js — берёт из них copyZero и copyRecordViaBuffer.
//
// Зачем отдельный слой: модели блоков не проходят через Node и контекст агента. Обе страницы
// живут в одном аккаунте, и getzerocode/editrecordsettings читают ЛЮБУЮ страницу проекта из
// открытого редактора (проверено 2026-09-09) — поэтому копирование целиком выполняется здесь,
// а Node отвечает за план сборки, журнал и сверку.
//
// Публикации здесь нет и быть не должно.
() => {
  const T = (window.__tilda = window.__tilda || {});
  const LOG = (level, fn, msg, data) => console[level](`[tilda-copy.${fn}] ${msg}`, data === undefined ? '' : JSON.stringify(data));

  const requireApi = (names, fn) => {
    const missing = names.filter((n) => typeof T[n] !== 'function');
    if (missing.length) {
      LOG('error', fn, 'browser layer parts are not installed', { missing });
      throw new Error(`NO_API ${missing.join(',')}: install tilda-zero.js and tilda-page.js`);
    }
  };

  /**
   * Переключает видимость блока запросом `offrecord` (для только что созданного блока DOM ещё не
   * обновлён, поэтому setBlockHidden не подходит). Возвращает итоговое 'y'|'n'; несовпадение
   * с ожидаемым — HIDE_FAILED.
   */
  const toggleHidden = async (pageid, recordid, want, current) => {
    const r = await fetch('/page/submit/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ comm: 'offrecord', pageid, recordid }).toString(),
    });
    const answer = (await r.text()).trim();
    const hidden = answer === 'y' || answer === 'off' || answer === '' ? 'y' : 'n';
    if (hidden !== want) {
      LOG('error', 'copyBlock', 'visibility after toggling does not match the expected one', { recordid, want, answer: answer.slice(0, 60) });
      throw new Error(`HIDE_FAILED ${recordid}: wanted ${want}, response ${answer.slice(0, 60)}`);
    }
    LOG('info', 'copyBlock', 'block visibility toggled', { recordid, from: current, to: hidden });
    return hidden;
  };

  /**
   * Копирует один блок: Zero Block (тип 396) моделью, остальные — полями. Режим `new` —
   * блок из полей без источника: addRecord(tplid) + saveRecordFull(fields).
   * @param {object} spec {srcPage, srcRecordid, tplid, hidden} или {mode: 'new', tplid, fields, hidden}
   * @returns {{recordid, tplid, kind, hidden}}
   */
  T.copyBlock = async (spec, dstPageid, afterid = '') => {
    dstPageid = String(dstPageid || window.pageid);
    const tplid = String(spec.tplid);
    const want = spec.hidden === true || spec.hidden === 'y' ? 'y' : 'n';

    if (spec.mode === 'new') {
      requireApi(['addRecord', 'saveRecordFull', 'deleteRecord'], 'copyBlock(new)');
      if (tplid === '396') throw new Error('NEW_ZERO_UNSUPPORTED: a Zero Block cannot be built from fields');
      if (!Array.isArray(spec.fields)) throw new Error('NEW_FIELDS_REQUIRED: the new mode needs a fields array');
      if (spec.code !== undefined && tplid !== '131') throw new Error('NEW_CODE_TPLID: code can be written only into the HTML block 131');
      const { recordid } = await T.addRecord(dstPageid, tplid, afterid);
      try {
        // Код HTML-блока пишется своим запросом без onlythisfield, остальное — полной записью.
        if (spec.code !== undefined) {
          requireApi(['saveT123Code'], 'copyBlock(new, code)');
          await T.saveT123Code(dstPageid, window.projectid, recordid, String(spec.code));
          LOG('info', 'copyBlock', 'T123 code written', { recordid, bytes: String(spec.code).length });
        }
        if (spec.fields.length) await T.saveRecordFull(dstPageid, recordid, spec.fields, { allowFormContent: spec.formContent === 'reference' });
      } catch (e) {
        LOG('error', 'copyBlock', 'fields were not written, deleting the new block', { recordid, tplid, error: String(e.message).slice(0, 160) });
        try {
          await T.deleteRecord(dstPageid, recordid);
        } catch (e2) {
          LOG('error', 'copyBlock', 'block was not deleted after the error', { recordid, error: String(e2.message).slice(0, 160) });
        }
        throw e;
      }
      let hidden = 'n';
      if (want === 'y') hidden = await toggleHidden(dstPageid, recordid, 'y', 'n');
      LOG('info', 'copyBlock', 'block built from fields', { recordid, tplid, fields: spec.fields.length, hidden });
      return { recordid, tplid, kind: 'record', hidden, written: spec.fields.length, skipped: [] };
    }

    requireApi(['copyZero', 'copyRecordViaBuffer', 'setBlockHidden'], 'copyBlock');
    const kind = tplid === '396' ? 'zero' : 'record';
    const res =
      kind === 'zero'
        ? await T.copyZero(spec.srcPage, spec.srcRecordid, dstPageid, afterid)
        : await T.copyRecordViaBuffer(spec.srcPage, spec.srcRecordid, dstPageid, afterid);

    // copyZero (addRecord) всегда создаёт видимый блок — переключать нужно, только если источник
    // скрыт. copyRecordViaBuffer (paste) переносит видимость источника сам — трогать, только если
    // она не совпала с ожидаемой. Слепое переключение здесь один раз испортило состояние
    // (HIDE_FAILED: paste уже отдал скрытый блок, второе переключение сделало его видимым) —
    // 2026-09-09.
    const current = kind === 'zero' ? 'n' : res.hidden || 'n';
    const hidden = current !== want ? await toggleHidden(dstPageid, res.recordid, want, current) : current;
    return { ...res, kind, hidden };
  };

  /**
   * Собирает блоки по порядку: каждый следующий вставляется после предыдущего.
   *
   * @param {string} dstPageid страница-приёмник
   * @param {Array}  blocks    [{id, srcPage, srcRecordid, tplid, hidden}] в нужном порядке
   * @param {object} opts      {startAfter: recordid|'' — после чего вставлять первый блок
   *                            (по умолчанию в конец страницы), continueOnError: false}
   * @returns {{pageid, built: Array, ok: number, failed: number, lastRecordid: string}}
   *
   * Журнал возвращается целиком: агент кладёт его в site-baseline/reread/<pageid>/_built.json,
   * по нему apply-plan verify сопоставляет операции плана с получившимися recordid.
   * Большую страницу собирать порциями: startAfter = lastRecordid предыдущего вызова.
   */
  T.buildBlocks = async (dstPageid, blocks, opts = {}) => {
    requireApi(['copyBlock'], 'buildBlocks');
    dstPageid = String(dstPageid || window.pageid);
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('BAD_ARGUMENT: buildBlocks needs a non-empty list of blocks');
    const continueOnError = opts.continueOnError === true;
    let afterid = opts.startAfter === undefined ? '' : String(opts.startAfter || '');
    const built = [];
    LOG('info', 'buildBlocks', 'build started', { dstPageid, blocks: blocks.length, startAfter: afterid || '(at end)' });

    for (let i = 0; i < blocks.length; i++) {
      const spec = blocks[i];
      const id = spec.id || `b${i + 1}`;
      // Режим new источника не имеет — в журнале null, а не строка 'undefined'.
      const src = { srcPage: spec.srcPage == null ? null : String(spec.srcPage), srcRecordid: spec.srcRecordid == null ? null : String(spec.srcRecordid), mode: spec.mode || 'copy' };
      try {
        const res = await T.copyBlock(spec, dstPageid, afterid);
        afterid = res.recordid;
        built.push({ index: i, id, ...src, tplid: res.tplid, recordid: res.recordid, kind: res.kind, hidden: res.hidden, status: 'ok', skipped: res.skipped || [] });
        LOG('info', 'buildBlocks', `block ${i + 1}/${blocks.length} done`, { id, source: spec.srcRecordid ?? spec.tplid, recordid: res.recordid, tplid: res.tplid });
      } catch (e) {
        const error = String(e.message).slice(0, 200);
        built.push({ index: i, id, ...src, tplid: String(spec.tplid), recordid: null, status: 'error', error });
        LOG('error', 'buildBlocks', `block ${i + 1}/${blocks.length} not built`, { id, source: spec.srcRecordid ?? spec.tplid, error });
        if (!continueOnError) {
          LOG('error', 'buildBlocks', 'stopping after the first error', { done: built.filter((b) => b.status === 'ok').length, lastRecordid: afterid });
          break;
        }
      }
    }

    const ok = built.filter((b) => b.status === 'ok').length;
    const failed = built.filter((b) => b.status === 'error').length;
    LOG('info', 'buildBlocks', 'build finished', { dstPageid, ok, failed, lastRecordid: afterid });
    return { pageid: dstPageid, built, ok, failed, lastRecordid: afterid };
  };

  /**
   * Снимает модели всех блоков ОТКРЫТОЙ страницы за один вызов: Zero Block — моделью,
   * остальные — полями обеих вкладок. Результат сохраняют в файл (`browser_evaluate` с `filename`)
   * и раскладывают по снимкам: `node scripts/snapshot.mjs import <файл>`.
   *
   * Только чтение: ни одной команды записи здесь нет.
   */
  /**
   * Снимок всей страницы: один запрос на блок, «рваным» темпом — пачками по `batch` чтений
   * с паузой `delayMs` между чтениями и `pauseMs` между пачками. Основание:
   * 2026-09-11 второй полный снимок подряд выбивал сессию Тильды — на 45-м запросе без пауз и
   * на ~75-м при 800 мс; порог не измерен. При первом SESSION_LOST цикл останавливается.
   * `timeline` — время и длительность каждого чтения для разбора закономерности.
   */
  T.snapshotPage = async (opts = {}) => {
    requireApi(['listRecords', 'getZero', 'readRecordSnapshot'], 'snapshotPage');
    const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 2500;
    const batch = Number.isFinite(opts.batch) && opts.batch > 0 ? opts.batch : 10;
    const pauseMs = Number.isFinite(opts.pauseMs) ? opts.pauseMs : 60000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pageid = String(window.pageid);
    const inventory = T.listRecords();
    const zero = {};
    const records = {};
    const errors = [];
    const timeline = [];
    const t0 = Date.now();
    LOG('info', 'snapshotPage', 'started', { pageid, blocks: inventory.length, delayMs, batch, pauseMs });
    for (const [i, rec] of inventory.entries()) {
      if (i > 0) {
        if (i % batch === 0 && pauseMs > 0) {
          LOG('info', 'snapshotPage', 'pause between batches', { read: i, of: inventory.length, pauseMs });
          await sleep(pauseMs);
        } else if (delayMs > 0) await sleep(delayMs);
      }
      const started = Date.now();
      try {
        if (rec.tplid === '396') zero[rec.recordid] = await T.getZero(pageid, rec.recordid);
        else records[rec.recordid] = await T.readRecordSnapshot(pageid, rec.recordid);
        timeline.push({ i, recordid: rec.recordid, at: new Date(started).toISOString(), ms: Date.now() - started, ok: true });
      } catch (e) {
        const error = String(e.message).slice(0, 200);
        errors.push({ recordid: rec.recordid, tplid: rec.tplid, error });
        timeline.push({ i, recordid: rec.recordid, at: new Date(started).toISOString(), ms: Date.now() - started, ok: false, error: error.slice(0, 120) });
        LOG('error', 'snapshotPage', 'block was not read', { recordid: rec.recordid, tplid: rec.tplid, error: error.slice(0, 120) });
        if (/SESSION_LOST/.test(error)) {
          LOG('error', 'snapshotPage', 'session lost, snapshot aborted', { read: i, of: inventory.length, ms: Date.now() - t0 });
          break;
        }
      }
    }
    LOG('info', 'snapshotPage', 'done', { pageid, zero: Object.keys(zero).length, records: Object.keys(records).length, errors: errors.length, ms: Date.now() - t0 });
    return { pageid, at: new Date().toISOString(), inventory, zero, records, errors, timeline, pace: { delayMs, batch, pauseMs } };
  };

  LOG('info', 'install', 'API installed', { pageid: window.pageid });
  return { installed: ['copyBlock', 'buildBlocks', 'snapshotPage'], pageid: window.pageid, needs: ['tilda-zero.js', 'tilda-page.js'] };
}
