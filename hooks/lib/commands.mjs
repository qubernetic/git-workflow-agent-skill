// Recognise git / gh invocations in a SimpleCommand and normalise them.
//
// recognise(cmd, readFile?, {platform?}) -> Action | null
//   Action = {tool, sub, flags, positionals, env, cwd, texts: {message?, title?, body?}, raw}
//
// Flag convention (flags: Map<string, string|true>):
//   - keys carry no leading dashes: `--squash` and `-s` both give key `squash`.
//   - a flag that takes a value maps to that value (`-m msg` -> message: 'msg'),
//     any other flag maps to `true`; `--flag=value` is accepted.
//   - repeated `message` values are joined with a blank line; for other flags the last wins.
//   - short aliases are folded to the long name ONLY for the (tool, sub) pairs below;
//     every other short flag keeps its single-letter key (e.g. `switch -c`, `checkout -b`,
//     `worktree add -b`, `gh pr create -m` is a milestone and stays `m`).
//   Alias table:
//     gh pr merge   : -s squash, -r rebase, -m merge, -d delete-branch,
//                     -t subject (NOT title), -b body, -B base, -H head, -F body-file
//     gh pr create/edit, gh issue create/edit:
//                     -t title, -b body, -B base, -H head, -F body-file
//     every gh sub  : -R repo (also accepted before the group and between group and verb)
//     git commit    : -m message, -F file, -n no-verify, -a all
//     git push      : -f force, -d delete, -u set-upstream
//     git tag       : -m message, -F file
//   Combined short flags (`-am msg`, `-fu`) are split; a value flag takes the rest of the
//   cluster or the next argument. git commit -u<mode> and -S<keyid> take only an attached value.
//   git commit --trailer values are appended to texts.message (texts.trailers without a message).
// Git global options (-C <dir>, -c k=v, --no-pager, -P, ...) are skipped; -C folds into cwd.
import { readFileSync, statSync } from 'node:fs';
import { pathApi, fromGitBash } from './paths.mjs';

const GH_TEXT = { t: 'title', b: 'body', B: 'base', H: 'head', F: 'body-file', R: 'repo' };
const ALIASES = {
  'git commit': { m: 'message', F: 'file', n: 'no-verify', a: 'all' },
  'git tag': { m: 'message', F: 'file' },
  'git push': { f: 'force', d: 'delete', u: 'set-upstream' },
  'gh pr merge': { s: 'squash', r: 'rebase', m: 'merge', d: 'delete-branch', ...GH_TEXT, t: 'subject' },
  'gh pr create': GH_TEXT,
  'gh pr edit': GH_TEXT,
  'gh issue create': GH_TEXT,
  'gh issue edit': GH_TEXT,
};

// Canonical flag names (post-alias) that consume a value, per sub.
const gh = ['title', 'body', 'body-file', 'base', 'head', 'repo', 'a', 'assignee', 'l', 'label',
  'm', 'milestone', 'p', 'project', 'r', 'reviewer', 'T', 'template', 'add-label', 'remove-label',
  'add-assignee', 'remove-assignee', 'add-reviewer', 'remove-reviewer', 'add-project',
  'remove-project', 'remove-milestone'];
const VALUE_FLAGS = {
  'git commit': ['message', 'file', 'C', 'c', 'reuse-message', 'reedit-message', 'author', 'date',
    'cleanup', 'template', 't', 'fixup', 'squash', 'trailer'],
  'git push': ['o', 'push-option', 'repo', 'receive-pack', 'exec'],
  'git checkout': ['b', 'B', 'orphan', 'conflict', 'pathspec-from-file'],
  'git switch': ['c', 'C', 'create', 'force-create', 'orphan', 'conflict'],
  'git branch': ['u', 'set-upstream-to', 'contains', 'no-contains', 'merged', 'no-merged',
    'points-at', 'sort', 'format'],
  'git worktree': ['b', 'B', 'reason'],
  'git tag': ['m', 'message', 'F', 'file', 'u', 'local-user', 'contains', 'no-contains', 'merged',
    'no-merged', 'points-at', 'sort', 'format'],
  'gh pr merge': ['subject', 'body', 'body-file', 'A', 'author-email', 'match-head-commit', 'repo'],
  'gh pr create': gh,
  'gh pr edit': gh,
  'gh issue create': gh,
  'gh issue edit': gh,
};

// Short flags whose value is optional and only ever attached (`-uno`, `-S<keyid>`).
const OPTIONAL_ATTACHED = {
  'git commit': ['u', 'S'],
};

const GIT_SUBS = new Set(['commit', 'push', 'checkout', 'switch', 'branch', 'worktree', 'tag']);
const GH_SUBS = {
  pr: new Set(['create', 'edit', 'merge']),
  issue: new Set(['create', 'edit']),
};
// Long git global options that may take their value as a separate argument (besides -C/-c below).
const GIT_GLOBAL_VALUE = new Set(['--git-dir', '--work-tree', '--namespace', '--attr-source']);

const base = (s) => String(s ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');

const MAX_TEXT_FILE = 1024 * 1024;

// Regular files up to 1 MiB only: a FIFO or device could hang the hook. Anything else is unknown.
function defaultReadFile(p) {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_TEXT_FILE) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

function resolveDir(raw, cwd, platform) {
  const dir = fromGitBash(raw, platform);
  if (pathApi(platform).isAbsolute(dir) || /^[~]/.test(dir) || !cwd) return dir;
  return pathApi(platform).join(cwd, dir);
}

// Skips git global options (any --long[=v], -p, -P, -C, -c); the first other word is the subcommand. Returns {i: index of subcommand, cwd}.
function skipGitGlobals(argv, cwd, platform) {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-C' && i + 1 < argv.length) { cwd = resolveDir(argv[i + 1], cwd, platform); i += 2; }
    else if (a === '-c' && i + 1 < argv.length) i += 2;
    else if (GIT_GLOBAL_VALUE.has(a)) i += 2;
    else if (a.startsWith('--') && a.length > 2) i += 1;
    else if (a === '-p' || a === '-P') i += 1;
    else break;
  }
  return { i, cwd };
}

// gh [-R|--repo X] <group> [-R|--repo X] <verb> ... -> {words: [group, verb], rest, repo}.
function skipGhRepo(argv) {
  const words = [];
  let repo;
  let i = 1;
  while (i < argv.length && words.length < 2) {
    const a = argv[i];
    if (a === '-R' || a === '--repo') { repo = argv[i + 1] ?? true; i += 2; }
    else if (a.startsWith('--repo=')) { repo = a.slice(7); i += 1; }
    else if (/^-R./.test(a)) { repo = a.slice(2); i += 1; }
    else { words.push(a); i += 1; }
  }
  return { words, rest: argv.slice(i), repo };
}

function parseArgs(args, key) {
  const aliases = ALIASES[key] ?? {};
  const valueFlags = new Set(VALUE_FLAGS[key] ?? []);
  const optionalAttached = new Set(OPTIONAL_ATTACHED[key] ?? []);
  const flags = new Map();
  const positionals = [];
  const set = (name, val) => {
    const prev = flags.get(name);
    if (name === 'message' && typeof val === 'string' && typeof prev === 'string') {
      flags.set(name, `${prev}\n\n${val}`);
    } else if (name === 'trailer' && typeof val === 'string' && typeof prev === 'string') {
      flags.set(name, `${prev}\n${val}`);
    } else flags.set(name, val);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) set(name, a.slice(eq + 1));
      else if (valueFlags.has(name) && i + 1 < args.length) set(name, args[++i]);
      else set(name, true);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const name = aliases[a[j]] ?? a[j];
        if (optionalAttached.has(a[j])) {
          set(name, a.slice(j + 1) || true);
          break;
        }
        if (valueFlags.has(name)) {
          const rest = a.slice(j + 1);
          if (rest) set(name, rest);
          else if (i + 1 < args.length) set(name, args[++i]);
          else set(name, true);
          break;
        }
        set(name, true);
      }
    } else positionals.push(a);
  }
  return { flags, positionals };
}

export function recognise(cmd, readFile = defaultReadFile, { platform = process.platform } = {}) {
  const argv = cmd?.argv;
  if (!argv || argv.length === 0) return null;
  const tool = base(argv[0]);
  let cwd = cmd.cwd;
  let sub;
  let rest;
  let ghRepo;
  if (tool === 'git') {
    const g = skipGitGlobals(argv, cwd, platform);
    cwd = g.cwd;
    if (!GIT_SUBS.has(argv[g.i])) return null;
    sub = argv[g.i];
    rest = argv.slice(g.i + 1);
  } else if (tool === 'gh') {
    const g = skipGhRepo(argv);
    if (!GH_SUBS[g.words[0]]?.has(g.words[1])) return null;
    sub = `${g.words[0]} ${g.words[1]}`;
    rest = g.rest;
    ghRepo = g.repo;
  } else return null;

  const { flags, positionals } = parseArgs(rest, `${tool} ${sub}`);
  if (ghRepo !== undefined && !flags.has('repo')) flags.set('repo', ghRepo);
  const fileText = (p) => {
    if (p === '-') return cmd.stdin ?? null;
    return readFile(resolveDir(p, cwd, platform));
  };

  const texts = {};
  if (tool === 'git' && (sub === 'commit' || sub === 'tag')) {
    const parts = [];
    if (typeof flags.get('message') === 'string') parts.push(flags.get('message'));
    if (typeof flags.get('file') === 'string') {
      const t = fileText(flags.get('file'));
      if (t != null) parts.push(t);
    }
    // --trailer values ("Key: value" or "Key=value"), one per line, for attribution scans.
    const trailer = flags.get('trailer');
    const trailers = typeof trailer === 'string'
      ? trailer.split('\n').map((t) => t.replace(/^([A-Za-z0-9-]+)\s*=\s*/, '$1: ')).join('\n') : null;
    if (parts.length) texts.message = parts.join('\n\n') + (trailers ? `\n\n${trailers}` : '');
    else if (trailers) texts.trailers = trailers;
  } else if (tool === 'gh' && /create|edit|merge/.test(sub)) {
    const title = flags.get(sub === 'pr merge' ? 'subject' : 'title');
    if (typeof title === 'string') texts.title = title;
    if (typeof flags.get('body') === 'string') texts.body = flags.get('body');
    else if (typeof flags.get('body-file') === 'string') {
      const t = fileText(flags.get('body-file'));
      if (t != null) texts.body = t;
    }
  }

  return { tool, sub, flags, positionals, env: cmd.env ?? {}, cwd, texts, raw: cmd.raw };
}
