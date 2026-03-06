#!/bin/bash
#
# Launch Obsidian with CDP enabled for Augment visual testing.
#
# Uses --remote-debugging-port so Playwright can connect via CDP.
#
# macOS note: `open -n -a Obsidian` is required (not just `open -a`).
# The -n flag forces a new app instance. Without it, macOS collapses
# the launch into the existing Obsidian process and the CDP port
# won't bind. This means a second Obsidian instance will appear in
# the dock while tests run — that's expected.
#
# Usage:
#   ./scripts/start-test.sh          # Port 9223 (default)
#   ./scripts/start-test.sh 9224     # Custom port
#
# Prerequisites:
#   ./scripts/setup-test.sh          # Run once (or after each build)
#
# Stop when done:
#   pkill -f "remote-debugging-port=9223"

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${1:-9223}"
CONFIG_DIR="$REPO_DIR/test-config"
VAULT_DIR="$REPO_DIR/test-vault"

# Sanity checks
if [ ! -f "$CONFIG_DIR/obsidian.json" ]; then
  echo "Error: test-config not found. Run ./scripts/setup-test.sh first."
  exit 1
fi

if lsof -i ":$PORT" >/dev/null 2>&1; then
  echo "Error: Port $PORT is already in use."
  echo "  Stop existing instance: pkill -f \"remote-debugging-port=$PORT\""
  exit 1
fi

echo "Starting Obsidian..."
echo "  Vault:     $VAULT_DIR"
echo "  Config:    $CONFIG_DIR"
echo "  CDP port:  $PORT"

OS="$(uname)"
case "$OS" in
  Darwin)
    open -n -a Obsidian --args \
      --user-data-dir="$CONFIG_DIR" \
      --remote-debugging-port="$PORT"
    ;;
  Linux)
    OBSIDIAN="${OBSIDIAN_PATH:-obsidian}"
    if ! command -v "$OBSIDIAN" >/dev/null 2>&1; then
      echo "Error: Obsidian binary not found."
      echo "  Set OBSIDIAN_PATH to your Obsidian binary or AppImage."
      exit 1
    fi
    "$OBSIDIAN" \
      --user-data-dir="$CONFIG_DIR" \
      --remote-debugging-port="$PORT" &
    ;;
  *)
    echo "Error: Unsupported platform: $OS"
    exit 1
    ;;
esac

# Poll until CDP is ready
echo -n "Waiting for CDP..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo " ready."
    echo ""
    echo "Obsidian is running. Connect Playwright to http://localhost:$PORT"
    echo "Run tests:  node playwright/tests/smoke.mjs"
    echo "Stop:       pkill -f \"remote-debugging-port=$PORT\""
    exit 0
  fi
  sleep 0.5
  echo -n "."
done

echo ""
echo "Error: Timed out waiting for CDP on port $PORT."
echo "  Check that Obsidian launched successfully."
exit 1
