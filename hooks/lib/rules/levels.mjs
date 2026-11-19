// Rule levels from config (`rules: {<id>: <level>}`), shared by every layer.
// Only off|warn|ask|deny change a finding; "on" and anything unknown keep the rule's own decision.
const LEVELS = new Set(['off', 'warn', 'ask', 'deny']);

// -> decision string, or null when the rule is off. `ask` becomes `deny` where the caller cannot ask.
export function levelDecision(level, defaultDecision = 'deny', askSupported = true) {
  if (level === 'off') return null;
  const d = LEVELS.has(level) ? level : defaultDecision;
  return d === 'ask' && !askSupported ? 'deny' : d;
}

// Applies the configured level for finding.rule; null when the rule is off.
export function withLevel(finding, config, askSupported = true) {
  const d = levelDecision(config?.rules?.[finding.rule], finding.decision ?? 'deny', askSupported);
  if (d === null) return null;
  return d === finding.decision ? finding : { ...finding, decision: d };
}
