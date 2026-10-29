#!/usr/bin/env bash
# `make isolation-live` (MS-02): main's stack (project program-capacity) and this branch's stack
# (project program-capacity-ms) must be healthy at the same time. Read-only: it starts and stops
# nothing. Exit code 1 when either project is missing a healthy service.
set -uo pipefail
cd "$(dirname "$0")/.."

api_ms="http://localhost:${HOST_PORT_API:-13000}"
ops_ms="http://localhost:${HOST_PORT_API_OPS:-19464}"
# main's ports are the branch's minus 10000 (ADR 027); the numbers are never written down here.
api_main="http://localhost:$((${HOST_PORT_API:-13000} - 10000))"
ops_main="http://localhost:$((${HOST_PORT_API_OPS:-19464} - 10000))"
failed=0

report() { # label project
  local ps
  ps=$(docker compose -p "$2" ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)
  echo "== $1 (docker compose -p $2 ps) =="
  echo "$ps"
  if [[ -z "$ps" ]]; then echo "no containers"; failed=1; return; fi
  # one-shot services (migrate, kafka-init) exit 0; everything else must run and not be unhealthy
  while read -r service state health; do
    case "$service" in migrate | kafka-init) continue ;; esac
    if [[ "$state" != running || "$health" == unhealthy || "$health" == starting ]]; then
      echo "NOT HEALTHY: $service ($state $health)"
      failed=1
    fi
  done <<<"$ps"
}

report "main" program-capacity
report "branch" program-capacity-ms

for entry in "main:$ops_main" "branch:$ops_ms"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${entry#*:}/health/ready")
  echo "${entry%%:*} readiness ${entry#*:}/health/ready -> $code"
  [[ "$code" == 200 ]] || failed=1
done
echo "branch API ${api_ms}, main API ${api_main}"

if ((failed)); then
  echo "isolation-live: FAILED"
  exit 1
fi
echo "isolation-live: both stacks healthy together"
