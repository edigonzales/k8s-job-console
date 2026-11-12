#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $(namespace_owner) == job-console/job-console ]]
npm run build
npm run generate -- --jobs-dir "${JOBS_DIR:-../gretl-runtime-jobs}"
generated=(-f build/generated/cronworkflows.yaml -f build/generated/catalog-configmap.yaml)
k apply --dry-run=server "${generated[@]}"
# Stop the retired MVP schedules, scoped to Console-managed resources.
k delete cronjobs.batch -l app.kubernetes.io/managed-by=job-console --cascade=orphan
k apply "${generated[@]}"
while IFS= read -r name; do
  if [[ -n $name ]] && ! jq -e --arg id "$name" 'any(.[]; .id == $id and has("schedule"))' build/generated/catalog.json >/dev/null; then
    k delete cronworkflows.argoproj.io "$name" --cascade=orphan
  fi
done < <(k get cronworkflows.argoproj.io -l app.kubernetes.io/managed-by=job-console -o json | jq -r '.items[].metadata.name')
if k get deployment launcher >/dev/null 2>&1; then
  k rollout restart deployment/launcher
  k rollout status deployment/launcher --timeout=180s
fi
