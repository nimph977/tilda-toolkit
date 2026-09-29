// Браузерный слой: загрузка картинки на CDN Тильды. Выполняется ВНУТРИ страницы редактора
// через Playwright MCP: browser_evaluate function = <содержимое этого файла целиком>.
// Дальше вызовы: browser_evaluate function = `async () => window.__tilda.uploadImageFromDataUrl('data:image/png;base64,…', 'photo.png')`
//
// Точка загрузки снята с живого редактора 2026-09-03 (захват запроса
// в site-baseline/captures/):
//   POST https://upload.tildaapi.com/api/upload/?publickey=<…>&uploadkey=<…>
//   multipart/form-data, поле файла `file`  →  {"errorExists":0,"result":[{cdnUrl,width,height,…}]}
// Домен `upload.tildacdn.com` из справки tilda-edit-mcp-audit.md неверен.
//
// Ключи берутся со страницы (window.Tildaupload_PUBLICKEY / Tildaupload_UPLOADKEY) в момент
// вызова, никуда не сохраняются и в лог не попадают. Публикации здесь нет.
() => {
  const T = (window.__tilda = window.__tilda || {});
  const LOG = (level, fn, msg, data) => console[level](`[tilda-upload.${fn}] ${msg}`, data === undefined ? '' : JSON.stringify(data));

  /** Адреса загрузки читаются из виджета редактора, а не зашиваются. */
  const endpoints = () => {
    const W = window.TUWidget || {};
    return {
      image: W.urlUploadAPI || 'https://upload.tildaapi.com/api/upload/',
      imageFallback: W.urlUploadFallback || 'https://upload.tildaapi.one/api/upload/',
      file: W.urlFileUploadAPI || 'https://ai.tildacdn.com/file/upload/',
      video: window.Tildavideoupload_URL || null,
    };
  };

  const keys = () => {
    const publickey = window.Tildaupload_PUBLICKEY;
    const uploadkey = window.Tildaupload_UPLOADKEY;
    if (!publickey || !uploadkey) {
      LOG('error', 'keys', 'на странице нет ключей загрузки — открыт ли редактор страницы?', {
        hasPublicKey: !!publickey, hasUploadKey: !!uploadkey,
      });
      throw new Error('NO_UPLOAD_KEYS');
    }
    return { publickey, uploadkey };
  };

  /** Отправляет Blob на CDN. Возвращает {cdnUrl, width, height, size, ext, uuid}. */
  const post = async (blob, filename, url) => {
    const { publickey, uploadkey } = keys();
    const fd = new FormData();
    fd.append('file', blob, filename);
    const target = `${url}?publickey=${encodeURIComponent(publickey)}&uploadkey=${encodeURIComponent(uploadkey)}`;
    LOG('debug', 'post', 'загрузка файла', { filename, bytes: blob.size, type: blob.type, endpoint: url });
    const r = await fetch(target, {
      method: 'POST',
      body: fd,
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const text = await r.text();
    if (r.status === 403) {
      LOG('error', 'post', '403 при загрузке: ключи устарели либо запрос ушёл не со страницы редактора (заголовок Origin)', { status: r.status, body: text.slice(0, 200) });
      throw new Error(`UPLOAD_FORBIDDEN ${r.status}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      LOG('error', 'post', 'ответ не JSON (страница логина?)', { status: r.status, head: text.slice(0, 120) });
      throw new Error(`UPLOAD_BAD_JSON ${r.status}`);
    }
    const item = data && data.result && data.result[0];
    if (data.errorExists || !item || !item.cdnUrl) {
      LOG('error', 'post', 'загрузка не удалась', { status: r.status, body: text.slice(0, 200) });
      throw new Error(`UPLOAD_FAILED ${text.slice(0, 200)}`);
    }
    const out = { cdnUrl: item.cdnUrl, width: item.width, height: item.height, size: item.size, ext: item.ext, uuid: item.uuid };
    LOG('info', 'post', 'загружено', out);
    return out;
  };

  /**
   * Загружает картинку, переданную как data:-адрес (base64). Основной путь: не упирается в CORS,
   * файл целиком приходит в вызове. Возвращает поля для операции `set.image` плана:
   * cdnUrl → img, width → filewidth, height → fileheight.
   */
  T.uploadImageFromDataUrl = async (dataUrl, filename) => {
    if (typeof dataUrl !== 'string' || !/^data:/.test(dataUrl)) throw new Error('uploadImageFromDataUrl: нужен data:-адрес');
    const blob = await (await fetch(dataUrl)).blob();
    const eps = endpoints();
    try {
      return await post(blob, filename || 'upload.png', eps.image);
    } catch (e) {
      if (/UPLOAD_FORBIDDEN|Failed to fetch|NetworkError/i.test(String(e.message))) {
        LOG('warn', 'uploadImageFromDataUrl', 'основной адрес не ответил, пробую запасной', { fallback: eps.imageFallback });
        return post(blob, filename || 'upload.png', eps.imageFallback);
      }
      throw e;
    }
  };

  /**
   * Загружает картинку по чужому адресу. Файл сначала скачивается страницей редактора,
   * поэтому чужой сервер должен отдавать CORS-заголовки; иначе — понятная ошибка и совет
   * воспользоваться data:-адресом или встроенным `TUWidget.uploadFileFromURL`.
   */
  T.uploadImageFromUrl = async (url, filename) => {
    let blob;
    try {
      blob = await (await fetch(url, { mode: 'cors' })).blob();
    } catch (e) {
      LOG('error', 'uploadImageFromUrl', 'не удалось скачать картинку из страницы редактора (CORS?) — передайте её как data:-адрес', { url: String(url).slice(0, 120), error: String(e.message) });
      throw new Error('SOURCE_FETCH_FAILED');
    }
    const name = filename || (String(url).split('/').pop() || 'upload.png').split('?')[0];
    return post(blob, name, endpoints().image);
  };

  LOG('info', 'install', 'API загрузки установлен', { endpoints: endpoints(), hasKeys: !!(window.Tildaupload_PUBLICKEY && window.Tildaupload_UPLOADKEY) });
  return { installed: ['uploadImageFromDataUrl', 'uploadImageFromUrl'], endpoints: endpoints() };
}
