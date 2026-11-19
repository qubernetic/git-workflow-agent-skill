# Workflow Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the git-workflow skill's mechanically checkable rules with one Node.js guard engine, wired into Claude Code and Codex CLI hooks and into git's `commit-msg`/`pre-push` hooks, with install/update/doctor/repair commands.

**Architecture:** A zero-dependency ESM engine (`hooks/`) tokenizes a shell command line, recognises `git`/`gh` invocations, runs rule modules (some query repository state through an injectable executor) and returns allow/ask/deny. Thin adapters translate each harness's hook JSON in and out; git hook shims call the same rules. A management CLI in the same entry point registers the hooks in user-level harness configs.

**Tech Stack:** Node.js ≥ 20 (ESM `.mjs`, `node:test`, `node:child_process`, `node:fs`), POSIX sh shims, GitHub CLI `gh`, git.

**Spec:** `docs/superpowers/specs/2026-11-19-workflow-guard-design.md`

**Prerequisite:** PR #100 (epic branches, #99) and the rebase policy (#101) are merged into `develop`, and this branch has `develop` merged in, before execution starts. Rules follow SKILL.md as it stands after both.

## Global Constraints

- No npm dependencies, no `package.json` needed; every file under `hooks/` is ESM `.mjs`, Node ≥ 20, runs unchanged on Linux, macOS, Windows.
- Entry point: `node hooks/guard.mjs <subcommand> ...`. Subcommands: `hook <harness> <event>`, `git <hook-name> [args]`, `install`, `update`, `doctor`, `repair`, `uninstall`, `enable`, `disable`.
- Deny message format, one line per finding: `git-workflow guard: <rule-id>: <what is wrong>. <what to do instead>.`
- Decision precedence: deny > ask > warn > allow.
- Fail open: parse error, state query error/timeout (3 s default), unexpected input → allow + one stderr warning line, except the raw-text fallback for `no-ai-attribution` and `merge-method` (spec 6.4).
- Commands with no `git`/`gh` word must return allow without spawning any process.
- Activation: user config `scope` = `opt-in` (default) or `all`; with `opt-in` the guard is active only where the repo root has `.git-workflow.json` (spec 6.5).
- User config path: `$XDG_CONFIG_HOME/git-workflow-guard/config.json` (fallback `~/.config/...`), on Windows `%APPDATA%\git-workflow-guard\config.json`.
- `merge-gate`: ask where supported; otherwise deny unless the command line carries `WORKFLOW_GUARD_APPROVE=<same PR number>` (spec 6.6).
- Conventional types (SKILL.md): `feat fix docs chore refactor test style perf ci build revert`.
- Commits in this plan: Conventional Commits, `Refs #102` footer, **no AI attribution lines**.

## Review Focus

1. Claude's own commit idiom `git commit -m "$(cat <<'EOF' ... EOF)"` with a `Co-Authored-By` trailer → must be denied (the #1 real violation). Pinned in Task 1 and Task 4 tests.
2. A chained command (`git add -A && git commit -m "..." && git push`) where only one part violates → that part's finding is reported, the rest is not blocked spuriously. Pinned in Task 7.
3. Text that merely *mentions* a forbidden flag (`echo "never use --squash"`, a PR body containing `gh pr merge --squash`) → allow. Pinned in Task 2 and Task 7.
4. `gh` not installed or not authenticated → state rules skip silently (fail open), text rules still run. Pinned in Task 3 and Task 7.
5. Repo without `.git-workflow.json` under `opt-in` scope, and a non-git directory → allow in < 50 ms without spawning git/gh. Pinned in Task 7.

---

## File Structure

```
hooks/
  guard.mjs                 entry: subcommand dispatch only
  lib/shell.mjs             parseCommandLine
  lib/commands.mjs          recognise (git/gh actions)
  lib/config.mjs            loadConfig, userConfigPath, findRepoRoot
  lib/state.mjs             createState (cached git/gh queries)
  lib/check.mjs             runCheck (pipeline, fail-open, raw fallback)
  lib/rules/index.mjs       RULES list, evaluate
  lib/rules/text.mjs        no-ai-attribution, conventional-commit, conventional-title, closes-one-per-line
  lib/rules/merge.mjs       merge-method, merge-gate, test-plan-ticked
  lib/rules/branch.mjs      protected-commit, force-push, protected-delete, no-verify, branch-name, branch-issue, fresh-base, pr-base, tag-on-main
  lib/adapters/claude.mjs   Claude Code PreToolUse / SessionStart I/O
  lib/adapters/codex.mjs    Codex CLI PreToolUse / SessionStart I/O
  lib/adapters/tools.mjs    extractCommand (Bash, Codex shell, context-mode MCP)
  lib/githooks.mjs          commit-msg / pre-push handlers, shim writer
  lib/manage/registry.mjs   harness config read/merge/remove
  lib/manage/commands.mjs   install, uninstall, enable, disable, doctor, repair, update
  git/commit-msg, git/pre-push   POSIX sh shims (templates)
  reminder.md               session-start text
  test/*.test.mjs           node:test suites, fixtures in test/fixtures/
```

---

### Task 1: Shell tokenizer

**Files:**
- Create: `hooks/lib/shell.mjs`
- Test: `hooks/test/shell.test.mjs`

**Interfaces:**
- Produces: `parseCommandLine(src: string, opts?: {cwd?: string}) -> {ok: boolean, commands: SimpleCommand[]}` where `SimpleCommand = {argv: string[], env: Record<string,string>, cwd: string|undefined, stdin: string|undefined, raw: string}`. `cwd` reflects a preceding `cd X &&` / `cd X;` in the same line (resolved against `opts.cwd`). `stdin` is the body of a heredoc or here-string feeding that command. `$(...)` and backticks are recursed: their inner commands are appended to `commands`, and the substitution's text value is used inside the outer word when the inner command is `cat` of a heredoc (so `-m "$(cat <<'EOF'\nmsg\nEOF\n)"` yields the message text as one argv word).

- [ ] **Step 1: Write the failing tests** — table-driven, one `test()` per row, asserting `argv`, `env`, `cwd`, `stdin`:
  - `git commit -m "feat: x"` → argv `['git','commit','-m','feat: x']`
  - `git add -A && git commit -m 'a b' ; git push` → 3 commands
  - `FOO=1 BAR=2 gh pr merge 4 --merge` → env `{FOO:'1',BAR:'2'}`, argv starts `gh`
  - `cd /tmp/r && git status` → second command `cwd === '/tmp/r'`
  - `git commit -m "$(cat <<'EOF'\nfeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"` → argv[3] contains both lines
  - `gh pr create --body-file - <<'EOF'\nbody\nEOF` → `stdin === 'body\n'`
  - `echo "never use --squash" | cat` → argv[0] `echo` (mentions stay data)
  - `git log | grep x || true` → 3 commands
  - unterminated quote `git commit -m "oops` → `ok === false`

- [ ] **Step 2: Run** `node --test hooks/test/shell.test.mjs` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `parseCommandLine`** as a single-pass character scanner with a quote/heredoc state machine; separators `&& || ; | & \n`; unquoted-delimiter heredocs keep `$VAR` literal (no expansion is attempted).
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(guard): add shell command tokenizer` (+ `Refs #102`).

### Task 2: git/gh recognisers

**Files:**
- Create: `hooks/lib/commands.mjs`
- Test: `hooks/test/commands.test.mjs`

**Interfaces:**
- Consumes: `SimpleCommand` (Task 1).
- Produces: `recognise(cmd: SimpleCommand, readFile?: (p) => string|null) -> Action|null`, where
  `Action = {tool:'git'|'gh', sub:string /* 'commit','push','checkout','switch','branch','worktree','tag' | 'pr create','pr edit','pr merge','issue create','issue edit' */, flags: Map<string, string|true>, positionals: string[], env, cwd, texts: {message?: string, title?: string, body?: string}, raw}`.
  Git global options `-C <dir>` (folds into `cwd`), `-c k=v`, `--no-pager`, `-P` are skipped. `git commit` message from `-m/--message` (multiple joined with `\n\n`), `-F <file>`/`--file` via `readFile`, `-F -` via `stdin`. `gh` `--title/-t`, `--body/-b`, `--body-file/-F` (file or `-` → stdin). Combined short flags (`-am`) are split.

- [ ] **Step 1: Write the failing tests**: `git -C /r -c x=y commit -am "fix: y"` → `{sub:'commit', cwd:'/r', texts.message:'fix: y', flags has 'a'}`; `git switch -c feature/12-x develop` → flags `c`, positionals `['feature/12-x','develop']`; `gh pr merge 42 --squash` → `sub:'pr merge'`, positionals `['42']`, flags `squash`; `gh issue create -t "feat: a" -b "b"`; `gh pr create --body-file body.md` with `readFile` stub; `echo git commit` → `null`; `npx gh pr list` → `null`.
- [ ] **Step 2: Run** `node --test hooks/test/commands.test.mjs` — FAIL.
- [ ] **Step 3: Implement `recognise`.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): recognise git and gh invocations`.

### Task 3: Config, activation and repository state

**Files:**
- Create: `hooks/lib/config.mjs`, `hooks/lib/state.mjs`
- Test: `hooks/test/config.test.mjs`, `hooks/test/state.test.mjs`

**Interfaces:**
- Produces (config): `userConfigPath(env = process.env, platform = process.platform) -> string`; `findRepoRoot(cwd) -> string|null` (walks up for `.git` dir or file, no process spawn); `loadConfig({cwd, env}) -> {active: boolean, scope: 'opt-in'|'all', repoRoot: string|null, protectedBranches: string[] /* default ['main','develop'] */, branchTypes: string[] /* default ['feature','fix','hotfix','epic'] */, rules: Record<string,'on'|'off'|'warn'|'ask'|'deny'>, attributionPatterns: string[]}`. Invalid `.git-workflow.json` → `active: true`, defaults, plus a `warnings` array entry.
- Produces (state): `createState({cwd, exec = defaultExec, timeoutMs = 3000}) -> State` with memoised async methods: `currentBranch(): Promise<string|null>`, `hasCommits(): Promise<boolean>`, `prView(ref?: string): Promise<{number:number, baseRefName:string, headRefName:string, body:string}|null>`, `issueState(n: number): Promise<'OPEN'|'CLOSED'|null>` (null = not found), `behindRemote(branch: string): Promise<number|null>` (runs `git fetch origin <branch> --quiet` once, then `git rev-list --count <branch>..origin/<branch>`), `isAncestor(commit: string, ref: string): Promise<boolean|null>`, `showFile(commit: string, path: string): Promise<string|null>`. `exec(cmd: string, args: string[], {cwd, timeoutMs}) -> Promise<{code:number, stdout:string}>`. Any thrown error or timeout → method resolves to `null` (caller treats as unknown).

- [ ] **Step 1: Write the failing tests**: config — temp dir without `.git` → `repoRoot null, active false`; repo with `.git-workflow.json` `{}` and scope opt-in → `active true`; scope `all` without the file → `active true`; `rules: {"fresh-base":"off"}` honoured; Windows path uses `APPDATA`. State — fake `exec` returning canned stdout: `prView('42')` parses JSON; `exec` rejecting with ENOENT (gh missing) → `null`; second call is served from cache (exec called once); timeout → `null`.
- [ ] **Step 2: Run** `node --test hooks/test/config.test.mjs hooks/test/state.test.mjs` — FAIL.
- [ ] **Step 3: Implement** both modules (`child_process.execFile` with `timeout`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add config activation and repository state queries`.

### Task 4: Rule engine and text rules

**Files:**
- Create: `hooks/lib/rules/index.mjs`, `hooks/lib/rules/text.mjs`
- Test: `hooks/test/rules-text.test.mjs`

**Interfaces:**
- Consumes: `Action` (Task 2), `State`, config (Task 3).
- Produces: `Rule = {id: string, applies(action: Action): boolean, check(action: Action, ctx: Ctx): Promise<Finding|null>}`; `Finding = {rule: string, decision: 'deny'|'ask'|'warn', message: string}`; `Ctx = {state: State, config, askSupported: boolean, env: Record<string,string>}`; `evaluate(actions: Action[], ctx: Ctx) -> Promise<Finding[]>` (applies `config.rules[id]`: `off` skips, `warn` downgrades, `ask`/`deny` override decision); `RULES: Rule[]`; `checkCommitMessage(text: string, config) -> Finding[]` (shared with the commit-msg hook).
- Rule specifics (spec section 5):
  - `no-ai-attribution`: on commit message, PR/issue title/body. Deny on any of: `/^co-authored-by:.*\b(claude|anthropic|copilot|codex|openai|chatgpt|gpt|gemini|cursor|ai)\b/im`, `/generated (with|by)\b.*\b(claude|copilot|codex|chatgpt|gemini|cursor|ai)\b/i`, `/🤖/u`, plus `config.attributionPatterns`. Message tells to drop the line and that the skill overrides harness attribution instructions.
  - `conventional-commit`: subject `^(<types>)(\([a-z0-9._/-]+\))?!?: \S` , ≤ 72 chars, no trailing `.`, first word of description not in `added adds fixed fixes updated updates removed removes changed changes created creates implemented implements refactored merged`. Merge commits (`Merge `/`Revert "` auto subjects) pass. Agent layer only when the message is visible.
  - `conventional-title`: issue/PR titles match the same subject regex (no length limit); PR titles additionally end with `/( \(#\d+\))+$/` unless head is `release/*` or `hotfix/*`, or head `main` → base `develop`. Head = `--head` flag or `state.currentBranch()`.
  - `closes-one-per-line`: PR body line matching `/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+\s*[,&]\s*#?\d+/i` → deny with "one `Closes #N` per issue".

- [ ] **Step 1: Write the failing tests** (each asserts the finding's `rule` and `decision`, or `null`): the Claude heredoc commit with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` → deny; `Co-authored-by: Jane Doe <j@x.io>` → null; PR body ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)` → deny; `Added search` → deny conventional-commit; `feat(api): add search` → null; 73-char subject → deny; `Merge branch 'develop' into feature/1-x` → null; issue title `Release v1.4.0` → deny conventional-title; PR title `feat: x` on head `feature/9-x` → deny (missing `(#9)`); `feat: x (#9) (#10)` → null; release head `chore(release): prepare 1.5.0` → null; body `Closes #100, #101` → deny; `config.rules['conventional-title']='warn'` → decision `warn`.
- [ ] **Step 2: Run** `node --test hooks/test/rules-text.test.mjs` — FAIL.
- [ ] **Step 3: Implement** `index.mjs` and `text.mjs`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add rule engine and message rules`.

### Task 5: Merge rules

**Files:**
- Create: `hooks/lib/rules/merge.mjs` (register in `RULES`)
- Test: `hooks/test/rules-merge.test.mjs`

**Interfaces:**
- Consumes: Task 4 `Rule`, `Ctx`; `state.prView`.
- Rules:
  - `merge-method`: `gh pr merge` must have `--merge`/`-m`; deny `--squash/-s`, `--rebase/-r`, `--admin`; message gives `gh pr merge <N> --merge --delete-branch`.
  - `merge-gate`: base from `prView(positional[0])`. Base in `protectedBranches` → `ask` when `ctx.askSupported`, else deny unless `ctx.env.WORKFLOW_GUARD_APPROVE === String(pr.number)` (env from the command's own prefix merged over process env), message exactly as spec 6.6. Base `epic/*` or anything else → null. `prView` null → null (fail open).
  - `test-plan-ticked`: in `prView().body`, the section under a heading matching `/^#{2,3} .*(test plan|checklist|user test)/im` up to the next heading contains `- [ ]` → deny "tick the passed items in the PR description (gh pr edit N --body-file ...) before merging".

- [ ] **Step 1: Write the failing tests** with a stub `state`: `--squash` → deny merge-method; `--merge` into `epic/180-beta` → no findings; into `develop` with `askSupported:true` → ask; `askSupported:false` → deny containing `WORKFLOW_GUARD_APPROVE=42`; same with env `WORKFLOW_GUARD_APPROVE=42` → null; with `=41` → deny; body `## Test plan\n- [x] a\n- [ ] b` → deny; all ticked → null; `prView` null → null.
- [ ] **Step 2: Run** `node --test hooks/test/rules-merge.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add merge method, gate and test-plan rules`.

### Task 6: Branch, push and tag rules

**Files:**
- Create: `hooks/lib/rules/branch.mjs` (register in `RULES`)
- Test: `hooks/test/rules-branch.test.mjs`

**Interfaces:**
- Consumes: Task 4, Task 3 state.
- Produces: `branchCreation(action: Action) -> {name: string, startPoint: string|null}|null` (covers `checkout -b/-B`, `switch -c/-C`, `branch <new> [start]` without `-d/-D/-m`, `worktree add -b <new> <path> [start]`) — reused by Task 9.
- Rules (spec section 5 table; values):
  - `protected-commit`: `git commit` while `currentBranch()` ∈ protectedBranches and `hasCommits()` → deny.
  - `force-push`: `--force`, `-f`, or a refspec starting `+` → deny; `--force-with-lease`/`--force-if-includes` → deny when the destination (refspec dst, else current branch) ∈ protectedBranches or matches `epic/*`, `release/*`.
  - `protected-delete`: `push --delete|-d X`, refspec `:X`, `branch -d|-D X` with X ∈ protectedBranches or `epic/*` → deny.
  - `no-verify`: `commit --no-verify|-n`, `push --no-verify` → deny.
  - `branch-name`: new name must match `^(<branchTypes joined |>)/\d+-[a-z0-9]+(-[a-z0-9]+)*$` or `^release/\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$`.
  - `branch-issue`: number from the name; `issueState(n)` null → deny "issue #n does not exist in this repository; open it first"; `CLOSED` → deny; unknown (exec failed) → skip. Releases exempt.
  - `fresh-base`: start point (or current branch when absent) that is a local branch in `develop|main|epic/*|release/*`: `behindRemote(b) > 0` → deny "run git pull origin <b> first". Start point `origin/...` → skip.
  - `pr-base`: `gh pr create` base (`--base/-B`, default `develop`) vs head type: `feature|fix → develop|epic/*`, `epic → develop`, `release|hotfix → main`, `main → develop`; mismatch → deny naming the expected base.
  - `tag-on-main`: `git tag [-a] vX.Y.Z [commit]` (stable versions only): `isAncestor(commit||'HEAD','origin/main')` false → deny; `showFile(commit||'HEAD','CHANGELOG.md')` lacks `## [X.Y.Z]` → deny. Pre-release tags skip.

- [ ] **Step 1: Write the failing tests** with stub state, one per bullet: allow and deny case each, including `git worktree add -b fix/100-x ../wt develop` with `behindRemote('develop')=3` → deny fresh-base; `git push --force-with-lease origin feature/9-x` → null; `git push origin +develop` → deny; `git branch -D epic/34-pre-alpha` → deny; `docs/179-x` with default branchTypes → deny, with `branchTypes` incl. `docs` → null; `gh pr create --base main` on head `feature/9-x` → deny; `git tag -a v1.5.0` when CHANGELOG lacks `## [1.5.0]` → deny.
- [ ] **Step 2: Run** `node --test hooks/test/rules-branch.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add branch, push and tag rules`.

### Task 7: Check pipeline

**Files:**
- Create: `hooks/lib/check.mjs`
- Test: `hooks/test/check.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `runCheck({command: string, cwd: string, askSupported: boolean, env?: object, exec?: Function}) -> Promise<{decision: 'allow'|'ask'|'deny', reason: string, warnings: string[]}>`. Order: fast path (no `\b(git|gh)\b` in `command` → allow, no spawn) → `loadConfig` (inactive → allow) → `parseCommandLine` → `recognise` each → `evaluate` → strictest decision; `reason` joins findings' messages with `\n`. Parse failure → raw-text fallback: attribution regexes when the text contains `git commit` or `gh (pr|issue)`; `/gh\s+pr\s+merge\b[^\n]*--(squash|rebase|admin)\b/`. Any thrown error → allow + warning.

- [ ] **Step 1: Write the failing tests**: the five Review Focus cases (chained command reports only the violating part's finding; `echo "never use --squash"` → allow; exec throwing ENOENT for gh → text rules still deny an attribution commit; non-git dir and opt-in repo without `.git-workflow.json` → allow with an `exec` spy never called and elapsed < 50 ms); unterminated quote + `gh pr merge 3 --squash` → deny via fallback; rule throwing → allow + warning.
- [ ] **Step 2: Run** `node --test hooks/test/check.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add check pipeline with fail-open fallback`.

### Task 8: Harness adapters, entry point and session reminder

**Files:**
- Create: `hooks/guard.mjs`, `hooks/lib/adapters/tools.mjs`, `hooks/lib/adapters/claude.mjs`, `hooks/lib/adapters/codex.mjs`, `hooks/reminder.md`
- Test: `hooks/test/adapters.test.mjs`, fixtures `hooks/test/fixtures/{claude,codex}-*.json`

**Interfaces:**
- Consumes: `runCheck` (Task 7), `loadConfig` (Task 3).
- Produces:
  - `extractCommand(toolName: string, toolInput: object) -> string|null`: `Bash` → `command`; Codex `shell|shell_command|exec_command|local_shell` → `command` string, or array: `[sh|bash|zsh, -c|-lc, script]` → `script`, else the array shell-quoted and joined; tool names ending `ctx_execute` with `language === 'shell'` → `code`; ending `ctx_batch_execute` → `commands.map(c => c.command).join('\n')`; anything else → null.
  - `claude.preToolUse(input) -> {stdout: string, exitCode: 0}`: allow → empty stdout; deny/ask → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":reason}}`. `askSupported = !['bypassPermissions','dontAsk'].includes(input.permission_mode)` (verified in Task 12).
  - `codex.preToolUse(input)`: same JSON shape, `askSupported: false`, deny only.
  - `<adapter>.sessionStart(input)`: when the guard is active in `input.cwd` → `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext": <reminder.md>}}`, else empty.
  - `guard.mjs hook <claude|codex> <pre-tool-use|session-start>` reads stdin JSON and writes the adapter result; malformed stdin → allow + stderr warning.
  - `reminder.md`: the five bullets of spec section 7, ≤ 15 lines.

- [ ] **Step 1: Write the failing tests**: fixture Claude Bash input with attribution commit → stdout JSON with `permissionDecision:"deny"`; `permission_mode:"bypassPermissions"` + develop merge → deny with approval hint; default mode → `ask`; Codex `shell` array `["bash","-lc","gh pr merge 5 --squash"]` → deny; context-mode `ctx_execute` shell code with `git push --force` → deny; `Read` tool → empty stdout; session-start in an active repo → `additionalContext` contains `issue → branch`; spawn `node hooks/guard.mjs hook claude pre-tool-use` with fixture stdin → exit 0 and the same JSON.
- [ ] **Step 2: Run** `node --test hooks/test/adapters.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add Claude Code and Codex adapters`.

### Task 9: Git hooks

**Files:**
- Create: `hooks/lib/githooks.mjs`, `hooks/git/commit-msg`, `hooks/git/pre-push`
- Modify: `hooks/guard.mjs` (dispatch `git <hook>`)
- Test: `hooks/test/githooks.test.mjs`

**Interfaces:**
- Consumes: `checkCommitMessage` (Task 4), `loadConfig`.
- Produces: `commitMsg(file: string, {cwd}) -> {exitCode: 0|1, stderr: string}` (strips `#` comment lines; inactive repo → 0); `prePush(stdinText: string, {cwd}) -> {exitCode, stderr}`: each line `<local ref> <local sha> <remote ref> <remote sha>`; deny update of `refs/heads/<protected>` (direct push; skipped when the remote sha is all zeros and the repo has a single commit — bootstrap) and deletion (local sha all zeros) of protected or `epic/*` refs. `installShims(repoRoot) -> {written: string[], chained: string[]}`: writes `commit-msg`/`pre-push` into the effective hooks dir (`git rev-parse --git-path hooks`, which honours `core.hooksPath`/Husky); an existing hook of the same name is renamed `<name>.local` and called first by our shim; never overwrites an existing shim of ours. Shim body: `#!/bin/sh\n[ -x "$(dirname "$0")/<name>.local" ] && { "$(dirname "$0")/<name>.local" "$@" || exit $?; }\nexec node "<abs guard.mjs>" git <name> "$@"`.

- [ ] **Step 1: Write the failing tests** in a temp repo (`git init`, commits): `commitMsg` with `Added x` → exit 1 and `conventional-commit` in stderr; valid message → 0; pre-push line pushing `refs/heads/develop` → 1; deleting `refs/heads/epic/3-x` → 1; `installShims` twice with a pre-existing `commit-msg` → `.local` created once, shim calls it; real `git commit -m "Added x"` in the temp repo after `installShims` (with `.git-workflow.json`) → non-zero.
- [ ] **Step 2: Run** `node --test hooks/test/githooks.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add commit-msg and pre-push git hooks`.

### Task 10: Install, uninstall, enable, disable

**Files:**
- Create: `hooks/lib/manage/registry.mjs`, `hooks/lib/manage/commands.mjs`
- Modify: `hooks/guard.mjs` (dispatch)
- Test: `hooks/test/manage.test.mjs`

**Interfaces:**
- Produces:
  - `HARNESSES = {claude: {detect(env) -> boolean /* ~/.claude exists */, configPath(env) -> '~/.claude/settings.json', events: {PreToolUse: {matcher: 'Bash|mcp__.*ctx_execute|mcp__.*ctx_batch_execute', command: 'hook claude pre-tool-use'}, SessionStart: {matcher: undefined, command: 'hook claude session-start'}}}, codex: {detect: $CODEX_HOME or ~/.codex exists, configPath: '<codex home>/hooks.json', events: {PreToolUse: {matcher: 'shell|shell_command|exec_command|local_shell|ctx_execute|ctx_batch_execute', command: 'hook codex pre-tool-use'}, SessionStart: {command: 'hook codex session-start'}}}}`.
  - Registered command string: `node "<abs path of guard.mjs>" <command>`. Our entries are recognised by `/guard\.mjs"? hook (claude|codex) /`.
  - `register(harness, guardPath, env) -> {changed: boolean}` and `unregister(harness, env) -> {changed}`: read JSON (missing → `{}`), add/replace only our entries under `hooks.<Event>[]` as `{matcher?, hooks:[{type:'command', command, timeout: 10}]}`, write with 2-space indent, keep every foreign key and entry; idempotent.
  - `install({scope='opt-in', harnesses?, env}) -> report lines`, `uninstall({env})`, `enable({cwd, gitHooks:boolean})` (writes `.git-workflow.json` `{}` if missing, calls `installShims` when asked), `disable({cwd})` (removes `.git-workflow.json` only if it is exactly `{}`, else prints how to set rules off). `install` writes user config `{scope, version: <SKILL.md version>, guardPath, harnesses}`. Codex: when `<codex home>/config.toml` lacks `hooks = true` under `[features]`, print the line to add (no TOML editing — zero-dep call).

- [ ] **Step 1: Write the failing tests** with `env.HOME`/`CODEX_HOME`/`XDG_CONFIG_HOME` pointed at temp dirs: settings.json with an existing foreign `PreToolUse` and `SessionStart` entry → after `register` both foreign entries intact and ours added; second `register` → `changed:false`; path change → our entry replaced, not duplicated; `unregister` removes only ours; `install` writes user config with `scope:'opt-in'`; `enable({gitHooks:true})` creates `.git-workflow.json` and shims.
- [ ] **Step 2: Run** `node --test hooks/test/manage.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add install, uninstall, enable and disable commands`.

### Task 11: Doctor, repair, update

**Files:**
- Modify: `hooks/lib/manage/commands.mjs`, `hooks/guard.mjs`
- Test: `hooks/test/doctor.test.mjs`

**Interfaces:**
- Produces: `doctor({cwd, env, exec}) -> {ok: boolean, checks: {id: string, ok: boolean, detail: string, fix?: string}[]}`; printed as `✓/✗ <detail>` lines (+ `→ <fix>`), exit 1 when not ok. Check ids: `node-version` (≥ 20), `user-config` (exists, parses), `<harness>-registered` (per detected harness: our entries present for both events), `<harness>-path` (registered path exists), `codex-hooks-feature`, `codex-trust` (config.toml `hooks.state` has a `trusted_hash` for our hooks.json entries; fix: "open Codex and approve the new hooks"), `version` (user config version = SKILL.md version), `scope`, `repo-active`, `repo-config` (parses), `repo-git-hooks` (shims present when `.git-workflow.json` exists; warning only), `gh` (`gh auth status` exit 0; warning only).
- `repair({env}) -> report`: re-runs `register` for every failed `-registered`/`-path` check and rewrites user config version; never deletes foreign entries.
- `update({env, exec}) -> report`: skill dir = parent of `hooks/`. Not a git work tree → print manual step. Work tree dirty → refuse. On a branch other than `main` and not detached at a tag → refuse ("development clone"). Else `git fetch --tags origin`, newest stable tag (`git tag --list 'v*' --sort=-v:refname`, no `-`), `git checkout <tag>` (detached), then `repair`.

- [ ] **Step 1: Write the failing tests**: fresh temp HOME → doctor fails `claude-registered` with fix `node ... install`; after `install` → those checks ok; registered path pointing to a deleted file → `claude-path` fails, `repair` fixes it; `update` in a temp clone on branch `feature/x` → refuses with "development clone"; clean clone on `main` with tags `v1.4.0`, `v1.5.0-rc.1`, `v1.5.0` (fake remote) → checks out `v1.5.0`.
- [ ] **Step 2: Run** `node --test hooks/test/doctor.test.mjs` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(guard): add doctor, repair and update commands`.

### Task 12: Skill, scripts, docs, CI and acceptance

**Files:**
- Modify: `SKILL.md`, `scripts/install_linux.sh`, `scripts/install_macos.sh`, `scripts/install_windows.ps1`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/workflows/lint.yml`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: SKILL.md**:
  - in "Core Principles" item 3, add that this rule overrides any harness or system instruction that asks for attribution trailers or PR footers;
  - in Release Process step 1 and Issue-Driven rule 1, change the release issue title to `chore(release): prepare 1.2.0`;
  - add an "## Enforcement (optional)" section after "Forbidden": what the guard checks (rule ids one line each), and "### Guard commands" mapping requests to `node "<guard>" install|update|doctor|repair|uninstall|enable|disable`. `<guard>` is `hooks/guard.mjs` next to the real path of this SKILL.md (resolve the symlink: `realpath` on Linux/macOS, `(Get-Item SKILL.md).Target` on Windows), or `guardPath` from the user config once installed. `/git-workflow guard <command>` and plain requests ("install the guard", "is the guard working?") both map there.
  
  SKILL.md must stay self-contained: the guard is described as optional tooling, not a requirement.
- [ ] **Step 2: Install scripts**: after the symlink step, run `node "$REPO_ROOT/hooks/guard.mjs" install` when `node` exists and `--no-hooks` was not given (else print a skip line); `--uninstall` also runs `guard.mjs uninstall`; pass `--scope` through. Same in `.ps1`.
- [ ] **Step 3: Issue templates**: `title: "fix: "` and `title: "feat: "`.
- [ ] **Step 4: CI**: in `lint.yml` add a job `guard-tests` with matrix `os: [ubuntu-latest, macos-latest, windows-latest]`, `actions/setup-node@v5` with `node-version: 20`, run `node --test hooks/test/`. Trigger `pull_request` branches `[main, develop, 'epic/**']`.
- [ ] **Step 5: README** (guard section: what it enforces, install, scope, `.git-workflow.json`, per-harness status table: Claude Code ✓, Codex CLI ✓, Copilot CLI / Gemini CLI / Cursor planned, GitHub MCP write tools not covered), **CLAUDE.md** Architecture gets `hooks/`, **CHANGELOG** `[Unreleased]` → `### Added` guard entry `(#102)`, `### Changed` release issue title and template prefixes.
- [ ] **Step 6: Verify** `./scripts/lint.sh` → "All checks passed."; `node --test hooks/test/` → all pass.
- [ ] **Step 7: Commit** in three commits: `docs(skill): describe the workflow guard and its commands`, `build(scripts): register guard hooks on install`, `ci: run guard tests on three platforms` (templates folded into the skill commit's scope only if ≤ 2 lines each; otherwise `chore(templates): use conventional title prefixes`).
- [ ] **Step 8: Manual acceptance** (record results in the PR test plan): install with `--scope all` locally; in Claude Code: attribution commit denied; `gh pr merge N --squash` denied; merge into `develop` asks; repeat the develop merge in `auto` and `bypassPermissions` modes and record whether `ask` prompts — if it does not prompt in `auto`, add `'auto'` to the no-ask list in `claude.mjs` with a test, and commit `fix(guard): treat auto mode as unable to ask`. In Codex CLI: same three, develop merge denied with the approval hint and passes with `WORKFLOW_GUARD_APPROVE=N`; `doctor` all ✓ after trusting the hooks.
