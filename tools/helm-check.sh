#!/usr/bin/env bash
# `make helm-check` (K8-01): helm lint and helm template for every chart under deploy/helm, the
# rendered manifests validated with kubeconform. kubeconform is pinned and downloaded into
# .tools/ (gitignored) on first use, never installed globally. Needs only helm.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECONFORM_VERSION=v0.7.0
KUBERNETES_VERSION=1.34.0
# Kinds without a schema in the default catalog (Gateway API, Envoy Gateway) are skipped by
# name, as ADR 029 requires; every other kind must validate.
SKIP_KINDS=Gateway,HTTPRoute,GatewayClass,EnvoyProxy,SecurityPolicy,ClientTrafficPolicy,BackendTrafficPolicy,Backend

command -v helm >/dev/null || { echo "helm not found — brew install helm" >&2; exit 1; }

bin=.tools/kubeconform-$KUBECONFORM_VERSION/kubeconform
if [[ ! -x $bin ]]; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$(uname -m)" in x86_64) arch=amd64 ;; arm64 | aarch64) arch=arm64 ;; *) arch=$(uname -m) ;; esac
  base=https://github.com/yannh/kubeconform/releases/download/$KUBECONFORM_VERSION
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  echo "▸ downloading kubeconform $KUBECONFORM_VERSION ($os/$arch) into .tools/"
  curl -fsSL "$base/kubeconform-$os-$arch.tar.gz" -o "$dir/kc.tar.gz"
  curl -fsSL "$base/CHECKSUMS" -o "$dir/CHECKSUMS"
  want=$(awk -v f="kubeconform-$os-$arch.tar.gz" '$2 == f { print $1 }' "$dir/CHECKSUMS")
  have=$(shasum -a 256 "$dir/kc.tar.gz" | awk '{ print $1 }')
  [[ -n $want && $want == "$have" ]] || { echo "kubeconform checksum mismatch" >&2; exit 1; }
  mkdir -p "$(dirname "$bin")"
  tar -xzf "$dir/kc.tar.gz" -C "$(dirname "$bin")" kubeconform
fi

# The chart carries a copy of the OAuth2 mock config; it must not drift from compose's.
cmp -s deploy/oauth/config.json deploy/helm/local-infra/files/oauth-config.json || {
  echo "deploy/helm/local-infra/files/oauth-config.json differs from deploy/oauth/config.json" >&2
  exit 1
}

for chart in deploy/helm/*/; do
  chart=${chart%/}
  echo "▸ $chart"
  helm lint --strict "$chart"
  helm template "$(basename "$chart")" "$chart" --namespace finverity-ms |
    "$bin" -strict -summary -kubernetes-version "$KUBERNETES_VERSION" -skip "$SKIP_KINDS" -
done
echo "✔ helm-check passed"
