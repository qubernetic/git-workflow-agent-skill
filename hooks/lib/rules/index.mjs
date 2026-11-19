// Rule engine: runs applicable rules over recognised actions.
import { TEXT_RULES, checkCommitMessage } from './text.mjs';
import { MERGE_RULES } from './merge.mjs';
import { BRANCH_RULES } from './branch.mjs';
import { levelDecision } from './levels.mjs';

export { checkCommitMessage };
export const RULES = [...TEXT_RULES, ...MERGE_RULES, ...BRANCH_RULES];

export async function evaluate(actions, ctx) {
  const findings = [];
  for (const action of actions) {
    for (const rule of RULES) {
      const level = ctx.config?.rules?.[rule.id];
      if (level === 'off') continue;
      let found = null;
      try {
        if (!rule.applies(action)) continue;
        found = await rule.check(action, ctx);
      } catch (err) {
        process.stderr.write(`git-workflow guard: ${rule.id}: rule failed (${err.message}); allowing\n`);
        continue;
      }
      if (!found) continue;
      const decision = levelDecision(level, found.decision ?? 'deny', Boolean(ctx.askSupported));
      if (decision) findings.push(decision === found.decision ? found : { ...found, decision });
    }
  }
  return findings;
}
