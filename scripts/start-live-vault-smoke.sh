#!/bin/bash
#
# Launch a dedicated Obsidian instance on a real vault with CDP enabled.
#
# This uses a separate user-data-dir so the smoke can run against the real
# vault without attaching to Matt's everyday Obsidian config.
#
# Usage:
#   OBSIDIAN_VAULT_PATH="/path/to/vault" ./scripts/start-live-vault-smoke.sh
#   OBSIDIAN_VAULT_PATH="/path/to/vault" ./scripts/start-live-vault-smoke.sh 9224
#
# Then run:
#   AUGMENT_CDP_PORT=9224 OBSIDIAN_VAULT_PATH="/path/to/vault" npm run live-vault-bus

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SLOT_OWNER_SCRIPT="${SCRIPT_DIR}/slot-owner-adapter.mjs"
VAULT_DIR="${OBSIDIAN_VAULT_PATH:-${AUGMENT_VAULT_PATH:-}}"
PORT="${AUGMENT_CDP_PORT:-9224}"
mode="direct"
slot_id="s02"
owner="augment-plugin-live-vault"
obsidian_version="latest"

usage() {
  cat <<'USAGE'
Usage:
  OBSIDIAN_VAULT_PATH="/path/to/vault" ./scripts/start-live-vault-smoke.sh [9224]
  OBSIDIAN_VAULT_PATH="/path/to/vault" ./scripts/start-live-vault-smoke.sh --shared [--slot <sNN>] [--owner <label>] [--obsidian-version <ver>]

Notes:
  - Direct mode preserves the existing real-vault launcher on a dedicated CDP port.
  - Shared mode copies the source vault into one Matt Stack slot, then launches Obsidian through the shared harness.
  - Shared mode defaults to slot s02, which maps to CDP port 9224.
USAGE
}

run_shared() {
  local claim_json=""
  local claim_record=""
  local claimed_slot_id=""
  local claimed_port=""
  local claimed_vault_dir=""
  local claimed_config_dir=""
  local claim_cmd=(
    node "$SLOT_OWNER_SCRIPT"
    claimSlot
    --slot "$slot_id"
    --fixture "$VAULT_DIR"
    --caller "$owner"
    --obsidian-version "$obsidian_version"
    --request-id "start-live-vault-claim-${slot_id}-$$-$(date +%s)"
    --json
  )

  [[ -f "$SLOT_OWNER_SCRIPT" ]] || {
    echo "Error: slot-owner adapter not found at $SLOT_OWNER_SCRIPT" >&2
    exit 1
  }

  claim_json="$("${claim_cmd[@]}")"
  claim_record="$(CLAIM_JSON="$claim_json" node - <<'NODE'
const data = JSON.parse(process.env.CLAIM_JSON || "{}");
if (data.outcome !== "ok") {
  console.error(`Error: slot claim outcome was ${data.outcome || "unknown"}.`);
  process.exit(1);
}
const state = data.stateAfter ?? {};
process.stdout.write(
  [
    state.slotId ?? "",
    state.debugPort ?? "",
    state.vaultDir ?? "",
    state.configDir ?? "",
  ].join("\t")
);
NODE
  )"
  IFS=$'\t' read -r claimed_slot_id claimed_port claimed_vault_dir claimed_config_dir <<<"$claim_record"

  [[ -n "$claimed_slot_id" && -n "$claimed_port" && -n "$claimed_vault_dir" ]] || {
    echo "Error: shared slot claim did not return slot_id/port/vault_dir." >&2
    exit 1
  }

  echo "Starting Obsidian through the shared slot harness..."
  echo "  Source:    $VAULT_DIR"
  echo "  Slot:      $claimed_slot_id"
  echo "  Vault:     $claimed_vault_dir"
  echo "  Config:    $claimed_config_dir"
  echo "  CDP port:  $claimed_port"
  echo ""
  echo "Smoke instance is running on an isolated slot copy."
  echo "Run smoke:  AUGMENT_CLOSE_EXISTING_TERMINALS=1 AUGMENT_CDP_PORT=$claimed_port OBSIDIAN_VAULT_PATH=\"$claimed_vault_dir\" npm run live-vault-bus"
  echo "Stop:       node \"$SLOT_OWNER_SCRIPT\" stopSlot --slot \"$claimed_slot_id\" --caller \"$owner\" --json"
}

run_direct() {
  local port="$PORT"
  local config_dir="${AUGMENT_LIVE_CONFIG_DIR:-/tmp/augment-live-vault-smoke-${port}}"
  local vault_path_escaped=""
  local os=""

  if lsof -i ":$port" >/dev/null 2>&1; then
    echo "Error: port $port is already in use."
    echo "  Stop existing instance: pkill -f \"remote-debugging-port=$port\""
    exit 1
  fi

  mkdir -p "$config_dir"
  vault_path_escaped=$(printf '%s' "$VAULT_DIR" | sed 's/"/\\"/g')

  cat > "$config_dir/obsidian.json" <<EOF
{
  "vaults": {
    "augment-live-vault-smoke": {
      "path": "$vault_path_escaped",
      "ts": $(date +%s)000,
      "open": true
    }
  },
  "updateDisabled": true
}
EOF

  echo "Starting Obsidian..."
  echo "  Vault:     $VAULT_DIR"
  echo "  Config:    $config_dir"
  echo "  CDP port:  $port"

  os="$(uname)"
  case "$os" in
    Darwin)
      open -n -a Obsidian --args \
        --user-data-dir="$config_dir" \
        --remote-debugging-port="$port"
      ;;
    Linux)
      OBSIDIAN="${OBSIDIAN_PATH:-obsidian}"
      if ! command -v "$OBSIDIAN" >/dev/null 2>&1; then
        echo "Error: Obsidian binary not found."
        echo "  Set OBSIDIAN_PATH to your Obsidian binary or AppImage."
        exit 1
      fi
      "$OBSIDIAN" \
        --user-data-dir="$config_dir" \
        --remote-debugging-port="$port" &
      ;;
    *)
      echo "Error: unsupported platform: $os"
      exit 1
      ;;
  esac

  echo -n "Waiting for CDP..."
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:$port/json/version" >/dev/null 2>&1; then
      echo " ready."
      echo ""
      echo "Smoke instance is running."
      echo "Run smoke:  AUGMENT_CLOSE_EXISTING_TERMINALS=1 AUGMENT_CDP_PORT=$port OBSIDIAN_VAULT_PATH=\"$VAULT_DIR\" npm run live-vault-bus"
      echo "Stop:       pkill -f \"remote-debugging-port=$port\""
      exit 0
    fi
    sleep 0.5
    echo -n "."
  done

  echo ""
  echo "Error: timed out waiting for CDP on port $port."
  echo "  Check that Obsidian launched successfully."
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shared)
      mode="shared"
      shift
      ;;
    --slot)
      slot_id="${2:-}"
      shift 2
      ;;
    --owner)
      owner="${2:-}"
      shift 2
      ;;
    --obsidian-version)
      obsidian_version="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ && "$mode" == "direct" ]]; then
        PORT="$1"
        shift
      else
        echo "Error: unknown option: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$VAULT_DIR" ]]; then
  echo "Error: set OBSIDIAN_VAULT_PATH (or AUGMENT_VAULT_PATH) to the real vault path."
  exit 1
fi

if [[ ! -d "$VAULT_DIR" ]]; then
  echo "Error: vault path does not exist: $VAULT_DIR"
  exit 1
fi

case "$mode" in
  shared)
    run_shared
    ;;
  direct)
    run_direct
    ;;
esac
