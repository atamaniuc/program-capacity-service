#!/usr/bin/env bash
# `make status`: what a session needs before it starts and before every gate.
set -uo pipefail
cd "$(dirname "$0")/.."

BUDGET=.harness/4-state/BUDGET.md

echo "== harness check =="
if npx --no-install harnessimo check >/tmp/harnessimo-status.$$ 2>&1; then
  echo "green"
else
  echo "RED"; tail -n 20 /tmp/harnessimo-status.$$
fi
rm -f /tmp/harnessimo-status.$$

echo
echo "== last logged gate =="
grep '^| 20' "$BUDGET" | tail -1 | awk -F' [|] ' '{ print $1 " " $2 }' | cut -c3-160

echo
echo "== last five commits =="
git log --oneline -5 2>/dev/null || echo "(no commits yet)"

echo
echo "== next action =="
handoff=$(grep -m1 -- '— active' specs/TRACKS.md | sed -n 's/.*\[handoff\](\([^)]*\)).*/\1/p')
if [[ -n "$handoff" && -f "$handoff" ]]; then
  echo "active handoff: $handoff"
  awk '/^## First step/{f=1;next} /^## /{f=0} f' "$handoff" | sed '/^$/d'
fi
sed -n '/^exact next action:/p' "$BUDGET"
