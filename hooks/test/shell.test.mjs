import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../lib/shell.mjs';

const gitOf = (r) => r.commands.find((c) => c.argv[0] === 'git');

test('simple double-quoted commit', () => {
  const r = parseCommandLine('git commit -m "feat: x"');
  assert.equal(r.ok, true);
  assert.equal(r.commands.length, 1);
  assert.deepEqual(r.commands[0].argv, ['git', 'commit', '-m', 'feat: x']);
  assert.deepEqual(r.commands[0].env, {});
  assert.equal(r.commands[0].stdin, undefined);
});

test('&& and ; yield three commands', () => {
  const r = parseCommandLine("git add -A && git commit -m 'a b' ; git push");
  assert.equal(r.ok, true);
  assert.deepEqual(r.commands.map((c) => c.argv), [
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', 'a b'],
    ['git', 'push'],
  ]);
});

test('leading env assignments', () => {
  const r = parseCommandLine('FOO=1 BAR=2 gh pr merge 4 --merge');
  assert.deepEqual(r.commands[0].env, { FOO: '1', BAR: '2' });
  assert.deepEqual(r.commands[0].argv, ['gh', 'pr', 'merge', '4', '--merge']);
});

test('cd sets cwd for following command', () => {
  const r = parseCommandLine('cd /tmp/r && git status');
  assert.equal(r.commands[1].cwd, '/tmp/r');
  assert.deepEqual(r.commands[1].argv, ['git', 'status']);
});

test('relative cd resolves against opts.cwd', () => {
  const r = parseCommandLine('cd sub; git status', { cwd: '/a/b' });
  assert.equal(r.commands[0].cwd, '/a/b');
  assert.equal(r.commands[1].cwd, '/a/b/sub');
});

test('heredoc inside command substitution yields one argv word', () => {
  const src = `git commit -m "$(cat <<'EOF'\nfeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`;
  const r = parseCommandLine(src);
  assert.equal(r.ok, true);
  const g = gitOf(r);
  assert.equal(g.argv.length, 4);
  assert.equal(g.argv[3], 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
});

test('heredoc body with ) and quotes does not end substitution early', () => {
  const src = `git commit -m "$(cat <<'EOF'\nfix: a (b) it's "q"\nEOF\n)" && git push`;
  const r = parseCommandLine(src);
  assert.equal(r.ok, true);
  assert.equal(gitOf(r).argv[3], `fix: a (b) it's "q"`);
  assert.deepEqual(r.commands[r.commands.length - 1].argv, ['git', 'push']);
});

test('heredoc stdin on plain command', () => {
  const r = parseCommandLine("gh pr create --body-file - <<'EOF'\nbody\nEOF");
  assert.equal(r.ok, true);
  assert.equal(r.commands[0].stdin, 'body\n');
  assert.deepEqual(r.commands[0].argv, ['gh', 'pr', 'create', '--body-file', '-']);
});

test('unquoted heredoc keeps $VAR literal', () => {
  const r = parseCommandLine('cat <<EOF\nhi $USER\nEOF\n');
  assert.equal(r.commands[0].stdin, 'hi $USER\n');
});

test('here-string', () => {
  const r = parseCommandLine("cat <<< 'hello world'");
  assert.equal(r.commands[0].stdin, 'hello world\n');
  assert.deepEqual(r.commands[0].argv, ['cat']);
});

test('mentions in quoted args stay data', () => {
  const r = parseCommandLine('echo "never use --squash" | cat');
  assert.equal(r.commands[0].argv[0], 'echo');
  assert.deepEqual(r.commands[0].argv, ['echo', 'never use --squash']);
  assert.equal(r.commands.length, 2);
});

test('pipe and || give three commands', () => {
  const r = parseCommandLine('git log | grep x || true');
  assert.equal(r.commands.length, 3);
});

test('command substitution inner commands are appended', () => {
  const r = parseCommandLine('echo $(git rev-parse HEAD)');
  assert.ok(r.commands.some((c) => c.argv[0] === 'git' && c.argv[1] === 'rev-parse'));
});

test('single quotes do not substitute', () => {
  const r = parseCommandLine("echo '$(git push)'");
  assert.equal(r.commands.length, 1);
  assert.deepEqual(r.commands[0].argv, ['echo', '$(git push)']);
});

test('backtick substitution recursed', () => {
  const r = parseCommandLine('echo `git status`');
  assert.ok(r.commands.some((c) => c.argv[0] === 'git'));
});

test('redirections are not argv', () => {
  const r = parseCommandLine('git status > out.txt 2>&1');
  assert.deepEqual(r.commands[0].argv, ['git', 'status']);
});

test('comment ignored', () => {
  const r = parseCommandLine('git status # git push');
  assert.equal(r.commands.length, 1);
});

test('unterminated quote is not ok', () => {
  assert.equal(parseCommandLine('git commit -m "oops').ok, false);
  assert.equal(parseCommandLine("git commit -m 'oops").ok, false);
  assert.equal(parseCommandLine('echo $(git status').ok, false);
});

test('subshell cd does not leak cwd', () => {
  const r = parseCommandLine('(cd sub && git status); git push', { cwd: '/w' });
  assert.equal(r.commands.find((c) => c.argv[1] === 'status').cwd, '/w/sub');
  assert.equal(r.commands.find((c) => c.argv[1] === 'push').cwd, '/w');
  const r2 = parseCommandLine('(cd /x && git status); git push');
  assert.equal(r2.commands.find((c) => c.argv[1] === 'push').cwd, undefined);
});

test('shell keywords at command position are skipped', () => {
  let r = parseCommandLine('if true; then git push; fi');
  assert.ok(r.commands.some((c) => c.argv.join(' ') === 'git push'));
  assert.ok(!r.commands.some((c) => ['fi', 'then'].includes(c.argv[0])));
  r = parseCommandLine('for b in a; do git branch -D $b; done');
  assert.ok(r.commands.some((c) => c.argv[0] === 'git' && c.argv[1] === 'branch' && c.argv[2] === '-D'));
  assert.ok(!r.commands.some((c) => c.argv[0] === 'done'));
  r = parseCommandLine('! git diff --quiet');
  assert.deepEqual(r.commands[0].argv, ['git', 'diff', '--quiet']);
  r = parseCommandLine('time -p git push');
  assert.deepEqual(r.commands[0].argv, ['git', 'push']);
  r = parseCommandLine('{ git push; }');
  assert.deepEqual(r.commands.map((c) => c.argv), [['git', 'push']]);
});

test('cd to dynamic or empty target makes cwd unknown', () => {
  const r = parseCommandLine('cd "$(mktemp -d)" && git status', { cwd: '/w' });
  assert.equal(r.commands.find((c) => c.argv[0] === 'git').cwd, undefined);
  const r2 = parseCommandLine("cd '' && git status", { cwd: '/w' });
  assert.equal(r2.commands[1].cwd, undefined);
});

test('cd does not persist across pipes or background', () => {
  for (const src of ['cd sub | git push', 'cd sub & git push', 'git log | cd sub; git push']) {
    const r = parseCommandLine(src, { cwd: '/w' });
    assert.equal(r.commands.find((c) => c.argv[1] === 'push').cwd, '/w', src);
  }
  for (const src of ['cd sub && git push', 'cd sub; git push', 'cd sub || git push']) {
    const r = parseCommandLine(src, { cwd: '/w' });
    assert.equal(r.commands.find((c) => c.argv[1] === 'push').cwd, '/w/sub', src);
  }
});

test('relative cd from unknown base stays unknown', () => {
  const r = parseCommandLine("cd '' ; cd sub; git status", { cwd: '/w' });
  assert.equal(r.commands.find((c) => c.argv[0] === 'git').cwd, undefined);
});
