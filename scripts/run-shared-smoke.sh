#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PLAYWRIGHT_DIR="${REPO_DIR}/playwright"
SLOT_OWNER_SCRIPT="${SCRIPT_DIR}/slot-owner-adapter.mjs"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/run-shared-smoke.sh <smoke|team-launch|background-completion> [--slot <sNN>] [--fixture <abs-dir>] [--owner <label>] [--obsidian-version <ver>] [--keep-open]

Notes:
  - Claims a shared Obsidian slot through the Matt Stack harness.
  - Runs the selected Playwright smoke against that slot's CDP port.
  - Stops the slot on exit unless --keep-open is set.
USAGE
}

mode="${1:-}"
case "$mode" in
  smoke|team-launch|background-completion)
    shift
    ;;
  --help|-h|"")
    usage
    exit 0
    ;;
  *)
    echo "Error: unknown mode: $mode" >&2
    usage >&2
    exit 1
    ;;
esac

slot_id="s01"
fixture_path=""
owner="augment-plugin-${mode}"
obsidian_version="latest"
keep_open=false

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --keep-open)
      keep_open=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

[[ -f "$SLOT_OWNER_SCRIPT" ]] || {
  echo "Error: slot-owner adapter not found at $SLOT_OWNER_SCRIPT" >&2
  exit 1
}

cleanup() {
  if [[ "$keep_open" == false ]]; then
    node "$SLOT_OWNER_SCRIPT" stopSlot --slot "$slot_id" --caller "$owner" --request-id "run-shared-smoke-stop-${slot_id}-$$-$(date +%s)" --json >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

claim_cmd=(
  node "$SLOT_OWNER_SCRIPT"
  claimSlot
  --slot "$slot_id"
  --caller "$owner"
  --obsidian-version "$obsidian_version"
  --request-id "run-shared-smoke-claim-${slot_id}-$$-$(date +%s)"
  --json
)

if [[ -n "$fixture_path" ]]; then
  claim_cmd+=(--fixture "$fixture_path")
fi

claim_json="$("${claim_cmd[@]}")"
cdp_port="$(CLAIM_JSON="$claim_json" node -e 'const data = JSON.parse(process.env.CLAIM_JSON || "{}"); const state = data.stateAfter ?? {}; if (data.outcome !== "ok" || !Number.isFinite(state.debugPort)) process.exit(1); process.stdout.write(String(state.debugPort));')"

export AUGMENT_CDP_PORT="$cdp_port"

case "$mode" in
  smoke)
    (cd "$PLAYWRIGHT_DIR" && node tests/smoke.mjs)
    ;;
  team-launch)
    (cd "$PLAYWRIGHT_DIR" && node tests/team-launch-smoke.mjs)
    ;;
  background-completion)
    (cd "$PLAYWRIGHT_DIR" && node tests/background-completion-smoke.mjs)
    ;;
esac
