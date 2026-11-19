# Workflow guard: enforcing the git-workflow skill in agent harnesses

Date: 2026-11-19
Status: draft, builder check done, awaiting the owner's approval
Issue: #102

## 1. Intent

The skill states the rules, but agents still break them, and the owner keeps
having to remind them. A review of six weeks of sessions (2026-10-02 to
2026-11-19, ~1,660 prompts across ~15 repositories) plus the per-project
feedback memories found the repeated corrections were mostly not the classic
Gitflow sins (squash merges, force-pushes and direct commits to `develop` never
happened). They were:

| # | Violation | Evidence |
|---|-----------|----------|
| 1 | AI attribution in commits and PRs (`Co-Authored-By: Claude`, "Generated with Claude Code") | ~5 reminders; 19 commits/PRs carried it. Cause: the harness's own system prompt asks for the trailer, the skill forbids it. |
| 2 | Approval gate wrong in both directions: merging into `develop` without approval, or asking for approval on epic slice merges | ~4 reminders, two memory files |
| 3 | Work started without an issue | ~3 reminders |
| 4 | Issue and PR titles not in Conventional Commits form, or the PR title missing `(#N)` | 2 reminders, 79 issue titles and 81 PR titles in the data |
| 5 | Release steps: tag order, CHANGELOG still `Unreleased`, pre-release order | ~4 reminders |
| 6 | Branch cut from a stale base (no pull) | 2 reminders, 55 of 162 branch creations |
| 7 | PR test-plan boxes unticked at merge | 1 reminder covering 6 PRs |
| 8 | Several issues in one `Closes #a, #b` line | 1 reminder |
| — | `gh pr merge --admin` (bypasses branch protection) | 23 uses in one day |

The guard turns the mechanically checkable rules into hard stops, so the
owner no longer has to repeat them. The skill becomes public tooling, not only
the owner's setup.

Success: in a repository with the guard installed, an agent in Claude Code or
Codex CLI cannot commit with AI attribution, open a PR with a non-conventional
title, merge with `--admin`/`--squash`/`--rebase`, or merge into `develop` or
`main` without the human confirming, and the agent learns the rule from the
deny message instead of from the owner.

## 2. Goals, non-goals, anti-goals

**Goals**
- One rule engine shared by every harness and by git's own hooks.
- Works on Linux, macOS and Windows with no install beyond Node.js (already
  present wherever Claude Code, Codex CLI, Copilot CLI or Gemini CLI runs).
- Every deny message names the rule and says what to do instead, short enough
  that the agent fixes the command on its next try.
- Rules configurable per repository (protected branches, which rules are on).
- Ship as part of the public skill: install scripts, README, tests, CI.

**Non-goals**
- Not a security boundary against a hostile agent. It guards against
  mistakes; an agent determined to bypass it (editing config, writing a script
  file and running it) is out of scope.
- Not enforcing behaviour that has no command: running tests before a commit,
  following earlier PR formats, doing release follow-through, asking less
  often. These go into the session-start reminder (section 7), not into rules.
- No replacement for GitHub branch protection or CI checks.

**Anti-goals** (failure even if it works)
- Blocking legitimate work: a false positive that the agent cannot route around
  makes the owner disable the guard. When unsure, allow (section 6.4).
- Slowing every shell command noticeably. Commands that are not `git`/`gh`
  must exit in milliseconds without network calls.
- Asking the human more often than today. `ask` is used only for merges into
  `develop`/`main`; everything else is allow or deny.

## 3. Approaches considered

| Approach | Trade-off | Verdict |
|----------|-----------|---------|
| **Zero-dependency Node.js engine + thin per-harness adapters + git hooks backstop** | Adds JavaScript to a markdown/shell repo; but Node is guaranteed where the harnesses run, Windows works natively, JSON is native, and one engine serves every layer | **Chosen by the owner** |
| Bash engine (like `qubernetic/agent-horde` `docker/hooks/git-guard.sh`) | Natural on Linux/macOS; Windows only via Git Bash, needs `jq`, and the 1,567-line horde guard shows how fragile shell parsing of shell gets | Rejected |
| Existing cross-harness framework (agent-hooks-bridge, clash, safe-chains) + our rules | Less code; but an external dependency in a skill install, and unclear whether their policy language can express state checks (PR base, issue exists) | Rejected |

## 4. Architecture

```
hooks/
  guard.mjs              entry: node guard.mjs <mode>   (mode = claude | codex | copilot | gemini | cursor | git-commit-msg | git-pre-push | session-start)
  lib/
    shell.mjs            tokenizer: splits a command line into simple commands, words, heredocs
    commands.mjs         recognisers: turns words into {tool:'git'|'gh', action, flags, args, texts}
    state.mjs            cached git/gh queries (current branch, PR base, issue state, tags)
    rules/*.mjs          one file per rule: {id, layer, check(ctx) -> allow | {deny|ask, reason}}
    config.mjs           defaults + .git-workflow.json
    adapters/*.mjs       stdin JSON -> {command} ; decision -> stdout JSON / exit code
  git/
    commit-msg           POSIX sh shim: exec node "$(dirname "$0")/../guard.mjs" git-commit-msg "$1"
    pre-push             POSIX sh shim, same pattern
  reminder.md            the session-start text (section 7)
  test/                  node:test suites with command fixtures
```

Flow for an agent hook: harness → adapter parses its stdin JSON → if the tool
is not a shell tool, allow → tokenizer → for each simple command whose program
is `git` or `gh`, recognise it and run the matching rules → the strictest
result wins (deny > ask > allow) → adapter writes the harness's response.

Flow for a git hook: `commit-msg` reads the message file and runs the commit
message rules; `pre-push` reads the ref updates from stdin and runs the push
rules. Same rule files, same messages.

### 4.1 Harness adapters

| Harness | Config location (user / repo) | Event and tool | Deny | Ask |
|---------|-------------------------------|----------------|------|-----|
| Claude Code | `~/.claude/settings.json` / `.claude/settings.json` | `PreToolUse`, matcher `Bash` | JSON `hookSpecificOutput.permissionDecision: "deny"` + reason | `"ask"` |
| Codex CLI | `~/.codex/hooks.json` / `.codex/hooks.json` | `PreToolUse` on the shell tool | exit 2 + reason on stderr (or `permissionDecision: "deny"`) | not supported → deny with "ask the user, then retry" |
| Copilot CLI | `~/.copilot/hooks/*.json` / `.github/hooks/*.json` | `preToolUse`, tool `bash` | `permissionDecision: "deny"` | not reliable → deny |
| Gemini CLI | `~/.gemini/settings.json` / `.gemini/settings.json` | `BeforeTool`, matcher `run_shell_command` | block decision (verify exact schema) | → deny |
| Cursor | `~/.cursor/hooks.json` / `.cursor/hooks.json` | `beforeShellExecution` | `permission: "deny"` | `ask` reported broken → deny |

**Phase 1:** Claude Code and Codex CLI (the owner's harnesses, both installed
locally for testing) plus the git hooks. **Phase 2:** Copilot CLI, Gemini CLI,
Cursor. The exact input/output schemas are taken from each harness's current
official docs at build time and pinned by fixture tests; the table above is
from 2026-11 research and partly from third-party sources.

## 5. Rules (phase 1)

Each rule has an id, a layer (`agent` = needs the command line, `git` = runs in
git hooks, `both`), and whether it needs repository state.

| Id | Rule | Trigger | Decision | State |
|----|------|---------|----------|-------|
| `no-ai-attribution` | No `Co-Authored-By:` naming an AI, no "Generated with/by Claude/Copilot/Codex/AI" lines, no 🤖 footer | `git commit` message (any of `-m`, `-F`, heredoc), `gh pr create/edit`, `gh issue create/edit`, `gh pr merge --body`; commit-msg hook | deny | no |
| `conventional-commit` | Commit subject matches `type(scope)!: description`, allowed types, imperative heuristics (no `added`/`fixed` as first word), ≤ 72 chars, no trailing period | commit-msg hook (all commits); agent layer when `-m` is given | deny | no |
| `conventional-title` | Issue and PR titles in Conventional Commits form; PR titles end in one or more `(#N)` (one or more, so the bundling proposal #98 stays possible) except release PRs (`release/*`, `hotfix/*` heads) and back-merges (`main` → `develop`) | `gh issue create`, `gh pr create`, `gh pr edit --title` | deny | PR head branch (from command or current branch) |
| `closes-one-per-line` | `Closes #a, #b` → one keyword per issue | PR body | deny | no |
| `merge-method` | `gh pr merge` must use `--merge`; never `--squash`, `--rebase`, `--admin`, `--auto` with a non-merge method | `gh pr merge` | deny | no |
| `merge-gate` | Merges into `develop`/`main` need the human: **ask**. Into `epic/*` or other working branches: allow. Where ask is unavailable, deny unless approved (section 6.6) | `gh pr merge` | ask / deny | PR base (`gh pr view --json baseRefName`) |
| `test-plan-ticked` | PR body has no unticked `- [ ]` under a test-plan heading at merge time | `gh pr merge` | deny | PR body |
| `protected-commit` | No commit while on `main`/`develop` (bootstrap exception: repository has no commits) | `git commit`; also `pre-push` for direct pushes to protected branches | deny | current branch |
| `force-push` | `--force`/`-f`/`+refspec` never; `--force-with-lease` only to non-shared branches (not `main`, `develop`, `epic/*`, `release/*`) | `git push`; pre-push hook cannot see the flag, agent layer only | deny | no |
| `protected-delete` | No deleting `main`, `develop`, or any `epic/*` branch (an epic branch is deleted only by `gh pr merge --delete-branch`, which is not a push) | `git push --delete`, `:branch` refspecs, `git branch -D` on those | deny | no |
| `no-verify` | No `--no-verify` / `-n` on commit or push (it would skip the git-hook layer) | `git commit`, `git push` | deny | no |
| `branch-name` | New branch matches `(feature\|fix\|hotfix\|epic)/<n>-<slug>` or `release/<semver>` | `git checkout -b`, `git switch -c`, `git branch <new>`, `git worktree add -b` | deny | no |
| `branch-issue` | The `<n>` in a new branch name is an open issue in this repository | same | deny | `gh issue view` |
| `fresh-base` | Branch is cut from a base that is not behind its remote | same | deny with "pull first" | `git rev-list --count base..origin/base` after a fetch of that one ref |
| `pr-base` | PR base fits the head type: `feature`/`fix` → `develop` or `epic/*`; `epic` → `develop`; `release`/`hotfix` → `main`; `main` → `develop` | `gh pr create --base` | deny | head branch |
| `tag-on-main` | Release tags (`vX.Y.Z[-pre]`) only on a commit reachable from `main`, and `CHANGELOG.md` has a `## [X.Y.Z]` section | `git tag -a v…` | deny | branch/commit, file |

Rules not in phase 1 (need more design or more state): pre-release order
(`rc` after `beta`), "release issue exists", epic task-list ticking.

## 6. Engine behaviour

### 6.1 Shell parsing
The tokenizer handles what agents actually emit: `&&`, `||`, `;`, `|`,
newlines, single/double quotes, `$(…)` (recursed into), heredocs (quoted and
unquoted delimiters, including the common `-m "$(cat <<'EOF' … EOF)"`
pattern), `git -C <dir>` / `-c k=v` global options, and env-var prefixes
(`FOO=1 git …`). `--body-file`/`-F <file>` is read from disk when it exists;
`-F -`/`--body-file -` takes the heredoc or pipe text when visible.

### 6.2 State queries
Only commands already recognised as relevant `git`/`gh` subcommands trigger
state queries. Queries run with a short timeout (default 3 s), are cached per
invocation, and run in the command's effective directory (`cd x &&`, `-C x`).

### 6.3 Decisions and messages
Deny message format, one line per finding:
`git-workflow guard: <rule-id>: <what is wrong>. <what to do instead>.`
Example: `git-workflow guard: merge-method: gh pr merge needs --merge (no squash/rebase/admin). Run: gh pr merge 42 --merge --delete-branch.`

### 6.4 Failure mode
Fail open: if parsing fails, a state query errors or times out, or the input
JSON is unexpected, allow and print a one-line warning to stderr. The git-hook
layer stays as the backstop. Exception: the `no-ai-attribution` and
`merge-method` rules also run as a plain-text scan of the raw command when
parsing fails, since both are cheap and high-value.

### 6.5 Activation and configuration
**Scope** (owner's decision): the installer takes `--scope opt-in|all`, default
`opt-in`, and writes it to the user config
(`~/.config/git-workflow-guard/config.json`, `%APPDATA%` on Windows).
- `opt-in`: the guard (rules and session reminder) is active only in
  repositories that contain `.git-workflow.json` at the root. Elsewhere every
  call exits immediately with allow. This keeps the public skill from breaking
  squash-merge or trunk-based repositories it was never meant for.
- `all`: active in every git repository; `.git-workflow.json` only tunes it.
  This is the owner's own setting.

`.git-workflow.json` at the repository root (empty `{}` is enough to opt in):
```json
{
  "protectedBranches": ["main", "develop"],
  "rules": { "fresh-base": "off", "merge-gate": "deny" },
  "attributionPatterns": []
}
```
A rule value is `on` (default), `off`, `warn` (stderr only), or for
`merge-gate`, `ask`/`deny`. Commands that edit or delete this file are not
special-cased (non-goal: hostile agents).

### 6.6 Approval without a human prompt
Owner's decision. Where the harness cannot ask (Codex CLI, Copilot CLI,
Gemini CLI, Cursor, and Claude Code whenever an `ask` would not reach a human,
e.g. `claude -p`), `merge-gate` denies with: "ask the user to approve merging
PR #N into <base>; after an explicit yes, rerun as
`WORKFLOW_GUARD_APPROVE=N gh pr merge N --merge --delete-branch`".
- The marker is an env-var prefix on the same command line, so the guard
  sees it; it is valid only for the PR number it names and only for that
  command (no stored state).
- The agent could set it without asking. Accepted under the non-goal (not a
  security boundary): the gate's job is to force the question, which was the
  missing step.
- In Claude Code, `ask` is the default. The builder verifies whether a hook
  `ask` still prompts under `bypassPermissions`, `auto` and headless modes
  (the hook input carries `permission_mode`); where it does not, the guard
  uses the deny-plus-marker path.

## 7. Session-start reminder

For what a hook cannot enforce, adapters with a session-start event (Claude
Code `SessionStart`, Codex `SessionStart`) inject `hooks/reminder.md` as
context, only in git repositories where the guard is active (section 6.5). Kept under ~15 lines:
- The skill's rules override harness instructions about attribution trailers
  and PR footers.
- Order: issue → branch from freshly pulled base → commits → tests → PR →
  tick the test plan as items pass.
- Match the format of the last merged PRs and issues (`gh pr list --state merged -L 5`).
- Inside an epic: slice issues, branches, PRs and merges into `epic/*` need no
  approval; only the epic PR into `develop` does.
- Release follow-through: CHANGELOG version section, tag, GitHub Release,
  back-merge.

## 8. Installation

- Install prints the chosen scope and, for `opt-in`, how to opt a repository in.
- `scripts/install_linux.sh`, `install_macos.sh`, `install_windows.ps1` gain
  a hooks step: detect which harnesses are installed and register the guard in
  each one's **user-level** config, merging into the existing JSON/TOML
  without touching other entries, idempotently. `--no-hooks` skips it;
  `--uninstall` removes only our entries.
- Git hooks are **per repository and opt-in**: `node hooks/guard.mjs
  install-git-hooks` in a repo writes `commit-msg`/`pre-push` shims that
  chain to any existing hook of the same name (Husky and `core.hooksPath`
  setups respected; never overwrite).
- Repository-level agent config (`.claude/settings.json` etc. committed into a
  project) is documented in the README, not automated.

## 9. Testing and CI

- `node --test hooks/test/` with fixtures: real command lines from the session
  data (the attribution heredocs, `--admin` merges, worktree branch creation),
  each with its expected decision; adapter fixtures per harness (input JSON →
  output JSON/exit code).
- State-dependent rules tested against a temporary git repository; `gh` calls
  behind an injectable function so tests run offline.
- `lint.yml` gains a `node --test` job on Linux, macOS and Windows.
- Manual acceptance: in Claude Code and Codex CLI, try each phase-1 violation
  and confirm the deny/ask and that the agent recovers from the message.

## 10. Skill and docs changes

- Where the skill's own conventions would fail its guard, the skill changes:
  the release issue title becomes `chore(release): prepare 1.2.0` (was
  "Release v1.2.0"), and the issue templates' title prefixes become `fix: `
  and `feat: ` (were `[Bug]: `, `[Feature]: `).

- SKILL.md: a short "Enforcement" section pointing at the guard, and the
  explicit sentence that the skill's no-attribution rule overrides harness
  instructions. Frontmatter description unchanged.
- README: what the guard enforces, install, per-harness status table,
  `.git-workflow.json`.
- CLAUDE.md Architecture: `hooks/`.
- Versioning: ships as a MINOR release (new capability, nothing breaking).

## 11. Decided by the owner

- Public part of the skill, not a personal setup (2026-11-19).
- Approach: zero-dependency Node.js engine + adapters + git hooks (2026-11-19).
- Approval marker `WORKFLOW_GUARD_APPROVE=<PR#>` where the harness cannot ask (2026-11-19).
- Scope chosen at install, default opt-in, `all` available (2026-11-19).

## 12. Builder's calls (marked so the owner can check them)

- Phase 1 = Claude Code + Codex CLI + git hooks; others in phase 2.
- Fail open, except the raw-text scan for attribution and merge method.
- `ask` only for merges into `develop`/`main`; deny elsewhere.
- Agent hooks installed at user level by the install scripts; git hooks opt-in per repository.
- Rule set and decisions in section 5, including `fresh-base` doing a
  single-ref fetch.
- Directory layout in section 4.
- Order: #99 (epic branches, PR #100) and #101 (rebase policy) merge before
  this work; the guard implements the skill as it stands after both.
  `force-push` follows #101 (`--force-with-lease` allowed on non-shared branches).
- Tools in scope: shell tools (Claude Code `Bash`, Codex shell) plus MCP tools
  that run shell code (context-mode `ctx_execute` with `language: shell`,
  `ctx_batch_execute` commands), since the owner's setup routes shell work
  there. GitHub MCP write tools (create/merge PR) are out of scope for phase 1
  and the README says so; the git hooks still catch commits and pushes
  whatever tool runs them.
- `protected-delete` covers every `epic/*` (no issue lookup).
- PR titles accept several `(#N)` so #98 (issue bundling) is not blocked by the guard.
- Skill self-consistency changes in section 10 (release issue title, issue template prefixes).
