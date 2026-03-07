#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

# Resolve vault path — checked in order:
#   1. VAULT_PATH env var
#   2. .vault-path file at repo root (gitignored, set once per developer)
#   3. Hardcoded default (Matt's local vault)
if [ -n "${VAULT_PATH:-}" ]; then
  VAULT_BASE="$VAULT_PATH"
elif [ -f "$PLUGIN_DIR/.vault-path" ]; then
  VAULT_BASE="$(cat "$PLUGIN_DIR/.vault-path" | tr -d '[:space:]')"
else
  VAULT_BASE="$HOME/Obsidian Main Vault/ObsidianVault"
fi

VAULT_PLUGIN_DIR="$VAULT_BASE/.obsidian/plugins/augment-terminal"

# Check build exists
if [ ! -f "$PLUGIN_DIR/main.js" ]; then
    echo "Error: main.js not found. Run 'npm run build' first."
    exit 1
fi

# Enforce automated rename-sync regression guard before deploy.
echo "Running rename-sync smoke check..."
(cd "$PLUGIN_DIR" && npm run test:rename-sync)

# Create plugin dir
mkdir -p "$VAULT_PLUGIN_DIR"

# Copy files
cp "$PLUGIN_DIR/main.js" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_DIR/manifest.json" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_DIR/styles.css" "$VAULT_PLUGIN_DIR/"

echo "Deployed to $VAULT_PLUGIN_DIR"
echo "Reload Obsidian or the plugin to pick up changes."
