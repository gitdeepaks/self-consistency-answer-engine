#!/usr/bin/env bash
set -euo pipefail
: "${FLY_APP:?}" "${FLY_CONFIG:?}" "${NEW_IMAGE:?}" "${EVIDENCE_DIR:?}"
[[ "$NEW_IMAGE" =~ ^registry\.fly\.io/$FLY_APP@sha256:[a-f0-9]{64}$ ]]
[[ -d "$EVIDENCE_DIR" ]]

# Ignore release-command machines; refuse an already mixed/ambiguous fleet.
fleet() {
  flyctl machines list --app "$FLY_APP" --json | jq '[.[] |
    select(.config.metadata.fly_process_group == "api" or .config.metadata.fly_process_group == "worker") |
    {id, state, group: .config.metadata.fly_process_group, image: .config.image, digest: .image_ref.digest}]'
}
verify_image() {
  local expected="$1" attempt
  for attempt in {1..12}; do
    if fleet | jq -e --arg digest "${expected##*@}" '
      length >= 2 and (map(.group) | unique | sort) == ["api", "worker"] and
      all(.[]; .digest == $digest and (.state == "started" or (.group == "api" and .state == "suspended")))' >/dev/null; then
      return 0
    fi
    sleep 10
  done
  return 1
}
fleet > "$EVIDENCE_DIR/before.json"
jq -e 'length >= 2 and (map(.group) | unique | sort) == ["api", "worker"] and
  (map(.digest) | unique | length) == 1 and all(.[]; .digest | test("^sha256:[a-f0-9]{64}$"))' "$EVIDENCE_DIR/before.json" >/dev/null
OLD_IMAGE="registry.fly.io/$FLY_APP@$(jq -r '.[0].digest' "$EVIDENCE_DIR/before.json")"
printf '%s\n' "$OLD_IMAGE" > "$EVIDENCE_DIR/old-image.txt"
printf '%s\n' "$NEW_IMAGE" > "$EVIDENCE_DIR/new-image.txt"
# The trap is armed BEFORE deploy, including partial rolling-deploy failures.
attempted=0
rollback() {
  local result=$?
  trap - EXIT INT TERM
  if (( attempted && result != 0 )); then
    printf '%s\n' 'Deployment failed; restoring previous immutable image.' >&2
    if flyctl deploy --app "$FLY_APP" --config "$FLY_CONFIG" --image "$OLD_IMAGE" --skip-release-command --yes &&
       verify_image "$OLD_IMAGE" && READINESS_ALLOW_LEGACY=yes TEST_ID="${TEST_ID}-rollback" bash infra/ops/smoke.sh; then
      printf '%s\n' verified > "$EVIDENCE_DIR/rollback-result.txt"
    else
      printf '%s\n' 'FAILED: operator intervention required' > "$EVIDENCE_DIR/rollback-result.txt"
    fi
  fi
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
attempted=1
flyctl deploy --app "$FLY_APP" --config "$FLY_CONFIG" --image "$NEW_IMAGE" --yes
verify_image "$NEW_IMAGE"
bash infra/ops/smoke.sh
fleet > "$EVIDENCE_DIR/after.json"
