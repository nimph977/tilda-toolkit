// Браузерный слой: команды уровня проекта и публикация страницы.
// Выполняется ВНУТРИ страницы редактора: scripts/lib/browser.mjs читает файл с диска и ставит
// его через page.evaluate. Ставит API на window.__tilda (совместно с tilda-zero/tilda-page).
//
// Команды уровня проекта идут на /projects/submit/ и требуют csrf=getCSRF() (проверено
// 2026-09-09); getCSRF() есть и в редакторе страницы.
//
//   POST /projects/submit/  comm=dublicatepage&pageid&csrf                                  → новый pageid строкой
//                           (исчерпан лимит страниц — текст с подстрокой «you created maximum»)
//   POST /projects/submit/  comm=addnewpagedublicateexample&projectid&examplepageid=1231&folderid&csrf → новый pageid
//   POST /page/publish/     comm=pagepublish&pageid&csrf&returnjson=yes                     → JSON {link, linkstr, wslink, customdomain}
//   POST /projects/get/getprojects/  comm=getprojectslist&projectid (без csrf)               → JSON {pages[], project{...}, ...}
//
// Свой шрифт проекта — прочитано 2026-09-24 со страницы /projects/fontsupload/?projectid=<id>
// (td-inner-fontsupload.min.js: td__fontsupload__save → serializeArray(form) + csrf → td__submit; toString, только чтение):
//   POST /projects/submit/  comm=editprojectfontsupload&projectid&myfont_name=<имя>&myfont_<вес>=<url .woff>…
//                           [&myfont_woff2_<вес>=<url .woff2>][&myfont_vf=<url>][&myfont_woff2_vf=<url>]
//                           [&set_ff_to_h=on][&set_ff_to_t=on]&csrf                              → "OK" (иначе текст ошибки)
//        веса: 100…900 и vf; поля пустых весов шлются пустыми (форма отправляется целиком, serializeArray);
//        второй и третий шрифт — суффикс _2/_3 после myfont: myfont_2_name, myfont_2_<вес>, set_ff_2_to_h;
//        флажки set_ff_to_h / set_ff_to_t — «назначить шрифт заголовков / текста» (в теле только отмеченные,
//        значение on); файлы — ссылки на CDN Tilda (страница грузит их через TUWidget), сами файлы не шлются;
//        кодировка тела — application/x-www-form-urlencoded (td__encodeData).
//   myfonts_json (getsitesettings → значение строкой JSON): массив, по объекту на шрифт:
//        [{f_name, f_100…f_900, f_vf, f_woff2_100…f_woff2_900, f_woff2_vf, cnt}] — пустой вес = "",
//        cnt — число заполненных файлов; форма загрузки читает его же (getfontsupload → project.myfonts_json).
//
// Заголовок страницы — прочитано 2026-09-24 из окна настроек страницы редактора
// (showformEditPageSettings(pageid) → td-pagesettings-all.min.js: td__pagesettings__addEvents; toString, только чтение):
//   POST /projects/submit/  comm=savepagesettings&pageid&test=test4.0&title&descr&alias&img…&fb_*&twitter_site&meta_*
//                           &link_canonical&[nosearch|animationoff|noadaptive|noheader|nofooter…=on]&csrf&jssubmit=y → "OK"
//        (заголовок страницы; способ записи: форма — запрос несёт ВСЕ настройки страницы, прямой запрос с одним
//        title затёр бы остальные; слой заполняет input#modalinputtitle (name=title) в #popup_pagesettings
//        и отправляет form#formpageedit, ответ ловит Node через callWithResponse; после OK редактор
//        перезагружает страницу)
//   POST /projects/get/getpagesettings/  comm=getpagesettings&pageid&js=js3page&csrf → JSON {page{…}, project{…}, folders, owner}
//
// Адрес страницы — проба 2026-09-24 в том же окне (td__pagesettings__addEvents, tc__clearPageAlias; toString,
// запись только в черновые страницы тестового проекта, адрес возвращён к пустому):
//   поле input#popup-ps-input-alias (name=alias) формы #formpageedit; значение без ведущего "/" (перед полем
//        выводится адрес сайта со "/"); уходит тем же savepagesettings, что и заголовок;
//   перед отправкой редактор чистит значение tc__clearPageAlias: нижний регистр, только [a-z0-9_-|/],
//        ведущие "/" срезаются, повторы "/" схлопываются, завершающий "/" остаётся ("/Probe-Y/" → "probe-y/");
//   ответ: "OK" (или пусто) — сохранено; адрес другой страницы проекта → "<p>Указанный адрес страницы уже занят</p>"
//        (текст выводится в .td-popup-error, окно не закрывается); пустой адрес — "OK", страница снова page<id>.html.
//
// Публикация прочитана 2026-09-11 из TPPublishModal.prototype.publish (toString, read-only):
// URL относительный — на tilda.ru, где живут все проверенные команды; в tilda-editor-api.md
// (чужой код) домен tilda.cc и тело pageid&projectid — неверно. Перед запросом редактор
// сбрасывает несохранённый порядок блоков (tp__saveRecordsSort) — у нас несохранённого нет.
//
// Публикация — только по явной команде пользователя (AGENTS.md): без маркера
// подтверждения слой отказывает ДО отправки запроса. Второй такой же guard — в Node
// (scripts/page-ops.mjs); ни один из двух не ослабляется. Ответы слой отдаёт сырым текстом,
// разбор — в Node, чтобы он проверялся тестами без сети.
() => {
  const T = (window.__tilda = window.__tilda || {});
  const LOG = (level, fn, msg, data) => console[level](`[tilda-project.${fn}] ${msg}`, data === undefined ? '' : JSON.stringify(data));

  /** Маркер подтверждения публикации — тот же, что в scripts/page-ops.mjs (PUBLISH_CONFIRM). */
  T.PUBLISH_CONFIRM = 'publish';
  T.BLANK_EXAMPLE_PAGE = '1231';

  const looksLikeHtml = (text) => /^\s*<|<html|<!doctype/i.test(text.slice(0, 300));

  /**
   * csrf берётся ровно так, как это делает сам редактор (delPage, TPPublishModal.publish):
   * значение getCSRF() как есть. В редакторе страницы meta#csrf пуста и getCSRF() отдаёт
   * «err. is empty. » — сервер это принимает (проба 3 от 2026-09-09 создала страницу из
   * редактора этим же путём). Отказ только если функции нет вовсе. Сам токен в лог не пишется.
   */
  const csrf = (fn) => {
    if (typeof getCSRF !== 'function') {
      LOG('error', fn, 'getCSRF() is missing on the page, is this a Tilda editor?');
      throw new Error(`NO_CSRF ${fn}`);
    }
    const value = String(getCSRF());
    LOG('debug', fn, 'csrf', { kind: /^err\.|^notset$/.test(value) ? `stub "${value.trim()}" (meta#csrf is empty, as in the editor itself)` : 'token', length: value.length });
    return value;
  };

  /** logHead=false — не писать начало ответа в консоль: в нём служебные ключи (listPages). */
  const post = async (url, params, fn, { logHead = true, logBody = true } = {}) => {
    const body = new URLSearchParams(params).toString();
    LOG('debug', fn, 'request', { url, ...(logBody ? { body } : { bodyBytes: body.length }) });
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    const text = await r.text();
    if (looksLikeHtml(text)) {
      LOG('error', fn, 'SESSION_LOST: got HTML instead of data (login page?)', { url, status: r.status });
      throw new Error(`SESSION_LOST ${url} status=${r.status}`);
    }
    LOG('debug', fn, 'response', { status: r.status, bytes: text.length, ...(logHead ? { head: text.slice(0, 200) } : {}) });
    return { status: r.status, text };
  };

  /**
   * Перечень страниц проекта — прочитано 2026-09-23 из td__projectslist__loadList (toString,
   * read-only): тем же запросом кабинет рисует страницу проекта. CSRF кабинет не шлёт — и мы нет.
   * Ответ — JSON с pages[] и project{...} плюс служебные ключи (csrf, jwt, upload key): слой отдаёт
   * текст как есть и не пишет его в консоль; разбор и отбор полей — в Node (scripts/page-list.mjs).
   * emptyMarker — заглушка пустого проекта .td-project-nopages (td__project__drawPages).
   */
  T.listPages = async (projectid) => {
    projectid = String(projectid || window.projectid);
    LOG('debug', 'listPages', 'request', { projectid });
    const r = await post('/projects/get/getprojects/', { comm: 'getprojectslist', projectid }, 'listPages', { logHead: false });
    const emptyMarker = Boolean(document.querySelector('.td-project-nopages'));
    LOG('info', 'listPages', 'response received', { status: r.status, bytes: r.text.length, emptyMarker });
    return { source: 'api', status: r.status, text: r.text, emptyMarker };
  };

  /** В сессии с allow-списком записи (донор) операции уровня проекта запрещены целиком: у них нет pageid для проверки. */
  const assertProjectWritable = (fn) => {
    if (Array.isArray(T.writablePages)) {
      LOG('error', fn, 'project-level operation is forbidden in a session with a write allowlist', { writablePages: T.writablePages });
      throw new Error(`WRITE_NOT_ALLOWED project (${fn})`);
    }
  };

  /** Дубль страницы: источник только читается, поэтому защита protectedPages здесь не применяется. */
  T.duplicatePage = async (pageid) => {
    assertProjectWritable('duplicatePage');
    pageid = String(pageid || window.pageid);
    const r = await post('/projects/submit/', { comm: 'dublicatepage', pageid, csrf: csrf('duplicatePage') }, 'duplicatePage');
    LOG('info', 'duplicatePage', 'response received', { pageid, status: r.status, text: r.text.slice(0, 120) });
    return { source: pageid, status: r.status, text: r.text };
  };

  /** Пустая страница из шаблона «Пустая страница» (examplepageid=1231; проверено 2026-09-09). */
  T.createPage = async (projectid, examplepageid) => {
    assertProjectWritable('createPage');
    projectid = String(projectid || window.projectid);
    examplepageid = String(examplepageid || T.BLANK_EXAMPLE_PAGE);
    const r = await post('/projects/submit/', { comm: 'addnewpagedublicateexample', projectid, examplepageid, folderid: '', csrf: csrf('createPage') }, 'createPage');
    LOG('info', 'createPage', 'response received', { projectid, examplepageid, status: r.status, text: r.text.slice(0, 120) });
    return { projectid, status: r.status, text: r.text };
  };

  /**
   * Публикация страницы. confirm обязан равняться T.PUBLISH_CONFIRM — иначе отказ ДО запроса.
   * Никогда не вызывается как побочный эффект другой операции.
   */
  T.publishPage = async (pageid, confirm) => {
    assertProjectWritable('publishPage');
    pageid = String(pageid || '');
    if (!pageid) throw new Error('PUBLISH_NO_PAGE: the page is not specified');
    if (confirm !== T.PUBLISH_CONFIRM) {
      LOG('warn', 'publishPage', 'publish without confirmation: refused before sending the request', { pageid });
      throw new Error(`PUBLISH_NOT_CONFIRMED ${pageid}`);
    }
    const r = await post('/page/publish/', { comm: 'pagepublish', pageid, csrf: csrf('publishPage'), returnjson: 'yes' }, 'publishPage');
    LOG('info', 'publishPage', 'response received', { pageid, status: r.status, text: r.text.slice(0, 200) });
    return { pageid, status: r.status, text: r.text };
  };

  /** Маркер подтверждения назначения шапки/подвала — тот же, что в scripts/page-role.mjs (ROLE_CONFIRM). */
  T.ROLE_CONFIRM = 'assign';
  const ROLE_FIELDS = ['headerpageid', 'footerpageid', 'indexpageid'];
  /** Вкладка настроек, на которой есть select роли (проба 2026-09-24). */
  const ROLE_TAB = { headerpageid: 'ss_menu_header', footerpageid: 'ss_menu_header', indexpageid: 'ss_menu_index' };

  /** Первые 16 hex-символов sha256 строки. */
  const fingerprint = async (value) => {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  };

  /**
   * Настройки проекта для сравнения «до/после» (проба 2026-09-23): в DOM вкладки видно
   * 16 элементов из 73, а полный набор кабинет берёт тем же запросом getsitesettings (comm, projectid,
   * без csrf) — объект project, 46 ключей. Наружу уходят только отпечатки значений; открыто —
   * лишь роли и списки опций select#headerpageid / select#footerpageid (страница настроек,
   * вкладка «Шапка и подвал»). В ответе также csrf и useruploadkey — они не читаются и не пишутся.
   */
  T.readProjectSettings = async (projectid) => {
    projectid = String(projectid || window.projectid);
    const r = await post('/projects/get/getsitesettings/', { comm: 'getsitesettings', projectid }, 'readProjectSettings', { logHead: false });
    let project;
    try {
      project = JSON.parse(r.text).project;
    } catch (e) {
      LOG('error', 'readProjectSettings', 'response is not JSON', { status: r.status, bytes: r.text.length });
      throw new Error(`SETTINGS_PARSE_FAILED status=${r.status}`);
    }
    if (!project || typeof project !== 'object') throw new Error('SETTINGS_PARSE_FAILED: no project in the response');
    const fingerprints = {};
    for (const [name, value] of Object.entries(project)) {
      fingerprints[name] = await fingerprint(typeof value === 'string' ? value : JSON.stringify(value));
    }
    const options = (id) => {
      const el = document.getElementById(id);
      return el && el.options ? [...el.options].map((o) => o.value) : null;
    };
    const result = {
      count: Object.keys(fingerprints).length,
      fingerprints,
      headerpageid: String(project.headerpageid ?? ''),
      footerpageid: String(project.footerpageid ?? ''),
      indexpageid: String(project.indexpageid ?? ''),
      headerOptions: options('headerpageid'),
      footerOptions: options('footerpageid'),
      indexOptions: options('indexpageid'),
    };
    LOG('info', 'readProjectSettings', 'settings read', { count: result.count, headerpageid: result.headerpageid, footerpageid: result.footerpageid, indexpageid: result.indexpageid });
    return result;
  };

  /**
   * Назначение шапки/подвала или главной так, как это делает сам кабинет: выставить select
   * на вкладке поля (ROLE_TAB) и нажать «Сохранить изменения» — страница сама отправит все настройки
   * текущими значениями. confirm обязан равняться T.ROLE_CONFIRM — иначе отказ ДО изменения формы.
   * Ответ сервера ловит Node (callWithResponse).
   */
  T.setPageRoles = async ({ headerpageid, footerpageid, indexpageid, confirm } = {}) => {
    assertProjectWritable('setPageRoles');
    if (confirm !== T.ROLE_CONFIRM) {
      LOG('warn', 'setPageRoles', 'assignment without confirmation: refused before changing the form');
      throw new Error('ROLE_NOT_CONFIRMED');
    }
    const wanted = { headerpageid, footerpageid, indexpageid };
    for (const name of ROLE_FIELDS) {
      const value = wanted[name];
      if (value === undefined || value === null) continue;
      const el = document.getElementById(name);
      if (!el) throw new Error(`NO_CONTROL ${name}: open the tab #tab=${ROLE_TAB[name]}`);
      if (![...el.options].some((o) => o.value === String(value))) throw new Error(`NOT_IN_OPTIONS ${name} ${value}`);
    }
    for (const name of ROLE_FIELDS) {
      const value = wanted[name];
      if (value === undefined || value === null) continue;
      const el = document.getElementById(name);
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const button = [...document.querySelectorAll('button[type="submit"]')]
      .find((b) => /Сохранить изменения/.test(b.textContent || '') && (b.offsetWidth || b.offsetHeight));
    if (!button) throw new Error('NO_SAVE_BUTTON: the Save changes button was not found');
    LOG('info', 'setPageRoles', 'roles set, saving', { headerpageid, footerpageid, indexpageid });
    button.click();
    return { clicked: true };
  };

  /**
   * Оформление проекта: значения ключей шрифтов и цветов
   * из getsitesettings, отпечатки всех настроек и имена пресетов шрифтов вкладки «Шрифты» (если
   * она открыта). Прочие настройки наружу не уходят — только отпечатки.
   */
  T.PROJECT_STYLE_KEYS = ['headlinefont', 'headlinefontweight', 'headlinecolor', 'textfont', 'textfontweight', 'textfontsize', 'textcolor', 'linkcolor', 'linkfontweight', 'linklinecolor', 'linklineheight', 'bgcolor', 'myfonts_json'];
  T.readProjectStyle = async (projectid) => {
    projectid = String(projectid || window.projectid);
    const r = await post('/projects/get/getsitesettings/', { comm: 'getsitesettings', projectid }, 'readProjectStyle', { logHead: false });
    let project;
    try {
      project = JSON.parse(r.text).project;
    } catch (e) {
      LOG('error', 'readProjectStyle', 'response is not JSON', { status: r.status, bytes: r.text.length });
      throw new Error(`SETTINGS_PARSE_FAILED status=${r.status}`);
    }
    if (!project || typeof project !== 'object') throw new Error('SETTINGS_PARSE_FAILED: no project in the response');
    const values = {};
    for (const k of T.PROJECT_STYLE_KEYS) {
      const v = project[k];
      values[k] = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }
    const fingerprints = {};
    for (const [name, value] of Object.entries(project)) fingerprints[name] = await fingerprint(typeof value === 'string' ? value : JSON.stringify(value));
    const presets = [...document.querySelectorAll('button')]
      .filter((b) => /Выбрать|Выбрано/.test(b.textContent || ''))
      .map((b) => ((b.parentElement?.parentElement?.innerText || '').replace(/\s+/g, ' ').match(/Заголовки: (.+?) Текст: (.+?) Выбра/) || [])[1])
      .filter(Boolean);
    LOG('info', 'readProjectStyle', 'style read', { count: Object.keys(fingerprints).length, presets: presets.length });
    return { values, fingerprints, count: Object.keys(fingerprints).length, presets };
  };

  /** Веса формы загрузки шрифтов: форма шлёт все поля, пустые — пустой строкой (serializeArray). */
  T.FONT_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'vf'];

  /**
   * Свой шрифт проекта (протокол — в шапке файла): имя, файлы по весам ссылками на CDN, флажки
   * «шрифт заголовков» / «шрифт текста». Тело повторяет форму /projects/fontsupload/ целиком —
   * незаполненные веса пустыми строками. Ответ — сырой текст ("OK"), разбор в Node.
   * Адреса файлов в консоль не пишутся (logBody: false) — в них путь проекта донора.
   */
  T.uploadProjectFont = async ({ projectid, name, files, asHeadline = false, asText = false } = {}) => {
    assertProjectWritable('uploadProjectFont');
    projectid = String(projectid || window.projectid);
    if (!name || !files || typeof files !== 'object' || !Object.keys(files).length) throw new Error('FONT_NO_FILES: a font name and at least one file are required');
    const params = { comm: 'editprojectfontsupload', projectid };
    for (const w of T.FONT_WEIGHTS) {
      params[`myfont_${w}`] = String(files[w] || '');
      params[`myfont_woff2_${w}`] = String(files[`woff2_${w}`] || '');
    }
    params.myfont_name = String(name);
    if (asHeadline) params.set_ff_to_h = 'on';
    if (asText) params.set_ff_to_t = 'on';
    params.csrf = csrf('uploadProjectFont');
    const r = await post('/projects/submit/', params, 'uploadProjectFont', { logHead: true, logBody: false });
    LOG('info', 'uploadProjectFont', 'response received', { name, weights: Object.keys(files).length, asHeadline, asText, status: r.status, head: r.text.slice(0, 80) });
    return { name, status: r.status, text: r.text };
  };

  T.TITLE_MAX = 200;

  /**
   * Заголовок страницы через окно настроек страницы (протокол — в шапке файла: запрос
   * savepagesettings несёт все настройки, поэтому заполняется форма, а не шлётся один title).
   * Открывает окно тем обработчиком, что есть на странице: на странице проекта —
   * td__showform__EditPageSettings (после OK редактор обновляет список без перезагрузки — путь
   * по умолчанию), в редакторе — showformEditPageSettings (после OK страница перезагружается).
   * Ответ ловит Node через callWithResponse (urlPart /projects/submit/, bodyPart comm=savepagesettings).
   */
  /**
   * Общий путь записи одного поля окна настроек страницы (заголовок, адрес): открыть окно тем
   * обработчиком, что есть на странице, дождаться поля, сверить pageid формы, заполнить поле и
   * отправить #formpageedit. Возвращает прежнее значение поля.
   */
  const submitPageSetting = async (fn, pageid, selectors, value, { timeoutMs, missingCode }) => {
    const opener = typeof td__showform__EditPageSettings === 'function' ? td__showform__EditPageSettings : typeof showformEditPageSettings === 'function' ? showformEditPageSettings : null;
    if (!opener) throw new Error('NO_PAGE_SETTINGS: the page has no handler for the page settings window');
    LOG('debug', fn, 'opening the settings window', { pageid, length: value.length });
    opener(pageid);
    const deadline = Date.now() + timeoutMs;
    let input = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const popup = document.querySelector('#popup_pagesettings');
      if (!popup || document.querySelector('#pagesettingsloader')) continue;
      input = selectors.map((s) => popup.querySelector(s)).find(Boolean) || null;
      if (input) break;
    }
    if (!input) throw new Error(`${missingCode}: the page settings window did not open in time`);
    const pageInput = document.querySelector('#formpageedit [name="pageid"]');
    if (pageInput && String(pageInput.value) !== pageid) throw new Error(`WRONG_PAGE_SETTINGS ${pageInput.value} instead of ${pageid}`);
    const previous = input.value;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const form = document.getElementById('formpageedit');
    if (!form) throw new Error('NO_PAGE_FORM: the formpageedit form is missing');
    LOG('info', fn, 'form filled, saving', { pageid, previousLength: previous.length, length: value.length });
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return previous;
  };

  T.setPageTitle = async (pageid, title, { timeoutMs = 30_000 } = {}) => {
    assertProjectWritable('setPageTitle');
    pageid = String(pageid);
    title = String(title ?? '');
    if (!title.trim()) throw new Error('TITLE_EMPTY: the title is empty');
    if (title.length > T.TITLE_MAX) throw new Error(`TITLE_TOO_LONG ${title.length} > ${T.TITLE_MAX}`);
    if (typeof T.assertWritable === 'function') T.assertWritable(pageid, 'setPageTitle');
    const previous = await submitPageSetting('setPageTitle', pageid, ['#modalinputtitle', 'input[name="title"]'], title, { timeoutMs, missingCode: 'NO_TITLE_INPUT' });
    return { pageid, submitted: true, previousLength: previous.length };
  };

  /**
   * Адрес страницы через то же окно настроек (протокол — в шапке файла). Значение — без ведущего "/";
   * редактор сам чистит его tc__clearPageAlias. Ответ «адрес занят» разбирает Node (page-ops).
   */
  T.setPageAlias = async (pageid, alias, { timeoutMs = 30_000 } = {}) => {
    assertProjectWritable('setPageAlias');
    pageid = String(pageid);
    alias = String(alias ?? '');
    if (!alias.trim()) throw new Error('ALIAS_EMPTY: the address is empty');
    if (typeof T.assertWritable === 'function') T.assertWritable(pageid, 'setPageAlias');
    const previous = await submitPageSetting('setPageAlias', pageid, ['#popup-ps-input-alias', 'input[name="alias"]'], alias, { timeoutMs, missingCode: 'NO_ALIAS_INPUT' });
    return { pageid, submitted: true, previous };
  };

  /** Нажать видимую «Сохранить изменения» страницы настроек (ответ ловит Node). */
  T.clickSaveSettings = () => {
    assertProjectWritable('clickSaveSettings');
    const button = [...document.querySelectorAll('button')].find((b) => /Сохранить изменения/.test(b.textContent || '') && (b.offsetWidth || b.offsetHeight));
    if (!button) throw new Error('NO_SAVE_BUTTON: the Save changes button was not found');
    button.click();
    return { clicked: true };
  };

  LOG('info', 'install', 'API installed', { pageid: window.pageid, projectid: window.projectid });
  return {
    installed: ['duplicatePage', 'createPage', 'publishPage', 'listPages', 'readProjectSettings', 'setPageRoles', 'readProjectStyle', 'clickSaveSettings', 'uploadProjectFont', 'setPageTitle', 'setPageAlias'],
    pageid: window.pageid,
    projectid: window.projectid,
  };
}
