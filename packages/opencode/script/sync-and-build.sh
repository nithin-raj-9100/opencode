#!/usr/bin/env bash
set -e

REPO_DIR="/Users/nithin/Desktop/code/personal/opencode"
STATE_DIR="$HOME/.local/state/opencode3"
LAST_SYNC_FILE="$STATE_DIR/last_sync"
mkdir -p "$STATE_DIR"
mkdir -p "$HOME/.local/bin"

cd "$REPO_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting automated sync & build..."

STASHED=0
if [ -n "$(git status --porcelain)" ]; then
  echo "==> Stashing uncommitted local changes..."
  git stash push -m "opencode3-auto-sync-stash-$(date +%s)"
  STASHED=1
fi

echo "==> Fetching upstream dev from sst/opencode..."
git fetch upstream dev

echo "==> Rebasing local custom commits on top of upstream/dev..."
git rebase upstream/dev

echo "==> Installing workspace dependencies..."
bun install

echo "==> Compiling native standalone binary with shared database channel..."
OPENCODE_CHANNEL=latest bun run --cwd "$REPO_DIR/packages/opencode" build --single

# Detect architecture and link binary
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  BIN_PATH="$REPO_DIR/packages/opencode/dist/opencode-darwin-arm64/bin/opencode"
else
  BIN_PATH="$REPO_DIR/packages/opencode/dist/opencode-darwin-x64/bin/opencode"
fi

if [ -f "$BIN_PATH" ]; then
  ln -sf "$BIN_PATH" "$HOME/.local/bin/opencode3"
  echo "==> Updated symlink: $HOME/.local/bin/opencode3 -> $BIN_PATH"
else
  echo "Warning: Binary not found at $BIN_PATH" >&2
fi

echo "==> Backing up custom build to personal GitHub fork (origin)..."
git push origin dev --force-with-lease || true

if [ "$STASHED" -eq 1 ]; then
  echo "==> Restoring stashed changes..."
  git stash pop || true
fi

date +%s > "$LAST_SYNC_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Automated sync and build completed successfully!"
