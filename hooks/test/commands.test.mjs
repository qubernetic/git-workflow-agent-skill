import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../lib/shell.mjs';
import { recognise } from '../lib/commands.mjs';

const rec = (src, readFile, opts) => {
  const r = parseCommandLine(src, opts);
  assert.equal(r.ok, true);
  return recognise(r.commands[0], readFile);
};

test('git -C/-c globals fold into cwd, combined -am split', () => {
  const a = rec('git -C /r -c x=y commit -am "fix: y"');
  assert.equal(a.tool, 'git');
  assert.equal(a.sub, 'commit');
  assert.equal(a.cwd, '/r');
  assert.equal(a.texts.message, 'fix: y');
  assert.equal(a.flags.get('all'), true);
  assert.equal(a.flags.get('message'), 'fix: y');
  assert.deepEqual(a.positionals, []);
});

test('git global flags --no-pager and -P are skipped', () => {
  const a = rec('git --no-pager -P commit -m x');
  assert.equal(a.sub, 'commit');
  assert.equal(a.texts.message, 'x');
});

test('git switch -c keeps value and positionals', () => {
  const a = rec('git switch -c feature/12-x develop');
  assert.equal(a.sub, 'switch');
  assert.equal(a.flags.get('c'), 'feature/12-x');
  assert.deepEqual(a.positionals, ['develop']);
});

test('git checkout -b takes the branch name', () => {
  const a = rec('git checkout -b feature/1-a develop');
  assert.equal(a.flags.get('b'), 'feature/1-a');
  assert.deepEqual(a.positionals, ['develop']);
});

test('git worktree add -b', () => {
  const a = rec('git worktree add -b fix/3-z ../wt develop');
  assert.equal(a.sub, 'worktree');
  assert.equal(a.flags.get('b'), 'fix/3-z');
  assert.deepEqual(a.positionals, ['add', '../wt', 'develop']);
});

test('multiple -m are joined with a blank line, --message=value works', () => {
  const a = rec('git commit -m "feat: a" -m "body line"');
  assert.equal(a.texts.message, 'feat: a\n\nbody line');
  const b = rec('git commit --message=fix:b');
  assert.equal(b.texts.message, 'fix:b');
});

test('git commit -F reads via readFile, relative to cwd', () => {
  const seen = [];
  const a = rec('git commit -F msg.txt', (p) => { seen.push(p); return 'chore: z'; }, { cwd: '/w' });
  assert.equal(a.texts.message, 'chore: z');
  assert.deepEqual(seen, ['/w/msg.txt']);
  assert.equal(a.flags.get('file'), 'msg.txt');
});

test('git commit -F - uses stdin heredoc', () => {
  const a = rec("git commit -F - <<'EOF'\nfeat: from stdin\nEOF");
  assert.equal(a.texts.message, 'feat: from stdin\n');
});

test('git commit -n and push aliases', () => {
  assert.equal(rec('git commit -n -m x').flags.get('no-verify'), true);
  const p = rec('git push -fu origin main');
  assert.equal(p.flags.get('force'), true);
  assert.equal(p.flags.get('set-upstream'), true);
  assert.deepEqual(p.positionals, ['origin', 'main']);
  assert.equal(rec('git push -d origin x').flags.get('delete'), true);
});

test('git tag -a with message', () => {
  const a = rec('git tag -a v1.0.0 -m "release"');
  assert.equal(a.sub, 'tag');
  assert.deepEqual(a.positionals, ['v1.0.0']);
  assert.equal(a.flags.get('message'), 'release');
});

test('env and raw are carried over', () => {
  const a = rec('FOO=1 git branch -d x');
  assert.deepEqual(a.env, { FOO: '1' });
  assert.equal(a.raw, 'FOO=1 git branch -d x');
});

test('gh pr merge aliases normalise to long names', () => {
  const a = rec('gh pr merge 42 --squash');
  assert.equal(a.tool, 'gh');
  assert.equal(a.sub, 'pr merge');
  assert.deepEqual(a.positionals, ['42']);
  assert.equal(a.flags.get('squash'), true);
  const b = rec('gh pr merge 42 -sd');
  assert.equal(b.flags.get('squash'), true);
  assert.equal(b.flags.get('delete-branch'), true);
  assert.equal(rec('gh pr merge -r 7').flags.get('rebase'), true);
  assert.equal(rec('gh pr merge -m 7').flags.get('merge'), true);
});

test('gh issue create -t/-b', () => {
  const a = rec('gh issue create -t "feat: a" -b "b"');
  assert.equal(a.sub, 'issue create');
  assert.equal(a.texts.title, 'feat: a');
  assert.equal(a.texts.body, 'b');
  assert.equal(a.flags.get('title'), 'feat: a');
});

test('gh pr create base/head and body-file', () => {
  const a = rec('gh pr create -B develop -H feature/1-x --title "feat: t" --body-file body.md',
    (p) => (p === 'body.md' ? 'the body' : null));
  assert.equal(a.sub, 'pr create');
  assert.equal(a.flags.get('base'), 'develop');
  assert.equal(a.flags.get('head'), 'feature/1-x');
  assert.equal(a.texts.title, 'feat: t');
  assert.equal(a.texts.body, 'the body');
});

test('gh pr create -m is a milestone, not merge', () => {
  const a = rec('gh pr create -m v1 -t t');
  assert.equal(a.flags.get('m'), 'v1');
  assert.equal(a.flags.has('merge'), false);
});

test('gh body-file - reads stdin; -F alias', () => {
  const a = rec("gh pr edit 3 -F - <<'EOF'\nhello\nEOF");
  assert.equal(a.sub, 'pr edit');
  assert.equal(a.texts.body, 'hello\n');
  assert.equal(a.flags.get('body-file'), '-');
});

test('non git/gh commands return null', () => {
  assert.equal(rec('echo git commit'), null);
  assert.equal(rec('npx gh pr list'), null);
  assert.equal(rec('git status'), null);
  assert.equal(rec('gh pr list'), null);
  assert.equal(rec('gh auth login'), null);
});

test('gh pr merge --subject is a value flag; -t means subject', () => {
  const a = rec('gh pr merge --subject "s" 42');
  assert.deepEqual(a.positionals, ['42']);
  assert.equal(a.flags.get('subject'), 's');
  const b = rec('gh pr merge -t "s2" 42');
  assert.equal(b.flags.get('subject'), 's2');
  assert.deepEqual(b.positionals, ['42']);
  assert.equal(b.texts.title, 's2');
});

test('gh pr merge fills texts from subject/body', () => {
  const a = rec('gh pr merge 4 --merge --body "x\n\nCo-Authored-By: Claude"');
  assert.match(a.texts.body, /Co-Authored-By/);
  const b = rec('gh pr merge 4 --merge -F body.md', () => 'Co-Authored-By: Claude');
  assert.match(b.texts.body, /Co-Authored-By/);
});

test('unlisted git global options are skipped', () => {
  const a = rec('git --literal-pathspecs --no-advice commit -m x');
  assert.equal(a.sub, 'commit');
  assert.equal(a.texts.message, 'x');
  assert.equal(rec('git --git-dir=/x -p push origin a').sub, 'push');
});

test('git tag -m/-F fill texts.message', () => {
  assert.equal(rec('git tag -a v1 -m "rel"').texts.message, 'rel');
  assert.equal(rec('git tag -a v1 -F n.txt', () => 'notes').texts.message, 'notes');
});

test('git global options with separate values: --attr-source consumes, --exec-path does not', () => {
  assert.equal(rec('git --attr-source HEAD commit -m x').sub, 'commit');
  assert.equal(rec('git --attr-source=HEAD commit -m x').sub, 'commit');
  assert.equal(rec('git --exec-path commit -m x').sub, 'commit');
  assert.equal(rec('git --namespace ns --work-tree /w push origin a').sub, 'push');
});
