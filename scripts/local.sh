#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
if [[ $(kubectl config current-context) != rancher-desktop ]]; then
  echo 'Select the rancher-desktop Kubernetes context first.' >&2
  exit 1
fi
k() { kubectl --context rancher-desktop --namespace job-console "$@"; }
namespace_owner() {
  k get namespace job-console --ignore-not-found -o jsonpath='{.metadata.name}/{.metadata.labels.app\.kubernetes\.io/managed-by}'
}
