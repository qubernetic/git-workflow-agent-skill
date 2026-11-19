import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractCommand } from '../lib/adapters/tools.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import * as codex from '../lib/adapters/codex.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, '..', 'guard.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-adapters-'));
const xdg = path.join(tmp, 'xdg');
fs.mkdirSync(xdg);
const mkRepo = (name, optIn = true) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (optIn) fs.writeFileSync(path.join(dir, '.git-workflow.json'), '{}');
  return dir;
};
const repo = mkRepo('repo');
const plain = mkRepo('plain', false);
const env = { XDG_CONFIG_HOME: xdg, APPDATA: xdg, HOME: tmp };
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8').replaceAll('__CWD__', repo));

const PR = JSON.stringify({ number: 5, baseRefName: 'develop', headRefName: 'feature/1-x', body: '## Test plan\n- [x] a\n' });
const exec = async (cmd, args) => {
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: PR, stderr: '' };
  if (cmd === 'git' && args[0] === 'symbolic-ref') return { code: 0, stdout: 'feature/1-x\n', stderr: '' };
  return { code: 1, stdout: '', stderr: '' };
};
const bash = (command, extra = {}) => ({ cwd: repo, tool_name: 'Bash', tool_input: { command }, ...extra });
const decision = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test('extractCommand: Bash, codex shapes, context-mode, others', () => {
  assert.equal(extractCommand('Bash', { command: 'git status' }), 'git status');
  assert.equal(extractCommand('shell', { command: 'git status' }), 'git status');
  assert.equal(extractCommand('shell', { command: ['bash', '-lc', 'gh pr merge 5 --squash'] }), 'gh pr merge 5 --squash');
  assert.equal(extractCommand('exec_command', { command: ['git', 'commit', '-m', 'a b'] }), "git commit -m 'a b'");
  assert.equal(extractCommand('mcp__x__ctx_execute', { language: 'shell', code: 'git push -f' }), 'git push -f');
  assert.equal(extractCommand('mcp__x__ctx_execute', { language: 'python', code: 'git push -f' }), null);
  assert.equal(extractCommand('mcp__x__ctx_batch_execute', { commands: [{ command: 'a' }, { command: 'b' }] }), 'a\nb');
  assert.equal(
    extractCommand('mcp__x__ctx_batch', { commands: [{ command: 'a' }, { language: 'shell', code: 'b' }, { language: 'python', code: 'c' }, {}] }),
    'a\nb',
  );
  assert.equal(extractCommand('mcp__x__ctx_batch', { commands: [{ language: 'python', code: 'c' }] }), null);
  assert.equal(extractCommand('Read', { file_path: '/x' }), null);
});

test('claude: attribution commit denied', async () => {
  const r = await claude.preToolUse(fixture('claude-bash-attribution.json'), { env, exec });
  assert.equal(r.exitCode, 0);
  const o = decision(r);
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /no-ai-attribution/);
});

test('claude: develop merge asks by default, denies with approval hint under bypassPermissions', async () => {
  const cmd = 'gh pr merge 5 --merge --delete-branch';
  assert.equal(decision(await claude.preToolUse(bash(cmd, { permission_mode: 'default' }), { env, exec })).permissionDecision, 'ask');
  const o = decision(await claude.preToolUse(bash(cmd, { permission_mode: 'bypassPermissions' }), { env, exec }));
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /WORKFLOW_GUARD_APPROVE=5/);
});

test('codex: shell array gh pr merge --squash denied', async () => {
  const r = await codex.preToolUse(fixture('codex-shell-merge.json'), { env, exec });
  assert.equal(decision(r).permissionDecision, 'deny');
  assert.match(decision(r).permissionDecisionReason, /merge-method/);
});

test('codex: never asks', async () => {
  const r = await codex.preToolUse({ cwd: repo, tool_name: 'shell', tool_input: { command: 'gh pr merge 5 --merge' } }, { env, exec });
  assert.equal(decision(r).permissionDecision, 'deny');
});

test('context-mode ctx_execute shell force push denied', async () => {
  const input = { cwd: repo, tool_name: 'mcp__plugin_context-mode_context-mode__ctx_execute', tool_input: { language: 'shell', code: 'git push --force origin feature/1-x' } };
  assert.equal(decision(await claude.preToolUse(input, { env, exec })).permissionDecision, 'deny');
});

test('Read tool and allowed commands give empty stdout', async () => {
  assert.equal((await claude.preToolUse({ cwd: repo, tool_name: 'Read', tool_input: { file_path: 'x' } }, { env, exec })).stdout, '');
  assert.equal((await claude.preToolUse(bash('git status'), { env, exec })).stdout, '');
});

test('sessionStart: reminder only where active', () => {
  const on = claude.sessionStart({ cwd: repo }, { env });
  const o = decision(on);
  assert.equal(o.hookEventName, 'SessionStart');
  assert.match(o.additionalContext, /issue → branch/);
  assert.equal(codex.sessionStart({ cwd: repo }, { env }).stdout.includes('issue → branch'), true);
  assert.equal(claude.sessionStart({ cwd: plain }, { env }).stdout, '');
});

const spawn = (args, input) => spawnSync(process.execPath, [guard, ...args], {
  input, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: xdg, APPDATA: xdg, HOME: tmp },
});

test('subprocess: pre-tool-use fixture gives exit 0 and deny JSON', () => {
  const r = spawn(['hook', 'claude', 'pre-tool-use'], JSON.stringify(fixture('claude-bash-attribution.json')));
  assert.equal(r.status, 0);
  assert.equal(decision(r).permissionDecision, 'deny');
});

test('subprocess: session-start prints reminder', () => {
  const r = spawn(['hook', 'codex', 'session-start'], JSON.stringify({ cwd: repo }));
  assert.equal(r.status, 0);
  assert.match(decision(r).additionalContext, /issue → branch/);
});

test('subprocess: malformed stdin allows with one stderr line', () => {
  const r = spawn(['hook', 'claude', 'pre-tool-use'], '{nope');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('subprocess: unknown subcommand exits 2 with usage', () => {
  const r = spawn(['bogus'], '');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
