import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RULE_VALUES = ['on', 'off', 'warn', 'ask', 'deny'];
const DEFAULT_PROTECTED = ['main', 'develop'];
const DEFAULT_BRANCH_TYPES = ['feature', 'fix', 'hotfix', 'epic'];

export function userConfigPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.APPDATA || path.win32.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
    return path.win32.join(base, 'git-workflow-guard', 'config.json');
  }
  const base = env.XDG_CONFIG_HOME || path.posix.join(env.HOME || os.homedir(), '.config');
  return path.posix.join(base, 'git-workflow-guard', 'config.json');
}

export function findRepoRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Returns {value, missing, error}. Missing file is not an error.
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { missing: true };
    return { error: e.message };
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'not a JSON object' };
    return { value };
  } catch (e) {
    return { error: e.message };
  }
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

export function loadConfig({ cwd, env = process.env } = {}) {
  const warnings = [];
  const config = {
    active: false,
    scope: 'opt-in',
    repoRoot: null,
    protectedBranches: [...DEFAULT_PROTECTED],
    branchTypes: [...DEFAULT_BRANCH_TYPES],
    rules: {},
    attributionPatterns: [],
    warnings,
  };

  const userFile = userConfigPath(env);
  const user = readJson(userFile);
  if (user.error) warnings.push(`invalid user config ${userFile}: ${user.error}; using scope opt-in`);
  else if (user.value) {
    if (user.value.scope === 'all' || user.value.scope === 'opt-in') config.scope = user.value.scope;
    else if (user.value.scope !== undefined) warnings.push(`invalid scope in ${userFile}; using opt-in`);
  }

  config.repoRoot = findRepoRoot(cwd ?? process.cwd());
  if (!config.repoRoot) return config;

  const repoFile = path.join(config.repoRoot, '.git-workflow.json');
  const repo = readJson(repoFile);
  config.active = config.scope === 'all' || !repo.missing;
  if (repo.error) {
    warnings.push(`invalid ${repoFile}: ${repo.error}; using defaults`);
    return config;
  }
  if (!repo.value) return config;

  const v = repo.value;
  for (const key of ['protectedBranches', 'branchTypes', 'attributionPatterns']) {
    if (v[key] === undefined) continue;
    if (isStringArray(v[key])) config[key] = [...v[key]];
    else warnings.push(`.git-workflow.json: ${key} must be an array of strings; ignored`);
  }
  if (v.rules !== undefined) {
    if (v.rules === null || typeof v.rules !== 'object' || Array.isArray(v.rules)) {
      warnings.push('.git-workflow.json: rules must be an object; ignored');
    } else {
      for (const [id, val] of Object.entries(v.rules)) {
        if (RULE_VALUES.includes(val)) config.rules[id] = val;
        else warnings.push(`.git-workflow.json: rule ${id} has invalid value ${JSON.stringify(val)}; ignored`);
      }
    }
  }
  return config;
}
