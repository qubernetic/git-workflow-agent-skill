import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../lib/rules/index.mjs';
import { branchCreation, BRANCH_RULES } from '../lib/rules/branch.mjs';
import { recognise } from '../lib/commands.mjs';

const act = (line) => recognise({ argv: line.split(/\s+/), cwd: '/r', env: {}, raw: line });
const baseState = {
  currentBranch: async () => 'feature/9-x',
  hasCommits: async () => true,
  issueState: async () => 'OPEN',
  behindRemote: async () => 0,
  isAncestor: async () => true,
  showFile: async () => '## [1.5.0] - 2026-01-01\n',
  branchExists: async () => false,
  defaultBranch: async () => 'develop',
};
const ctx = (state = {}, config = {}) => ({
  state: { ...baseState, ...state },
  config: { protectedBranches: ['main', 'develop'], branchTypes: ['feature', 'fix', 'hotfix', 'epic'], rules: {}, ...config },
  askSupported: true,
  env: {},
});
const ids = async (line, c = ctx()) => (await evaluate([act(line)], c)).filter((f) => BRANCH_RULES.some((r) => r.id === f.rule)).map((f) => `${f.rule}:${f.decision}`);

test('branchCreation covers checkout/switch/branch/worktree and ignores the rest', () => {
  assert.deepEqual(branchCreation(act('git checkout -b feature/1-a develop')), { name: 'feature/1-a', startPoint: 'develop' });
  assert.deepEqual(branchCreation(act('git checkout -B feature/1-a')), { name: 'feature/1-a', startPoint: null, force: true });
  assert.deepEqual(branchCreation(act('git switch -c fix/2-b origin/develop')), { name: 'fix/2-b', startPoint: 'origin/develop' });
  assert.deepEqual(branchCreation(act('git switch -C fix/2-b')), { name: 'fix/2-b', startPoint: null, force: true });
  assert.deepEqual(branchCreation(act('git branch -f fix/2-b main')), { name: 'fix/2-b', startPoint: 'main', force: true });
  assert.deepEqual(branchCreation(act('git branch fix/2-b main')), { name: 'fix/2-b', startPoint: 'main' });
  assert.deepEqual(branchCreation(act('git worktree add -b fix/100-x ../wt develop')), { name: 'fix/100-x', startPoint: 'develop' });
  assert.equal(branchCreation(act('git branch -D fix/2-b')), null);
  assert.equal(branchCreation(act('git branch -d fix/2-b')), null);
  assert.equal(branchCreation(act('git branch -m old new')), null);
  assert.equal(branchCreation(act('git branch')), null);
  assert.equal(branchCreation(act('git checkout develop')), null);
  assert.equal(branchCreation(act('git worktree add ../wt develop')), null);
  assert.equal(branchCreation(act('git commit -m feat:x')), null);
});

test('protected-commit', async () => {
  assert.deepEqual(await ids('git commit -m feat:x', ctx({ currentBranch: async () => 'develop' })), ['protected-commit:deny']);
  assert.deepEqual(await ids('git commit -m feat:x'), []);
  assert.deepEqual(await ids('git commit -m feat:x', ctx({ currentBranch: async () => 'main', hasCommits: async () => false })), []);
  assert.deepEqual(await ids('git commit -m feat:x', ctx({ currentBranch: async () => 'main', hasCommits: async () => null })), []);
  assert.deepEqual(await ids('git commit -m feat:x', ctx({ currentBranch: async () => null })), []);
});

test('force-push', async () => {
  assert.deepEqual(await ids('git push --force origin feature/9-x'), ['force-push:deny']);
  assert.deepEqual(await ids('git push -f origin feature/9-x'), ['force-push:deny']);
  assert.deepEqual(await ids('git push origin +develop'), ['force-push:deny']);
  assert.deepEqual(await ids('git push --force-with-lease origin feature/9-x'), []);
  assert.deepEqual(await ids('git push --force-with-lease origin develop'), ['force-push:deny']);
  assert.deepEqual(await ids('git push --force-with-lease origin HEAD:release/1.0.0'), ['force-push:deny']);
  assert.deepEqual(await ids('git push --force-with-lease origin feature/9-x:epic/3-y'), ['force-push:deny']);
  assert.deepEqual(await ids('git push --force-if-includes', ctx({ currentBranch: async () => 'epic/34-pre-alpha' })), ['force-push:deny']);
  assert.deepEqual(await ids('git push --force-with-lease', ctx({ currentBranch: async () => null })), []);
  assert.deepEqual(await ids('git push origin feature/9-x'), []);
});

test('protected-delete', async () => {
  assert.deepEqual(await ids('git push origin --delete develop'), ['protected-delete:deny']);
  assert.deepEqual(await ids('git push origin -d epic/34-pre-alpha'), ['protected-delete:deny']);
  assert.deepEqual(await ids('git push origin :main'), ['protected-delete:deny']);
  assert.deepEqual(await ids('git branch -D epic/34-pre-alpha'), ['protected-delete:deny']);
  assert.deepEqual(await ids('git branch -d main'), ['protected-delete:deny']);
  assert.deepEqual(await ids('git branch -D feature/9-x'), []);
  assert.deepEqual(await ids('git push origin --delete feature/9-x'), []);
  assert.deepEqual(await ids('git push origin :feature/9-x'), []);
});

test('no-verify', async () => {
  assert.deepEqual(await ids('git commit --no-verify -m feat:x'), ['no-verify:deny']);
  assert.deepEqual(await ids('git commit -n -m feat:x'), ['no-verify:deny']);
  assert.deepEqual(await ids('git push --no-verify origin feature/9-x'), ['no-verify:deny']);
  assert.deepEqual(await ids('git commit -m feat:x'), []);
});

test('branch-name', async () => {
  assert.deepEqual(await ids('git checkout -b feature/9-good-name'), []);
  assert.deepEqual(await ids('git checkout -b release/1.2.0 develop'), []);
  assert.deepEqual(await ids('git checkout -b release/1.2.0-rc.1 develop'), []);
  assert.deepEqual(await ids('git checkout -b mybranch'), ['branch-name:deny']);
  assert.deepEqual(await ids('git checkout -b feature/9-Bad'), ['branch-name:deny']);
  assert.deepEqual(await ids('git checkout -b feature/x-9'), ['branch-name:deny']);
  assert.deepEqual(await ids('git checkout -b docs/179-x'), ['branch-name:deny']);
  assert.deepEqual(await ids('git checkout -b docs/179-x', ctx({}, { branchTypes: ['feature', 'docs'] })), []);
  assert.deepEqual(await ids('git switch -c release/1.2'), ['branch-name:deny']);
});

test('branch-issue', async () => {
  const seen = [];
  const st = (v) => ctx({ issueState: async (n) => { seen.push(n); return v; } });
  assert.deepEqual(await ids('git checkout -b feature/9-x', st('OPEN')), []);
  assert.equal(seen[0], 9);
  let [f] = await evaluate([act('git checkout -b feature/9-x')], st('MISSING'));
  assert.equal(f.rule, 'branch-issue');
  assert.match(f.message, /issue #9 does not exist in this repository; open it first/);
  [f] = await evaluate([act('git checkout -b feature/9-x')], st('CLOSED'));
  assert.equal(f.rule, 'branch-issue');
  assert.match(f.message, /issue #9 is closed/);
  assert.deepEqual(await ids('git checkout -b feature/9-x', st(null)), []);
  assert.deepEqual(await ids('git checkout -b release/1.2.0', st('MISSING')), []);
  assert.deepEqual(await ids('git checkout -b badname', st('MISSING')), ['branch-name:deny']);
});

test('fresh-base', async () => {
  const behind = (n, extra = {}) => ctx({ behindRemote: async () => n, ...extra });
  let [f] = await evaluate([act('git worktree add -b fix/100-x ../wt develop')], behind(3, { currentBranch: async () => 'feature/9-x' }));
  assert.equal(f.rule, 'fresh-base');
  assert.match(f.message, /git pull origin develop first/);
  assert.deepEqual(await ids('git checkout -b fix/100-x develop', behind(0)), []);
  assert.deepEqual(await ids('git checkout -b fix/100-x origin/develop', behind(3)), []);
  assert.deepEqual(await ids('git checkout -b fix/100-x', behind(2, { currentBranch: async () => 'develop' })), ['fresh-base:deny']);
  assert.deepEqual(await ids('git checkout -b fix/100-x', behind(2, { currentBranch: async () => 'epic/3-y' })), ['fresh-base:deny']);
  assert.deepEqual(await ids('git checkout -b fix/100-x', behind(2)), []);
  assert.deepEqual(await ids('git checkout -b fix/100-x develop', behind(null)), []);
});

test('names starting with a dash never reach state methods', async () => {
  const calls = [];
  const spy = (n) => async (...a) => { calls.push([n, ...a]); return null; };
  const c = ctx({ issueState: spy('issue'), behindRemote: spy('behind') });
  const out = await ids('git checkout -b feature/9-x -- -evil', c);
  assert.deepEqual(out, []);
  assert.deepEqual(calls.filter((x) => String(x[1]).startsWith('-')), []);
  calls.length = 0;
  assert.deepEqual(await ids('git checkout -b -x', c), ['branch-name:deny']);
  assert.deepEqual(calls.filter((x) => x[0] === 'issue'), []);
});

test('resetting an existing or protected branch is not a creation', async () => {
  const calls = [];
  const st = (exists) => ctx({
    branchExists: async (n) => { calls.push(n); return exists; },
    issueState: async () => 'MISSING',
    behindRemote: async () => 4,
    currentBranch: async () => 'develop',
  });
  for (const line of ['git branch -f develop origin/develop', 'git checkout -B develop origin/develop', 'git switch -C main origin/main',
    'git switch --force-create main origin/main']) {
    assert.deepEqual(await ids(line, st(false)), [], line);
  }
  for (const line of ['git checkout -B feature/9-x develop', 'git branch -f foo HEAD', 'git switch -C feature/9-x']) {
    assert.deepEqual(await ids(line, st(true)), [], line);
    assert.deepEqual(await ids(line, st(null)), [], line);
  }
  assert.ok(calls.includes('foo'));
  assert.deepEqual(await ids('git checkout -B foo develop', st(false)), ['branch-name:deny', 'fresh-base:deny']);
  assert.deepEqual(await ids('git checkout -B feature/9-x', st(false)), ['branch-issue:deny', 'fresh-base:deny']);
  assert.deepEqual(await ids('git checkout -b develop', st(true)), ['branch-name:deny', 'fresh-base:deny']);
});

test('pr-base without --base uses the repository default branch', async () => {
  const repos = [];
  const cfg = (head, def) => ctx({ currentBranch: async () => head, defaultBranch: async (r) => { repos.push(r); return def; } });
  assert.deepEqual(await ids('gh pr create', cfg('feature/9-x', 'main')), ['pr-base:deny']);
  assert.deepEqual(await ids('gh pr create', cfg('feature/9-x', null)), []);
  assert.deepEqual(await ids('gh pr create', cfg('hotfix/9-x', 'main')), []);
  assert.deepEqual(repos, [undefined, undefined, undefined]);
});

test('pr-base', async () => {
  const cfg = (head) => ctx({ currentBranch: async () => head });
  assert.deepEqual(await ids('gh pr create --base main', cfg('feature/9-x')), ['pr-base:deny']);
  const [f] = await evaluate([act('gh pr create --base main')], cfg('feature/9-x'));
  assert.match(f.message, /develop/);
  assert.deepEqual(await ids('gh pr create', cfg('feature/9-x')), []);
  assert.deepEqual(await ids('gh pr create -B epic/3-y', cfg('fix/9-x')), []);
  assert.deepEqual(await ids('gh pr create', cfg('hotfix/9-x')), ['pr-base:deny']);
  assert.deepEqual(await ids('gh pr create --base main', cfg('hotfix/9-x')), []);
  assert.deepEqual(await ids('gh pr create --base main', cfg('release/1.0.0')), []);
  assert.deepEqual(await ids('gh pr create --base develop', cfg('epic/3-y')), []);
  assert.deepEqual(await ids('gh pr create --base main', cfg('epic/3-y')), ['pr-base:deny']);
  assert.deepEqual(await ids('gh pr create', cfg('main')), []);
  assert.deepEqual(await ids('gh pr create --base main', cfg('main')), ['pr-base:deny']);
  assert.deepEqual(await ids('gh pr create --head hotfix/9-x --base main', cfg('feature/1-a')), []);
  assert.deepEqual(await ids('gh pr create --base main', cfg(null)), []);
});

test('tag-on-main', async () => {
  const asked = [];
  const c = ctx({ isAncestor: async (...a) => { asked.push(a); return true; } });
  assert.deepEqual(await ids('git tag -a v1.5.0', c), []);
  assert.deepEqual(asked[0], ['HEAD', 'origin/main']);
  assert.deepEqual(await ids('git tag -a v1.5.0 abc123', c), []);
  assert.deepEqual(asked[1], ['abc123', 'origin/main']);
  assert.deepEqual(await ids('git tag -a v1.5.0', ctx({ showFile: async () => '## [1.4.0]\n' })), ['tag-on-main:deny']);
  assert.deepEqual(await ids('git tag v1.5.0', ctx({ isAncestor: async () => false })), ['tag-on-main:deny']);
  assert.deepEqual(await ids('git tag v1.5.0-rc.1', ctx({ isAncestor: async () => false })), []);
  assert.deepEqual(await ids('git tag -d v1.5.0', ctx({ isAncestor: async () => false })), []);
  assert.deepEqual(await ids('git tag', ctx({ isAncestor: async () => false })), []);
  assert.deepEqual(await ids('git tag v1.5.0', ctx({ isAncestor: async () => null, showFile: async () => null })), []);
});
