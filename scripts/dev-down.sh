#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $# == 0 || ( $# == 1 && $1 == --purge-storage ) ]] || { echo 'Usage: dev-down.sh [--purge-storage]' >&2; exit 2; }
case $(namespace_owner) in
  "") exit 0 ;;
  job-console/job-console) ;;
  *) echo 'Namespace job-console is not owned by Job Console.' >&2; exit 1 ;;
esac
if [[ ${1:-} == --purge-storage ]]; then
  k delete namespace job-console
else
  k delete -f deploy/launcher.yaml -f deploy/headlamp.yaml --ignore-not-found
  k delete deployment/rustfs service/rustfs --ignore-not-found
  k delete jobs -l app=job-console-init-storage --ignore-not-found
  k delete jobs,cronjobs,configmaps -l app.kubernetes.io/managed-by=job-console --ignore-not-found
  k delete configmap job-console-catalog --ignore-not-found
fi
