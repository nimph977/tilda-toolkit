/**
 * Файлы для участников не пропадают и не ломаются молча: формы issue держат порядок ключей
 * и обязательные поля, запрет пустых issue и адрес приватных сообщений об уязвимостях стоят
 * на месте, CONTRIBUTING.md и шаблон PR называют проверки перед отправкой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './product-files.mjs';

const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const BUG_REPORT = '.github/ISSUE_TEMPLATE/bug_report.yml';
const FEATURE_REQUEST = '.github/ISSUE_TEMPLATE/feature_request.yml';
const CONFIG = '.github/ISSUE_TEMPLATE/config.yml';
const ADVISORY_URL = 'https://github.com/nimph977/tilda-toolkit/security/advisories/new';

/** Блок поля формы: от `id: <id>` до следующего `  - type:` или конца файла. */
function fieldBlock(text, id) {
  const from = text.indexOf(`id: ${id}\n`);
  assert.notEqual(from, -1, `${BUG_REPORT}: нет поля ${id}`);
  const rest = text.slice(from);
  const next = rest.indexOf('\n  - type:');
  return next === -1 ? rest : rest.slice(0, next);
}

test('issue forms declare name, description and body in order', () => {
  for (const file of [BUG_REPORT, FEATURE_REQUEST]) {
    assert.match(read(file), /^name: .+\ndescription: .+\ntitle: .+\nlabels: \[.+\]\nbody:\n/, file);
  }
});

test('bug report form requires version, os, node, command and doctor output', () => {
  const text = read(BUG_REPORT);
  for (const id of ['version', 'os', 'node', 'command', 'doctor', 'actual', 'expected']) {
    assert.match(fieldBlock(text, id), /required: true/, `${BUG_REPORT}: поле ${id} не обязательное`);
  }
});

test('blank issues are off and vulnerabilities go to private advisories', () => {
  const config = read(CONFIG);
  assert.match(config, /^blank_issues_enabled: false$/m);
  assert.ok(config.includes(ADVISORY_URL), `${CONFIG}: нет адреса ${ADVISORY_URL}`);
  assert.ok(read('SECURITY.md').includes(ADVISORY_URL), `SECURITY.md: нет адреса ${ADVISORY_URL}`);
});

test('changelog has a dated section for the package version', () => {
  const { version } = JSON.parse(read('package.json'));
  const changelog = read('CHANGELOG.md');
  const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
  assert.match(changelog, heading, `нет раздела ## [${version}] - дата`);
  const unreleased = changelog.indexOf('## [Unreleased]');
  assert.notEqual(unreleased, -1, 'CHANGELOG.md: нет раздела ## [Unreleased]');
  assert.ok(unreleased < changelog.search(heading), 'CHANGELOG.md: Unreleased должен стоять выше раздела версии');
  const link = `[${version}]: https://github.com/nimph977/tilda-toolkit/releases/tag/v${version}`;
  assert.ok(changelog.includes(link), `CHANGELOG.md: нет строки ссылки ${link}`);
});

test('contributing lists the checks a pull request runs', () => {
  const contributing = read('CONTRIBUTING.md');
  for (const needle of ['npm test', 'TILDA_LANG=ru npm test', 'locales/en.json', 'locales/ru.json']) {
    assert.ok(contributing.includes(needle), `CONTRIBUTING.md: нет «${needle}»`);
  }
  const template = read('.github/pull_request_template.md');
  for (const needle of ['npm test', 'TILDA_LANG=ru npm test']) {
    assert.ok(template.includes(needle), `pull_request_template.md: нет «${needle}»`);
  }
});
