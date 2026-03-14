#!/bin/bash
#
# Launch Obsidian with CDP enabled for Augment visual testing.
#
# Shared mode claims a Matt Stack slot and is now the default caller surface
# for Playwright. Legacy mode still launches the repo-local test-vault/test-config
# pair directly for debugging.
#
# Usage:
#   ./scripts/start-test.sh [--slot s01]
#   ./scripts/start-test.sh --legacy [9223]
#
# Prerequisites for legacy mode:
#   ./scripts/setup-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PLAYWRIGHT_DIR="${REPO_DIR}/playwright"
SLOT_OWNER_SCRIPT="${SCRIPT_DIR}/slot-owner-adapter.mjs"
CONFIG_DIR="$REPO_DIR/test-config"
VAULT_DIR="$REPO_DIR/test-vault"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/start-test.sh [--slot <sNN>] [--fixture <abs-dir>] [--owner <label>] [--obsidian-version <ver>]
  ./scripts/start-test.sh [9223-9248]
  ./scripts/start-test.sh --legacy [9223]

Notes:
  - Shared mode is the default and claims an isolated Matt Stack slot for manual Playwright work.
  - Legacy mode preserves the older repo-local test-vault/test-config launcher.
  - `playwright npm run start` now uses shared mode with slot s01 by default.
USAGE
}

shared_slot_from_port() {
  local port="${1:-}"
  local slot_number=0

  [[ "$port" =~ ^[0-9]+$ ]] || {
    echo "Error: invalid shared port: $port" >&2
    exit 1
  }

  slot_number="$((port - 9222))"
  if (( slot_number < 1 || slot_number > 26 )); then
    echo "Error: shared mode only supports ports 9223-9248 (slot-derived)." >&2
    exit 1
  fi

  printf 's%02d\n' "$slot_number"
}

run_shared() {
  local slot_id="$1"
  local fixture_path="$2"
  local owner="$3"
  local obsidian_version="$4"
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
    --caller "$owner"
    --obsidian-version "$obsidian_version"
    --request-id "start-test-claim-${slot_id}-$$-$(date +%s)"
    --json
  )

  [[ -f "$SLOT_OWNER_SCRIPT" ]] || {
    echo "Error: slot-owner adapter not found at $SLOT_OWNER_SCRIPT" >&2
    exit 1
  }

  if [[ -n "$fixture_path" ]]; then
    claim_cmd+=(--fixture "$fixture_path")
  fi

  claim_json="$("${claim_cmd[@]}")"

  claim_record="$(CLAIM_JSON="$claim_json" node - <<'NODE'
let data;
try {
  data = JSON.parse(process.env.CLAIM_JSON || "{}");
} catch (error) {
  console.error("Error: failed to parse slot claim JSON.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (data.outcome !== "ok") {
  console.error("Error: slot claim outcome was " + (data.outcome || "unknown") + ".");
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

  [[ -n "$claimed_slot_id" && -n "$claimed_port" ]] || {
    echo "Error: shared slot claim did not return slot_id/port." >&2
    exit 1
  }

  echo "Starting Obsidian through the shared slot harness..."
  echo "  Slot:      $claimed_slot_id"
  echo "  Vault:     $claimed_vault_dir"
  echo "  Config:    $claimed_config_dir"
  echo "  CDP port:  $claimed_port"
  echo ""
  echo "Obsidian is running. Connect Playwright to http://localhost:$claimed_port"
  echo "Run tests:  cd \"$PLAYWRIGHT_DIR\" && AUGMENT_CDP_PORT=$claimed_port node tests/smoke.mjs"
  echo "Stop:       node \"$SLOT_OWNER_SCRIPT\" stopSlot --slot \"$claimed_slot_id\" --caller \"$owner\" --json"
}

run_legacy() {
  local port="$1"
  local os=""

  if [[ ! -f "$CONFIG_DIR/obsidian.json" ]]; then
    echo "Error: test-config not found. Run ./scripts/setup-test.sh first." >&2
    exit 1
  fi

  if lsof -i ":$port" >/dev/null 2>&1; then
    echo "Error: Port $port is already in use." >&2
    echo "  Stop existing instance: pkill -f \"remote-debugging-port=$port\"" >&2
    exit 1
  fi

  echo "Starting Obsidian through the legacy local test harness..."
  echo "  Vault:     $VAULT_DIR"
  echo "  Config:    $CONFIG_DIR"
  echo "  CDP port:  $port"

  os="$(uname)"
  case "$os" in
    Darwin)
      open -n -a Obsidian --args \
        --user-data-dir="$CONFIG_DIR" \
        --remote-debugging-port="$port"
      ;;
    Linux)
      OBSIDIAN="${OBSIDIAN_PATH:-obsidian}"
      if ! command -v "$OBSIDIAN" >/dev/null 2>&1; then
        echo "Error: Obsidian binary not found." >&2
        echo "  Set OBSIDIAN_PATH to your Obsidian binary or AppImage." >&2
        exit 1
      fi
      "$OBSIDIAN" \
        --user-data-dir="$CONFIG_DIR" \
        --remote-debugging-port="$port" &
      ;;
    *)
      echo "Error: Unsupported platform: $os" >&2
      exit 1
      ;;
  esac

  echo -n "Waiting for CDP..."
  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:$port/json/version" >/dev/null 2>&1; then
      echo " ready."
      echo ""
      echo "Obsidian is running. Connect Playwright to http://localhost:$port"
      echo "Run tests:  node playwright/tests/smoke.mjs"
      echo "Stop:       pkill -f \"remote-debugging-port=$port\""
      exit 0
    fi
    sleep 0.5
    echo -n "."
  done

  echo ""
  echo "Error: Timed out waiting for CDP on port $port." >&2
  echo "  Check that Obsidian launched successfully." >&2
  exit 1
}

mode=""
slot_id="s01"
fixture_path=""
owner="augment-plugin-start"
obsidian_version="latest"
legacy_port="9223"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shared)
      [[ "$mode" != "legacy" ]] || {
        echo "Error: choose either --shared or --legacy" >&2
        exit 1
      }
      mode="shared"
      shift
      ;;
    --legacy)
      [[ "$mode" != "shared" ]] || {
        echo "Error: choose either --shared or --legacy" >&2
        exit 1
      }
      mode="legacy"
      shift
      ;;
    --slot)
      slot_id="${2:-}"
      shift 2
      ;;
    --fixture)
      fixture_path="${2:-}"
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
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        if [[ "$mode" == "legacy" ]]; then
          mode="${mode:-legacy}"
          legacy_port="$1"
        else
          mode="${mode:-shared}"
          slot_id="$(shared_slot_from_port "$1")"
        fi
        shift
      else
        echo "Error: unknown option: $1" >&2
        usage >&2
        exit 1
      fi
      ;;
  esac
done

mode="${mode:-shared}"

case "$mode" in
  shared)
    run_shared "$slot_id" "$fixture_path" "$owner" "$obsidian_version"
    ;;
  legacy)
    run_legacy "$legacy_port"
    ;;
esac
