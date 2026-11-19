import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, defaultExec } from '../lib/state.mjs';

const fake = (handler) => {
  const calls = [];
  const exec = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return handler(cmd, args, opts); };
  return { exec, calls };
};

test('currentBranch trims output; non-zero (detached) is null', async () => {
  let f = fake(() => ({ code: 0, stdout: 'feature/1-x\n' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).currentBranch(), 'feature/1-x');
  assert.equal(f.calls[0].opts.cwd, '/r');
  f = fake(() => ({ code: 1, stdout: '' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).currentBranch(), null);
});

test('hasCommits: true on 0, false on non-zero, null on error', async () => {
  assert.equal(await createState({ cwd: '/r', exec: fake(() => ({ code: 0, stdout: 'abc' })).exec }).hasCommits(), true);
  assert.equal(await createState({ cwd: '/r', exec: fake(() => ({ code: 128, stdout: '' })).exec }).hasCommits(), false);
  assert.equal(await createState({ cwd: '/r', exec: fake(() => { throw new Error('x'); }).exec }).hasCommits(), null);
});

test('prView parses JSON and passes ref', async () => {
  const pr = { number: 42, baseRefName: 'develop', headRefName: 'feature/1-x', body: 'Closes #1' };
  const f = fake(() => ({ code: 0, stdout: JSON.stringify(pr) }));
  assert.deepEqual(await createState({ cwd: '/r', exec: f.exec }).prView('42'), pr);
  assert.equal(f.calls[0].cmd, 'gh');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['pr', 'view', '42']);
});

test('prView without ref omits it', async () => {
  const f = fake(() => ({ code: 1, stdout: '' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).prView(), null);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['pr', 'view', '--json']);
});

test('prView passes --repo and keys the cache on it', async () => {
  const f = fake(() => ({ code: 0, stdout: JSON.stringify({ number: 1 }) }));
  const s = createState({ cwd: '/r', exec: f.exec });
  await s.prView('1', 'o/r'); await s.prView('1', 'o/r'); await s.prView('1');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args, ['pr', 'view', '1', '--repo', 'o/r', '--json', 'number,baseRefName,headRefName,body']);
  assert.ok(!f.calls[1].args.includes('--repo'));
});

test('gh missing (ENOENT) resolves null', async () => {
  const f = fake(() => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; });
  const s = createState({ cwd: '/r', exec: f.exec });
  assert.equal(await s.prView('1'), null);
  assert.equal(await s.issueState(1), null);
});

test('invalid JSON from gh resolves null', async () => {
  const f = fake(() => ({ code: 0, stdout: 'not json' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).prView('1'), null);
});

test('second call is served from cache', async () => {
  const f = fake(() => ({ code: 0, stdout: JSON.stringify({ number: 1 }) }));
  const s = createState({ cwd: '/r', exec: f.exec });
  await s.prView('1'); await s.prView('1');
  assert.equal(f.calls.length, 1);
  await s.prView('2');
  assert.equal(f.calls.length, 2);
});

test('failures are cached too', async () => {
  const f = fake(() => { throw new Error('boom'); });
  const s = createState({ cwd: '/r', exec: f.exec });
  await s.prView('1'); await s.prView('1');
  assert.equal(f.calls.length, 1);
});

test('timeout resolves null and timeoutMs is passed', async () => {
  const f = fake(() => { const e = new Error('timed out'); e.killed = true; throw e; });
  const s = createState({ cwd: '/r', exec: f.exec, timeoutMs: 50 });
  assert.equal(await s.prView('1'), null);
  assert.equal(f.calls[0].opts.timeoutMs, 50);
});

test('issueState maps OPEN/CLOSED, null when not found', async () => {
  let f = fake(() => ({ code: 0, stdout: '{"state":"OPEN"}' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).issueState(7), 'OPEN');
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['issue', 'view', '7']);
  f = fake(() => ({ code: 0, stdout: '{"state":"CLOSED"}' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).issueState(7), 'CLOSED');
  f = fake(() => ({ code: 1, stdout: '' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).issueState(7), null);
});

test('behindRemote fetches once with 10s timeout, then counts', async () => {
  const f = fake((cmd, args) => args[0] === 'fetch' ? { code: 0, stdout: '' } : { code: 0, stdout: '3\n' });
  const s = createState({ cwd: '/r', exec: f.exec });
  assert.equal(await s.behindRemote('develop'), 3);
  assert.deepEqual(f.calls[0].args, ['fetch', 'origin', 'develop', '--quiet']);
  assert.equal(f.calls[0].opts.timeoutMs, 10000);
  assert.deepEqual(f.calls[1].args, ['rev-list', '--count', 'develop..origin/develop']);
  assert.equal(f.calls[1].opts.timeoutMs, 3000);
  await s.behindRemote('develop');
  assert.equal(f.calls.length, 2);
});

test('behindRemote: fetch failure or bad count is null', async () => {
  let f = fake(() => ({ code: 128, stdout: '' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).behindRemote('x'), null);
  f = fake((c, a) => a[0] === 'fetch' ? { code: 0, stdout: '' } : { code: 0, stdout: 'abc' });
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).behindRemote('x'), null);
});

test('isAncestor: 0 true, 1 false, other null', async () => {
  const run = async (code) => createState({ cwd: '/r', exec: fake(() => ({ code, stdout: '' })).exec }).isAncestor('a', 'b');
  assert.equal(await run(0), true);
  assert.equal(await run(1), false);
  assert.equal(await run(128), null);
});

test('showFile returns content or null', async () => {
  let f = fake(() => ({ code: 0, stdout: 'hello' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).showFile('abc', 'a/b.txt'), 'hello');
  assert.deepEqual(f.calls[0].args, ['show', 'abc:a/b.txt']);
  f = fake(() => ({ code: 128, stdout: '' }));
  assert.equal(await createState({ cwd: '/r', exec: f.exec }).showFile('abc', 'x'), null);
});

test('defaultExec: runs a process, returns non-zero code, rejects on ENOENT and timeout', async () => {
  const ok = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hi")'], { cwd: process.cwd(), timeoutMs: 5000 });
  assert.deepEqual(ok, { code: 0, stdout: 'hi' });
  const bad = await defaultExec(process.execPath, ['-e', 'process.exit(3)'], { cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(bad.code, 3);
  await assert.rejects(defaultExec('gwg-no-such-binary', [], { cwd: process.cwd(), timeoutMs: 1000 }));
  await assert.rejects(defaultExec(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { cwd: process.cwd(), timeoutMs: 100 }));
});
