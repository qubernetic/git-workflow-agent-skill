import { execFile } from 'node:child_process';

const FETCH_TIMEOUT_MS = 10000;

// Resolves {code, stdout, stderr} for any process that ran to completion (including
// non-zero exit). Rejects when the process cannot start or is killed by timeout.
export function defaultExec(cmd, args, { cwd, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr: stderr ?? '' });
        if (typeof err.code === 'number' && !err.killed) return resolve({ code: err.code, stdout: stdout ?? '', stderr: stderr ?? '' });
        reject(err);
      });
  });
}

export function createState({ cwd, exec = defaultExec, timeoutMs = 3000 } = {}) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(fn).catch(() => null));
    return cache.get(key);
  };
  const run = (cmd, args, t = timeoutMs) => exec(cmd, args, { cwd, timeoutMs: t });

  return {
    currentBranch: () => memo('currentBranch', async () => {
      const r = await run('git', ['symbolic-ref', '--short', 'HEAD']);
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }),
    hasCommits: () => memo('hasCommits', async () => (await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0),
    prView: (ref, repo) => memo(`prView:${ref ?? ''}:${repo ?? ''}`, async () => {
      const args = ['pr', 'view', ...(ref === undefined ? [] : [String(ref)]),
        ...(repo === undefined || repo === true ? [] : ['--repo', String(repo)]), '--json', 'number,baseRefName,headRefName,body'];
      const r = await run('gh', args);
      return r.code === 0 ? JSON.parse(r.stdout) : null;
    }),
    issueState: (n) => memo(`issueState:${n}`, async () => {
      const r = await run('gh', ['issue', 'view', String(n), '--json', 'state']);
      if (r.code !== 0) return /could not resolve|not found/i.test(r.stderr ?? '') ? 'MISSING' : null;
      const state = JSON.parse(r.stdout).state;
      return state === 'OPEN' || state === 'CLOSED' ? state : null;
    }),
    behindRemote: (branch) => memo(`behindRemote:${branch}`, async () => {
      const f = await run('git', ['fetch', 'origin', branch, '--quiet'], FETCH_TIMEOUT_MS);
      if (f.code !== 0) return null;
      const r = await run('git', ['rev-list', '--count', `${branch}..origin/${branch}`]);
      const n = Number.parseInt(r.stdout.trim(), 10);
      return r.code === 0 && Number.isInteger(n) ? n : null;
    }),
    isAncestor: (commit, ref) => memo(`isAncestor:${commit}:${ref}`, async () => {
      const r = await run('git', ['merge-base', '--is-ancestor', commit, ref]);
      return r.code === 0 ? true : r.code === 1 ? false : null;
    }),
    showFile: (commit, path) => memo(`showFile:${commit}:${path}`, async () => {
      const r = await run('git', ['show', `${commit}:${path}`]);
      return r.code === 0 ? r.stdout : null;
    }),
  };
}
