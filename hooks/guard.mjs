#!/usr/bin/env node
// git-workflow guard entry point: node hooks/guard.mjs <subcommand> ...
import * as claude from './lib/adapters/claude.mjs';
import * as codex from './lib/adapters/codex.mjs';
import { commitMsg, prePush } from './lib/githooks.mjs';
import * as manage from './lib/manage/commands.mjs';

const ADAPTERS = { claude, codex };
const EVENTS = { 'pre-tool-use': 'preToolUse', 'session-start': 'sessionStart' };

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const warn = (msg) => process.stderr.write(`git-workflow guard: ${msg}\n`);

// Hook subcommands never exit non-zero; any failure means allow.
async function hook([harness, event]) {
  const adapter = ADAPTERS[harness];
  const fn = adapter && EVENTS[event];
  if (!fn) { process.stderr.write('usage: guard.mjs hook <claude|codex> <pre-tool-use|session-start>\n'); return 2; }
  try {
    let input;
    try { input = JSON.parse(await readStdin()); } catch (e) { warn(`malformed hook input (${e.message}); allowing`); return 0; }
    if (input === null || typeof input !== 'object') { warn('hook input is not a JSON object; allowing'); return 0; }
    const r = await adapter[fn](input);
    for (const w of r.warnings ?? []) warn(String(w).replace(/^git-workflow guard:\s*/, '').replace(/\n/g, ' '));
    if (r.stdout) process.stdout.write(r.stdout);
  } catch (e) {
    warn(`hook failed (${e?.message ?? e}); allowing`);
  }
  return 0;
}

// Git hook subcommands: exit 1 only for a rule violation; failures fail open.
async function gitHook([name, ...args]) {
  try {
    let r;
    if (name === 'commit-msg') r = commitMsg(args[0], { cwd: process.cwd() });
    else if (name === 'pre-push') r = prePush(await readStdin(), { cwd: process.cwd() });
    else { process.stderr.write('usage: guard.mjs git <commit-msg|pre-push> [args]\n'); return 2; }
    if (r.stderr) process.stderr.write(r.stderr);
    return r.exitCode;
  } catch (e) {
    warn(`git hook failed (${e?.message ?? e}); allowing`);
    return 0;
  }
}

const flag = (args, name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

// Management commands print report lines; exit 1 on failure.
const manageCmd = (fn) => async (args) => {
  try {
    for (const l of fn(args)) process.stdout.write(`${l}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`git-workflow guard: ${e.message}\n`);
    return 1;
  }
};

// Later tasks add: update, doctor, repair.
const COMMANDS = {
  hook,
  git: gitHook,
  install: manageCmd((a) => manage.install({
    scope: flag(a, '--scope') ?? 'opt-in',
    harnesses: flag(a, '--harness')?.split(',').filter(Boolean),
  })),
  uninstall: manageCmd(() => manage.uninstall()),
  enable: manageCmd((a) => manage.enable({ gitHooks: a.includes('--git-hooks') })),
  disable: manageCmd(() => manage.disable()),
};

const [sub, ...rest] = process.argv.slice(2);
if (!COMMANDS[sub]) {
  process.stderr.write(`usage: guard.mjs <${Object.keys(COMMANDS).join('|')}> ...\n`);
  process.exitCode = 2;
} else {
  process.exitCode = await COMMANDS[sub](rest);
}
