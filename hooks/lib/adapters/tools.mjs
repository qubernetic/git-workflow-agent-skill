// Extracts the shell command line from a harness tool call, or null.
const CODEX_SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const SHELL_FLAGS = new Set(['-c', '-lc']);

const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function fromCodex(input) {
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.length === 0) return null;
  const argv = c.map(String);
  const name = argv[0].replace(/^.*[\\/]/, '');
  if (argv.length === 3 && SHELLS.has(name) && SHELL_FLAGS.has(argv[1])) return argv[2];
  return argv.map(quote).join(' ');
}

export function extractCommand(toolName, toolInput) {
  const name = String(toolName ?? '');
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (name === 'Bash') return typeof input.command === 'string' ? input.command : null;
  if (CODEX_SHELL_TOOLS.has(name)) return fromCodex(input);
  if (name.endsWith('ctx_execute')) {
    return input.language === 'shell' && typeof input.code === 'string' ? input.code : null;
  }
  if (name.endsWith('ctx_batch_execute') || name.endsWith('ctx_batch')) {
    if (!Array.isArray(input.commands)) return null;
    const parts = [];
    for (const e of input.commands) {
      if (!e || typeof e !== 'object') continue;
      if (typeof e.command === 'string') parts.push(e.command);
      else if (e.language === 'shell' && typeof e.code === 'string') parts.push(e.code);
    }
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}
