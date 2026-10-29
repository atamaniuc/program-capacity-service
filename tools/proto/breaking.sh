#!/usr/bin/env bash
# buf breaking (FILE rules) against the merge base with PROTO_BASE (default: main; CI sets the PR
# base). When the base has no contracts/proto yet (the first baseline, ADR 024), the baseline is
# empty and the check passes.
set -euo pipefail
cd "$(dirname "$0")/../.."
base="${PROTO_BASE:-main}"
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  base="origin/$base"
fi
ref="$(git merge-base HEAD "$base")"
if git cat-file -e "$ref:contracts/proto/buf.yaml" 2>/dev/null; then
  exec node_modules/.bin/buf breaking contracts/proto --against ".git#ref=$ref,subdir=contracts/proto"
fi
# An empty module cannot be a buf baseline, and against nothing every addition is allowed.
echo "proto:breaking: $base has no contracts/proto at ${ref:0:12}; empty baseline, nothing to break"
