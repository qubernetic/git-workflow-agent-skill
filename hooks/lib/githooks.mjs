// Git-side layer: commit-msg and pre-push hooks plus shim installation.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { checkCommitMessage } from './rules/text.mjs';
import { levelDecision } from './rules/levels.mjs';

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../guard.mjs').replace(/\\/g, '/');
const HOOK_NAMES = ['commit-msg', 'pre-push'];
const SCISSORS = '# ------------------------ >8 ------------------------';
const ZERO_SHA = /^0+$/;
const PREFIX = 'git-workflow guard: ';

const line = (msg) => (msg.startsWith(PREFIX) ? msg : PREFIX + msg);

// Findings -> {exitCode, stderr}. warn passes with output; deny blocks.
function verdict(findings, warnings = []) {
  const lines = warnings.map((w) => line(String(w).replace(/^git-workflow guard:\s*/, '')));
  let exitCode = 0;
  for (const f of findings) {
    lines.push(f.message);
    if (f.decision !== 'warn') exitCode = 1;
  }
  return { exitCode, stderr: lines.length ? lines.join('\n') + '\n' : '' };
}

const failOpen = (e) => ({ exitCode: 0, stderr: `${PREFIX}git hook failed (${e?.message ?? e}); allowing\n` });

export function commitMsg(file, { cwd = process.cwd() } = {}) {
  try {
    const config = loadConfig({ cwd });
    if (!config.active) return { exitCode: 0, stderr: '' };
    let text = fs.readFileSync(file, 'utf8');
    const cut = text.split('\n').findIndex((l) => l.trimEnd() === SCISSORS);
    if (cut >= 0) text = text.split('\n').slice(0, cut).join('\n');
    text = text.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    return verdict(checkCommitMessage(text, config), config.warnings);
  } catch (e) {
    return failOpen(e);
  }
}

// Git hooks cannot ask: a configured `ask` blocks like `deny`.
function finding(config, rule, what, instead) {
  const decision = levelDecision(config.rules?.[rule], 'deny', false);
  if (decision === null) return null;
  return { rule, decision, message: `${PREFIX}${rule}: ${what}. ${instead}.` };
}

export function prePush(stdinText, { cwd = process.cwd() } = {}) {
  try {
    const config = loadConfig({ cwd });
    if (!config.active) return { exitCode: 0, stderr: '' };
    const findings = [];
    const warnings = [...config.warnings];
    const protectedRefs = config.protectedBranches.map((b) => `refs/heads/${b}`);
    for (const l of stdinText.split('\n')) {
      const parts = l.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [, localSha, remoteRef, remoteSha] = parts;
      const isProtected = protectedRefs.includes(remoteRef);
      const branch = remoteRef.replace(/^refs\/heads\//, '');
      if (ZERO_SHA.test(localSha)) {
        if (isProtected || remoteRef.startsWith('refs/heads/epic/')) {
          findings.push(finding(config, 'protected-delete', `deleting ${branch} is not allowed`, 'Keep protected and epic branches; close the epic through its PR instead'));
        }
        continue;
      }
      if (!isProtected) continue;
      if (ZERO_SHA.test(remoteSha)) {
        const r = spawnSync('git', ['rev-list', '--count', localSha], { cwd, encoding: 'utf8' });
        if (r.status === 0 && r.stdout.trim() === '1') continue; // bootstrap: first commit of a new repo
        if (r.status !== 0) {
          warnings.push(`could not count commits of ${localSha} (${(r.stderr || 'git error').trim()}); allowing push to ${branch}`);
          continue;
        }
      }
      findings.push(finding(config, 'protected-commit', `pushing directly to ${branch} is not allowed`, 'Push a feature/fix branch and open a PR instead'));
    }
    return verdict(findings.filter(Boolean), warnings);
  } catch (e) {
    return failOpen(e);
  }
}

// pre-push gets the ref list on stdin: buffer it so a chained .local hook and the guard both see it.
const shimBody = (name) => (name === 'pre-push'
  ? `#!/bin/sh\ninput=$(cat)\nlocal_hook="$(dirname "$0")/${name}.local"\nif [ -x "$local_hook" ]; then printf '%s\\n' "$input" | "$local_hook" "$@" || exit $?; fi\nprintf '%s\\n' "$input" | node "${GUARD}" git ${name} "$@"\n`
  : `#!/bin/sh\n[ -x "$(dirname "$0")/${name}.local" ] && { "$(dirname "$0")/${name}.local" "$@" || exit $?; }\nexec node "${GUARD}" git ${name} "$@"\n`);

// Matches every shim version we have written (older bodies are upgraded in place).
const readOurShim = (file, name) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes(`guard.mjs" git ${name} `) ? text : null;
  } catch { return null; }
};

export function installShims(repoRoot) {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse --git-path hooks failed: ${r.stderr.trim()}`);
  const dir = path.resolve(repoRoot, r.stdout.trim());
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const chained = [];
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    const ours = readOurShim(file, name);
    if (ours !== null && ours === shimBody(name)) continue;
    if (ours === null && fs.existsSync(file)) {
      const local = `${file}.local`;
      if (fs.existsSync(local)) throw new Error(`${local} already exists; refusing to overwrite it`);
      fs.renameSync(file, local);
      chained.push(name);
    }
    fs.writeFileSync(file, shimBody(name), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    written.push(name);
  }
  return { written, chained };
}
