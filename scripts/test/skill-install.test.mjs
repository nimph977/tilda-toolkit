import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import {
  MARKER, SkillInstallError, checkSkillTargets, expectedTree, inspectSkill, installSkill,
  readSkillSource, rewriteLinks, treeHash,
} from '../lib/skill-install.mjs';
import { ROOT } from './product-files.mjs';

const SRC_ROOT = 'skills/tilda-manager';
const DST_CLAUDE = '.claude/skills/tilda-manager';
const DST_CODEX = '.agents/skills/tilda-manager';
const LINK = /\]\(([^)\s]+)\)/g;
const EXTERNAL = /^(?:https?:|mailto:|#)/;

const SKILL_MD = '[a](references/x.md) [b](../../docs/cli.md#flags) [c](https://example.test/x)\n';
const X_MD = '[d](../../../docs/workflow.md#причины-отказов) [e](../SKILL.md) [f](../../../examples/x.json)\n';

/** Временный корень клона с синтетическим скиллом и файлами, на которые он ссылается. */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'skill-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put(`${SRC_ROOT}/SKILL.md`, SKILL_MD);
  put(`${SRC_ROOT}/references/x.md`, X_MD);
  put('docs/cli.md', '# cli\n');
  put('docs/workflow.md', '# workflow\n');
  put('examples/x.json', '{}\n');
  return root;
}

test('rewriteLinks recomputes only links that leave the skill folder', () => {
  const skill = rewriteLinks(SKILL_MD, { fileRel: 'SKILL.md', srcRoot: SRC_ROOT, dstRoot: DST_CLAUDE });
  assert.equal(
    skill,
    '[a](references/x.md) [b](../../../docs/cli.md#flags) [c](https://example.test/x)\n',
  );
  const ref = rewriteLinks(X_MD, { fileRel: 'references/x.md', srcRoot: SRC_ROOT, dstRoot: DST_CLAUDE });
  assert.equal(
    ref,
    '[d](../../../../docs/workflow.md#причины-отказов) [e](../SKILL.md) [f](../../../../examples/x.json)\n',
  );
});

test('every rewritten link resolves from the installed copy', (t) => {
  const root = makeRoot(t);
  installSkill({ root, agent: 'claude' });
  const dst = join(root, ...DST_CLAUDE.split('/'));
  const broken = [];
  for (const fileRel of readdirSync(dst, { recursive: true }).filter((name) => name.endsWith('.md'))) {
    const text = readFileSync(join(dst, fileRel), 'utf8');
    for (const match of text.matchAll(LINK)) {
      if (EXTERNAL.test(match[1])) continue;
      const path = decodeURI(match[1].split('#')[0]);
      if (!existsSync(join(dirname(join(dst, fileRel)), path))) broken.push(`${fileRel}: ${match[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

for (const dstRoot of [DST_CLAUDE, DST_CODEX]) {
  test(`links of the real skill resolve from ${dstRoot}`, () => {
    const tree = expectedTree(readSkillSource({ root: ROOT }), { dstRoot });
    const broken = [];
    for (const [fileRel, content] of tree) {
      if (!fileRel.endsWith('.md')) continue;
      for (const match of content.toString('utf8').matchAll(LINK)) {
        if (EXTERNAL.test(match[1])) continue;
        const path = decodeURI(match[1].split('#')[0]);
        // Копии на диске нет: ссылка внутрь скилла сверяется с источником, наружу — с корнем клона.
        const target = posix.normalize(posix.join(posix.dirname(`${dstRoot}/${fileRel}`), path));
        const onDisk = target.startsWith(`${dstRoot}/`) ? `${SRC_ROOT}/${target.slice(dstRoot.length + 1)}` : target;
        if (!existsSync(join(ROOT, ...onDisk.split('/')))) broken.push(`${fileRel}: ${match[1]}`);
      }
    }
    assert.deepEqual(broken, [], `Битые ссылки копии:\n${broken.join('\n')}`);
  });
}

test('installSkill installs, keeps a current copy and updates a stale one', (t) => {
  const root = makeRoot(t);
  const dst = join(root, ...DST_CLAUDE.split('/'));

  assert.equal(inspectSkill({ root, agent: 'claude' }).state, 'missing');
  assert.equal(installSkill({ root, agent: 'claude' }).action, 'installed');
  assert.equal(inspectSkill({ root, agent: 'claude' }).state, 'current');
  assert.equal(readFileSync(join(dst, 'SKILL.md'), 'utf8').includes('](../../../docs/cli.md#flags)'), true);
  assert.equal(existsSync(join(dst, MARKER)), true);
  assert.deepEqual(readdirSync(dirname(dst)), ['tilda-manager']);

  assert.equal(installSkill({ root, agent: 'claude' }).action, 'unchanged');

  writeFileSync(join(dst, 'SKILL.md'), 'edited\n');
  assert.equal(inspectSkill({ root, agent: 'claude' }).state, 'stale');
  assert.equal(installSkill({ root, agent: 'claude' }).action, 'updated');
  assert.equal(inspectSkill({ root, agent: 'claude' }).state, 'current');
  assert.deepEqual(readdirSync(dirname(dst)), ['tilda-manager']);
});

test('installSkill refuses a folder that setup did not create', (t) => {
  const root = makeRoot(t);
  const dst = join(root, ...DST_CLAUDE.split('/'));
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'mine.txt'), 'mine\n');

  assert.throws(() => installSkill({ root, agent: 'claude' }), { name: 'SkillInstallError', code: 'SKILL_TARGET_FOREIGN' });
  assert.equal(readFileSync(join(dst, 'mine.txt'), 'utf8'), 'mine\n');
  assert.deepEqual(readdirSync(dirname(dst)), ['tilda-manager']);
});

test('installSkill refuses a file in place of the folder', (t) => {
  const root = makeRoot(t);
  const dst = join(root, ...DST_CODEX.split('/'));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, 'file\n');

  assert.throws(() => installSkill({ root, agent: 'codex' }), { code: 'SKILL_TARGET_FOREIGN' });
  assert.equal(readFileSync(dst, 'utf8'), 'file\n');
});

test('installSkill refuses a link and leaves its target alone', (t) => {
  const root = makeRoot(t);
  const other = join(root, 'elsewhere');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'keep\n');
  const dst = join(root, ...DST_CLAUDE.split('/'));
  mkdirSync(dirname(dst), { recursive: true });
  symlinkSync(other, dst, 'junction');

  assert.equal(inspectSkill({ root, agent: 'claude' }).state, 'link');
  assert.throws(() => installSkill({ root, agent: 'claude' }), { code: 'SKILL_TARGET_LINK' });
  assert.deepEqual(readdirSync(other), ['keep.txt']);
});

test('an unknown agent is an error', (t) => {
  const root = makeRoot(t);
  assert.throws(() => installSkill({ root, agent: 'gemini' }), (error) => {
    assert.ok(error instanceof SkillInstallError);
    assert.equal(error.code, 'SKILL_UNKNOWN_AGENT');
    assert.equal(error.exitCode, 1);
    return true;
  });
});

test('checkSkillTargets refuses before any write', (t) => {
  const root = makeRoot(t);
  const foreign = join(root, ...DST_CODEX.split('/'));
  mkdirSync(foreign, { recursive: true });

  assert.throws(() => checkSkillTargets({ root, agents: ['claude', 'codex'] }), { code: 'SKILL_TARGET_FOREIGN' });
  assert.equal(existsSync(join(root, '.claude')), false);
  checkSkillTargets({ root, agents: ['claude'] });
});

test('installSkill writes through a folder link used as the parent', (t) => {
  const root = makeRoot(t);
  const realDir = join(root, 'real-claude');
  mkdirSync(realDir);
  symlinkSync(realDir, join(root, '.claude'), 'junction');

  assert.equal(installSkill({ root, agent: 'claude' }).action, 'installed');
  assert.equal(existsSync(join(realDir, 'skills', 'tilda-manager', 'SKILL.md')), true);
  assert.equal(inspectSkill({ root, agent: 'claude' }).state, 'current');
});

test('treeHash ignores insertion order and the marker', () => {
  const a = new Map([['a.md', Buffer.from('1')], ['b/c.md', Buffer.from('2')]]);
  const b = new Map([['b/c.md', Buffer.from('2')], ['a.md', Buffer.from('1')]]);
  assert.equal(treeHash(a), treeHash(b));
  b.set(MARKER, Buffer.from('{}'));
  assert.equal(treeHash(a), treeHash(b));
  b.set('a.md', Buffer.from('changed'));
  assert.notEqual(treeHash(a), treeHash(b));
});
