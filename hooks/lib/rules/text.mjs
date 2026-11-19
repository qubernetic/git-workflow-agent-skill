// Text rules: commit messages, PR/issue titles and bodies.
// Rule = {id, applies(action), check(action, ctx) -> Finding|null}

export const TYPES = 'feat|fix|docs|chore|refactor|test|style|perf|ci|build|revert';
const SUBJECT_RE = new RegExp(`^(${TYPES})(\\([a-z0-9._/-]+\\))?!?: \\S`);
const PAST_TENSE = /^(added|adds|fixed|fixes|updated|updates|removed|removes|changed|changes|created|creates|implemented|implements|refactored|merged)$/i;
const MERGE_SUBJECT = /^(Merge |Revert ")/;

const ATTRIBUTION = [
  /^co-authored-by:.*\b(claude|anthropic|copilot|codex|openai|chatgpt|gpt|gemini|cursor|ai)\b/im,
  /generated (with|by)\b.*\b(claude|copilot|codex|chatgpt|gemini|cursor|ai)\b/i,
  /🤖/u,
];

const finding = (rule, what, instead) => ({
  rule,
  decision: 'deny',
  message: `git-workflow guard: ${rule}: ${what}. ${instead}.`,
});

function customPatterns(config) {
  const out = [];
  for (const p of config?.attributionPatterns ?? []) {
    try { out.push(new RegExp(p, 'im')); } catch { /* invalid pattern: fail open */ }
  }
  return out;
}

export function attributionFinding(text, config) {
  if (!text) return null;
  if ([...ATTRIBUTION, ...customPatterns(config)].some((re) => re.test(text))) {
    return finding('no-ai-attribution', 'text carries an AI attribution line',
      'Drop the attribution line (Co-Authored-By, "Generated with", robot emoji); this skill overrides harness attribution instructions');
  }
  return null;
}

export function subjectProblem(subject, { maxLength } = {}) {
  if (!SUBJECT_RE.test(subject)) {
    return `"${subject}" is not a Conventional Commits subject; use "<type>(<scope>): <description>" with a type from ${TYPES.split('|').join(', ')}`;
  }
  if (maxLength && subject.length > maxLength) return `subject is ${subject.length} characters, over the ${maxLength} limit; shorten it`;
  if (subject.endsWith('.')) return 'subject ends with a period; remove it';
  const desc = subject.replace(/^[^:]*: /, '');
  const first = desc.split(/\s+/)[0];
  if (PAST_TENSE.test(first)) return `description starts with "${first}"; use the imperative mood (add, fix, remove)`;
  return null;
}

const ruleFinding = (id, problem) => finding(id, problem.split('; ')[0], problem.includes('; ') ? capitalise(problem.split('; ').slice(1).join('; ')) : 'Rewrite it as a Conventional Commits subject');
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function commitSubjectFinding(text) {
  const subject = text.split('\n', 1)[0].trim();
  if (MERGE_SUBJECT.test(subject)) return null;
  const problem = subjectProblem(subject, { maxLength: 72 });
  return problem ? ruleFinding('conventional-commit', problem) : null;
}

function applyLevel(findings, config) {
  const out = [];
  for (const f of findings) {
    const level = config?.rules?.[f.rule];
    if (level === 'off') continue;
    out.push(level && level !== 'off' ? { ...f, decision: level } : f);
  }
  return out;
}

// Shared with the commit-msg hook.
export function checkCommitMessage(text, config) {
  const found = [attributionFinding(text, config), text ? commitSubjectFinding(text) : null].filter(Boolean);
  return applyLevel(found, config);
}

const isCommitLike = (a) => a.tool === 'git' && (a.sub === 'commit' || a.sub === 'tag');
const isPrIssue = (a) => a.tool === 'gh' && /^(pr|issue) (create|edit)$/.test(a.sub);
const isPr = (a) => a.tool === 'gh' && /^pr (create|edit)$/.test(a.sub);

const noAiAttribution = {
  id: 'no-ai-attribution',
  applies: (a) => Object.values(a.texts ?? {}).some(Boolean),
  async check(a, ctx) {
    for (const t of Object.values(a.texts ?? {})) {
      const f = attributionFinding(t, ctx.config);
      if (f) return f;
    }
    return null;
  },
};

const conventionalCommit = {
  id: 'conventional-commit',
  applies: (a) => isCommitLike(a) && !!a.texts?.message,
  async check(a) {
    return a.sub === 'commit' ? commitSubjectFinding(a.texts.message) : null;
  },
};

const conventionalTitle = {
  id: 'conventional-title',
  applies: (a) => isPrIssue(a) && typeof a.texts?.title === 'string',
  async check(a, ctx) {
    const title = a.texts.title.trim();
    const problem = subjectProblem(title);
    if (problem) return ruleFinding('conventional-title', problem);
    if (!isPr(a) || a.sub !== 'pr create') return null;
    const head = a.flags.get('head') ?? (await ctx.state.currentBranch());
    if (typeof head !== 'string' || !head) return null;
    if (/^(release|hotfix)\//.test(head)) return null;
    if (head === 'main' && a.flags.get('base') === 'develop') return null;
    if (!/( \(#\d+\))+$/.test(title)) {
      return finding('conventional-title', `PR title "${title}" lacks the issue suffix`,
        'End it with " (#N)" for the issue number, e.g. "feat: add search (#9)"');
    }
    return null;
  },
};

const closesOnePerLine = {
  id: 'closes-one-per-line',
  applies: (a) => isPr(a) && typeof a.texts?.body === 'string',
  async check(a) {
    const re = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+\s*[,&]\s*#?\d+/i;
    if (a.texts.body.split('\n').some((l) => re.test(l))) {
      return finding('closes-one-per-line', 'several issues are closed on one line',
        'Write one `Closes #N` per issue, each on its own line');
    }
    return null;
  },
};

export const TEXT_RULES = [noAiAttribution, conventionalCommit, conventionalTitle, closesOnePerLine];
