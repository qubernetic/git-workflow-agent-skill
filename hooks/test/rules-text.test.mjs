import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, checkCommitMessage, RULES } from '../lib/rules/index.mjs';

const mk = (over = {}) => ({ tool: 'git', sub: 'commit', flags: new Map(), positionals: [], env: {}, cwd: '/r', texts: {}, raw: '', ...over });
const commit = (message) => mk({ texts: { message } });
const pr = (texts, flags = {}, sub = 'pr create') => mk({ tool: 'gh', sub, texts, flags: new Map(Object.entries(flags)) });
const ctx = (branch = 'feature/9-x', rules = {}, extra = {}) => ({
  state: { currentBranch: async () => branch }, config: { rules, attributionPatterns: [], ...extra }, askSupported: true, env: {},
});
const run = (a, c = ctx()) => evaluate([a], c);
const one = async (a, c) => { const r = await run(a, c); return r.length ? [r[0].rule, r[0].decision] : null; };

test('claude co-author trailer is denied', async () => {
  const msg = 'feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
  assert.deepEqual(await one(commit(msg)), ['no-ai-attribution', 'deny']);
});
test('human co-author passes', async () => {
  assert.equal(await one(commit('feat: x\n\nCo-authored-by: Jane Doe <j@x.io>')), null);
});
test('generated-with PR body is denied', async () => {
  const a = pr({ title: 'feat: x (#9)', body: 'ok\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' });
  assert.deepEqual(await one(a), ['no-ai-attribution', 'deny']);
});
test('custom attribution pattern; invalid pattern is skipped', async () => {
  const c = ctx('feature/9-x', {}, { attributionPatterns: ['(', 'made by bot'] });
  assert.deepEqual(await one(commit('feat: x\n\nMade by bot'), c), ['no-ai-attribution', 'deny']);
  assert.equal(await one(commit('feat: fine'), c), null);
});
test('past tense subject is denied', async () => {
  assert.deepEqual(await one(commit('Added search')), ['conventional-commit', 'deny']);
});
test('valid subject passes', async () => {
  assert.equal(await one(commit('feat(api): add search')), null);
});
test('73-char subject is denied, 72 passes', async () => {
  const s = (n) => 'feat: ' + 'a'.repeat(n - 6);
  assert.deepEqual(await one(commit(s(73))), ['conventional-commit', 'deny']);
  assert.equal(await one(commit(s(72))), null);
});
test('trailing period and past-tense description denied', async () => {
  assert.deepEqual(await one(commit('feat: add search.')), ['conventional-commit', 'deny']);
  assert.deepEqual(await one(commit('feat: added search')), ['conventional-commit', 'deny']);
});
test('merge and revert subjects pass', async () => {
  assert.equal(await one(commit("Merge branch 'develop' into feature/1-x")), null);
  assert.equal(await one(commit('Revert "feat: x"')), null);
});
test('issue title not conventional is denied', async () => {
  assert.deepEqual(await one(pr({ title: 'Release v1.4.0' }, {}, 'issue create')), ['conventional-title', 'deny']);
});
test('PR title needs (#N) suffix on feature head', async () => {
  assert.deepEqual(await one(pr({ title: 'feat: x' })), ['conventional-title', 'deny']);
  assert.equal(await one(pr({ title: 'feat: x (#9) (#10)' })), null);
});
test('release/hotfix head and main->develop are exempt', async () => {
  assert.equal(await one(pr({ title: 'chore(release): prepare 1.5.0' }, {}), ctx('release/1.5.0')), null);
  assert.equal(await one(pr({ title: 'fix: y' }, { head: 'hotfix/2-y' })), null);
  assert.equal(await one(pr({ title: 'chore: sync' }, { head: 'main', base: 'develop' })), null);
  assert.deepEqual(await one(pr({ title: 'chore: sync' }, { head: 'main' })), ['conventional-title', 'deny']);
});
test('unknown head skips suffix check but subject regex still applies', async () => {
  assert.equal(await one(pr({ title: 'feat: x' }), ctx(null)), null);
  assert.deepEqual(await one(pr({ title: 'nope' }), ctx(null)), ['conventional-title', 'deny']);
});
test('closes on one line is denied; one per line passes', async () => {
  assert.deepEqual(await one(pr({ title: 'feat: x (#9)', body: 'Closes #100, #101' })), ['closes-one-per-line', 'deny']);
  assert.equal(await one(pr({ title: 'feat: x (#9)', body: 'Closes #100\nCloses #101' })), null);
});
test('config levels: warn downgrades, off skips, ask overrides', async () => {
  const a = pr({ title: 'feat: x' });
  assert.deepEqual(await one(a, ctx('feature/9-x', { 'conventional-title': 'warn' })), ['conventional-title', 'warn']);
  assert.equal(await one(a, ctx('feature/9-x', { 'conventional-title': 'off' })), null);
  assert.deepEqual(await one(a, ctx('feature/9-x', { 'conventional-title': 'ask' })), ['conventional-title', 'ask']);
});
test('message format follows the guard convention', async () => {
  const [f] = await run(commit('Added search'));
  assert.match(f.message, /^git-workflow guard: conventional-commit: .+\. .+\.$/);
  assert.ok(!f.message.includes('\n'));
});
test('checkCommitMessage is shared and applies config', () => {
  assert.equal(checkCommitMessage('feat: ok', { rules: {} }).length, 0);
  assert.equal(checkCommitMessage('bad', { rules: {} })[0].rule, 'conventional-commit');
  assert.equal(checkCommitMessage('bad', { rules: { 'conventional-commit': 'off' } }).length, 0);
});
test('RULES ids', () => {
  assert.deepEqual(RULES.map((r) => r.id), ['no-ai-attribution', 'conventional-commit', 'conventional-title', 'closes-one-per-line', 'merge-method', 'merge-gate', 'test-plan-ticked']);
});

const editCtx = (view) => ({ ...ctx(), state: { currentBranch: async () => 'x', prView: async () => view } });
const edit = (title, positionals = []) => ({ ...pr({ title }, {}, 'pr edit'), positionals });
test('pr edit checks the (#N) suffix using prView head', async () => {
  const v = { headRefName: 'feature/9-x', baseRefName: 'develop' };
  assert.deepEqual(await one(edit('feat: x'), editCtx(v)), ['conventional-title', 'deny']);
  assert.equal(await one(edit('feat: x (#9)', ['12']), editCtx(v)), null);
});
test('pr edit fails open on suffix when prView is unknown, still checks subject', async () => {
  assert.equal(await one(edit('feat: x'), editCtx(null)), null);
  assert.equal(await one(edit('feat: x'), editCtx({})), null);
  assert.deepEqual(await one(edit('nope'), editCtx(null)), ['conventional-title', 'deny']);
});
test('pr edit exempts release head', async () => {
  assert.equal(await one(edit('chore(release): prepare 1.5.0'), editCtx({ headRefName: 'release/1.5.0', baseRefName: 'main' })), null);
});
