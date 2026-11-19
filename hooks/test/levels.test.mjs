import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { levelDecision, withLevel } from '../lib/rules/levels.mjs';
import { evaluate, checkCommitMessage } from '../lib/rules/index.mjs';
import { runCheck } from '../lib/check.mjs';

test('levelDecision: off skips, known levels apply, on/unknown keep the default', () => {
  assert.equal(levelDecision('off', 'deny'), null);
  for (const lv of ['warn', 'ask', 'deny']) assert.equal(levelDecision(lv, 'deny'), lv);
  for (const lv of ['on', 'bogus', undefined, 1]) assert.equal(levelDecision(lv, 'deny'), 'deny');
  assert.equal(levelDecision('on', 'ask'), 'ask');
  assert.equal(levelDecision('ask', 'deny', false), 'deny');
  assert.equal(levelDecision(undefined, 'ask', false), 'deny');
});

test('withLevel returns null for off and rewrites the decision otherwise', () => {
  const f = { rule: 'x', decision: 'deny', message: 'm' };
  assert.equal(withLevel(f, { rules: { x: 'off' } }), null);
  assert.equal(withLevel(f, { rules: { x: 'on' } }).decision, 'deny');
  assert.equal(withLevel(f, { rules: { x: 'warn' } }).decision, 'warn');
});

const ATTR = { tool: 'git', sub: 'commit', flags: new Map(), positionals: [], env: {}, texts: { message: 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' } };
const ctx = (rules, askSupported = true) => ({ config: { rules, protectedBranches: ['main', 'develop'] }, askSupported, env: {}, state: { currentBranch: async () => 'feature/1-x', hasCommits: async () => true } });

test('evaluate: level "on" keeps the rule active with its own decision', async () => {
  const fs0 = await evaluate([ATTR], ctx({ 'no-ai-attribution': 'on' }));
  assert.equal(fs0.find((f) => f.rule === 'no-ai-attribution').decision, 'deny');
});

test('evaluate: configured ask becomes deny when the harness cannot ask', async () => {
  const r1 = await evaluate([ATTR], ctx({ 'no-ai-attribution': 'ask' }, true));
  assert.equal(r1.find((f) => f.rule === 'no-ai-attribution').decision, 'ask');
  const r2 = await evaluate([ATTR], ctx({ 'no-ai-attribution': 'ask' }, false));
  assert.equal(r2.find((f) => f.rule === 'no-ai-attribution').decision, 'deny');
});

test('checkCommitMessage: level "on" still denies', () => {
  const found = checkCommitMessage('bad subject', { rules: { 'conventional-commit': 'on' } });
  assert.equal(found[0].decision, 'deny');
});

test('runCheck: "on" denies attribution; raw fallback honours warn and off', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-levels-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = { XDG_CONFIG_HOME: path.join(tmp, 'xdg'), APPDATA: path.join(tmp, 'xdg'), HOME: tmp, USERPROFILE: tmp };
  const exec = async () => ({ code: 1, stdout: '', stderr: '' });
  const run = (command, rules) => {
    fs.writeFileSync(path.join(repo, '.git-workflow.json'), JSON.stringify({ rules }));
    return runCheck({ command, cwd: repo, askSupported: true, env, exec });
  };
  const on = await run('git commit -m "feat: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"', { 'no-ai-attribution': 'on' });
  assert.equal(on.decision, 'deny');
  const warn = await run('echo "oops && gh pr merge 3 --squash', { 'merge-method': 'warn' });
  assert.equal(warn.decision, 'allow');
  assert.ok(warn.warnings.some((w) => /merge-method/.test(w)));
  const off = await run('echo "oops && gh pr merge 3 --squash', { 'merge-method': 'off' });
  assert.equal(off.decision, 'allow');
  assert.ok(!off.warnings.some((w) => /merge-method/.test(w)));
});
