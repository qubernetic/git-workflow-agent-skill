// Merge rules: `gh pr merge` method, human gate and test-plan state.
// Rule = {id, applies(action), check(action, ctx) -> Finding|null}

const finding = (rule, decision, what, instead) => ({
  rule,
  decision,
  message: `git-workflow guard: ${rule}: ${what}. ${instead}.`,
});

const isMerge = (a) => a.tool === 'gh' && a.sub === 'pr merge';
const prRef = (a) => a.positionals[0];
const loadPr = (a, ctx) => ctx.state.prView(prRef(a), a.flags.get('repo') ?? a.flags.get('R'));

const mergeMethod = {
  id: 'merge-method',
  applies: isMerge,
  check(a) {
    const bad = ['squash', 'rebase', 'admin'].filter((f) => a.flags.has(f));
    if (bad.length === 0 && a.flags.has('merge')) return null;
    const what = bad.length
      ? `gh pr merge must not use --${bad.join('/--')}`
      : 'gh pr merge needs --merge (no squash/rebase/admin)';
    return finding('merge-method', 'deny', what, `Run: gh pr merge ${prRef(a) ?? '<N>'} --merge --delete-branch`);
  },
};

const mergeGate = {
  id: 'merge-gate',
  applies: isMerge,
  async check(a, ctx) {
    const pr = await loadPr(a, ctx);
    if (!pr) return null;
    const protectedBranches = ctx.config?.protectedBranches ?? ['main', 'develop'];
    if (!protectedBranches.includes(pr.baseRefName)) return null;
    const what = `merging PR #${pr.number} into ${pr.baseRefName} needs the user's approval`;
    if (ctx.askSupported) return finding('merge-gate', 'ask', what, 'Confirm the merge with the user');
    const env = { ...ctx.env, ...a.env };
    if (env.WORKFLOW_GUARD_APPROVE === String(pr.number)) return null;
    return finding('merge-gate', 'deny',
      `ask the user to approve merging PR #${pr.number} into ${pr.baseRefName}`,
      `After an explicit yes, rerun as \`WORKFLOW_GUARD_APPROVE=${pr.number} gh pr merge ${pr.number} --merge --delete-branch\``);
  },
};

const PLAN_HEADING = /^#{2,3} .*(test plan|checklist|user test)/i;
const ANY_HEADING = /^#{1,6} /;

function hasUntickedPlanItem(body) {
  let inPlan = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (ANY_HEADING.test(line)) inPlan = PLAN_HEADING.test(line);
    else if (inPlan && /^\s*[-*] \[ \]/.test(line)) return true;
  }
  return false;
}

const testPlanTicked = {
  id: 'test-plan-ticked',
  applies: isMerge,
  async check(a, ctx) {
    const pr = await loadPr(a, ctx);
    if (!pr || !hasUntickedPlanItem(pr.body)) return null;
    return finding('test-plan-ticked', 'deny', `PR #${pr.number} has unticked items in its test plan`,
      `Tick the passed items in the PR description (gh pr edit ${pr.number} --body-file ...) before merging`);
  },
};

export const MERGE_RULES = [mergeMethod, mergeGate, testPlanTicked];
