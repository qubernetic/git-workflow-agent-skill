// Platform-aware path helpers for directories named inside a command line.
import path from 'node:path';

export const pathApi = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);

// Git Bash (how Claude Code and Codex run commands on Windows) names drives as /c/... or /C,
// Cygwin as /cygdrive/c/...;
// Node would read that as \c\... on the current drive. Other platforms are left untouched.
export function fromGitBash(p, platform = process.platform) {
  if (platform !== 'win32' || typeof p !== 'string') return p;
  const m = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/|$)/.exec(p);
  return m ? `${m[1].toUpperCase()}:/${p.slice(m[0].length)}` : p;
}
