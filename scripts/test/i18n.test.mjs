import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LangError, attachMessage, isMessage, messageText, msg, peekLang, pluralForm, render, renderError,
  resolveLang, systemLang, t,
} from '../lib/i18n.mjs';

describe('resolveLang', () => {
  it('флаг побеждает окружение', () => {
    const r = resolveLang({ flag: 'en', env: { TILDA_LANG: 'ru' }, locale: 'ru-RU' });
    assert.deepEqual(r, { lang: 'en', source: 'flag' });
  });

  it('окружение побеждает язык системы', () => {
    const r = resolveLang({ env: { TILDA_LANG: 'ru' }, locale: 'en-US' });
    assert.deepEqual(r, { lang: 'ru', source: 'env' });
  });

  it('пустой и пробельный TILDA_LANG считаются незаданными', () => {
    assert.equal(resolveLang({ env: { TILDA_LANG: '' }, locale: 'ru-RU' }).source, 'system');
    assert.equal(resolveLang({ env: { TILDA_LANG: '   ' }, locale: 'ru-RU' }).lang, 'ru');
  });

  it('язык системы: ru-RU → ru, en-US → en, uk-UA → en', () => {
    assert.equal(systemLang('ru-RU'), 'ru');
    assert.equal(systemLang('en-US'), 'en');
    assert.equal(systemLang('uk-UA'), 'en');
    assert.equal(resolveLang({ env: {}, locale: 'ru' }).lang, 'ru');
  });

  it('значение сравнивается без учёта регистра', () => {
    assert.equal(resolveLang({ env: { TILDA_LANG: 'RU' } }).lang, 'ru');
    assert.equal(resolveLang({ flag: ' En ', env: {} }).lang, 'en');
  });

  it('неверный флаг — LangError с кодом USAGE_ERROR и выходом 2', () => {
    assert.throws(() => resolveLang({ flag: 'de', env: {} }), (e) => {
      assert.ok(e instanceof LangError);
      assert.equal(e.code, 'USAGE_ERROR');
      assert.equal(e.name, 'UsageError');
      assert.equal(e.exitCode, 2);
      assert.equal(e.key, 'i18n.badFlag');
      assert.equal(e.message, '--lang expects en or ru, got de');
      return true;
    });
  });

  it('неверный TILDA_LANG — LangError с кодом CONFIG_ERROR и переменной', () => {
    assert.throws(() => resolveLang({ env: { TILDA_LANG: 'fr' } }), (e) => {
      assert.equal(e.code, 'CONFIG_ERROR');
      assert.equal(e.variable, 'TILDA_LANG');
      assert.equal(e.exitCode, 2);
      assert.equal(e.key, 'i18n.badEnv');
      assert.equal(e.message, 'TILDA_LANG expects en or ru, got fr');
      return true;
    });
  });
});

describe('peekLang', () => {
  it('находит --lang в двух формах', () => {
    assert.equal(peekLang(['--lang', 'ru', 'doctor'], {}, 'en-US'), 'ru');
    assert.equal(peekLang(['--lang=en'], {}, 'ru-RU'), 'en');
  });

  it('недопустимый флаг пропускается, дальше окружение', () => {
    assert.equal(peekLang(['--lang', 'xx'], { TILDA_LANG: 'ru' }, 'en-US'), 'ru');
  });

  it('не бросает на мусоре', () => {
    assert.equal(peekLang(undefined, { TILDA_LANG: 'zz' }, 'en-US'), 'en');
    assert.equal(peekLang(['--lang'], {}, 'ru-RU'), 'ru');
  });
});

describe('t', () => {
  it('подставляет именованный параметр', () => {
    assert.equal(t('ru', 'i18n.badFlag', { value: 'de' }), '--lang ждёт en или ru, получено de');
    assert.equal(t('en', 'i18n.badFlag', { value: 'de' }), '--lang expects en or ru, got de');
  });

  it('без параметра оставляет {имя}', () => {
    assert.equal(t('en', 'i18n.badFlag'), '--lang expects en or ru, got {value}');
  });

  it('неизвестный ключ возвращается как есть', () => {
    assert.equal(t('ru', 'i18n.noSuchKey'), 'i18n.noSuchKey');
  });

  it('13-значное число подставляется без разделителей', () => {
    assert.equal(t('ru', 'i18n.badFlag', { value: 1000000000001 }), '--lang ждёт en или ru, получено 1000000000001');
    assert.equal(t('en', 'i18n.badFlag', { value: 1000000000001 }), '--lang expects en or ru, got 1000000000001');
  });

  it('неизвестный язык — RangeError', () => {
    assert.throws(() => t('de', 'i18n.badFlag'), RangeError);
  });
});

describe('pluralForm', () => {
  it('ru: 1 → one, 3 → few, 5 → many, 21 → one', () => {
    assert.equal(pluralForm('ru', 1), 'one');
    assert.equal(pluralForm('ru', 3), 'few');
    assert.equal(pluralForm('ru', 5), 'many');
    assert.equal(pluralForm('ru', 21), 'one');
  });

  it('en: 1 → one, 2 → other', () => {
    assert.equal(pluralForm('en', 1), 'one');
    assert.equal(pluralForm('en', 2), 'other');
  });
});

describe('msg и render', () => {
  it('msg проверяет формат ключа', () => {
    assert.throws(() => msg('Bad Key'), TypeError);
    assert.throws(() => msg('nodots'), TypeError);
    assert.ok(isMessage(msg('i18n.badFlag', { value: 'x' })));
  });

  it('messageText даёт английский текст, строку не меняет', () => {
    assert.equal(messageText(msg('i18n.badFlag', { value: 'x' })), '--lang expects en or ru, got x');
    assert.equal(messageText('plain'), 'plain');
  });

  it('render переводит вложенные объекты и массивы, прочее не трогает', () => {
    const date = new Date(0);
    const out = render('ru', {
      a: msg('i18n.badFlag', { value: 'x' }),
      list: [msg('i18n.badEnv', { value: 'y' }), 5, 'text'],
      nested: { m: msg('i18n.badFlag', { value: 'z' }) },
      date,
      n: 7,
    });
    assert.equal(out.a, '--lang ждёт en или ru, получено x');
    assert.deepEqual(out.list, ['TILDA_LANG ждёт en или ru, получено y', 5, 'text']);
    assert.equal(out.nested.m, '--lang ждёт en или ru, получено z');
    assert.equal(out.date, date);
    assert.equal(out.n, 7);
  });

  it('параметр-Message переводится до подстановки', () => {
    const inner = msg('i18n.badFlag', { value: 'q' });
    const text = render('en', msg('i18n.unknownError', { code: 'X', message: inner }));
    assert.equal(text, 'X: --lang expects en or ru, got q');
  });

  it('attachMessage кладёт ключ и параметры в ошибку', () => {
    const e = attachMessage(new Error('boom'), msg('i18n.badFlag', { value: 'x' }));
    assert.equal(e.key, 'i18n.badFlag');
    assert.deepEqual(e.params, { value: 'x' });
    assert.equal(attachMessage(new Error('plain'), 'text').key, undefined);
  });
});

describe('renderError', () => {
  it('ошибка с ключом переводится', () => {
    const e = attachMessage(new Error('x'), msg('i18n.badFlag', { value: 'de' }));
    assert.equal(renderError('ru', e), '--lang ждёт en или ru, получено de');
  });

  it('ошибка без ключа — КОД: английский текст', () => {
    const e = Object.assign(new Error('something broke'), { code: 'SOME_CODE' });
    assert.equal(renderError('ru', e), 'SOME_CODE: something broke');
    assert.equal(renderError('en', new TypeError('bad')), 'TypeError: bad');
  });
});
