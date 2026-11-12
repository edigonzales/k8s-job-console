#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $# == 0 || ( $# == 1 && $1 == --purge-storage ) ]] || { echo 'Usage: dev-down.sh [--purge-storage]' >&2; exit 2; }
case $(namespace_owner) in
  "") exit 0 ;;
  job-console/job-console) ;;
  *) echo 'Namespace job-console is not owned by Job Console.' >&2; exit 1 ;;
esac
if [[ -n $(k get crd workflows.argoproj.io --ignore-not-found -o name) ]]; then
  if k get workflows -l 'app.kubernetes.io/managed-by=job-console,job-console.io/test-fixture!=true' -o json |
      jq -e 'any(.items[]; (.status.phase // "") as $phase | ["Succeeded","Failed","Error"] | index($phase) == null)' >/dev/null; then
    echo 'Wait for active Console workflows to finish or terminate them first.' >&2
    exit 1
  fi
  k delete cronworkflows -l app.kubernetes.io/managed-by=job-console --cascade=orphan
fi
k delete -f deploy/local-identity.yaml --ignore-not-found
k delete -f deploy/seeder.yaml --ignore-not-found
k delete configmap job-console-sync --ignore-not-found
k delete -f deploy/launcher.yaml -f deploy/headlamp.yaml -f deploy/argo-executor.yaml --ignore-not-found
k delete deployment/rustfs service/rustfs deployment/argo-server service/argo-server deployment/workflow-controller --ignore-not-found
k delete jobs -l app=job-console-init-storage --ignore-not-found
k delete configmap job-console-catalog --ignore-not-found
if [[ ${1:-} == --purge-storage ]]; then
  k delete pvc rustfs --ignore-not-found
fi
