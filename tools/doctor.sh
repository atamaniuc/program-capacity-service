#!/usr/bin/env bash
# `make doctor` (and the first step of `make install`): checks that this machine has what the
# project needs, and says how to fix what is missing. Exit code 1 if a hard requirement fails;
# warnings (busy ports, low Docker memory, no jq) never fail it.
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ -t 1 && -z "${NO_COLOR:-}" ]] || [[ -n "${FORCE_COLOR:-}" ]]; then
  G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' D=$'\033[2m' X=$'\033[0m'
else
  G='' Y='' R='' D='' X=''
fi
errors=0
ok() { printf '  %s✔%s %-16s %s\n' "$G" "$X" "$1" "$2"; }
warn() { printf '  %s!%s %-16s %s\n' "$Y" "$X" "$1" "$2"; }
fail() { printf '  %s✘%s %-16s %s\n' "$R" "$X" "$1" "$2"; errors=$((errors + 1)); }
# major.minor of the first version number in a string, as one comparable integer (24.1 -> 24001)
ver() { sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/' <<<"$1" | awk '{ print $1 * 1000 + $2 }'; }

echo "Requirements"

if ! command -v docker >/dev/null; then
  fail docker "not found — install Docker Desktop (macOS/Windows) or Docker Engine (Linux)"
elif ! docker info >/dev/null 2>&1; then
  fail docker "installed but the daemon is not running — start Docker Desktop / dockerd"
else
  ok docker "$(docker --version | sed 's/,.*//')"
  compose=$(docker compose version --short 2>/dev/null || true)
  if [[ -z "$compose" ]]; then
    fail "docker compose" "Compose v2 plugin not found (docker-compose v1 is not enough)"
  elif (($(ver "$compose") < 2020)); then
    fail "docker compose" "$compose is too old — need 2.20 or newer (for 'up --wait')"
  else
    ok "docker compose" "$compose"
  fi
  mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
  if ((mem > 0 && mem < 4 * 1024 * 1024 * 1024)); then
    warn "docker memory" "$((mem / 1024 / 1024)) MiB — give Docker at least 4 GiB, Kafka and the tests are hungry"
  else
    ok "docker memory" "$((mem / 1024 / 1024 / 1024)) GiB"
  fi
fi

if ! command -v node >/dev/null; then
  fail node "not found — install Node.js 24 (nvm install 24, or https://nodejs.org)"
elif (($(ver "$(node -v)") < 24000)); then
  fail node "$(node -v) is too old — need Node.js 24 or newer (nvm install 24)"
else
  ok node "$(node -v)"
fi
if command -v npm >/dev/null; then ok npm "$(npm -v)"; else fail npm "not found — it ships with Node.js"; fi
ok make "$(make -v 2>/dev/null | head -1)"
if command -v curl >/dev/null; then ok curl "found"; else fail curl "not found — the demo and the API tour use it"; fi
if command -v jq >/dev/null; then ok jq "found"; else warn jq "not found — only 'make qa' needs it (brew install jq / apt install jq)"; fi

for tool in kind helm kubectl; do
  if command -v "$tool" >/dev/null; then ok "$tool" "found"; else warn "$tool" "not found — only the Kubernetes targets (make kind-up) need it"; fi
done

echo
echo "Ports (this branch's stack, project program-capacity-ms; main's stack keeps its own)"
# Same variables and defaults as the Makefile and deploy/compose.yaml (ADR 027).
ports=("${HOST_PORT_API:-13000}" "${HOST_PORT_POSTGRES:-15432}" "${HOST_PORT_OAUTH:-18081}"
  "${HOST_PORT_API_OPS:-19464}" "${HOST_PORT_WORKER_OPS:-19465}" "${HOST_PORT_KAFKA:-39092}")
if [[ -n "$(docker compose -f deploy/compose.yaml ps -q 2>/dev/null)" ]]; then
  ok ports "the stack is already running and holds them"
elif ! command -v lsof >/dev/null; then
  warn ports "lsof not found, skipped — the stack needs ${ports[*]}"
else
  busy=()
  for port in "${ports[@]}"; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && busy+=("$port")
  done
  if ((${#busy[@]})); then
    warn ports "in use: ${busy[*]} — stop whatever listens there, or 'make up' will fail"
  else
    ok ports "${ports[*]} are free"
  fi
fi

echo
if ((errors)); then
  printf '%s%d requirement(s) missing — fix them and run make install again.%s\n' "$R" "$errors" "$X"
  exit 1
fi
printf '%sThis machine is ready.%s\n' "$G" "$X"
