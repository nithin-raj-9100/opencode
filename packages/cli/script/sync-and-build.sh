#!/bin/bash
set -euo pipefail

# Determine repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting OpenCode V2 automated sync & build..."

# Check git status for uncommitted changes
STASHED=0
if [ -n "$(git status --porcelain)" ]; then
  echo "==> Stashing uncommitted local changes..."
  git stash push -m "opencode3-auto-sync-stash-$(date +%s)"
  STASHED=1
fi

echo "==> Fetching upstream v2 from sst/opencode..."
git fetch upstream v2

echo "==> Rebasing local custom commits on top of upstream/v2..."
git rebase upstream/v2

echo "==> Installing workspace dependencies..."
bun install

echo "==> Compiling native OpenCode 2 binary..."
OPENCODE_CLI_NAME=opencode bun run --cwd "$REPO_DIR/packages/cli" build --single --skip-web-ui

# Detect architecture and link binary
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BIN_PATH="$REPO_DIR/packages/cli/dist/cli-darwin-arm64/bin/opencode"
else
  BIN_PATH="$REPO_DIR/packages/cli/dist/cli-darwin-x64/bin/opencode"
fi

if [ -f "$BIN_PATH" ]; then
  ln -sf "$BIN_PATH" "$HOME/.local/bin/opencode3"
  echo "==> Updated symlink: $HOME/.local/bin/opencode3 -> $BIN_PATH"
else
  echo "Warning: Binary not found at $BIN_PATH" >&2
fi

# Restore stash if we stashed earlier
if [ "$STASHED" -eq 1 ]; then
  echo "==> Restoring uncommitted local changes..."
  git stash pop || true
fi

echo "==> Backing up custom build to personal GitHub fork (origin)..."
git push origin v2-dev --force-with-lease || echo "Warning: push to origin failed"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Automated V2 sync and build completed successfully!"
