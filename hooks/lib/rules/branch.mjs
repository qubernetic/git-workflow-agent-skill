// Branch, push and tag rules.
// Rule = {id, applies(action), check(action, ctx) -> Finding|null}
// Any state method returning null (unknown) makes the rule skip (fail open).

const finding = (rule, what, instead) => ({
  rule,
  decision: 'deny',
  message: `git-workflow guard: ${rule}: ${what}. ${instead}.`,
});

const DEFAULT_PROTECTED = ['main', 'develop'];
const DEFAULT_TYPES = ['feature', 'fix', 'hotfix', 'epic'];
const RELEASE_NAME = /^release\/\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/;
const protectedOf = (ctx) => ctx.config?.protectedBranches ?? DEFAULT_PROTECTED;
const typesOf = (ctx) => ctx.config?.branchTypes ?? DEFAULT_TYPES;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (ref) => String(ref).replace(/^refs\/heads\//, '');
const isOption = (s) => typeof s === 'string' && s.startsWith('-');

const isGit = (sub) => (a) => a.tool === 'git' && a.sub === sub;
const str = (v) => (typeof v === 'string' ? v : null);

const NOT_CREATE = ['d', 'D', 'delete', 'm', 'M', 'move', 'c', 'C', 'copy', 'l', 'list', 'a', 'all', 'r', 'remotes',
  'u', 'set-upstream-to', 'unset-upstream', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at',
  'show-current', 'v', 'vv', 'verbose', 'edit-description'];

// -> {name, startPoint, force?}|null for commands that create a new branch.
// force: -B/-C/--force-create/branch -f, which may also reset an existing branch.
export function branchCreation(a) {
  if (a.tool !== 'git') return null;
  const flag = (...keys) => keys.map((k) => str(a.flags.get(k))).find((v) => v !== null) ?? null;
  const at = (i) => a.positionals[i] ?? null;
  let name = null;
  let start = null;
  let force = false;
  if (a.sub === 'checkout' || a.sub === 'switch') {
    name = a.sub === 'checkout' ? flag('b', 'B') : flag('c', 'C', 'create', 'force-create');
    force = name !== null && name === (a.sub === 'checkout' ? flag('B') : flag('C', 'force-create'));
    start = at(0);
  } else if (a.sub === 'branch') {
    if (NOT_CREATE.some((k) => a.flags.has(k))) return null;
    name = at(0);
    start = at(1);
    force = a.flags.has('f') || a.flags.has('force');
  } else if (a.sub === 'worktree' && a.positionals[0] === 'add') {
    name = flag('b', 'B');
    force = name !== null && name === flag('B');
    start = at(2);
  }
  if (!name) return null;
  return force ? { name, startPoint: start, force } : { name, startPoint: start };
}

// branchCreation, minus forced resets of a protected or existing local branch.
// Unknown existence (null) counts as a reset: never deny on doubt.
async function newBranch(a, ctx) {
  const c = branchCreation(a);
  if (!c || !c.force) return c;
  if (protectedOf(ctx).includes(c.name)) return null;
  const exists = await ctx.state.branchExists?.(c.name);
  return exists === false ? c : null;
}

const matchesProtected = (name, ctx) => protectedOf(ctx).includes(name) || /^epic\/./.test(name);

const protectedCommit = {
  id: 'protected-commit',
  applies: isGit('commit'),
  async check(a, ctx) {
    const branch = await ctx.state.currentBranch();
    if (!branch || !protectedOf(ctx).includes(branch)) return null;
    if ((await ctx.state.hasCommits()) !== true) return null;
    return finding('protected-commit', `committing directly on ${branch} is not allowed`,
      'Create a working branch from an issue (git checkout -b feature/<issue>-<slug>) and commit there');
  },
};

const forceKinds = ['force-with-lease', 'force-if-includes'];

const forcePush = {
  id: 'force-push',
  applies: isGit('push'),
  async check(a, ctx) {
    const refspecs = a.positionals.slice(1);
    if (a.flags.has('force') || refspecs.some((r) => r.startsWith('+'))) {
      return finding('force-push', 'force pushing is not allowed',
        'Push normally; if history diverged, rebase or merge and push again');
    }
    if (!forceKinds.some((k) => a.flags.has(k))) return null;
    const dsts = [];
    for (const spec of refspecs) {
      const dst = strip(spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec);
      if (dst === 'HEAD') dsts.push(await ctx.state.currentBranch());
      else dsts.push(dst);
    }
    if (refspecs.length === 0) dsts.push(await ctx.state.currentBranch());
    const hit = dsts.find((d) => d && (matchesProtected(d, ctx) || /^release\/./.test(d)));
    if (!hit) return null;
    return finding('force-push', `force pushing to ${hit} is not allowed`,
      'Only force-push your own feature or fix branch');
  },
};

const protectedDelete = {
  id: 'protected-delete',
  applies: (a) => (a.tool === 'git' && (a.sub === 'push' || a.sub === 'branch')),
  check(a, ctx) {
    let targets = [];
    if (a.sub === 'push') {
      const refspecs = a.positionals.slice(1);
      if (a.flags.has('delete')) targets = refspecs;
      else targets = refspecs.filter((r) => r.startsWith(':')).map((r) => r.slice(1));
    } else if (a.flags.has('d') || a.flags.has('D') || a.flags.has('delete')) targets = a.positionals;
    const hit = targets.map(strip).find((t) => matchesProtected(t, ctx));
    if (!hit) return null;
    return finding('protected-delete', `deleting ${hit} is not allowed`,
      'Protected and epic branches are removed only through the merge flow (gh pr merge --delete-branch)');
  },
};

const noVerify = {
  id: 'no-verify',
  applies: (a) => a.tool === 'git' && (a.sub === 'commit' || a.sub === 'push'),
  check(a) {
    if (!a.flags.has('no-verify')) return null;
    return finding('no-verify', `git ${a.sub} --no-verify skips the hooks`,
      'Fix what the hook reports and run the command without --no-verify');
  },
};

const nameRe = (ctx) => new RegExp(`^(${typesOf(ctx).map(escapeRe).join('|')})/\\d+-[a-z0-9]+(-[a-z0-9]+)*$`);
const validName = (name, ctx) => nameRe(ctx).test(name) || RELEASE_NAME.test(name);

const branchName = {
  id: 'branch-name',
  applies: (a) => branchCreation(a) !== null,
  async check(a, ctx) {
    const c = await newBranch(a, ctx);
    if (!c) return null;
    const { name } = c;
    if (validName(name, ctx)) return null;
    return finding('branch-name', `branch name "${name}" is invalid`,
      `Use <type>/<issue>-<slug> with type one of ${typesOf(ctx).join(', ')} (e.g. feature/12-add-login), or release/X.Y.Z`);
  },
};

const branchIssue = {
  id: 'branch-issue',
  applies: (a) => branchCreation(a) !== null,
  async check(a, ctx) {
    const c = await newBranch(a, ctx);
    if (!c) return null;
    const { name } = c;
    if (isOption(name) || RELEASE_NAME.test(name) || !nameRe(ctx).test(name)) return null;
    const n = Number.parseInt(name.split('/')[1], 10);
    const state = await ctx.state.issueState(n);
    if (state === 'MISSING') return finding('branch-issue', `issue #${n} does not exist in this repository; open it first`, 'Create the issue, then branch from it');
    if (state === 'CLOSED') return finding('branch-issue', `issue #${n} is closed`, 'Reopen it or open a new issue before branching');
    return null;
  },
};

const freshBase = {
  id: 'fresh-base',
  applies: (a) => branchCreation(a) !== null,
  async check(a, ctx) {
    const c = await newBranch(a, ctx);
    if (!c) return null;
    const { startPoint } = c;
    const base = startPoint ?? await ctx.state.currentBranch();
    if (!base || isOption(base) || base.startsWith('origin/')) return null;
    if (!(matchesProtected(base, ctx) || /^release\/./.test(base))) return null;
    const behind = await ctx.state.behindRemote(base);
    if (!(behind > 0)) return null;
    return finding('fresh-base', `local ${base} is ${behind} commit(s) behind origin/${base}`, `Run git pull origin ${base} first`);
  },
};

const EXPECTED_BASE = {
  feature: ['develop or an epic/* branch', (b) => b === 'develop' || /^epic\/./.test(b)],
  fix: ['develop or an epic/* branch', (b) => b === 'develop' || /^epic\/./.test(b)],
  epic: ['develop', (b) => b === 'develop'],
  release: ['main', (b) => b === 'main'],
  hotfix: ['main', (b) => b === 'main'],
  main: ['develop', (b) => b === 'develop'],
};

const prBase = {
  id: 'pr-base',
  applies: (a) => a.tool === 'gh' && a.sub === 'pr create',
  async check(a, ctx) {
    const baseFlag = a.flags.get('base');
    if (baseFlag === true) return null;
    const headFlag = a.flags.get('head');
    const head = typeof headFlag === 'string' ? headFlag.replace(/^.*:/, '') : await ctx.state.currentBranch();
    if (!head) return null;
    const rule = EXPECTED_BASE[head.split('/')[0]];
    if (!rule) return null;
    // Without --base, gh targets the repository's default branch.
    const repo = a.flags.get('repo');
    const base = baseFlag ?? await ctx.state.defaultBranch?.(typeof repo === 'string' ? repo : undefined);
    if (typeof base !== 'string' || !base) return null;
    if (rule[1](base)) return null;
    return finding('pr-base', `a PR from ${head} must not target ${base}`, `Use --base ${rule[0]}`);
  },
};

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
const TAG_NOT_CREATE = ['d', 'delete', 'l', 'list', 'v', 'verify'];

const tagOnMain = {
  id: 'tag-on-main',
  applies: (a) => a.tool === 'git' && a.sub === 'tag' && !TAG_NOT_CREATE.some((k) => a.flags.has(k)),
  async check(a, ctx) {
    const m = STABLE_TAG.exec(a.positionals[0] ?? '');
    if (!m) return null;
    const commit = a.positionals[1] ?? 'HEAD';
    if (isOption(commit)) return null;
    if ((await ctx.state.isAncestor(commit, 'origin/main')) === false) {
      return finding('tag-on-main', `${a.positionals[0]} must be tagged on a commit that is on origin/main`,
        'Merge the release into main, pull, then tag');
    }
    const changelog = await ctx.state.showFile(commit, 'CHANGELOG.md');
    if (typeof changelog === 'string' && !changelog.includes(`## [${m[1]}]`)) {
      return finding('tag-on-main', `CHANGELOG.md has no "## [${m[1]}]" entry at ${commit}`,
        'Add the changelog entry on the release branch before tagging');
    }
    return null;
  },
};

export const BRANCH_RULES = [protectedCommit, forcePush, protectedDelete, noVerify, branchName, branchIssue, freshBase, prBase, tagOnMain];
