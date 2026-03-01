#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
VAULT_PLUGIN_DIR="$HOME/Obsidian Main Vault/ObsidianVault/.obsidian/plugins/augment-terminal"

# Check build exists
if [ ! -f "$PLUGIN_DIR/main.js" ]; then
    echo "Error: main.js not found. Run 'npm run build' first."
    exit 1
fi

# Create plugin dir
mkdir -p "$VAULT_PLUGIN_DIR"
mkdir -p "$VAULT_PLUGIN_DIR/scripts"

# Copy files
cp "$PLUGIN_DIR/main.js" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_DIR/manifest.json" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_DIR/styles.css" "$VAULT_PLUGIN_DIR/"
cp "$PLUGIN_DIR/scripts/terminal_pty.py" "$VAULT_PLUGIN_DIR/scripts/"

echo "Deployed to $VAULT_PLUGIN_DIR"
echo "Reload Obsidian or the plugin to pick up changes."
