#!/usr/bin/env bash
# buf breaking (FILE rules) of the working tree against a baseline commit (ADR 024):
#   PROTO_BASE unset  -> HEAD (local: catches an uncommitted breaking edit)
#   PROTO_BASE=<ref>  -> that ref; CI passes the PR base on pull_request and github.event.before
#                        on push. An empty or all-zero ref (a new branch) skips the check.
# When the baseline commit has no contracts/proto yet, the baseline is empty and the check passes.
set -euo pipefail
cd "$(dirname "$0")/../.."
base="${PROTO_BASE:-HEAD}"
if [[ -z "$base" || "$base" =~ ^0+$ ]]; then
  echo "proto:breaking: no baseline commit (new branch); nothing to compare"
  exit 0
fi
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  base="origin/$base"
fi
ref="$(git rev-parse "$base^{commit}")"
if git cat-file -e "$ref:contracts/proto/buf.yaml" 2>/dev/null; then
  exec node_modules/.bin/buf breaking contracts/proto --against ".git#ref=$ref,subdir=contracts/proto"
fi
# An empty module cannot be a buf baseline, and against nothing every addition is allowed.
echo "proto:breaking: $base has no contracts/proto at ${ref:0:12}; empty baseline, nothing to break"
