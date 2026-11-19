import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userConfigPath, findRepoRoot } from '../config.mjs';
import { installShims } from '../githooks.mjs';
import { HARNESSES, register, unregister, codexHome } from './registry.mjs';

const GUARD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../guard.mjs');

function skillVersion() {
  try {
    const text = fs.readFileSync(path.resolve(path.dirname(GUARD_PATH), '../SKILL.md'), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    return /^version:\s*"?([^"\s]+)"?\s*$/m.exec(fm)?.[1] ?? null;
  } catch { return null; }
}

function codexFeatureEnabled(env) {
  try {
    const toml = fs.readFileSync(path.join(codexHome(env), 'config.toml'), 'utf8');
    const section = /^\[features\][^\S\n]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? '';
    return /^\s*hooks\s*=\s*true\b/m.test(section);
  } catch { return false; }
}

export function install({ scope = 'opt-in', harnesses, env = process.env } = {}) {
  if (scope !== 'opt-in' && scope !== 'all') throw new Error(`invalid scope ${JSON.stringify(scope)}; use opt-in or all`);
  const lines = [];
  const registered = [];
  for (const name of harnesses ?? Object.keys(HARNESSES)) {
    const h = HARNESSES[name];
    if (!h) { lines.push(`${name}: error: unknown harness`); continue; }
    if (!harnesses && !h.detect(env)) { lines.push(`${name}: not detected, skipped`); continue; }
    try {
      const { changed } = register(name, GUARD_PATH, env);
      registered.push(name);
      lines.push(`${name}: ${changed ? 'registered in' : 'already registered in'} ${h.configPath(env)}`);
      if (name === 'codex' && !codexFeatureEnabled(env)) {
        lines.push(`codex: add to ${path.join(codexHome(env), 'config.toml')}:\n[features]\nhooks = true`);
      }
    } catch (e) {
      lines.push(`${name}: error: ${e.message}; left untouched`);
    }
  }
  const file = userConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cfg = { scope, version: skillVersion(), guardPath: GUARD_PATH, harnesses: registered };
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  lines.push(`user config written to ${file} (scope: ${scope})`);
  return lines;
}

export function uninstall({ env = process.env } = {}) {
  const lines = [];
  for (const name of Object.keys(HARNESSES)) {
    try {
      const { changed } = unregister(name, env);
      lines.push(`${name}: ${changed ? 'unregistered' : 'nothing to remove'}`);
    } catch (e) {
      lines.push(`${name}: error: ${e.message}; left untouched`);
    }
  }
  return lines;
}

export function enable({ cwd = process.cwd(), gitHooks = false } = {}) {
  const root = findRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository`);
  const file = path.join(root, '.git-workflow.json');
  const lines = [];
  if (fs.existsSync(file)) lines.push(`${file} already exists`);
  else { fs.writeFileSync(file, '{}\n'); lines.push(`created ${file}`); }
  if (gitHooks) {
    const { written, chained } = installShims(root);
    lines.push(`git hooks installed: ${written.join(', ') || 'none new'}`);
    if (chained.length) lines.push(`existing hooks kept as <name>.local: ${chained.join(', ')}`);
  }
  return lines;
}

export function disable({ cwd = process.cwd() } = {}) {
  const root = findRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository`);
  const file = path.join(root, '.git-workflow.json');
  if (!fs.existsSync(file)) return [`${file} not present; guard already inactive here (scope opt-in)`];
  let empty = false;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    empty = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
  } catch { /* keep file */ }
  if (empty) { fs.rmSync(file); return [`removed ${file}`]; }
  return [`${file} has settings, kept. To turn rules off set "rules": {"<rule-id>": "off"} for each rule, or set scope opt-in and delete the file by hand.`];
}
