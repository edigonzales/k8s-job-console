#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $(namespace_owner) == job-console/job-console ]]
api=http://127.0.0.1:4466/job-console-api/api
temp=$(mktemp -d)
fixtures=()
cleanup() {
  if (( ${#fixtures[@]} > 0 )); then
    k delete "${fixtures[@]}" --ignore-not-found
  fi
  rm -rf "$temp"
}
trap cleanup EXIT
npx playwright test
umask 077
node test/e2e/cookie.ts > "$temp/cookies"
request() { curl --cookie "$temp/cookies" -H 'Origin: http://127.0.0.1:4466' "$@"; }
request -fsS "$api/jobs" >/dev/null

echo 'Streaming upload of 100 MiB'
node -e 'for (let i = 0; i < 100; i++) process.stdout.write(("1,"+"x".repeat(125)+"\n").repeat(8192))' > "$temp/large.csv"
[[ $(wc -c < "$temp/large.csv" | tr -d ' ') == 104857600 ]]
rss() { k exec deploy/launcher -- awk '/VmRSS/{print $2}' /proc/1/status; }
baseline=$(rss)
request --limit-rate 16m -fsS -F 'parameters={"hasHeader":false}' -F "inputFile=@$temp/large.csv" \
  "$api/jobs/csv-analyzer/runs" > "$temp/run.json" &
upload_pid=$!
peak=$baseline
while kill -0 "$upload_pid" 2>/dev/null; do
  current=$(rss)
  if (( current > peak )); then peak=$current; fi
  sleep 0.3
done
wait "$upload_pid"
printf 'Launcher RSS baseline=%s KiB peak=%s KiB\n' "$baseline" "$peak"
(( peak - baseline < 80 * 1024 ))
large=$(jq -er .name "$temp/run.json")
k wait --for=jsonpath='{.status.phase}'=Succeeded "workflow/$large" --timeout=150s
id=$(request -fsS "$api/runs/$large/artifacts" | jq -er '.[0].id')
request -fsS "$api/runs/$large/artifacts/$id" | jq -e '.records == 819200 and .columns == 2'

echo 'Interrupted upload does not create a run'
before=$(k get workflow -l job-console.io/job-id=csv-analyzer -o name | sort)
set +e
request --limit-rate 8m --max-time 2 -sS -F 'parameters={"hasHeader":false}' -F "inputFile=@$temp/large.csv" \
  "$api/jobs/csv-analyzer/runs" > "$temp/interrupted.json"
status=$?
set -e
[[ $status == 28 ]]
sleep 2
[[ $(k get workflow -l job-console.io/job-id=csv-analyzer -o name | sort) == "$before" ]]
k exec deploy/launcher -- node --input-type=module -e '
  import { S3Client, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
  const client = new S3Client({endpoint:process.env.S3_ENDPOINT,forcePathStyle:true});
  const result = await client.send(new ListMultipartUploadsCommand({Bucket:process.env.S3_BUCKET}));
  if (result.Uploads?.length) throw new Error("Unexpected unfinished multipart uploads");
'

echo 'Literal parameters and new run on repeat'
literal='$(HOME) $HOME ${HOME} {{workflow.name}} {{= 1 }} "Grüezi";
second line'
hello=$(jq -nc --arg message "$literal" '{parameters:{message:$message}}' |
  request -fsS --json @- "$api/jobs/hello-gretl/runs" | jq -er .name)
k wait --for=jsonpath='{.status.phase}'=Succeeded "workflow/$hello" --timeout=90s
request -fsS "$api/runs/$hello/logs" | jq -e --arg literal "$literal" '.logs | contains($literal)'
repeat=$(request -fsS -X POST "$api/runs/$hello/rerun" | jq -er .name)
[[ $repeat != "$hello" ]]
k wait --for=jsonpath='{.status.phase}'=Succeeded "workflow/$repeat" --timeout=90s

echo 'Missing S3 input fails before GRETL runs'
missing="csv-analyzer-missing-$(openssl rand -hex 5)"
k get configmap job-console-catalog -o jsonpath='{.data.catalog\.json}' > "$temp/catalog.json"
node --input-type=module - "$missing" "$temp/catalog.json" <<'NODE' | k create -f -
import { readFileSync } from 'node:fs';
import { workflow } from './build/control/workflows.js';
const job = JSON.parse(readFileSync(process.argv[3])).find(job => job.id === 'csv-analyzer');
const run = workflow(job, process.argv[2], { delimiter: ',', hasHeader: true }, ['inputFile']);
run.metadata.labels['job-console.io/test-fixture'] = 'true';
console.log(JSON.stringify(run));
NODE
fixtures+=("workflow/$missing")
for ((i=0; i<45; i++)); do
  phase=$(request -fsS "$api/runs/$missing" | jq -er .status)
  [[ $phase != Failed ]] || break
  sleep 2
done
[[ $phase == Failed ]]
request -fsS "$api/runs/$missing/logs" | jq -er .logs | rg -i 'key does not exist|NoSuchKey'

echo 'A manual run and a CronWorkflow wait for the same GRETL job mutex'
holder=$(k create -f test/e2e/fixtures/wait-workflow.yaml -o jsonpath='{.metadata.name}')
fixtures+=("workflow/$holder")
k wait --for=jsonpath='{.status.phase}'=Running "workflow/$holder" --timeout=90s
for ((i=0; i<45; i++)); do
  if request -fsS "$api/runs/$holder/logs" | jq -er .logs | rg 'waiting for cancellation'; then break; fi
  sleep 2
done
manual=$(request -fsS --json '{}' "$api/jobs/scheduled-report/runs" | jq -er .name)
schedule=console-v2-test-$(openssl rand -hex 5)
k get cronworkflow scheduled-report -o json |
  jq --arg name "$schedule" '{
    apiVersion,kind,metadata:{name:$name,labels:{"job-console.io/test-fixture":"true"}},
    spec:(.spec | .schedules=["* * * * *"] | .suspend=false)
  }' | k create -f -
fixtures+=("cronworkflow/$schedule")
scheduled=''
for ((i=0; i<50; i++)); do
  scheduled=$(k get workflows -l "workflows.argoproj.io/cron-workflow=$schedule" -o json | jq -r '.items[0].metadata.name // ""')
  [[ -z $scheduled ]] || break
  sleep 2
done
[[ -n $scheduled ]]
k patch cronworkflow "$schedule" --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
for name in "$manual" "$scheduled"; do
  for ((i=0; i<30; i++)); do
    phase=$(request -fsS "$api/runs/$name" | jq -er .status)
    [[ $phase != Queued ]] || break
    sleep 2
  done
  [[ $phase == Queued ]]
  [[ -z $(k get pod -l "workflows.argoproj.io/workflow=$name" -o name) ]]
done
k delete cronworkflow "$schedule" --cascade=orphan
request -fsS -X POST "$api/runs/$holder/cancel"  | jq -e '.status == "Canceling" or .status == "Canceled"'
k wait --for=jsonpath='{.status.phase}'=Succeeded "workflow/$manual" "workflow/$scheduled" --timeout=120s
request -fsS "$api/runs/$scheduled" | jq -e '.scheduled and .status == "Succeeded"'

node test/e2e/production-preview.ts
node test/e2e/tokens.ts
node test/e2e/large-download.ts
node test/e2e/webhook.ts
echo 'Argo execution and browser checks passed on Rancher Desktop'
