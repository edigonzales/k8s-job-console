#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
npm run build
npm run generate -- --jobs-dir "${JOBS_DIR:-../gretl-runtime-jobs}"
generated=( -f build/generated/scripts.yaml -f build/generated/catalog-configmap.yaml -f build/generated/cronjobs.yaml )
k apply --dry-run=server "${generated[@]}"
k apply "${generated[@]}"
# Remove schedules no longer in Git. Keep source ConfigMaps for existing Jobs.
while IFS= read -r name; do
  if [[ -n $name ]] && ! jq -e --arg id "$name" 'any(.[]; .id == $id and has("schedule"))' build/generated/catalog.json >/dev/null; then
    k delete cronjob "$name"
  fi
done < <(k get cronjob -l app.kubernetes.io/managed-by=job-console -o json | jq -r '.items[].metadata.name')
if k get deployment launcher >/dev/null 2>&1; then
  k rollout restart deployment/launcher
  k rollout status deployment/launcher --timeout=180s
fi
