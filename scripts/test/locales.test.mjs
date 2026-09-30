import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { KEY_PATTERN } from '../lib/i18n.mjs';
import { listSourceFiles, scanSource } from './literal-scan.mjs';
import { ROOT } from './product-files.mjs';

/** Пространства имён ключей: модуль-источник текста. */
const NAMESPACES = [
  'cli', 'doctor', 'setup', 'site', 'paths', 'config', 'browser', 'skillInstall', 'i18n', 'report',
  'apply', 'cycle', 'zero', 'list', 'snapshot', 'upload', 'journal', 'shot', 'pageOps', 'pageRole',
  'pageList', 'promote', 'stage', 'projectStyle', 'donorCopy', 'donorStyle', 'calibrate', 'layout',
];

/**
 * Семейства ключей, которые собираются из кода и суффикса: префикс → функция, возвращающая
 * ожидаемый набор суффиксов. Остальные ключи пишутся в коде целиком одним литералом.
 */
const DYNAMIC_KEY_FAMILIES = {};

/** Литералы, похожие на ключи, но ключами не являющиеся: значение → причина. */
const NOT_KEYS = {
  'cycle.apply': 'метка источника снимка для snapshotBlocks',
  'cycle.preview': 'метка источника снимка для snapshotBlocks',
};

const CALLEES_WITHOUT_KEYS = new Set(['createLogger', 'import', 'require']);
const FILE_NAME = /\.(m?js|json|md|png)$/;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const CYRILLIC = /[А-Яа-яЁё]/;

function readDictionary(lang) {
  return JSON.parse(readFileSync(join(ROOT, 'locales', lang + '.json'), 'utf8'));
}

const en = readDictionary('en');
const ru = readDictionary('ru');

function placeholders(value) {
  const forms = typeof value === 'string' ? [value] : Object.values(value);
  const names = new Set();
  for (const form of forms) {
    for (const match of String(form).matchAll(PLACEHOLDER)) names.add(match[1]);
  }
  return [...names].sort();
}

function isKeyLike(value) {
  return KEY_PATTERN.test(value) && NAMESPACES.includes(value.split('.')[0]);
}

/** Литералы-ключи в коде: ключ → список `файл:строка`. */
function usedKeys() {
  const used = new Map();
  for (const file of listSourceFiles(ROOT)) {
    const name = relative(ROOT, file).replace(/\\/g, '/');
    for (const literal of scanSource(readFileSync(file, 'utf8')).literals) {
      if (literal.hasSubst || !isKeyLike(literal.value)) continue;
      if (CALLEES_WITHOUT_KEYS.has(literal.callee) || FILE_NAME.test(literal.value)) continue;
      if (Object.prototype.hasOwnProperty.call(NOT_KEYS, literal.value)) continue;
      if (!used.has(literal.value)) used.set(literal.value, []);
      used.get(literal.value).push(name + ':' + literal.line);
    }
  }
  return used;
}

describe('locales', () => {
  it('в en.json и ru.json одинаковый набор ключей', () => {
    const onlyEn = Object.keys(en).filter((key) => !(key in ru));
    const onlyRu = Object.keys(ru).filter((key) => !(key in en));
    assert.deepEqual({ onlyEn, onlyRu }, { onlyEn: [], onlyRu: [] });
  });

  it('у пары одинаковые подстановки {name}', () => {
    const diff = [];
    for (const key of Object.keys(en)) {
      if (!(key in ru)) continue;
      const a = placeholders(en[key]);
      const b = placeholders(ru[key]);
      if (a.join() !== b.join()) diff.push(`${key}: en {${a.join(',')}} vs ru {${b.join(',')}}`);
    }
    assert.deepEqual(diff, []);
  });

  it('формы множественного числа: en — one/other, ru — one/few/many/other', () => {
    const problems = [];
    const expected = { en: ['one', 'other'], ru: ['few', 'many', 'one', 'other'] };
    for (const key of Object.keys(en)) {
      if (!(key in ru)) continue;
      const enPlural = typeof en[key] === 'object';
      const ruPlural = typeof ru[key] === 'object';
      if (enPlural !== ruPlural) problems.push(`${key}: plural forms in only one dictionary`);
      if (enPlural && Object.keys(en[key]).sort().join() !== expected.en.join()) {
        problems.push(`${key}: en forms must be ${expected.en.join('/')}`);
      }
      if (ruPlural && Object.keys(ru[key]).sort().join() !== expected.ru.join()) {
        problems.push(`${key}: ru forms must be ${expected.ru.join('/')}`);
      }
      if ((enPlural || ruPlural) && !placeholders(en[key]).includes('count')) {
        problems.push(`${key}: plural entry must use {count}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('каждый ключ проходит формат и живёт в известном пространстве имён', () => {
    const bad = [];
    for (const key of new Set([...Object.keys(en), ...Object.keys(ru)])) {
      if (!KEY_PATTERN.test(key)) bad.push(`${key}: bad format`);
      else if (!NAMESPACES.includes(key.split('.')[0])) bad.push(`${key}: unknown namespace`);
    }
    assert.deepEqual(bad, []);
  });

  it('в en.json нет кириллицы', () => {
    const bad = [];
    for (const [key, value] of Object.entries(en)) {
      const forms = typeof value === 'string' ? [value] : Object.values(value);
      if (forms.some((form) => CYRILLIC.test(form))) bad.push(key);
    }
    assert.deepEqual(bad, []);
  });

  it('каждый ключ, записанный в коде литералом, есть в en.json', () => {
    const unknown = [];
    for (const [key, places] of usedKeys()) {
      if (!(key in en)) unknown.push(`${key} (${places.join(', ')})`);
    }
    assert.deepEqual(unknown, []);
  });

  it('семейства динамических ключей совпадают со словарём', () => {
    const problems = [];
    for (const [prefix, expectedSuffixes] of Object.entries(DYNAMIC_KEY_FAMILIES)) {
      const expected = expectedSuffixes().map((suffix) => prefix + suffix).sort();
      const actual = Object.keys(en).filter((key) => key.startsWith(prefix)).sort();
      const missing = expected.filter((key) => !actual.includes(key));
      const extra = actual.filter((key) => !expected.includes(key));
      if (missing.length || extra.length) problems.push({ prefix, missing, extra });
    }
    assert.deepEqual(problems, []);
  });

  it('неиспользуемых ключей в en.json нет', () => {
    const used = usedKeys();
    const prefixes = Object.keys(DYNAMIC_KEY_FAMILIES);
    const unused = Object.keys(en).filter(
      (key) => !used.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)),
    );
    assert.deepEqual(unused, []);
  });
});

describe('literal-scan', () => {
  it('«//» внутри строки — не комментарий', () => {
    const { literals, comments } = scanSource("const u = 'http://x'; // note\n");
    assert.deepEqual(literals.map((l) => l.value), ['http://x']);
    assert.deepEqual(comments, [{ line: 1, text: 'note' }]);
  });

  it("регулярное выражение /'/ не открывает строку", () => {
    const { literals } = scanSource("const r = /'/; const s = 'a';\n");
    assert.deepEqual(literals.map((l) => l.value), ['a']);
  });

  it('класс символов в регулярке может содержать слэш и кавычку', () => {
    const { literals } = scanSource("const r = /[/']x/g; const s = 'b';\n");
    assert.deepEqual(literals.map((l) => l.value), ['b']);
  });

  it('деление не принимается за регулярку', () => {
    const { literals } = scanSource("const a = (x / 2) + y / 3; const s = 'c';\n");
    assert.deepEqual(literals.map((l) => l.value), ['c']);
  });

  it('шаблон с подстановкой: вложенный литерал получает свой вызов', () => {
    const BT = '`';
    const { literals } = scanSource(BT + "a ${ f('x') } b" + BT + '\n');
    const inner = literals.find((l) => l.value === 'x');
    const outer = literals.find((l) => l.kind === 'template');
    assert.equal(inner.callee, 'f');
    assert.equal(outer.hasSubst, true);
    assert.equal(outer.value, 'a ${} b');
  });

  it('callee: log.warn и new Error', () => {
    const { literals } = scanSource("log.warn('m', 'текст');\nthrow new Error('boom');\n");
    assert.deepEqual(literals.map((l) => [l.value, l.callee]), [
      ['m', 'log.warn'], ['текст', 'log.warn'], ['boom', 'Error'],
    ]);
  });

  it('блочный комментарий разбирается по строкам, номера строк сохраняются', () => {
    const { literals, comments } = scanSource('/**\n * первая\n * вторая\n */\nconst s = "d";\n');
    assert.deepEqual(comments.filter((c) => c.text).map((c) => [c.line, c.text]), [[2, 'первая'], [3, 'вторая']]);
    assert.equal(literals[0].line, 5);
  });

  it('экранирование в строке', () => {
    const { literals } = scanSource("const s = 'it\\'s \\n ok';\n");
    assert.equal(literals[0].value, "it's \n ok");
  });
});
