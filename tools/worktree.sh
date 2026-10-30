#!/usr/bin/env bash
# Parallel delivery on branch `microservices`: one git worktree per independent task stream.
#   tools/worktree.sh add <name>     → ../finverity-ms-<name> on branch ms-<name>, npm ci done
#   tools/worktree.sh merge <name>   → merge ms-<name> into the current branch (no fast-forward)
#   tools/worktree.sh remove <name>  → remove the worktree and delete the merged branch
#   tools/worktree.sh list
# Worktrees never share a compose project or a kind cluster: each stream that needs live
# infrastructure owns it (see ADR 027). Never point this at the `main` checkout.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cmd="${1:-list}"
name="${2:-}"
dir="$(dirname "$root")/finverity-ms-${name}"
branch="ms-${name}"

need_name() { [[ -n "$name" ]] || { echo "usage: $0 $cmd <name>" >&2; exit 2; }; }

case "$cmd" in
  add)
    need_name
    git -C "$root" worktree add -q "$dir" -b "$branch" HEAD
    (cd "$dir" && npm ci --no-audit --no-fund >/dev/null)
    echo "ready: $dir (branch $branch)"
    ;;
  merge)
    need_name
    git -C "$root" merge --no-ff --no-edit "$branch"
    ;;
  remove)
    need_name
    git -C "$root" worktree remove "$dir"
    git -C "$root" branch -d "$branch"
    ;;
  list)
    git -C "$root" worktree list
    ;;
  *)
    echo "unknown command: $cmd (add|merge|remove|list)" >&2
    exit 2
    ;;
esac
