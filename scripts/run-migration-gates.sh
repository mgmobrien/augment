#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

dry_run=false

declare -a AUGMENT_MIGRATION_GATE_STEPS=(
  $'shared-domain messaging documents\tnode\tscripts/check-shared-domain-messaging-documents.mjs'
  $'shared-domain messaging projections\tnode\tscripts/check-shared-domain-messaging-projections.mjs'
  $'shared-domain boundary\tnode\tscripts/check-shared-domain-boundary.mjs'
  $'inbox-bus adapter\tnode\tscripts/check-inbox-bus-adapter.mjs'
  $'shared-domain runtime contracts\tnode\tscripts/check-shared-domain-runtime-contracts.mjs'
  $'shared-domain team-launch contracts\tnode\tscripts/check-shared-domain-team-launch-contracts.mjs'
  $'shared-domain team-roster parser\tnode\tscripts/check-shared-domain-team-roster-parser.mjs'
  $'runtime-owner singleton bootstrap\tnode\tscripts/check-runtime-owner-singleton-bootstrap.mjs'
  $'plugin build continuity\tnpm\trun\tbuild'
)

usage() {
  local index=1
  local spec=""
  local -a fields=()

  cat <<'EOF'
Usage:
  ./scripts/run-migration-gates.sh [--dry-run]

Runs the first bounded Augment migration gate set:
EOF

  for spec in "${AUGMENT_MIGRATION_GATE_STEPS[@]}"; do
    IFS=$'\t' read -r -a fields <<< "$spec"
    printf '  %s. %s\n' "$index" "${fields[0]}"
    index=$((index + 1))
  done
}

render_cmd() {
  local rendered=""
  local arg=""

  for arg in "$@"; do
    if [[ -z "$rendered" ]]; then
      printf -v rendered '%q' "$arg"
    else
      printf -v rendered '%s %q' "$rendered" "$arg"
    fi
  done

  printf '%s\n' "$rendered"
}

print_declared_migration_gate_steps() {
  local spec=""
  local -a fields=()
  local rendered=""

  for spec in "${AUGMENT_MIGRATION_GATE_STEPS[@]}"; do
    IFS=$'\t' read -r -a fields <<< "$spec"
    rendered="$(render_cmd "${fields[@]:1}")"
    printf '%s\t%s\n' "${fields[0]}" "$rendered"
  done
}

run_declared_steps() {
  local total="${#AUGMENT_MIGRATION_GATE_STEPS[@]}"
  local index=1
  local spec=""
  local -a fields=()

  for spec in "${AUGMENT_MIGRATION_GATE_STEPS[@]}"; do
    IFS=$'\t' read -r -a fields <<< "$spec"

    printf '[%s/%s] %s\n' "$index" "$total" "${fields[0]}"
    if [[ "$dry_run" == true ]]; then
      printf '  %s\n' "$(render_cmd "${fields[@]:1}")"
    else
      (
        cd "$REPO_DIR"
        "${fields[@]:1}"
      )
    fi

    index=$((index + 1))
  done
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        dry_run=true
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

  run_declared_steps

  if [[ "$dry_run" == true ]]; then
    echo "Augment migration gates dry-run complete."
  else
    echo "Augment migration gates passed."
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
