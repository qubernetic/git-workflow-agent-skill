import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitMsg, prePush, installShims } from '../lib/githooks.mjs';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guard.mjs');
const ZERO = '0'.repeat(40);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-githooks-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const ENV = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'),
  USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
};
process.env.HOME = ENV.HOME; process.env.XDG_CONFIG_HOME = ENV.XDG_CONFIG_HOME; process.env.APPDATA = ENV.APPDATA;

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};

let n = 0;
function makeRepo({ active = true, commits = 1, config } = {}) {
  const dir = path.join(tmp, `repo${n++}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (active) fs.writeFileSync(path.join(dir, '.git-workflow.json'), JSON.stringify(config ?? {}));
  for (let i = 0; i < commits; i++) git(dir, 'commit', '-q', '--allow-empty', '-m', `chore: c${i}`);
  return dir;
}
const msgFile = (dir, text) => { const f = path.join(dir, 'MSG'); fs.writeFileSync(f, text); return f; };

test('commitMsg rejects a non-conventional subject', () => {
  const dir = makeRepo();
  const r = commitMsg(msgFile(dir, 'Added x\n'), { cwd: dir });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /conventional-commit/);
});

test('commitMsg accepts a valid message and ignores comment lines', () => {
  const dir = makeRepo();
  assert.equal(commitMsg(msgFile(dir, '# Added comment\nfeat: add x\n'), { cwd: dir }).exitCode, 0);
});

test('commitMsg drops the git commit -v scissors section', () => {
  const dir = makeRepo();
  const text = 'feat: add x\n\n# ------------------------ >8 ------------------------\n# do not touch\ndiff --git a b\n+Co-Authored-By: Claude <x@y>\n';
  assert.equal(commitMsg(msgFile(dir, text), { cwd: dir }).exitCode, 0);
});

test('commitMsg denies AI attribution', () => {
  const dir = makeRepo();
  const r = commitMsg(msgFile(dir, 'feat: add x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'), { cwd: dir });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no-ai-attribution/);
});

test('commitMsg is a no-op in an inactive repo', () => {
  const dir = makeRepo({ active: false });
  assert.equal(commitMsg(msgFile(dir, 'Added x\n'), { cwd: dir }).exitCode, 0);
});

test('commitMsg honours rule levels: warn passes with stderr, off skips', () => {
  const warnDir = makeRepo({ config: { rules: { 'conventional-commit': 'warn' } } });
  const w = commitMsg(msgFile(warnDir, 'Added x\n'), { cwd: warnDir });
  assert.equal(w.exitCode, 0);
  assert.match(w.stderr, /conventional-commit/);
  const offDir = makeRepo({ config: { rules: { 'conventional-commit': 'off' } } });
  const o = commitMsg(msgFile(offDir, 'Added x\n'), { cwd: offDir });
  assert.equal(o.exitCode, 0);
  assert.equal(o.stderr, '');
});

test('commitMsg fails open on an unreadable file', () => {
  const dir = makeRepo();
  const r = commitMsg(path.join(dir, 'nope'), { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /allowing/);
});

test('prePush denies direct push to a protected branch', () => {
  const dir = makeRepo({ commits: 3 });
  const sha = git(dir, 'rev-parse', 'HEAD').out;
  const r = prePush(`refs/heads/develop ${sha} refs/heads/develop ${sha}\n`, { cwd: dir });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /protected-commit/);
  assert.match(r.stderr, /develop/);
});

test('protected-commit level governs pre-push direct pushes', () => {
  const sha = (d) => git(d, 'rev-parse', 'HEAD').out;
  const offDir = makeRepo({ commits: 3, config: { rules: { 'protected-commit': 'off' } } });
  assert.equal(prePush(`refs/heads/develop ${sha(offDir)} refs/heads/develop ${sha(offDir)}\n`, { cwd: offDir }).exitCode, 0);
  const warnDir = makeRepo({ commits: 3, config: { rules: { 'protected-commit': 'warn' } } });
  const w = prePush(`refs/heads/develop ${sha(warnDir)} refs/heads/develop ${sha(warnDir)}\n`, { cwd: warnDir });
  assert.equal(w.exitCode, 0);
  assert.match(w.stderr, /protected-commit/);
});

test('prePush allows bootstrap push of a single-commit repo to a new protected ref', () => {
  const dir = makeRepo({ commits: 1 });
  const sha = git(dir, 'rev-parse', 'HEAD').out;
  assert.equal(prePush(`refs/heads/main ${sha} refs/heads/main ${ZERO}\n`, { cwd: dir }).exitCode, 0);
});

test('prePush denies new protected ref when the repo has several commits', () => {
  const dir = makeRepo({ commits: 2 });
  const sha = git(dir, 'rev-parse', 'HEAD').out;
  assert.equal(prePush(`refs/heads/main ${sha} refs/heads/main ${ZERO}\n`, { cwd: dir }).exitCode, 1);
});

test('prePush bootstrap git error fails open with a warning', () => {
  const dir = makeRepo({ commits: 1 });
  const r = prePush(`refs/heads/main ${'1'.repeat(40)} refs/heads/main ${ZERO}\n`, { cwd: dir });
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /allowing/);
});

test('prePush denies deleting protected and epic refs, allows other branches', () => {
  const dir = makeRepo();
  const sha = git(dir, 'rev-parse', 'HEAD').out;
  assert.equal(prePush(`(delete) ${ZERO} refs/heads/epic/3-x ${sha}\n`, { cwd: dir }).exitCode, 1);
  assert.equal(prePush(`(delete) ${ZERO} refs/heads/main ${sha}\n`, { cwd: dir }).exitCode, 1);
  assert.equal(prePush(`(delete) ${ZERO} refs/heads/feature/1-x ${sha}\n`, { cwd: dir }).exitCode, 0);
  assert.equal(prePush(`refs/heads/feature/1-x ${sha} refs/heads/feature/1-x ${ZERO}\n`, { cwd: dir }).exitCode, 0);
});

test('prePush is a no-op in an inactive repo', () => {
  const dir = makeRepo({ active: false, commits: 3 });
  const sha = git(dir, 'rev-parse', 'HEAD').out;
  assert.equal(prePush(`refs/heads/main ${sha} refs/heads/main ${sha}\n`, { cwd: dir }).exitCode, 0);
});

test('installShims chains an existing hook once and never overwrites its own shim', () => {
  const dir = makeRepo();
  const hooks = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const first = installShims(dir);
  assert.deepEqual(first.chained, ['commit-msg']);
  assert.equal(first.written.length, 2);
  const shim = fs.readFileSync(path.join(hooks, 'commit-msg'), 'utf8');
  assert.equal(shim, `#!/bin/sh\n[ -x "$(dirname "$0")/commit-msg.local" ] && { "$(dirname "$0")/commit-msg.local" "$@" || exit $?; }\nexec node "${GUARD}" git commit-msg "$@"\n`);
  assert.equal(fs.readFileSync(path.join(hooks, 'commit-msg.local'), 'utf8'), '#!/bin/sh\nexit 0\n');
  const second = installShims(dir);
  assert.deepEqual(second.chained, []);
  assert.deepEqual(second.written, []);
  assert.equal(fs.readFileSync(path.join(hooks, 'commit-msg.local'), 'utf8'), '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(hooks, 'pre-push')).mode & 0o777, 0o755);
});

test('installShims honours core.hooksPath', () => {
  const dir = makeRepo();
  git(dir, 'config', 'core.hooksPath', '.husky');
  const r = installShims(dir);
  assert.equal(r.written.length, 2);
  assert.ok(fs.existsSync(path.join(dir, '.husky', 'pre-push')));
});

test('a real git commit is blocked by the installed shim', { skip: process.platform === 'win32' }, () => {
  const dir = makeRepo();
  installShims(dir);
  const bad = git(dir, 'commit', '--allow-empty', '-m', 'Added x');
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /conventional-commit/);
  assert.equal(git(dir, 'commit', '--allow-empty', '-m', 'feat: add x').status, 0);
});
