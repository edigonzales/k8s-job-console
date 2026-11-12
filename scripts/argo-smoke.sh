#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"

[[ $(namespace_owner) == job-console/job-console ]]
# The local runtime image and RustFS bucket must already be available.
k apply -f deploy/argo-executor.yaml
workflow=$(k create -f scripts/argo-smoke.yaml -o name)
name=${workflow#*/}
echo "$workflow"

for ((attempt=0; attempt<60; attempt++)); do
  state=$(k get "$workflow" -o json)
  node=$(jq -r '.status.nodes[]? | select(.type=="Suspend" and .phase=="Running") | .id' <<< "$state")
  [[ -z $node ]] || break
  case $(jq -r '.status.phase' <<< "$state") in
    Failed|Error) jq '.status' <<< "$state" >&2; exit 1 ;;
  esac
  sleep 2
done
[[ -n $node ]]

forward_log=$(mktemp)
kubectl --context rancher-desktop --namespace job-console port-forward \
  --address 127.0.0.1 svc/argo-server :2746 > "$forward_log" 2>&1 &
forward_pid=$!
trap 'kill "$forward_pid" 2>/dev/null || true; rm -f "$forward_log"' EXIT
for ((attempt=0; attempt<20; attempt++)); do
  if rg -q 'Forwarding from' "$forward_log"; then break; fi
  kill -0 "$forward_pid" 2>/dev/null || { cat "$forward_log" >&2; exit 1; }
  sleep 0.5
done
port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\) -> 2746$/\1/p' "$forward_log")
[[ -n $port ]]

# Argo's namespace installer uses a self-signed certificate on this local tunnel.
token=$(k create token argo --duration=10m)
url="https://127.0.0.1:$port/api/v1/workflows/job-console/$name/set"
decision() {
  jq -nc --arg name "$name" --arg node "$node" --arg value "$1" '{
    name: $name, namespace: "job-console", nodeFieldSelector: ("id="+$node),
    phase: "Succeeded", outputParameters: ({decision: $value}|tojson)
  }' |
    curl -ksS -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary @- "$url"
}
decision approved | jq -e --arg node "$node" '
  .status.nodes[$node] | select(.phase=="Succeeded" and .outputs.parameters[0].value=="approved") |
  {id, phase, outputs}'
decision conflicting | jq -e 'select(.message | contains("no suspend nodes matching")) | .message'
unset token

k wait --for=jsonpath='{.status.phase}'=Succeeded "$workflow" --timeout=90s
for step in analyze verify; do
  pod=$(k get pods -l "workflows.argoproj.io/workflow=$name" -o name | rg -- "-$step-[0-9]+$")
  if [[ $step == analyze ]]; then
    k logs "$pod" -c main | rg 'records=2 columns=2'
    k logs "$pod" -c init | rg 'S3 Load|artifactName=source'
    k logs "$pod" -c wait | rg 'S3 Save'
  else
    k logs "$pod" -c init | rg 'S3 Load'
    k logs "$pod" -c main | sed -n '/^{"schemaVersion":/p' | jq -e '
      select(.execution.status == "SUCCEEDED" and .execution.requestedTargets == ["analyze"]) |
      {source, status: .execution.status, targets: .execution.requestedTargets}'
  fi
done
