// Check pipeline: command line -> actions -> rule findings -> decision.
// runCheck({command, cwd, askSupported, env?, exec?}) -> {decision, reason, warnings}
import { parseCommandLine } from './shell.mjs';
import { recognise } from './commands.mjs';
import { loadConfig } from './config.mjs';
import { createState } from './state.mjs';
import { evaluate } from './rules/index.mjs';
import { attributionFinding } from './rules/text.mjs';

const GIT_OR_GH = /\b(git|gh)\b/;
const MAX_DEPTH = 3;
const RANK = { allow: 0, warn: 1, ask: 2, deny: 3 };
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t']);
const base = (s) => String(s ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');

// Strips one wrapper layer. Returns {argv, env, cwd} for the wrapped command,
// {script} for `<shell> -c <script>`, or null when argv is not a wrapper.
function unwrapOnce(cmd) {
  const { argv } = cmd;
  const name = base(argv[0]);
  let env = cmd.env ?? {};
  let cwd = cmd.cwd;
  let i = 1;
  if (name === 'env') {
    while (i < argv.length) {
      const a = argv[i];
      if (ENV_ASSIGN.test(a)) { const eq = a.indexOf('='); env = { ...env, [a.slice(0, eq)]: a.slice(eq + 1) }; i += 1; }
      else if (a === '-u' || a === '--unset') i += 2;
      else if ((a === '-C' || a === '--chdir') && i + 1 < argv.length) { cwd = resolveFrom(cwd, argv[i + 1]); i += 2; }
      else if (a.startsWith('-') && a !== '-' && a !== '--') i += 1;
      else if (a === '--') { i += 1; break; }
      else break;
    }
  } else if (name === 'command' || name === 'nohup' || name === 'exec' || name === 'time') {
    while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += 1;
    if (argv[i] === '--') i += 1;
  } else if (name === 'sudo') {
    while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += SUDO_VALUE_FLAGS.has(argv[i]) ? 2 : 1;
    if (argv[i] === '--') i += 1;
  } else if (name === 'nice') {
    while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += argv[i] === '-n' ? 2 : 1;
    if (argv[i] === '--') i += 1;
  } else if (SHELLS.has(name)) {
    for (let j = 1; j < argv.length; j++) {
      const a = argv[j];
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return j + 1 < argv.length ? { script: argv[j + 1], env, cwd } : null;
      if (!a.startsWith('-')) return null;
    }
    return null;
  } else return null;
  const rest = argv.slice(i);
  return rest.length ? { argv: rest, env, cwd } : null;
}

function resolveFrom(base0, dir) {
  if (!base0 || /^([/\\]|[A-Za-z]:)/.test(dir)) return dir;
  return `${base0.replace(/[/\\]$/, '')}/${dir}`;
}

// Expands wrappers recursively; returns {leaves: SimpleCommand[], failedScripts: string[]}.
function expand(cmd, depth, out) {
  const w = cmd.argv?.length ? unwrapOnce(cmd) : null;
  if (!w) { out.leaves.push(cmd); return; }
  if (w.script !== undefined) {
    if (depth >= MAX_DEPTH) { out.failedScripts.push(w.script); return; }
    const inner = parseCommandLine(w.script, { cwd: w.cwd });
    if (!inner.ok) { out.failedScripts.push(w.script); return; }
    for (const c of inner.commands) expand({ ...c, env: { ...w.env, ...c.env } }, depth + 1, out);
    return;
  }
  if (depth >= MAX_DEPTH) { out.leaves.push(cmd); return; }
  expand({ ...cmd, argv: w.argv, env: w.env, cwd: w.cwd }, depth + 1, out);
}

const MERGE_FALLBACK = /gh\s+pr\s+merge\b[^\n]*--(squash|rebase|admin)\b/;

// Raw-text scan used when the command cannot be parsed (spec 6.4).
function rawFallback(text, config) {
  const found = [];
  const level = (id) => config?.rules?.[id];
  if (level('no-ai-attribution') !== 'off' && /git\s+commit|gh\s+(pr|issue)/.test(text)) {
    // The trailer pattern is anchored to a line start; a one-line command has none.
    const f = attributionFinding(text.replace(/co-authored-by:/gi, '\n$&'), config);
    if (f) found.push(f);
  }
  const m = MERGE_FALLBACK.exec(text);
  if (m && level('merge-method') !== 'off') {
    found.push({
      rule: 'merge-method',
      decision: 'deny',
      message: `git-workflow guard: merge-method: gh pr merge must not use --${m[1]}. Run: gh pr merge <N> --merge --delete-branch.`,
    });
  }
  return found;
}

export async function runCheck({ command, cwd, askSupported = false, env, exec } = {}) {
  const warnings = [];
  try {
    if (!GIT_OR_GH.test(String(command ?? ''))) return { decision: 'allow', reason: '', warnings };
    const baseEnv = env ?? process.env;
    const config = loadConfig({ cwd, env: baseEnv });
    warnings.push(...(config.warnings ?? []));
    if (!config.active) return { decision: 'allow', reason: '', warnings };

    let findings = [];
    const parsed = parseCommandLine(command, { cwd });
    if (!parsed.ok) {
      findings = rawFallback(command, config);
      warnings.push('could not parse the command line; only plain-text checks ran');
    } else {
      const out = { leaves: [], failedScripts: [] };
      for (const c of parsed.commands) expand(c, 0, out);
      for (const s of out.failedScripts) findings.push(...rawFallback(s, config));
      const groups = new Map();
      for (const leaf of out.leaves) {
        const action = recognise(leaf);
        if (!action) continue;
        const key = action.cwd ?? cwd;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(action);
      }
      for (const [dir, actions] of groups) {
        const state = createState({ cwd: dir, ...(exec ? { exec } : {}) });
        findings.push(...await evaluate(actions, { state, config, askSupported, env: { ...baseEnv } }));
      }
    }

    let decision = 'allow';
    const reasons = [];
    for (const f of findings) {
      const d = f.decision ?? 'deny';
      if (d === 'warn') { warnings.push(f.message); continue; }
      reasons.push(f.message);
      if (RANK[d] > RANK[decision]) decision = d;
    }
    return { decision, reason: reasons.join('\n'), warnings };
  } catch (err) {
    warnings.push(`git-workflow guard: check failed (${err?.message ?? err}); allowing`);
    return { decision: 'allow', reason: '', warnings };
  }
}
