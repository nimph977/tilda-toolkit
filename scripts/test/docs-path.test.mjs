/**
 * Разбор страницы «Начало работы»: блок команд пути и запрос агенту на синтетическом тексте.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MARKERS,
  PATH_MARKERS,
  REPO_URL,
  SITE_EXAMPLE,
  SYNTHETIC_PROJECT,
  DocPathError,
  buildRunScript,
  checkAgentPrompt,
  extractFenced,
  normalizeForParity,
  parsePathCommands,
  parseRunCodes,
} from './docs-path.mjs';

const FENCE = '```';
const COMMANDS = [
  `git clone ${REPO_URL}`,
  'cd tilda-toolkit',
  'npm ci',
  `node scripts/tilda.mjs setup --site ${SITE_EXAMPLE} --project <project ID> --agent claude`,
  `node scripts/tilda.mjs --site ${SITE_EXAMPLE} doctor`,
];
const PROMPT = [
  'Clone https://github.com/nimph977/tilda-toolkit, run npm ci,',
  'then setup --site <folder> --project <ID> and the doctor command.',
  'If doctor prints FAIL, show its fix command and wait for my answer.',
];

function block(markers, lang, lines) {
  return `${markers.start}\n${FENCE}${lang}\n${lines.join('\n')}\n${FENCE}\n${markers.end}\n`;
}

function page({ commands = COMMANDS, prompt = PROMPT } = {}) {
  return `# Getting started\n\n${block(AGENT_MARKERS, 'text', prompt)}\nProse.\n\n${block(PATH_MARKERS, 'bash', commands)}`;
}

function failsWith(fn, code) {
  assert.throws(fn, (error) => error instanceof DocPathError && error.code === code, `ожидался код ${code}`);
}

const commandsOf = (lines) => parsePathCommands(lines);

test('a correct page gives five steps and a prompt that passes', () => {
  const text = page();
  const commands = commandsOf(extractFenced(text, PATH_MARKERS, 'bash'));
  assert.deepEqual(commands.map((c) => c.step), ['clone', 'cd', 'npm', 'setup', 'doctor']);
  checkAgentPrompt(extractFenced(text, AGENT_MARKERS, 'text'));
});

test('CRLF line endings give the same result', () => {
  const lf = page();
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(extractFenced(crlf, PATH_MARKERS, 'bash'), extractFenced(lf, PATH_MARKERS, 'bash'));
  assert.equal(commandsOf(extractFenced(crlf, PATH_MARKERS, 'bash')).length, 5);
});

test('markers: missing end, doubled start and reversed order are refused', () => {
  failsWith(() => extractFenced(page().replace(PATH_MARKERS.end, ''), PATH_MARKERS, 'bash'), 'MARKERS');
  failsWith(() => extractFenced(`${page()}\n${PATH_MARKERS.start}\n`, PATH_MARKERS, 'bash'), 'MARKERS');
  const reversed = `${PATH_MARKERS.end}\n${FENCE}bash\nnpm ci\n${FENCE}\n${PATH_MARKERS.start}\n`;
  failsWith(() => extractFenced(reversed, PATH_MARKERS, 'bash'), 'MARKERS');
});

test('fence: another language, two blocks, no block and an unclosed block are refused', () => {
  const powershell = block(PATH_MARKERS, 'powershell', COMMANDS);
  failsWith(() => extractFenced(powershell, PATH_MARKERS, 'bash'), 'FENCE');
  const two = `${PATH_MARKERS.start}\n${FENCE}bash\nnpm ci\n${FENCE}\n${FENCE}bash\nnpm ci\n${FENCE}\n${PATH_MARKERS.end}\n`;
  failsWith(() => extractFenced(two, PATH_MARKERS, 'bash'), 'FENCE');
  failsWith(() => extractFenced(`${PATH_MARKERS.start}\nNo code.\n${PATH_MARKERS.end}\n`, PATH_MARKERS, 'bash'), 'FENCE');
  failsWith(() => extractFenced(`${PATH_MARKERS.start}\n${FENCE}bash\nnpm ci\n${PATH_MARKERS.end}\n`, PATH_MARKERS, 'bash'), 'FENCE');
});

test('commands: wrong site path, missing step, swapped steps, sixth command, && and a line break are refused', () => {
  const windows = COMMANDS.map((line) => line.replace(SITE_EXAMPLE, 'D:\\Sites\\example-site'));
  failsWith(() => parsePathCommands(windows), 'COMMANDS');
  failsWith(() => parsePathCommands(COMMANDS.filter((line) => line !== 'npm ci')), 'COMMANDS');
  const swapped = [COMMANDS[0], COMMANDS[2], COMMANDS[1], COMMANDS[3], COMMANDS[4]];
  failsWith(() => parsePathCommands(swapped), 'COMMANDS');
  failsWith(() => parsePathCommands([...COMMANDS, 'echo done']), 'COMMANDS');
  failsWith(() => parsePathCommands(['git clone x && cd y', ...COMMANDS.slice(2)]), 'COMMANDS');
  failsWith(() => parsePathCommands([COMMANDS[0], COMMANDS[1], COMMANDS[2], `${COMMANDS[3]} \\`, COMMANDS[4]]), 'COMMANDS');
});

test('commands: blank lines and comment lines are allowed', () => {
  const lines = ['# Get the code', COMMANDS[0], '', COMMANDS[1], '  # then install', COMMANDS[2], COMMANDS[3], '', COMMANDS[4]];
  assert.equal(parsePathCommands(lines).length, 5);
});

test('commands: agent values claude, codex and all pass, anything else is refused', () => {
  for (const agent of ['claude', 'codex', 'all']) {
    const lines = COMMANDS.map((line) => line.replace('--agent claude', `--agent ${agent}`));
    assert.equal(parsePathCommands(lines).length, 5, agent);
  }
  const wrong = COMMANDS.map((line) => line.replace('--agent claude', '--agent x'));
  failsWith(() => parsePathCommands(wrong), 'COMMANDS');
});

test('agent prompt: a missing FAIL and a wrong order are refused', () => {
  failsWith(() => checkAgentPrompt(PROMPT.map((line) => line.replace('FAIL', 'errors'))), 'AGENT_PROMPT');
  const early = ['Run doctor first.', 'Clone https://github.com/nimph977/tilda-toolkit and npm ci.', 'Then setup --site x --project y.', 'On FAIL stop.'];
  failsWith(() => checkAgentPrompt(early), 'AGENT_PROMPT');
});

test('parity: the English and Russian placeholders normalise to the same lines', () => {
  const en = commandsOf(COMMANDS);
  const ru = commandsOf(COMMANDS.map((line) => line.replace('<project ID>', '<ID проекта>')));
  assert.deepEqual(normalizeForParity(en), normalizeForParity(ru));
  assert.ok(normalizeForParity(en)[3].includes('--project <> --agent'));
});

test('run script: two substitutions, a code line after each command, site path untouched', () => {
  const script = buildRunScript(commandsOf(COMMANDS), { repoPath: 'C:\\x\\repo', project: SYNTHETIC_PROJECT });
  const lines = script.split('\n');
  assert.equal(lines[0], 'set -u');
  assert.equal(lines[1], "git clone 'C:/x/repo' tilda-toolkit");
  assert.ok(script.includes(`--project ${SYNTHETIC_PROJECT} --agent claude`));
  assert.ok(!script.includes('<project ID>'));
  for (const step of ['clone', 'cd', 'npm', 'setup', 'doctor']) {
    assert.ok(script.includes(`echo "__rc ${step} $?"`), step);
  }
  assert.equal(script.split(SITE_EXAMPLE).length - 1, 2);
});

test('run script: a quote or a dollar sign in the repository path stays literal', () => {
  const script = buildRunScript(commandsOf(COMMANDS), { repoPath: "/tmp/it's$&", project: SYNTHETIC_PROJECT });
  assert.equal(script.split('\n')[1], "git clone '/tmp/it'\\''s$&' tilda-toolkit");
});

test('run codes: foreign lines are skipped', () => {
  const stdout = 'Cloning...\n__rc clone 0\nnpm warn\n__rc setup 1\r\n__rc doctor 0\nnot __rc x 1\n';
  assert.deepEqual([...parseRunCodes(stdout)], [['clone', 0], ['setup', 1], ['doctor', 0]]);
});
