import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userConfigPath, findRepoRoot, loadConfig } from '../config.mjs';
import { installShims } from '../githooks.mjs';
import { HARNESSES, register, unregister, codexHome, ourEntries, writeFileThrough } from './registry.mjs';
import { defaultExec } from '../state.mjs';

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

// Keep the user's broken file: a typo must not silently reset scope or other settings.
function backUpInvalid(user, lines) {
  if (user.value || user.missing) return;
  fs.copyFileSync(user.file, `${user.file}.bak`);
  lines.push(`invalid user config ${user.file} (${user.error}) backed up to ${user.file}.bak`);
}

const mergeHarnesses = (existing, registered) =>
  [...new Set([...(Array.isArray(existing) ? existing : []), ...registered])];

export function install({ scope, harnesses, env = process.env } = {}) {
  if (scope !== undefined && scope !== 'opt-in' && scope !== 'all') throw new Error(`invalid scope ${JSON.stringify(scope)}; use opt-in or all`);
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
  const user = readUserConfig(env);
  backUpInvalid(user, lines);
  const file = user.file;
  const existing = user.value;
  const kept = scope === undefined && (existing?.scope === 'all' || existing?.scope === 'opt-in');
  const finalScope = scope ?? (kept ? existing.scope : 'opt-in');
  const cfg = {
    scope: finalScope, version: skillVersion(), guardPath: GUARD_PATH,
    harnesses: mergeHarnesses(existing?.harnesses, registered),
  };
  writeFileThrough(file, `${JSON.stringify(cfg, null, 2)}\n`);
  lines.push(`user config written to ${file} (scope: ${finalScope}${kept ? ', kept' : ''})`);
  if (finalScope === 'opt-in') {
    lines.push(`to enable the guard in a repository, run there: node "${GUARD_PATH}" enable [--git-hooks]`);
  }
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
  if (!fs.existsSync(file)) return [`${file} not present; nothing to remove (with user scope all the guard still runs here)`];
  let empty = false;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    empty = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
  } catch { /* keep file */ }
  if (empty) { fs.rmSync(file); return [`removed ${file}`]; }
  return [`${file} has settings, kept. To turn rules off set "rules": {"<rule-id>": "off"} for each rule, or set scope opt-in and delete the file by hand.`];
}

// ---- doctor / repair / update -------------------------------------------------

const GUARD_CMD = `node "${GUARD_PATH}"`;
const SNAKE = { PreToolUse: 'pre_tool_use', SessionStart: 'session_start' };

function readUserConfig(env) {
  const file = userConfigPath(env);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { file, missing: e.code === 'ENOENT', error: e.message }; }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { file, error: 'not a JSON object' };
    return { file, value };
  } catch (e) { return { file, error: e.message }; }
}

// Line-based scan of config.toml for `[hooks.state."<key>"]` tables that carry a trusted_hash.
function trustedKeys(toml) {
  const keys = new Set();
  let current = null;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]*?)\s*\]\s*$/.exec(line);
    if (header) {
      const m = /^hooks\.state\."((?:[^"\\]|\\.)*)"$/.exec(header[1]);
      current = m ? m[1].replace(/\\(["\\])/g, '$1') : null;
    } else if (current !== null && /^\s*trusted_hash\s*=\s*"[^"]+"/.test(line)) {
      keys.add(current);
    }
  }
  return keys;
}

const harnessChecks = (name, env) => {
  const h = HARNESSES[name];
  const file = h.configPath(env);
  const checks = [];
  let entries = [];
  let error = null;
  try { entries = ourEntries(name, env); } catch (e) { error = e.message; }
  const events = Object.keys(h.events);
  const missing = events.filter((ev) => !entries.some((e) => e.event === ev));
  checks.push(error
    ? { id: `${name}-registered`, ok: false, detail: `${name}: cannot read ${file} (${error})`, fix: `fix ${file} by hand, then run: ${GUARD_CMD} repair` }
    : {
      id: `${name}-registered`, ok: missing.length === 0,
      detail: missing.length ? `${name}: guard hook missing for ${missing.join(', ')} in ${file}` : `${name}: guard registered in ${file}`,
      ...(missing.length ? { fix: `${GUARD_CMD} install --harness ${name}` } : {}),
    });
  const paths = [...new Set(entries.map((e) => /"([^"]*guard\.mjs)"/.exec(e.command)?.[1]).filter(Boolean))];
  const gone = paths.filter((p) => !fs.existsSync(p));
  checks.push({
    id: `${name}-path`, ok: paths.length > 0 && gone.length === 0,
    detail: !paths.length ? `${name}: no registered guard.mjs path` : gone.length ? `${name}: registered guard.mjs not found: ${gone.join(', ')}` : `${name}: registered guard.mjs exists`,
    ...(!paths.length || gone.length ? { fix: `${GUARD_CMD} repair` } : {}),
  });
  if (name === 'codex') {
    const enabled = codexFeatureEnabled(env);
    const cfgFile = path.join(codexHome(env), 'config.toml');
    checks.push({
      id: 'codex-hooks-feature', ok: enabled,
      detail: enabled ? 'codex: hooks feature enabled' : 'codex: hooks feature not enabled',
      ...(enabled ? {} : { fix: `add to ${cfgFile}: [features] hooks = true` }),
    });
    let keys = null;
    try { keys = trustedKeys(fs.readFileSync(cfgFile, 'utf8')); } catch { /* missing config.toml */ }
    const untrusted = keys === null ? null : entries.filter((e) => !keys.has(`${file}:${SNAKE[e.event] ?? e.event}:${e.group}:${e.hook}`));
    const ok = keys !== null && entries.length > 0 && untrusted.length === 0;
    checks.push({
      id: 'codex-trust', ok,
      detail: ok ? 'codex: hooks trusted'
        : keys === null ? `codex: ${cfgFile} not found, hooks not trusted`
          : !entries.length ? 'codex: no guard hooks to trust'
            : `codex: hooks not trusted yet (${untrusted.map((e) => e.event).join(', ')})`,
      ...(ok ? {} : { fix: 'open Codex and approve the new hooks' }),
    });
  }
  return checks;
};

const detected = (env) => Object.keys(HARNESSES).filter((n) => HARNESSES[n].detect(env));

export async function doctor({ cwd = process.cwd(), env = process.env, exec = defaultExec } = {}) {
  const checks = [];
  const add = (c) => checks.push(c);

  const major = Number(process.versions.node.split('.')[0]);
  add({ id: 'node-version', ok: major >= 20, detail: `Node.js ${process.versions.node}${major >= 20 ? '' : ' (need 20 or newer)'}`, ...(major >= 20 ? {} : { fix: 'install Node.js 20 or newer' }) });

  const user = readUserConfig(env);
  add(user.value
    ? { id: 'user-config', ok: true, detail: `user config ${user.file} OK` }
    : { id: 'user-config', ok: false, detail: user.missing ? `user config ${user.file} not found` : `user config ${user.file} is invalid (${user.error})`, fix: `${GUARD_CMD} ${user.missing ? 'install' : 'repair'}` });

  for (const name of detected(env)) for (const c of harnessChecks(name, env)) add(c);

  const skillV = skillVersion();
  const versionOk = Boolean(user.value) && user.value.version === skillV;
  add({
    id: 'version', ok: versionOk,
    detail: versionOk ? `registered version ${skillV} matches the skill` : `registered version ${user.value?.version ?? 'none'} differs from skill version ${skillV ?? 'unknown'}`,
    ...(versionOk ? {} : { fix: `${GUARD_CMD} repair` }),
  });

  const scope = user.value?.scope ?? 'opt-in';
  const scopeOk = scope === 'opt-in' || scope === 'all';
  add({ id: 'scope', ok: scopeOk, detail: scopeOk ? `scope: ${scope}` : `invalid scope ${JSON.stringify(scope)}`, ...(scopeOk ? {} : { fix: `${GUARD_CMD} install --scope opt-in` }) });

  const root = findRepoRoot(cwd);
  if (root) {
    const cfg = loadConfig({ cwd, env });
    add({ id: 'repo-active', ok: true, detail: cfg.active ? `guard active in ${root}` : `guard inactive in ${root} (scope opt-in; run: ${GUARD_CMD} enable)` });
    const repoFile = path.join(root, '.git-workflow.json');
    const present = fs.existsSync(repoFile);
    let repoErr = null;
    if (present) {
      try { const v = JSON.parse(fs.readFileSync(repoFile, 'utf8')); if (v === null || typeof v !== 'object' || Array.isArray(v)) repoErr = 'not a JSON object'; } catch (e) { repoErr = e.message; }
    }
    add({ id: 'repo-config', ok: !repoErr, detail: repoErr ? `${repoFile} is invalid (${repoErr})` : present ? `${repoFile} parses` : 'no .git-workflow.json (defaults)', ...(repoErr ? { fix: `fix the JSON in ${repoFile}` } : {}) });
    if (present) {
      let hooksDir = null;
      try {
        const r = await exec('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, timeoutMs: 5000 });
        if (r.code === 0) hooksDir = path.resolve(root, r.stdout.trim());
      } catch { /* git missing */ }
      const absent = ['commit-msg', 'pre-push'].filter((n) => {
        try { return !fs.readFileSync(path.join(hooksDir ?? '', n), 'utf8').includes(`guard.mjs" git ${n} `); } catch { return true; }
      });
      add({ id: 'repo-git-hooks', ok: absent.length === 0, warning: true, detail: absent.length ? `git hook shims missing: ${absent.join(', ')}` : 'git hook shims present', ...(absent.length ? { fix: `${GUARD_CMD} enable --git-hooks` } : {}) });
    }
  }

  let ghOk = false;
  try { ghOk = (await exec('gh', ['auth', 'status'], { cwd, timeoutMs: 5000 })).code === 0; } catch { /* gh missing */ }
  add({ id: 'gh', ok: ghOk, warning: true, detail: ghOk ? 'gh installed and authenticated' : 'gh missing or not authenticated (state rules degrade)', ...(ghOk ? {} : { fix: 'install gh and run: gh auth login' }) });

  return { ok: checks.every((c) => c.ok || c.warning), checks };
}

export function formatDoctor({ checks }) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${c.ok ? '✓' : c.warning ? '!' : '✗'} ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`  → ${c.fix}`);
  }
  return lines;
}

export function repair({ env = process.env } = {}) {
  const lines = [];
  const registered = [];
  for (const name of detected(env)) {
    const bad = harnessChecks(name, env).filter((c) => /-(registered|path)$/.test(c.id) && !c.ok);
    if (!bad.length) { lines.push(`${name}: nothing to repair`); registered.push(name); continue; }
    try {
      register(name, GUARD_PATH, env);
      registered.push(name);
      lines.push(`${name}: re-registered in ${HARNESSES[name].configPath(env)}`);
    } catch (e) {
      lines.push(`${name}: error: ${e.message}; left untouched`);
    }
  }
  const user = readUserConfig(env);
  backUpInvalid(user, lines);
  const base = user.value ?? {};
  const cfg = { ...base, scope: base.scope === 'all' ? 'all' : 'opt-in', version: skillVersion(), guardPath: GUARD_PATH, harnesses: mergeHarnesses(base.harnesses, registered) };
  writeFileThrough(user.file, `${JSON.stringify(cfg, null, 2)}\n`);
  lines.push(`user config rewritten at ${user.file} (version ${cfg.version})`);
  return lines;
}

export async function update({ env = process.env, exec = defaultExec, skillDir = path.resolve(path.dirname(GUARD_PATH), '..') } = {}) {
  const git = async (...args) => {
    try { return await exec('git', args, { cwd: skillDir, timeoutMs: 60000 }); } catch (e) { return { code: -1, stdout: '', stderr: e.message }; }
  };
  const manual = [`${skillDir} is not a git clone; update by hand: reinstall the skill from the latest release, then run: ${GUARD_CMD} repair`];
  const top = await git('rev-parse', '--show-toplevel');
  if (top.code !== 0) return manual;
  let same = false;
  try { same = fs.realpathSync.native(top.stdout.trim()) === fs.realpathSync.native(skillDir); } catch { /* fall through */ }
  if (!same) return manual;
  const dirty = await git('status', '--porcelain', '--untracked-files=no');
  if (dirty.code !== 0) throw new Error(`git status failed: ${dirty.stderr.trim()}`);
  if (dirty.stdout.trim()) throw new Error(`${skillDir} has local changes; commit or stash them first. Update refused.`);
  const br = await git('symbolic-ref', '--short', '-q', 'HEAD');
  const branch = br.code === 0 ? br.stdout.trim() : '';
  if (branch) {
    if (branch !== 'main') throw new Error(`${skillDir} is on branch ${branch}: development clone, update refused. Switch to main first.`);
  } else if ((await git('describe', '--tags', '--exact-match', 'HEAD')).code !== 0) {
    throw new Error(`${skillDir} is detached at a non-release commit: development clone, update refused.`);
  }
  const fetch = await git('fetch', '--tags', 'origin');
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr.trim()}`);
  const tags = await git('tag', '--list', 'v*', '--sort=-v:refname');
  const tag = tags.stdout.split(/\r?\n/).map((t) => t.trim()).find((t) => t && !t.includes('-'));
  if (!tag) throw new Error('no stable release tag (vX.Y.Z) found on origin');
  const co = await git('checkout', tag);
  if (co.code !== 0) throw new Error(`git checkout ${tag} failed: ${co.stderr.trim()}`);
  return [`skill updated to ${tag} (detached)`, ...repair({ env })];
}
