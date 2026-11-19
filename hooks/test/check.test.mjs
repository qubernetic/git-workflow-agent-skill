import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheck } from '../lib/check.mjs';
import { RULES } from '../lib/rules/index.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-check-'));
const xdg = path.join(tmp, 'xdg');
fs.mkdirSync(xdg);
const mkRepo = (name, optIn = true) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (optIn) fs.writeFileSync(path.join(dir, '.git-workflow.json'), '{}');
  return dir;
};
const repo = mkRepo('repo');
const env = { XDG_CONFIG_HOME: xdg, HOME: tmp };

const spy = (impl) => {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push([cmd, args, opts?.cwd]);
    if (impl) return impl(cmd, args);
    if (cmd === 'git' && args[0] === 'symbolic-ref') return { code: 0, stdout: 'feature/1-x\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
};
const run = (command, over = {}) => runCheck({ command, cwd: repo, askSupported: true, env, exec: spy(), ...over });

test('commands without git/gh allow without spawning', async () => {
  const exec = spy();
  const r = await run('ls -la && echo hi', { exec });
  assert.equal(r.decision, 'allow');
  assert.equal(exec.calls.length, 0);
});

test('chained command reports only the violating part', async () => {
  const r = await run('git commit -m "feat: add x" && gh pr merge 3 --squash');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /merge-method/);
  assert.equal(r.reason.split('\n').length, 1);
});

test('git-ish words inside echo text are not enforced', async () => {
  const r = await run('echo "never use gh pr merge --squash"');
  assert.equal(r.decision, 'allow');
});

test('exec ENOENT for gh: text rules still deny attribution', async () => {
  const exec = async () => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; };
  const r = await run('git commit -m "feat: add x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', { exec });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /no-ai-attribution/);
});

test('inactive repos and non-git dirs allow without exec, quickly', async () => {
  const optOut = mkRepo('optout', false);
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  for (const dir of [optOut, plain]) {
    const exec = spy();
    const t0 = performance.now();
    const r = await run('git commit -m "bad subject"', { cwd: dir, exec });
    assert.equal(r.decision, 'allow');
    assert.equal(exec.calls.length, 0);
    assert.ok(performance.now() - t0 < 50);
  }
});

test('unparsable command uses the raw-text fallback', async () => {
  const r = await run('echo "oops && gh pr merge 3 --squash');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /merge-method/);
  const r2 = await run("git commit -m 'unterminated Co-Authored-By: Claude <a@b>");
  assert.equal(r2.decision, 'deny');
  assert.match(r2.reason, /no-ai-attribution/);
  const r3 = await run("echo 'unterminated gh pr merge 3 --merge");
  assert.equal(r3.decision, 'allow');
});

test('wrappers are unwrapped: env, sudo, bash -c, nested', async () => {
  for (const cmd of [
    'env FOO=1 gh pr merge 3 --squash',
    'sudo -u bob gh pr merge 3 --squash',
    'command gh pr merge 3 --squash',
    `bash -c 'gh pr merge 3 --squash'`,
    `bash -lc "sh -c 'gh pr merge 3 --squash'"`,
  ]) {
    const r = await run(cmd);
    assert.equal(r.decision, 'deny', cmd);
    assert.match(r.reason, /merge-method/, cmd);
  }
  assert.equal((await run(`bash -c 'gh pr merge 3 --merge'`)).decision, 'allow');
});

test('one state per distinct action cwd', async () => {
  const other = path.join(tmp, 'other');
  const exec = spy();
  await run(`git commit -m "bad subject" && git -C ${other} commit -m "bad subject"`, { exec });
  const cwds = new Set(exec.calls.map((c) => c[2]));
  assert.ok(cwds.has(repo) && cwds.has(other), [...cwds].join());
});

test('warn findings become warnings, ask decision passes through', async () => {
  fs.writeFileSync(path.join(repo, '.git-workflow.json'), JSON.stringify({ rules: { 'merge-method': 'warn' } }));
  const r = await run('gh pr merge 3 --squash');
  assert.equal(r.decision, 'allow');
  assert.ok(r.warnings.some((w) => /merge-method/.test(w)));
  fs.writeFileSync(path.join(repo, '.git-workflow.json'), '{}');
  const pr = JSON.stringify({ number: 3, baseRefName: 'develop', headRefName: 'f', body: '' });
  const exec = spy((cmd, args) => (cmd === 'gh' ? { code: 0, stdout: pr, stderr: '' } : { code: 1, stdout: '', stderr: '' }));
  assert.equal((await run('gh pr merge 3 --merge', { exec })).decision, 'ask');
  assert.equal((await run('gh pr merge 3 --merge', { exec, askSupported: false })).decision, 'deny');
});

test('thrown errors fail open with a warning', async () => {
  const badEnv = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
  const r = await run('git status', { env: badEnv });
  assert.equal(r.decision, 'allow');
  assert.ok(r.warnings.some((w) => /boom/.test(w)));
});

test('a throwing rule fails open', async () => {
  RULES.push({ id: 'boom', applies: () => true, check() { throw new Error('rule boom'); } });
  const orig = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try {
    const r = await run('git commit -m "feat: ok"');
    assert.equal(r.decision, 'allow');
  } finally {
    process.stderr.write = orig;
    RULES.pop();
  }
  assert.match(err, /rule boom/);
});
