#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
command -v jq >/dev/null
api=http://127.0.0.1:4466/job-console-api/api
curl -fsS "$api/jobs" >/dev/null
export JOBS_DIR=$(cd "${JOBS_DIR:-../gretl-runtime-jobs}" && pwd)
temp=$(mktemp -d)
cleanup() {
  local result=$?
  trap - EXIT
  ./scripts/deploy-jobs.sh || result=1
  k delete jobs -l 'job-console.io/test-fixture=true' --ignore-not-found
  k delete jobs -l 'job-console.io/job-id=console-test-wait' --ignore-not-found
  k delete configmap job-console-script-console-test-wait --ignore-not-found
  rm -rf "$temp"
  exit "$result"
}
trap cleanup EXIT
cp -R "$JOBS_DIR/jobs" "$temp/jobs"
cp -R test/e2e/fixtures/console-test-wait "$temp/jobs/"
JOBS_DIR="$temp" ./scripts/deploy-jobs.sh
npx playwright test

echo 'E2E-04  100 MiB streaming upload'
# 128 bytes per row, 819200 rows. Use an independent byte count as well.
node -e 'for (let i = 0; i < 100; i++) process.stdout.write(("1,"+"x".repeat(125)+"\n").repeat(8192))' > "$temp/large.csv"
[[ $(wc -c < "$temp/large.csv" | tr -d ' ') == 104857600 ]]
rss() { k exec deploy/launcher -- awk '/VmRSS/{print $2}' /proc/1/status; }
baseline=$(rss)
curl --limit-rate 16m -fsS -F 'parameters={"hasHeader":false}' -F "inputFile=@$temp/large.csv" \
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
size=$(k exec deploy/launcher -- node --input-type=module -e '
  import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
  const client = new S3Client({endpoint:process.env.S3_ENDPOINT,forcePathStyle:true});
  const result = await client.send(new HeadObjectCommand({Bucket:process.env.S3_BUCKET,Key:process.argv[1]}));
  console.log(result.ContentLength);
' "runs/$large/inputs/inputFile")
[[ $size == 104857600 ]]
k wait --for=condition=complete "job/$large" --timeout=120s
curl -fsS "$api/runs/$large/logs" | jq -er '.logs | contains("records=819200 columns=2")' >/dev/null

echo 'E2E-04  Interrupted upload'
before=$(k get job -l job-console.io/job-id=csv-analyzer -o name | sort)
set +e
curl --limit-rate 8m --max-time 2 -sS -F 'parameters={"hasHeader":false}' -F "inputFile=@$temp/large.csv" \
  "$api/jobs/csv-analyzer/runs" > "$temp/interrupted.json"
status=$?
set -e
[[ $status == 28 ]]
sleep 2
[[ $(k get job -l job-console.io/job-id=csv-analyzer -o name | sort) == "$before" ]]
k exec deploy/launcher -- node --input-type=module -e '
  import { S3Client, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
  const client = new S3Client({endpoint:process.env.S3_ENDPOINT,forcePathStyle:true});
  const result = await client.send(new ListMultipartUploadsCommand({Bucket:process.env.S3_BUCKET}));
  if (result.Uploads?.length) throw new Error("Unexpected unfinished multipart uploads");
'

echo 'E2E-04  Missing object in InitContainer'
node --input-type=module <<'NODE' | k create -f - > "$temp/missing-job"
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { manualJob } from './build/control/manifests.js';
const job = JSON.parse(readFileSync('build/generated/catalog.json')).find(item => item.id === 'csv-analyzer');
const resource = manualJob(job, 'csv-analyzer-missing-' + randomBytes(5).toString('hex'),
  { delimiter: ',', hasHeader: true }, ['inputFile']);
resource.metadata.labels['job-console.io/test-fixture'] = 'true';
console.log(JSON.stringify(resource));
NODE
missing=$(awk '{sub(/^job.batch\//, "", $1); print $1}' "$temp/missing-job")
k wait --for=condition=failed "job/$missing" --timeout=90s
curl -fsS "$api/runs/$missing" | jq -e '.status == "Failed"' >/dev/null
curl -fsS "$api/runs/$missing/logs" | jq -er '.logs' | rg -i 'key does not exist|NoSuchKey'

echo 'E2E-07  Scheduled execution'
node -e '
  const fs=require("node:fs");
  const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("H H(1-3) * * *","H/1 * * * *"));
' "$temp/jobs/scheduled-report/job.yaml"
npm run generate -- --jobs-dir "$temp" --output "$temp/short-schedule"
k apply -f "$temp/short-schedule/cronjobs.yaml"
[[ $(k get cronjob scheduled-report -o jsonpath='{.spec.schedule}') == '0-59/1 * * * *' ]]
wait_for_schedule() {
  local id=$1 known=$2 job i
  for ((i=0; i<45; i++)); do
    job=$(k get job -l "job-console.io/job-id=$id" -o json | jq -r --arg id "$id" --argjson known "$known" '
      [.items[] | select(any(.metadata.ownerReferences[]?; .kind == "CronJob" and .name == $id))
      | .metadata.name | select(. as $name | ($known | index($name)) == null)] | first // empty')
    if [[ -n $job ]]; then printf '%s\n' "$job"; return; fi
    sleep 2
  done
  echo "No new scheduled job for $id" >&2
  return 1
}
existing=$(k get job -l job-console.io/job-id=scheduled-report -o json | jq '[.items[].metadata.name]')
scheduled=$(wait_for_schedule scheduled-report "$existing")
k wait --for=condition=complete "job/$scheduled" --timeout=90s
k logs "job/$scheduled" | rg 'Zeitbericht gestartet'

echo 'E2E-07  Canceled CronJob child releases the Forbid slot'
printf 'schedule: {cron: "H/1 * * * *"}\n' >> "$temp/jobs/console-test-wait/job.yaml"
npm run generate -- --jobs-dir "$temp" --output "$temp/short-schedule"
k apply -f "$temp/short-schedule/cronjobs.yaml"
first=$(wait_for_schedule console-test-wait '[]')
curl -fsS -X POST "$api/runs/$first/cancel" | jq -e '.status == "Canceled"' >/dev/null
k wait --for=condition=failed "job/$first" --timeout=60s
second=$(wait_for_schedule console-test-wait "$(jq -cn --arg name "$first" '[$name]')")
[[ $first != "$second" ]]
printf 'Scheduled after canceled child %s: %s\n' "$first" "$second"
curl -fsS "$api/runs/$first" | jq -e '.status == "Canceled"' >/dev/null
k delete cronjob console-test-wait --cascade=background

echo 'E2E-08  Restart and retention'
k rollout restart deployment/launcher
k rollout status deployment/launcher --timeout=120s
curl --retry 10 --retry-all-errors -fsS "$api/jobs" | jq -e 'any(.[]; .id == "csv-analyzer")' >/dev/null
curl -fsS "$api/runs/$large" | jq -e '.status == "Succeeded"' >/dev/null
curl -fsS "$api/runs/$large/logs" | jq -e '.logs | contains("records=819200 columns=2")' >/dev/null
echo 'E2E passed on rancher-desktop'
