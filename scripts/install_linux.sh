#!/usr/bin/env bash
#
# Install or uninstall the git-workflow skill for Claude Code (Linux).
# Creates a symlink so the skill stays in sync with the repo.
#
# Also registers the optional workflow guard hooks (hooks/guard.mjs) when
# node is available.
#
# Usage:
#   ./scripts/install_linux.sh                     # Install skill + guard hooks
#   ./scripts/install_linux.sh --scope all         # Guard active in every repository
#   ./scripts/install_linux.sh --no-hooks          # Install the skill only
#   ./scripts/install_linux.sh --uninstall         # Uninstall skill + agent hooks (repo git hooks stay)

set -euo pipefail

SKILL_DIR="$HOME/.claude/skills/git-workflow"
SKILL_FILE="$SKILL_DIR/SKILL.md"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/SKILL.md"
GUARD="$REPO_ROOT/hooks/guard.mjs"
SCOPE=""
NO_HOOKS=0

info()  { printf "  \033[34mℹ\033[0m %s\n" "$1"; }
pass()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

# Run the guard subcommand "$1" (plus any extra args) unless hooks are skipped
# or node is missing. A guard failure is reported but does not abort.
run_guard() {
  local sub="$1"; shift
  if [[ "$NO_HOOKS" -eq 1 ]]; then
    info "Skipping guard hooks (--no-hooks)"
  elif ! command -v node >/dev/null 2>&1; then
    info "Skipping guard hooks — node not found (the skill works without them)"
  elif [[ ! -f "$GUARD" ]]; then
    info "Skipping guard hooks — $GUARD not found"
  elif node "$GUARD" "$sub" "$@"; then
    pass "Guard hooks: $sub done"
  else
    fail "Guard hooks: $sub failed (the skill itself is unaffected)"
  fi
}

uninstall() {
  run_guard uninstall
  if [[ -L "$SKILL_FILE" ]]; then
    rm "$SKILL_FILE"
    pass "Removed symlink: $SKILL_FILE"
    # Remove directory if empty
    rmdir "$SKILL_DIR" 2>/dev/null && info "Removed empty directory: $SKILL_DIR" || true
  elif [[ -f "$SKILL_FILE" ]]; then
    fail "$SKILL_FILE exists but is not a symlink — remove it manually to avoid data loss"
    exit 1
  else
    info "Nothing to uninstall — $SKILL_FILE does not exist"
  fi
}

install_skill() {
  # Verify source exists
  if [[ ! -f "$SOURCE" ]]; then
    fail "SKILL.md not found at $SOURCE"
    exit 1
  fi

  # Check if already installed
  if [[ -L "$SKILL_FILE" ]]; then
    current_target="$(readlink -f "$SKILL_FILE")"
    if [[ "$current_target" == "$SOURCE" ]]; then
      pass "Already installed (symlink points to $SOURCE)"
      return 0
    else
      info "Existing symlink points to $current_target — replacing"
      rm "$SKILL_FILE"
    fi
  elif [[ -f "$SKILL_FILE" ]]; then
    fail "$SKILL_FILE exists but is not a symlink — remove it manually before installing"
    exit 1
  fi

  # Create directory and symlink
  mkdir -p "$SKILL_DIR"
  ln -s "$SOURCE" "$SKILL_FILE"
  pass "Installed: $SKILL_FILE → $SOURCE"
  info "The skill will stay in sync with this repo. Restart Claude Code to activate."
}

usage() {
  echo "Usage: $0 [--uninstall] [--no-hooks] [--scope opt-in|all]"
  exit 1
}

# --- Main ---
ACTION=install
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) ACTION=uninstall ;;
    --no-hooks)  NO_HOOKS=1 ;;
    --scope)     [[ $# -ge 2 ]] || usage; SCOPE="$2"; shift ;;
    --scope=*)   SCOPE="${1#--scope=}" ;;
    *)           usage ;;
  esac
  shift
done

if [[ "$ACTION" == "uninstall" ]]; then
  uninstall
else
  install_skill
  if [[ -n "$SCOPE" ]]; then
    run_guard install --scope "$SCOPE"
  else
    run_guard install
  fi
fi
