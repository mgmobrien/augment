#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
VAULT_ROOT="${MATT_STACK_VAULT_ROOT:-/Users/mattobrien/Obsidian Main Vault/ObsidianVault}"
SLOT_SCRIPT="${VAULT_ROOT}/claude/hooks/obsidian-slot.sh"
DEFAULT_FIXTURE="${VAULT_ROOT}/claude/hooks/tests/fixtures/obsidian-slot/minimal-vault"
PLUGIN_ID="augment-terminal"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/claim-shared-slot.sh --slot <sNN> [--fixture <abs-dir>] [--owner <label>] [--obsidian-version <ver>] [--json]

Notes:
  - Stages the current Augment plugin build into a temporary bundle directory.
  - Calls the shared Matt Stack slot harness rather than using repo-local test-vault/test-config paths.
  - Keeps the older repo-local `setup-test.sh` + `start-test.sh --legacy` path intact for debugging.
USAGE
}

slot_id=""
fixture_path="$DEFAULT_FIXTURE"
owner="augment-plugin"
obsidian_version="latest"
json_output=false

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
    --json)
      json_output=true
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

[[ -n "$slot_id" ]] || {
  echo "Error: --slot is required" >&2
  usage >&2
  exit 1
}

[[ -f "$SLOT_SCRIPT" ]] || {
  echo "Error: shared slot harness not found at $SLOT_SCRIPT" >&2
  exit 1
}

for build_artifact in main.js manifest.json styles.css; do
  [[ -f "${REPO_DIR}/${build_artifact}" ]] || {
    echo "Error: ${build_artifact} not found in ${REPO_DIR}. Run the Augment build first." >&2
    exit 1
  }
done

[[ -d "$fixture_path" ]] || {
  echo "Error: fixture path does not exist: $fixture_path" >&2
  exit 1
}

bundle_dir="$(mktemp -d "${TMPDIR:-/tmp}/augment-shared-slot-bundle.XXXXXX")"
cleanup() {
  rm -rf "$bundle_dir"
}
trap cleanup EXIT

mkdir -p "${bundle_dir}/scripts"
cp "${REPO_DIR}/main.js" "${bundle_dir}/main.js"
cp "${REPO_DIR}/manifest.json" "${bundle_dir}/manifest.json"
cp "${REPO_DIR}/styles.css" "${bundle_dir}/styles.css"
cp -R "${REPO_DIR}/scripts/." "${bundle_dir}/scripts/"

cmd=(
  bash "$SLOT_SCRIPT" claim
  --slot "$slot_id"
  --fixture "$fixture_path"
  --plugin-id "$PLUGIN_ID"
  --plugin-bundle "$bundle_dir"
  --owner "$owner"
  --obsidian-version "$obsidian_version"
)

if [[ "$json_output" == true ]]; then
  cmd+=(--json)
fi

"${cmd[@]}"
