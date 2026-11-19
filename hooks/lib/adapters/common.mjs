// Shared adapter logic. Adapters differ only in tool input shape and ask support.
import fs from 'node:fs';
import { runCheck } from '../check.mjs';
import { loadConfig } from '../config.mjs';
import { extractCommand } from './tools.mjs';

const EMPTY = { stdout: '', exitCode: 0, warnings: [] };
const REMINDER = new URL('../../reminder.md', import.meta.url);

export async function preToolUse(input, { askSupported, env, exec } = {}) {
  const command = extractCommand(input?.tool_name, input?.tool_input);
  if (command === null) return { ...EMPTY };
  const r = await runCheck({
    command,
    cwd: input.cwd || process.cwd(),
    askSupported,
    ...(env ? { env } : {}),
    ...(exec ? { exec } : {}),
  });
  const warnings = r.warnings ?? [];
  if (r.decision !== 'deny' && r.decision !== 'ask') return { stdout: '', exitCode: 0, warnings };
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: r.decision,
      permissionDecisionReason: r.reason,
    },
  };
  return { stdout: JSON.stringify(out), exitCode: 0, warnings };
}

export function sessionStart(input, { env } = {}) {
  const config = loadConfig({ cwd: input?.cwd || process.cwd(), ...(env ? { env } : {}) });
  const warnings = config.warnings ?? [];
  if (!config.active) return { stdout: '', exitCode: 0, warnings };
  const out = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: fs.readFileSync(REMINDER, 'utf8') },
  };
  return { stdout: JSON.stringify(out), exitCode: 0, warnings };
}
