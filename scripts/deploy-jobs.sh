#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $(namespace_owner) == job-console/job-console ]]
name=$(k create -o jsonpath='{.metadata.name}' -f - <<'YAML'
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: job-console-sync-
  labels: {job-console.io/sync: "true"}
spec:
  workflowTemplateRef: {name: job-console-sync}
YAML
)
echo "Workflow $name"
for ((i=0; i<120; i++)); do
  phase=$(k get workflow "$name" -o jsonpath='{.status.phase}')
  case $phase in
    Succeeded) break ;;
    Failed|Error) k logs -l "workflows.argoproj.io/workflow=$name" -c main --tail=50 || true; exit 1 ;;
  esac
  sleep 2
done
[[ $phase == Succeeded ]]
k logs -l "workflows.argoproj.io/workflow=$name" -c main --tail=20
