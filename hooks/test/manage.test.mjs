import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESSES, register, unregister } from '../lib/manage/registry.mjs';
import { install, uninstall, enable, disable } from '../lib/manage/commands.mjs';
import { userConfigPath } from '../lib/config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwg-manage-'));
let n = 0;
function makeEnv({ claude = true, codex = true } = {}) {
  const home = path.join(tmp, `home${n++}`);
  fs.mkdirSync(home);
  if (claude) fs.mkdirSync(path.join(home, '.claude'));
  const codexHome = path.join(home, '.codex');
  if (codex) fs.mkdirSync(codexHome);
  return {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'),
  };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const GUARD = '/opt/skill/hooks/guard.mjs';

test('register keeps foreign entries, adds ours, is idempotent', () => {
  const env = makeEnv();
  const file = HARNESSES.claude.configPath(env);
  const foreign = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo pre' }] };
  const foreignStart = { hooks: [{ type: 'command', command: 'echo start' }] };
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [foreign], SessionStart: [foreignStart] } }));
  assert.equal(register('claude', GUARD, env).changed, true);
  const cfg = readJson(file);
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(cfg.hooks.PreToolUse[0], foreign);
  assert.deepEqual(cfg.hooks.SessionStart[0], foreignStart);
  assert.equal(cfg.hooks.PreToolUse.length, 2);
  const ours = cfg.hooks.PreToolUse[1];
  assert.equal(ours.matcher, 'Bash|mcp__.*ctx_execute|mcp__.*ctx_batch(_execute)?');
  assert.deepEqual(ours.hooks, [{ type: 'command', command: `node "${GUARD}" hook claude pre-tool-use`, timeout: 30 }]);
  assert.equal('matcher' in cfg.hooks.SessionStart[1], false);
  assert.equal(register('claude', GUARD, env).changed, false);
});

test('register with a new path replaces our entry', () => {
  const env = makeEnv();
  register('codex', GUARD, env);
  assert.equal(register('codex', '/other/guard.mjs', env).changed, true);
  const cfg = readJson(HARNESSES.codex.configPath(env));
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.match(cfg.hooks.PreToolUse[0].hooks[0].command, /other\/guard\.mjs" hook codex pre-tool-use/);
  assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Bash|shell|shell_command|exec_command|local_shell|ctx_execute|ctx_batch(_execute)?');
  assert.equal(cfg.hooks.PreToolUse[0].hooks[0].timeout, 30);
});

test('register and unregister refuse a non-array hooks.<Event> and leave the file untouched', () => {
  const env = makeEnv();
  const file = HARNESSES.claude.configPath(env);
  for (const bad of [{ PreToolUse: { matcher: 'Bash' } }, { SessionStart: 'x' }, { PreToolUse: null }]) {
    const text = JSON.stringify({ hooks: bad });
    fs.writeFileSync(file, text);
    assert.throws(() => register('claude', GUARD, env), /not an array/);
    assert.throws(() => unregister('claude', env), /not an array/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  const lines = install({ env, harnesses: ['claude'] });
  assert.ok(lines.some((l) => /^claude: error: .*not an array.*left untouched/.test(l)), lines.join('\n'));
});

test('register writes through a symlinked settings file and keeps its mode', { skip: process.platform === 'win32' }, () => {
  const env = makeEnv();
  const file = HARNESSES.claude.configPath(env);
  const real = path.join(env.HOME, 'dotfiles-settings.json');
  fs.writeFileSync(real, JSON.stringify({ theme: 'dark' }), { mode: 0o600 });
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, file);
  assert.equal(register('claude', GUARD, env).changed, true);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(readJson(real).theme, 'dark');
  assert.ok(readJson(real).hooks.PreToolUse);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.equal(unregister('claude', env).changed, true);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('unregister removes only ours', () => {
  const env = makeEnv();
  const file = HARNESSES.claude.configPath(env);
  const foreign = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo pre' }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [foreign] } }));
  register('claude', GUARD, env);
  assert.equal(unregister('claude', env).changed, true);
  assert.deepEqual(readJson(file).hooks.PreToolUse, [foreign]);
  assert.equal(unregister('claude', env).changed, false);
});

test('HOME and CODEX_HOME resolve detection and paths', () => {
  const env = makeEnv({ claude: false, codex: false });
  assert.equal(HARNESSES.claude.detect(env), false);
  assert.equal(HARNESSES.codex.detect(env), false);
  assert.equal(HARNESSES.claude.configPath(env), path.join(env.HOME, '.claude', 'settings.json'));
  const env2 = makeEnv();
  assert.equal(HARNESSES.claude.detect(env2), true);
  assert.equal(HARNESSES.codex.configPath(env2), path.join(env2.CODEX_HOME, 'hooks.json'));
});

test('install writes user config, registers detected harnesses, hints codex feature flag', () => {
  const env = makeEnv({ codex: true });
  const lines = install({ env });
  const cfg = readJson(userConfigPath(env));
  assert.equal(cfg.scope, 'opt-in');
  assert.match(cfg.guardPath, /hooks[\\/]guard\.mjs$/);
  assert.equal(cfg.version, '1.4.0');
  assert.deepEqual(cfg.harnesses.sort(), ['claude', 'codex']);
  assert.ok(fs.existsSync(HARNESSES.claude.configPath(env)));
  assert.ok(lines.some((l) => /hooks = true/.test(l)));
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), '[features]\nhooks = true\n');
  assert.ok(!install({ env }).some((l) => /hooks = true/.test(l)));
});

test('install with opt-in prints how to enable a repository', () => {
  const env = makeEnv({ codex: false });
  const lines = install({ env });
  assert.ok(lines.some((l) => /guard\.mjs" enable( \[--git-hooks\])?/.test(l) && /repositor/.test(l)), lines.join('\n'));
  assert.ok(!install({ scope: 'all', env }).some((l) => /" enable/.test(l)));
});

test('install writes a symlinked user config through the link', { skip: process.platform === 'win32' }, () => {
  const env = makeEnv({ codex: false });
  const file = userConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const real = path.join(env.HOME, 'real-config.json');
  fs.writeFileSync(real, '{}', { mode: 0o640 });
  fs.chmodSync(real, 0o640);
  fs.symlinkSync(real, file);
  install({ scope: 'all', env });
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(readJson(real).scope, 'all');
  assert.equal(fs.statSync(real).mode & 0o777, 0o640);
});

test('install skips undetected harnesses and honours scope/harnesses', () => {
  const env = makeEnv({ codex: false });
  install({ scope: 'all', env });
  const cfg = readJson(userConfigPath(env));
  assert.equal(cfg.scope, 'all');
  assert.deepEqual(cfg.harnesses, ['claude']);
  assert.equal(fs.existsSync(HARNESSES.codex.configPath(env)), false);
});

test('install does not overwrite malformed settings and continues', () => {
  const env = makeEnv();
  const file = HARNESSES.claude.configPath(env);
  fs.writeFileSync(file, '{ not json');
  const lines = install({ env });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.ok(lines.some((l) => /claude/.test(l) && /error/i.test(l)));
  assert.ok(fs.existsSync(HARNESSES.codex.configPath(env)));
  assert.deepEqual(readJson(userConfigPath(env)).harnesses, ['codex']);
});

test('uninstall unregisters from all harnesses', () => {
  const env = makeEnv();
  install({ env });
  uninstall({ env });
  for (const h of ['claude', 'codex']) {
    const hooks = readJson(HARNESSES[h].configPath(env)).hooks ?? {};
    assert.deepEqual(Object.values(hooks).flat(), []);
  }
});

test('enable creates .git-workflow.json and shims; disable removes only an empty one', () => {
  const env = makeEnv();
  const dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir, env });
  enable({ cwd: dir, gitHooks: true, env });
  assert.deepEqual(readJson(path.join(dir, '.git-workflow.json')), {});
  assert.ok(fs.existsSync(path.join(dir, '.git', 'hooks', 'commit-msg')));
  disable({ cwd: dir });
  assert.equal(fs.existsSync(path.join(dir, '.git-workflow.json')), false);
  fs.writeFileSync(path.join(dir, '.git-workflow.json'), '{"rules":{}}');
  const lines = disable({ cwd: dir });
  assert.ok(fs.existsSync(path.join(dir, '.git-workflow.json')));
  assert.ok(lines.some((l) => /off/.test(l)));
});

test('guard.mjs dispatches the management commands', () => {
  const env = makeEnv();
  const g = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../guard.mjs');
  const r = spawnSync(process.execPath, [g, 'install'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(userConfigPath(env)));
});
