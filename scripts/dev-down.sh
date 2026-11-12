#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $# == 0 || ( $# == 1 && $1 == --purge-storage ) ]] || { echo 'Usage: dev-down.sh [--purge-storage]' >&2; exit 2; }
owner=$(k get namespace job-console --ignore-not-found -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')
[[ -z $owner && -z $(k get namespace job-console --ignore-not-found -o name) ]] && exit 0
[[ $owner == job-console ]] || { echo 'Namespace is not marked as owned by Job Console.' >&2; exit 1; }
if [[ ${1:-} == --purge-storage ]]; then
  k delete namespace job-console
else
  k delete -f deploy/launcher.yaml -f deploy/headlamp.yaml --ignore-not-found
  k delete deployment/rustfs service/rustfs --ignore-not-found
  k delete jobs,cronjobs,configmaps -l app.kubernetes.io/managed-by=job-console --ignore-not-found
  k delete configmap job-console-catalog --ignore-not-found
fi
