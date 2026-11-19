import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../lib/rules/index.mjs';

const merge = (flags = { merge: true }, over = {}) => ({
  tool: 'gh', sub: 'pr merge', flags: new Map(Object.entries(flags)), positionals: ['42'], env: {}, cwd: '/r', texts: {}, raw: '', ...over,
});
const PR = { number: 42, baseRefName: 'develop', headRefName: 'feature/1-x', body: '## Test plan\n- [x] a\n' };
const ctx = (pr = PR, extra = {}) => ({
  state: { prView: async () => pr }, config: { protectedBranches: ['main', 'develop'], rules: {} }, askSupported: true, env: {}, ...extra,
});
const rules = async (a, c) => (await evaluate([a], c)).map((f) => `${f.rule}:${f.decision}`);

test('squash, rebase, admin and missing --merge are denied', async () => {
  for (const flags of [{ squash: true }, { rebase: true }, { admin: true, merge: true }, {}]) {
    assert.ok((await rules(merge(flags), ctx({ ...PR, baseRefName: 'epic/1-x' }))).includes('merge-method:deny'), JSON.stringify(flags));
  }
  const [f] = await evaluate([merge({ squash: true })], ctx());
  assert.match(f.message, /gh pr merge 42 --merge --delete-branch/);
});

test('merge into epic branch yields no findings', async () => {
  assert.deepEqual(await rules(merge(), ctx({ ...PR, baseRefName: 'epic/180-beta' })), []);
});

test('merge into develop asks when ask is supported', async () => {
  assert.deepEqual(await rules(merge(), ctx()), ['merge-gate:ask']);
});

test('without ask support: deny with spec message, approval env unlocks only that PR', async () => {
  const c = ctx(PR, { askSupported: false });
  const [f] = await evaluate([merge()], c);
  assert.equal(f.decision, 'deny');
  assert.match(f.message, /ask the user to approve merging PR #42 into develop/);
  assert.match(f.message, /WORKFLOW_GUARD_APPROVE=42 gh pr merge 42 --merge --delete-branch/);
  assert.deepEqual(await rules(merge({ merge: true }, { env: { WORKFLOW_GUARD_APPROVE: '42' } }), c), []);
  assert.deepEqual(await rules(merge(), ctxEnv({ WORKFLOW_GUARD_APPROVE: '42' })), []);
  assert.deepEqual(await rules(merge({ merge: true }, { env: { WORKFLOW_GUARD_APPROVE: '41' } }), c), ['merge-gate:deny']);
});
const ctxEnv = (env) => ctx(PR, { askSupported: false, env });

test('unticked test plan item is denied; all ticked passes', async () => {
  const c = ctx({ ...PR, baseRefName: 'epic/1-x', body: '## Test plan\n- [x] a\n- [ ] b\n' });
  const [f] = await evaluate([merge()], c);
  assert.equal(f.rule, 'test-plan-ticked');
  assert.match(f.message, /gh pr edit 42 --body-file/);
  assert.deepEqual(await rules(merge(), ctx({ ...PR, baseRefName: 'epic/1-x', body: '## Test plan\n- [x] a\n- [x] b' })), []);
});

test('unticked items outside a test-plan section are ignored', async () => {
  const body = '## Test plan\n- [x] a\n\n## Follow-ups\n- [ ] later\n';
  assert.deepEqual(await rules(merge(), ctx({ ...PR, baseRefName: 'epic/1-x', body })), []);
});

test('unknown PR fails open', async () => {
  assert.deepEqual(await rules(merge(), ctx(null)), []);
});

test('repo flag is passed to prView', async () => {
  let seen;
  const c = ctx(PR, { state: { prView: async (...a) => { seen = a; return null; } } });
  await evaluate([merge({ merge: true, repo: 'o/r' })], c);
  assert.deepEqual(seen, ['42', 'o/r']);
});

test('non-merge actions are ignored', async () => {
  assert.deepEqual(await rules(merge({}, { sub: 'pr view' }), ctx()), []);
});
