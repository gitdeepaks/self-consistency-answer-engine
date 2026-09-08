#!/usr/bin/env bash
set -euo pipefail
: "${SCE_BASE_URL:?}" "${SCE_API_KEY:?}" "${ALLOW_PAID_LOAD:?}" "${SPEND_CAP_CONFIRMED:?}" "${TEST_ID:?}"
curl --fail --silent --show-error --max-time 15 "$SCE_BASE_URL/api/health" >/dev/null
ready=$(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' "$SCE_BASE_URL/api/ready")
if [[ "$ready" != 200 ]]; then
  # The shipped pre-Phase8 image lacks this route; only rollback may accept 404.
  [[ "$ready" == 404 && "${READINESS_ALLOW_LEGACY:-no}" == yes ]] || exit 1
fi
# The dependency probe covers DB/Redis. An uncached completed run also exercises
# auth, enqueue, workers and providers; image verification is separate.
PROFILE=steady MAX_RUNS=1 k6 run infra/load/runs.js
