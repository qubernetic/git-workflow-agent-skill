import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESSES } from '../lib/manage/registry.mjs';
import { install, doctor, formatDoctor, repair, update } from '../lib/manage/commands.mjs';
import { userConfigPath } from '../lib/config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-doctor-'));
let n = 0;
function makeEnv({ claude = true, codex = false } = {}) {
  const home = path.join(tmp, `home${n++}`);
  fs.mkdirSync(home);
  if (claude) fs.mkdirSync(path.join(home, '.claude'));
  const codexHome = path.join(home, '.codex');
  if (codex) fs.mkdirSync(codexHome);
  return {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'),
  };
}
const ghOk = async () => ({ code: 0, stdout: '', stderr: '' });
const ghFail = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });
const run = (env, o = {}) => doctor({ cwd: tmp, env, exec: ghOk, ...o });
const byId = (r, id) => r.checks.find((c) => c.id === id);

test('fresh HOME: claude-registered fails with install fix', async () => {
  const env = makeEnv();
  const r = await run(env);
  assert.equal(r.ok, false);
  const c = byId(r, 'claude-registered');
  assert.equal(c.ok, false);
  assert.match(c.fix, /^node .*install/);
  assert.equal(byId(r, 'user-config').ok, false);
});

test('after install the claude checks pass; codex checks skipped when not detected', async () => {
  const env = makeEnv();
  install({ env });
  const r = await run(env);
  for (const id of ['user-config', 'claude-registered', 'claude-path', 'version', 'scope']) assert.equal(byId(r, id).ok, true, id);
  assert.equal(byId(r, 'codex-registered'), undefined);
  assert.equal(r.ok, true);
});

test('registered path pointing to a deleted file fails claude-path; repair fixes it', async () => {
  const env = makeEnv();
  install({ env });
  const file = HARNESSES.claude.configPath(env);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.hooks.PreToolUse.unshift({ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo foreign' }] });
  for (const list of Object.values(cfg.hooks)) for (const e of list) for (const h of e.hooks) h.command = h.command.replace(/node "[^"]+"/, 'node "/nonexistent/guard.mjs"');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const bad = await run(env);
  assert.equal(byId(bad, 'claude-path').ok, false);
  repair({ env });
  const good = await run(env);
  assert.equal(byId(good, 'claude-path').ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(after.hooks.PreToolUse.some((e) => e.hooks[0].command === 'echo foreign'), 'foreign entry kept');
});

test('repair backs up an invalid user config before rewriting it', () => {
  const env = makeEnv();
  install({ scope: 'all', env });
  const file = userConfigPath(env);
  fs.writeFileSync(file, '{"scope": "all",');
  const lines = repair({ env });
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{"scope": "all",');
  assert.ok(lines.some((l) => l.includes(`${file}.bak`)), lines.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '1.4.0');
  const again = repair({ env });
  assert.ok(!again.some((l) => l.includes('.bak')));
});

test('stale user config version fails version; repair rewrites it', async () => {
  const env = makeEnv();
  install({ env });
  const f = userConfigPath(env);
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...cfg, version: '0.0.1', scope: 'all' }));
  assert.equal(byId(await run(env), 'version').ok, false);
  repair({ env });
  assert.equal(byId(await run(env), 'version').ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).scope, 'all');
});

test('codex: feature flag and trust checks', async () => {
  const env = makeEnv({ claude: false, codex: true });
  install({ env });
  let r = await run(env);
  assert.equal(byId(r, 'codex-registered').ok, true);
  assert.equal(byId(r, 'codex-hooks-feature').ok, false);
  assert.equal(byId(r, 'codex-trust').ok, false, 'missing config.toml');
  assert.match(byId(r, 'codex-trust').fix, /approve the new hooks/);
  const hooksJson = HARNESSES.codex.configPath(env);
  const hooks = JSON.parse(fs.readFileSync(hooksJson, 'utf8')).hooks;
  const tables = [];
  for (const [ev, snake] of [['PreToolUse', 'pre_tool_use'], ['SessionStart', 'session_start']]) {
    const g = hooks[ev].findIndex((e) => e.hooks.some((h) => /guard\.mjs/.test(h.command)));
    tables.push(`[hooks.state."${hooksJson}:${snake}:${g}:0"]\ntrusted_hash = "sha256:abc"\n`);
  }
  const toml = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(toml, `[features]\nhooks = true\n\n${tables[0]}`);
  r = await run(env);
  assert.equal(byId(r, 'codex-hooks-feature').ok, true);
  assert.equal(byId(r, 'codex-trust').ok, false, 'only one event trusted');
  fs.appendFileSync(toml, `\n${tables[1]}`);
  assert.equal(byId(await run(env), 'codex-trust').ok, true);
  fs.writeFileSync(toml, `[features]\nhooks = true\n${tables.map((t) => t.replace('sha256:abc', '')).join('')}`);
  assert.equal(byId(await run(env), 'codex-trust').ok, false, 'table without hash');
});

test('warning checks do not fail doctor and print with !', async () => {
  const env = makeEnv();
  install({ env });
  const r = await run(env, { exec: ghFail });
  assert.equal(byId(r, 'gh').ok, false);
  assert.equal(r.ok, true);
  assert.ok(formatDoctor(r).some((l) => l.startsWith('! ')));
  const rej = await run(env, { exec: async () => { throw new Error('ENOENT'); } });
  assert.equal(byId(rej, 'gh').ok, false);
  assert.equal(rej.ok, true);
});

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: tmp };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commitTag(dir, tag) {
  fs.writeFileSync(path.join(dir, 'f.txt'), tag);
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-m', `c ${tag}`);
  git(dir, 'tag', tag);
}

test('repo checks: git hook shims are a warning only', async () => {
  const env = makeEnv();
  install({ env });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.git-workflow.json'), '{}');
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return cmd === 'git' ? { code: 0, stdout: '.git/hooks\n', stderr: '' } : { code: 0, stdout: '', stderr: '' };
  };
  let r = await doctor({ cwd: repo, env, exec });
  assert.equal(byId(r, 'repo-active').ok, true);
  assert.equal(byId(r, 'repo-config').ok, true);
  assert.equal(byId(r, 'repo-git-hooks').ok, false);
  assert.equal(r.ok, true, 'warnings do not fail');
  assert.ok(calls.includes('git rev-parse --git-path hooks') && calls.includes('gh auth status'), calls.join('; '));
  fs.writeFileSync(path.join(repo, '.git-workflow.json'), '{nope');
  r = await doctor({ cwd: repo, env, exec });
  assert.equal(byId(r, 'repo-config').ok, false);
  assert.equal(r.ok, false);
});

function makeClone() {
  const base = path.join(tmp, `upd${n++}`);
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const clone = path.join(base, 'clone');
  fs.mkdirSync(base);
  git(base, 'init', '--bare', '-b', 'main', remote);
  git(base, 'clone', remote, seed);
  git(seed, 'checkout', '-b', 'main');
  commitTag(seed, 'v1.4.0');
  git(seed, 'push', 'origin', 'main', '--tags');
  git(base, 'clone', remote, clone);
  commitTag(seed, 'v1.5.0-rc.1');
  commitTag(seed, 'v1.5.0');
  git(seed, 'push', 'origin', 'main', '--tags');
  return clone;
}

test('update refuses a development clone on a feature branch', async () => {
  const clone = makeClone();
  git(clone, 'checkout', '-b', 'feature/x');
  await assert.rejects(update({ env: makeEnv(), skillDir: clone }), /development clone/);
});

test('update refuses a dirty work tree', async () => {
  const clone = makeClone();
  fs.writeFileSync(path.join(clone, 'f.txt'), 'dirty');
  await assert.rejects(update({ env: makeEnv(), skillDir: clone }), /local changes/);
});

test('update on main checks out the newest stable tag, then repairs', async () => {
  const clone = makeClone();
  const env = makeEnv();
  const lines = await update({ env, skillDir: clone });
  assert.match(lines[0], /v1\.5\.0/);
  assert.equal(git(clone, 'describe', '--tags', '--exact-match', 'HEAD'), 'v1.5.0');
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: clone, env: GIT_ENV }).status, 1, 'detached');
  assert.ok(fs.existsSync(userConfigPath(env)), 'repair ran');
  // detached at a tag is updatable again
  assert.match((await update({ env, skillDir: clone }))[0], /v1\.5\.0/);
});

test('update outside a git clone prints the manual step', async () => {
  const dir = path.join(tmp, 'plain');
  fs.mkdirSync(dir);
  const lines = await update({ env: makeEnv(), skillDir: dir });
  assert.match(lines[0], /not a git clone/);
});
