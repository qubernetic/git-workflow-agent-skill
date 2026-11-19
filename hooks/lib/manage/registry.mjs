import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// "~" resolves from env (HOME, or USERPROFILE on Windows) so tests stay hermetic.
export function homeDir(env = process.env) {
  const h = process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  return h || os.homedir();
}

export const codexHome = (env) => env.CODEX_HOME || path.join(homeDir(env), '.codex');

export const HARNESSES = {
  claude: {
    detect: (env) => fs.existsSync(path.join(homeDir(env), '.claude')),
    configPath: (env) => path.join(homeDir(env), '.claude', 'settings.json'),
    events: {
      PreToolUse: { matcher: 'Bash|mcp__.*ctx_execute|mcp__.*ctx_batch(_execute)?', command: 'hook claude pre-tool-use' },
      SessionStart: { matcher: undefined, command: 'hook claude session-start' },
    },
  },
  codex: {
    detect: (env) => fs.existsSync(codexHome(env)),
    configPath: (env) => path.join(codexHome(env), 'hooks.json'),
    events: {
      PreToolUse: { matcher: 'shell|shell_command|exec_command|local_shell|ctx_execute|ctx_batch(_execute)?', command: 'hook codex pre-tool-use' },
      SessionStart: { command: 'hook codex session-start' },
    },
  },
};

const OURS = /guard\.mjs"? hook (claude|codex) /;
const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => OURS.test(h?.command ?? ''));

// Missing file -> {}. Malformed content throws so callers never overwrite a user's config.
function readConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let value;
  try { value = JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message})`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
  if (value.hooks !== undefined && (value.hooks === null || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) {
    throw new Error(`${file}: "hooks" is not an object`);
  }
  return value;
}

function writeConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const entryFor = (spec, guardPath) => {
  const e = spec.matcher === undefined ? {} : { matcher: spec.matcher };
  e.hooks = [{ type: 'command', command: `node "${guardPath}" ${spec.command}`, timeout: 10 }];
  return e;
};

export function register(harness, guardPath, env = process.env) {
  const h = HARNESSES[harness];
  const file = h.configPath(env);
  const cfg = readConfig(file);
  const before = JSON.stringify(cfg);
  cfg.hooks ??= {};
  for (const [event, spec] of Object.entries(h.events)) {
    const list = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    const kept = list.filter((e) => !isOurs(e));
    // Keep our entry's position when replacing, append otherwise.
    const idx = list.findIndex(isOurs);
    const entry = entryFor(spec, guardPath);
    if (idx === -1) kept.push(entry);
    else kept.splice(list.slice(0, idx).filter((e) => !isOurs(e)).length, 0, entry);
    cfg.hooks[event] = kept;
  }
  if (JSON.stringify(cfg) === before) return { changed: false };
  writeConfig(file, cfg);
  return { changed: true };
}

export function unregister(harness, env = process.env) {
  const file = HARNESSES[harness].configPath(env);
  if (!fs.existsSync(file)) return { changed: false };
  const cfg = readConfig(file);
  let changed = false;
  for (const [event, list] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !isOurs(e));
    if (kept.length === list.length) continue;
    changed = true;
    if (kept.length) cfg.hooks[event] = kept; else delete cfg.hooks[event];
  }
  if (changed) writeConfig(file, cfg);
  return { changed };
}
