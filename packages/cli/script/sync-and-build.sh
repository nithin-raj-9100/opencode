#!/bin/bash
set -euo pipefail

# Canonical tracked source; install a copy at ~/.local/libexec/opencode3-sync-and-build.sh.
REPO_DIR="/Users/nithin/.local/share/opencode3/source"
UPSTREAM_BRANCH="dev"
LOCK_DIR="/Users/nithin/.local/state/opencode3/sync.lock"
STATE_DIR="/Users/nithin/.local/state/opencode3"
LAST_SYNC="$STATE_DIR/last_sync"
LAST_BUILT="$STATE_DIR/last_built_upstream"
LAST_FAIL_SHA="$STATE_DIR/last_resolve_fail_sha"
LEGACY_FAIL_SHA="$STATE_DIR/last_agy_fail_sha"
AGENT_CONFIG="$STATE_DIR/oc3-resolve-config.json"
VERIFY_LOG="$STATE_DIR/last_verify.log"
FORK_CONTEXT="$REPO_DIR/packages/cli/script/fork-context.md"
OC3_MODEL="opencode-go/deepseek-v4.1-flash#max"
MAX_FIX_ATTEMPTS=3
CAFF_PID=""
CONTEXT_SNAPSHOT=""

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

is_fullwake() {
  if pmset -g assertions 2>/dev/null | grep -q "UserIsActive.*1"; then
    return 0
  fi
  if ioreg -r -k AppleClamshellState -d 1 2>/dev/null | grep -q '"AppleClamshellState" = No'; then
    if ioreg -c IOPMrootDomain -d 2 2>/dev/null | grep -q '"IOPMUserTriggeredFullWake" = Yes'; then
      return 0
    fi
  fi
  return 1
}

wait_for_network() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS -m 5 -o /dev/null https://github.com 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rebase_in_progress() {
  [ -d "$REPO_DIR/.git/rebase-merge" ] || [ -d "$REPO_DIR/.git/rebase-apply" ]
}

# 'git clean -fd' leaves gitignored paths alone, so tsgo -b incremental state under
# node_modules survives a reset+rebase and reports phantom errors against the new tree.
purge_stale_build_cache() {
  echo "==> Purging stale TypeScript/turbo build caches..."
  find "$REPO_DIR/packages" -maxdepth 4 -type d -name ".ts-dist" -prune -exec /bin/rm -rf {} + 2>/dev/null || true
  find "$REPO_DIR/packages" -maxdepth 3 -type d -name ".turbo" -prune -exec /bin/rm -rf {} + 2>/dev/null || true
  /bin/rm -rf "$REPO_DIR/node_modules/.ts-dist" "$REPO_DIR/node_modules/.cache/turbo" 2>/dev/null || true
}

write_agent_config() {
  mkdir -p "$STATE_DIR"
  python3 -c "
import json
base=json.load(open('/Users/nithin/.config/opencode/opencode.json'))
# Auto mode suspends broad execution allows (interpreters and package-manager runs),
# so pre-approve the exact maintenance commands instead of 'bun *'.
extra=[{'action':'shell','resource':p,'effect':'allow'} for p in [
  'git *','GIT_EDITOR=true git *','cat *','ls *','head *','tail *','grep *','rg *','fd *','find *','test *','echo *','sed -n *',
  'bun install','bun install *','bun typecheck','bun test','bun test *','bun run check','bun run generate',
]]
base['permissions']=base.get('permissions',[])+extra
auto=base.get('permission_auto') or {}
allow=auto.get('allow') or []
if '\$defaults' not in allow:
  allow=['\$defaults']+allow
auto['allow']=allow+['Running the fork build command (bun run --cwd packages/cli build, optionally prefixed with OPENCODE_CHANNEL=latest OPENCODE_CLI_NAME=opencode and build flags) is allowed: it is this repository build step that the sync script runs unattended.']
auto['allow'] += ['Running bun run check at the repository root, bun run generate from packages/client, and the focused permission and Raycast tests is allowed for maintaining this fork.']
base['permission_auto']=auto
json.dump(base,open('$AGENT_CONFIG','w'))
"
}

# Rebase checks out earlier trees where this recently added file does not exist.
# Keep the current instructions outside the worktree for the entire run.
snapshot_fork_context() {
  if [ ! -s "$FORK_CONTEXT" ]; then
    echo "ERROR: required fork context is missing at $FORK_CONTEXT" >&2
    return 1
  fi
  mkdir -p "$STATE_DIR"
  CONTEXT_SNAPSHOT="$(mktemp "$STATE_DIR/fork-context.XXXXXX")" || return 1
  if ! cp "$FORK_CONTEXT" "$CONTEXT_SNAPSHOT"; then
    rm -f "$CONTEXT_SNAPSHOT"
    CONTEXT_SNAPSHOT=""
    return 1
  fi
  FORK_CONTEXT="$CONTEXT_SNAPSHOT"
}

fork_context() {
  if [ -f "$FORK_CONTEXT" ]; then
    cat "$FORK_CONTEXT"
  else
    echo "ERROR: required fork context is missing at $FORK_CONTEXT" >&2
    return 1
  fi
}

# Every agent invocation is a cold start, so the fork's purpose and custom surface have to
# be restated up front or the agent will treat our code as anonymous and delete it to compile.
run_agent() {
  local context
  context="$(fork_context)" || return 1
  local prompt="You are maintaining a personal fork of OpenCode, unattended, on behalf of its author.
Read the following context in full before acting. It is authoritative; re-read '$FORK_CONTEXT' any time you need it again.

<fork-context>
$context
</fork-context>

Use OpenCode Go DeepSeek V4.1 Flash at maximum effort, selected by the launcher as $OC3_MODEL.
Preserve all fork features, especially the in-daemon Raycast adapter. Never restore the removed Python bridge or its LaunchAgent.
Do not print API keys, server passwords, authorization headers, or generated credential-bearing configuration.

=== YOUR TASK ===

$1"
  (cd "$REPO_DIR" && OPENCODE_CONFIG_CONTENT="$(cat "$AGENT_CONFIG")" \
    /Users/nithin/.local/bin/opencode3 run --standalone --auto -m "$OC3_MODEL" "$prompt" </dev/null)
}

fail_run() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  mkdir -p "$STATE_DIR"
  git -C "$REPO_DIR" rev-parse upstream/$UPSTREAM_BRANCH >"$LAST_FAIL_SHA" 2>/dev/null || true
  exit 1
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

export HOME="/Users/nithin"
export USER="${USER:-nithin}"
export LOGNAME="${LOGNAME:-nithin}"
export SHELL="${SHELL:-/bin/zsh}"
export LANG="${LANG:-en_US.UTF-8}"
export PATH="/Users/nithin/.local/bin:/Users/nithin/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GIT_EDITOR=true

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_AGE=0
  LOCK_MTIME=$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ "$LOCK_MTIME" -gt 0 ]; then
    LOCK_AGE=$((NOW - LOCK_MTIME))
  fi
  if [ "$LOCK_AGE" -gt 7200 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Removing stale lock (${LOCK_AGE}s old)."
    rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" || {
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] OpenCode 3 sync already running; skipping."
      exit 0
    }
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] OpenCode 3 sync already running; skipping."
    exit 0
  fi
fi

cleanup() {
  if [ -n "$CAFF_PID" ]; then
    kill "$CAFF_PID" 2>/dev/null || true
  fi
  git -C "$REPO_DIR" rebase --abort >/dev/null 2>&1 || true
  if [ -n "$CONTEXT_SNAPSHOT" ]; then
    rm -f "$CONTEXT_SNAPSHOT"
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -f "$LEGACY_FAIL_SHA" ] && [ ! -f "$LAST_FAIL_SHA" ]; then
  mv "$LEGACY_FAIL_SHA" "$LAST_FAIL_SHA"
fi

if [ "$FORCE" -eq 0 ] && ! is_fullwake; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] DarkWake/maintenance wake detected (no UserIsActive, lid closed or no FullWake flag); deferring to FullWake retry. Exit 0."
  exit 0
fi

if ! wait_for_network; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Network not ready (github.com unreachable after 60s); deferring to next run. Exit 0."
  exit 0
fi

caffeinate -i -m -u &
CAFF_PID=$!
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting OpenCode 3 automated sync and build..."

git -C "$REPO_DIR" fetch origin v2-dev
git -C "$REPO_DIR" fetch upstream "$UPSTREAM_BRANCH"
UPSTREAM_SHA=$(git -C "$REPO_DIR" rev-parse upstream/$UPSTREAM_BRANCH)
if [ "$FORCE" -eq 0 ] && [ -f "$LAST_BUILT" ] && [ "$(cat "$LAST_BUILT")" = "$UPSTREAM_SHA" ] && git -C "$REPO_DIR" merge-base --is-ancestor upstream/$UPSTREAM_BRANCH HEAD; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already rebased onto upstream/$UPSTREAM_BRANCH ($UPSTREAM_SHA); skipping build."
  mkdir -p "$STATE_DIR"
  date +%s >"$LAST_SYNC"
  exit 0
fi
if [ "$FORCE" -eq 0 ] && [ -f "$LAST_FAIL_SHA" ] && [ "$(cat "$LAST_FAIL_SHA")" = "$UPSTREAM_SHA" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Same upstream ($UPSTREAM_SHA) as last resolve failure; waiting for new upstream or --force. Exit 0."
  exit 0
fi
git -C "$REPO_DIR" checkout v2-dev
git -C "$REPO_DIR" reset --hard origin/v2-dev
git -C "$REPO_DIR" clean -fd
purge_stale_build_cache

echo "==> Generating one-shot oc3 config with pre-approved shell rules..."
write_agent_config

snapshot_fork_context || fail_run "Unable to preserve fork instructions before rebase."

echo "==> Rebasing v2-dev onto upstream/$UPSTREAM_BRANCH..."
if ! git -C "$REPO_DIR" rebase upstream/$UPSTREAM_BRANCH; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Merge conflict detected during rebase. Invoking oc3 ($OC3_MODEL) to resolve..."

  RESOLVE_PROMPT="In the repository directory '$REPO_DIR', a git rebase of 'v2-dev' onto 'upstream/$UPSTREAM_BRANCH' encountered merge conflicts.
Please resolve all merge conflicts and complete the rebase in that repository:
1. Check 'git status' inside '$REPO_DIR' to inspect all unmerged/conflicted files.
2. For each conflicted file, inspect conflict markers (<<<<<<<, =======, >>>>>>>) and resolve them carefully:
   - Identify which side is ours using the fork context above; 'git log --oneline upstream/$UPSTREAM_BRANCH..HEAD' lists our commits and 'git diff upstream/$UPSTREAM_BRANCH...HEAD -- <file>' shows our changes to a given file.
   - Keep our behaviour, adopt upstream's interfaces: port our code onto renamed/reshaped APIs rather than deleting it.
   - Session /goal is ours (fork context cluster 4). Do not drop session_goal, SessionGoalContinuation, the goal tools, the TUI /goal slash command, the visible /goal user-prompt admission, live footer timer helpers, or completeSlashCommand to make a conflict go away, and do not fold goals into instruction entries.
   - Reviewed auto mode is ours (fork context cluster 1). Do not drop or weaken the classifier, the permission_auto configuration fields, the auto-mode CLI subcommands (defaults/config/critique/reset), the TUI permission surfaces, or the hardening invariants: configured deny rules win over saved approvals; every read and every file edit (edit/write/patch, any path, including .env, home dotfiles, temp dirs, external folders, and OpenCode config) runs without review; critical-path rm goes to the classifier even when an allow rule matches; shell has no read-only or help fast path, so shell without an allow rule, subagent delegation, web fetches, and MCP tools are classified; the classifier sees a reasoning-blind JSONL transcript and never tool results; permission_auto in the project's own config is ignored; rule labels and must-name clauses in permission/auto-rules.ts stay stable; classifier failures surface their reason and deny without counting toward the 3/20 denial limits.
   - Raycast integration is ours (fork context cluster 6). Preserve the chat endpoint, route-scoped bearer authentication, active Go credential lookup, session attribution, maximum-effort thinking, and unbuffered SSE. Keep generate.raycast omitted from generated SDK adapters. Regenerate clients after protocol changes; retain ConfigModel type references in the SDK generator.
   - After resolving an upstream-wide rename, search the whole repo for other uses of the old form; files that never conflicted can still reference it.
3. Stage the resolved files with 'git add <files>'.
4. Continue the rebase by running 'GIT_EDITOR=true git rebase --continue' inside '$REPO_DIR'.
   IMPORTANT: run exactly ONE shell command per tool call (never chain with ';' or '&&': separate 'git add', 'git status', and 'git rebase --continue' into individual calls), so each action is classified and approved on its own.
5. If subsequent commits also conflict, repeat this process until the rebase finishes completely (no rebase in progress).
6. Run the focused permission and Raycast tests listed in the fork context, then run 'bun run check' from '$REPO_DIR'. The pre-push hook runs this full lint and typecheck gate; per-package checks alone are insufficient.
Do NOT run 'git rebase --abort' unless the changes are fundamentally unresolvable."

  if ! run_agent "$RESOLVE_PROMPT" || rebase_in_progress; then
    fail_run "oc3 was unable to resolve the rebase conflicts."
  fi
  rm -f "$LAST_FAIL_SHA"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] oc3 successfully resolved all conflicts and completed the rebase."
fi

echo "==> Installing workspace dependencies (darwin-arm64 only)..."
bun install --cwd "$REPO_DIR" --os=darwin --cpu=arm64

ATTEMPT=0
while :; do
  ATTEMPT=$((ATTEMPT + 1))
  FAILED_STEP=""
  FAILED_WORKDIR="$REPO_DIR"

  echo "==> Verifying auto mode permission tests (attempt $ATTEMPT/$MAX_FIX_ATTEMPTS)..."
  if ! (cd "$REPO_DIR/packages/core" && bun test test/permission-auto.test.ts test/permission.test.ts test/permission-auto-service.test.ts) 2>&1 | tee "$VERIFY_LOG"; then
    FAILED_STEP="bun test test/permission-auto.test.ts test/permission.test.ts test/permission-auto-service.test.ts"
    FAILED_WORKDIR="$REPO_DIR/packages/core"
  elif ! (cd "$REPO_DIR/packages/server" && bun test test/raycast-chat.test.ts test/auth.test.ts test/generate.test.ts) 2>&1 | tee "$VERIFY_LOG"; then
    FAILED_STEP="bun test test/raycast-chat.test.ts test/auth.test.ts test/generate.test.ts"
    FAILED_WORKDIR="$REPO_DIR/packages/server"
  else
    echo "==> Checking the workspace (attempt $ATTEMPT/$MAX_FIX_ATTEMPTS)..."
    if ! (cd "$REPO_DIR" && bun run check) 2>&1 | tee "$VERIFY_LOG"; then
      FAILED_STEP="bun run check"
    else
      echo "==> Building the native OpenCode 3 binary (attempt $ATTEMPT/$MAX_FIX_ATTEMPTS)..."
      if ! (cd "$REPO_DIR" && OPENCODE_CHANNEL=latest OPENCODE_CLI_NAME=opencode bun run --cwd packages/cli build --single --skip-web-ui --skip-install) 2>&1 | tee "$VERIFY_LOG"; then
        FAILED_STEP="bun run --cwd packages/cli build --single --skip-web-ui --skip-install"
      fi
    fi
  fi

  if [ -z "$FAILED_STEP" ]; then
    break
  fi

  if [ "$ATTEMPT" -ge "$MAX_FIX_ATTEMPTS" ]; then
    fail_run "'$FAILED_STEP' still failing after $MAX_FIX_ATTEMPTS attempts; giving up. Full output: $VERIFY_LOG"
  fi

  # Cheap first: a purge + rerun clears phantom incremental-build errors without spending agent turns.
  if [ "$ATTEMPT" -eq 1 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] '$FAILED_STEP' failed; purging build caches and retrying before invoking oc3..."
    purge_stale_build_cache
    continue
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] '$FAILED_STEP' still failing after a clean cache. Invoking oc3 ($OC3_MODEL) to fix..."

  FIX_PROMPT="In the repository directory '$REPO_DIR' (branch 'v2-dev', freshly rebased onto 'upstream/$UPSTREAM_BRANCH'), the command '$FAILED_STEP' is failing in working directory '$FAILED_WORKDIR'. Caches were already purged and it was retried, so this is a real failure, not stale incremental state.

Here is the tail of the output:
---
$(tail -n 150 "$VERIFY_LOG")
---

Fix it:
1. Read the errors and open the offending files to understand the actual cause.
2. If a file is byte-identical to upstream ('git diff upstream/$UPSTREAM_BRANCH...HEAD -- <file>' is empty), the breakage is not ours: prefer a minimal, local fix over rewriting upstream code, and never revert one of our features to make it pass.
3. Otherwise the breakage is in our rebased custom code: keep its behaviour and adapt it to upstream's current interfaces, imports, and architecture.
   Session /goal is ours (fork context cluster 4): if typecheck/build fails in goal.ts, goal-continuation.ts, the goal tools, TUI goal.ts / goal-actions / footer, prompt parse completeSlashCommand, or prompt autocomplete/submit, fix those files — do not delete the feature, drop the visible /goal user prompt or live footer timer, or store goals in instruction entries.
   Raycast integration is ours (fork context cluster 6): preserve the daemon route, scoped token, active Go credentials, routing headers, forced max reasoning, SSE streaming and SDK omission. Do not add another background process.
   Reviewed auto mode is ours (fork context cluster 1): if typecheck/build fails in permission/auto.ts, permission/auto-rules.ts, permission/state.ts, permission.ts, the permission_auto config schema, the permission protocol/server handlers, the auto-mode CLI subcommands, or the TUI permission surfaces, fix those files — do not delete the classifier or weaken the hardening invariants (configured deny precedence over saved approvals, reads and file edits always allowed, critical-rm classification, no shell read-only/help fast path, subagent/web-fetch/MCP classification, reasoning-blind transcript, stable rule labels in auto-rules.ts, fail-closed failure detail).
4. Re-run '$FAILED_STEP' from '$FAILED_WORKDIR' and iterate until it passes cleanly.
5. Run the focused permission and Raycast tests from their package directories, then 'bun run check' from '$REPO_DIR'. The pre-push hook runs the full lint and typecheck gate. Regenerate clients with 'bun run generate' from packages/client after protocol/HttpApi changes; do not edit generated files manually.
6. Commit your fixes with 'git add <files>' then 'git commit -m \"fix: <what you fixed>\"'. Uncommitted work will not be pushed.
   IMPORTANT: run exactly ONE shell command per tool call (never chain with ';' or '&&'), so each action is classified and approved on its own.
Do NOT run 'git reset --hard', 'git rebase', or 'git push'."

  if ! run_agent "$FIX_PROMPT"; then
    fail_run "oc3 exited nonzero while fixing '$FAILED_STEP'."
  fi
done

ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  BIN_PATH="$REPO_DIR/packages/cli/dist/cli-darwin-arm64/bin/opencode"
else
  BIN_PATH="$REPO_DIR/packages/cli/dist/cli-darwin-x64/bin/opencode"
fi

test -x "$BIN_PATH"
ln -sf "$BIN_PATH" "/Users/nithin/.local/bin/opencode3"
git -C "$REPO_DIR" push origin v2-dev --force-with-lease

echo "==> Restarting the shared OpenCode service from the new build..."
/Users/nithin/.local/bin/opencode3 service restart

mkdir -p "$STATE_DIR"
date +%s >"$LAST_SYNC"
/bin/rm -f "$LAST_FAIL_SHA"
git -C "$REPO_DIR" rev-parse upstream/$UPSTREAM_BRANCH >"$LAST_BUILT" 2>/dev/null || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] OpenCode 3 automated sync and build completed successfully."
