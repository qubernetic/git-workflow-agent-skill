import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userConfigPath, findRepoRoot, loadConfig } from '../lib/config.mjs';

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-cfg-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (rel, content) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content ?? '');
  return p;
};
const repo = (name = 'repo') => { fs.mkdirSync(path.join(tmp, name, '.git'), { recursive: true }); return path.join(tmp, name); };
const envFor = (scope) => {
  const dir = path.join(tmp, 'xdg');
  if (scope) mk('xdg/git-workflow-guard/config.json', JSON.stringify({ scope }));
  return { XDG_CONFIG_HOME: dir };
};

test('userConfigPath: XDG_CONFIG_HOME, HOME fallback, Windows APPDATA', () => {
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: '/x' }, 'linux'), path.posix.join('/x', 'git-workflow-guard', 'config.json'));
  assert.equal(userConfigPath({ HOME: '/h' }, 'linux'), path.posix.join('/h', '.config', 'git-workflow-guard', 'config.json'));
  assert.equal(userConfigPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'),
    'C:\\Users\\u\\AppData\\Roaming\\git-workflow-guard\\config.json');
});

test('findRepoRoot: .git dir, .git file, none', () => {
  const r = repo();
  fs.mkdirSync(path.join(r, 'a', 'b'), { recursive: true });
  assert.equal(findRepoRoot(path.join(r, 'a', 'b')), r);
  mk('wt/.git', 'gitdir: /elsewhere');
  fs.mkdirSync(path.join(tmp, 'wt', 'sub'));
  assert.equal(findRepoRoot(path.join(tmp, 'wt', 'sub')), path.join(tmp, 'wt'));
  fs.mkdirSync(path.join(tmp, 'plain'));
  assert.equal(findRepoRoot(path.join(tmp, 'plain')), null);
});

test('no repo: inactive', () => {
  fs.mkdirSync(path.join(tmp, 'plain'));
  const c = loadConfig({ cwd: path.join(tmp, 'plain'), env: envFor('all') });
  assert.equal(c.repoRoot, null);
  assert.equal(c.active, false);
});

test('opt-in with empty .git-workflow.json: active with defaults', () => {
  const r = repo();
  mk('repo/.git-workflow.json', '{}');
  const c = loadConfig({ cwd: r, env: envFor() });
  assert.equal(c.active, true);
  assert.equal(c.scope, 'opt-in');
  assert.equal(c.repoRoot, r);
  assert.deepEqual(c.protectedBranches, ['main', 'develop']);
  assert.deepEqual(c.branchTypes, ['feature', 'fix', 'hotfix', 'epic']);
  assert.deepEqual(c.rules, {});
  assert.deepEqual(c.attributionPatterns, []);
  assert.deepEqual(c.warnings, []);
});

test('opt-in without .git-workflow.json: inactive', () => {
  const r = repo();
  assert.equal(loadConfig({ cwd: r, env: envFor('opt-in') }).active, false);
});

test('scope all without the file: active', () => {
  const r = repo();
  const c = loadConfig({ cwd: r, env: envFor('all') });
  assert.equal(c.active, true);
  assert.equal(c.scope, 'all');
});

test('rules and other keys honoured, unknown keys ignored', () => {
  const r = repo();
  mk('repo/.git-workflow.json', JSON.stringify({
    rules: { 'fresh-base': 'off', 'merge-gate': 'deny' },
    protectedBranches: ['trunk'], branchTypes: ['feature'], attributionPatterns: ['Bot'], bogus: 1,
  }));
  const c = loadConfig({ cwd: r, env: envFor() });
  assert.deepEqual(c.rules, { 'fresh-base': 'off', 'merge-gate': 'deny' });
  assert.deepEqual(c.protectedBranches, ['trunk']);
  assert.deepEqual(c.branchTypes, ['feature']);
  assert.deepEqual(c.attributionPatterns, ['Bot']);
  assert.equal(c.bogus, undefined);
});

test('invalid .git-workflow.json: active, defaults, warning', () => {
  const r = repo();
  mk('repo/.git-workflow.json', '{nope');
  const c = loadConfig({ cwd: r, env: envFor() });
  assert.equal(c.active, true);
  assert.deepEqual(c.protectedBranches, ['main', 'develop']);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /\.git-workflow\.json/);
});

test('wrongly typed keys fall back to defaults with warnings', () => {
  const r = repo();
  mk('repo/.git-workflow.json', JSON.stringify({ protectedBranches: 'main', rules: { a: 'bogus', b: 'warn' } }));
  const c = loadConfig({ cwd: r, env: envFor() });
  assert.deepEqual(c.protectedBranches, ['main', 'develop']);
  assert.deepEqual(c.rules, { b: 'warn' });
  assert.equal(c.warnings.length, 2);
});

test('invalid user config: opt-in with warning', () => {
  const r = repo();
  mk('xdg/git-workflow-guard/config.json', '{bad');
  const c = loadConfig({ cwd: r, env: { XDG_CONFIG_HOME: path.join(tmp, 'xdg') } });
  assert.equal(c.scope, 'opt-in');
  assert.equal(c.active, false);
  assert.equal(c.warnings.length, 1);
});
