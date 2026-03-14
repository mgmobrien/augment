#!/bin/bash
#
# Set up the legacy isolated test vault for Augment visual testing.
#
# Creates:
#   test-vault/   — minimal vault with augment-terminal plugin installed
#   test-config/  — Obsidian user-data-dir pointing to test-vault
#
# The plugin files (main.js, manifest.json, styles.css) are copied from
# the current build output. Run `npm run build` first if they're stale.
#
# Usage:
#   ./scripts/setup-test.sh            # Set up (or refresh) test environment
#   ./scripts/setup-test.sh --clean    # Force full rebuild of vault + config
#
# After setup, launch Obsidian:
#   ./scripts/start-test.sh --legacy

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

VAULT_DIR="$REPO_DIR/test-vault"
CONFIG_DIR="$REPO_DIR/test-config"
PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/augment-terminal"
PLUGIN_ID="augment-terminal"

CLEAN=false
for arg in "$@"; do
  case $arg in
    --clean) CLEAN=true ;;
    --help|-h)
      head -20 "$0" | tail -18
      exit 0
      ;;
  esac
done

# Verify build artifacts exist
for f in main.js manifest.json styles.css; do
  if [ ! -f "$REPO_DIR/$f" ]; then
    echo "Error: $f not found. Run 'npm run build' first."
    exit 1
  fi
done

if [ "$CLEAN" = true ]; then
  echo "Removing existing test-vault and test-config..."
  rm -rf "$VAULT_DIR" "$CONFIG_DIR"
fi

echo "=== Augment test setup ==="

# ── Vault structure ────────────────────────────────────────────
mkdir -p "$PLUGIN_DIR"

# Copy built plugin files
echo "Copying plugin build..."
cp "$REPO_DIR/main.js"      "$PLUGIN_DIR/main.js"
cp "$REPO_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"
cp "$REPO_DIR/styles.css"   "$PLUGIN_DIR/styles.css"
mkdir -p "$PLUGIN_DIR/scripts"
cp -R "$REPO_DIR/scripts/." "$PLUGIN_DIR/scripts/"

# Enable plugin (community-plugins.json)
echo "[\"$PLUGIN_ID\"]" > "$VAULT_DIR/.obsidian/community-plugins.json"

# Minimal app.json (suppress safe mode warning, disable auto-updates)
cat > "$VAULT_DIR/.obsidian/app.json" << 'EOF'
{
  "livePreview": true
}
EOF

# Minimal plugins config (allows plugin to load without safe mode prompt)
cat > "$VAULT_DIR/.obsidian/core-plugins.json" << 'EOF'
[]
EOF

# ── Obsidian config dir ────────────────────────────────────────
mkdir -p "$CONFIG_DIR"

# obsidian.json registers the vault and marks it open.
# The "open":true flag tells Obsidian to open this vault on launch.
VAULT_PATH_ESCAPED=$(echo "$VAULT_DIR" | sed 's/"/\\"/g')
cat > "$CONFIG_DIR/obsidian.json" << EOF
{
  "vaults": {
    "augment-test": {
      "path": "$VAULT_PATH_ESCAPED",
      "ts": $(date +%s)000,
      "open": true
    }
  },
  "updateDisabled": true
}
EOF

echo ""
echo "Test environment ready."
echo "  Vault:   $VAULT_DIR"
echo "  Config:  $CONFIG_DIR"
echo "  Plugin:  augment-terminal $(grep '"version"' "$PLUGIN_DIR/manifest.json" | cut -d'"' -f4)"
echo ""
echo "Next: ./scripts/start-test.sh --legacy"
