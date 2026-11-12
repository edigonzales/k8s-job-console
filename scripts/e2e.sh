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
  ./scripts/deploy-jobs.sh
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

echo 'E2E-07  Scheduled execution'
node -e '
  const fs=require("node:fs");
  const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("H H(1-3) * * *","H/1 * * * *"));
' "$temp/jobs/scheduled-report/job.yaml"
npm run generate -- --jobs-dir "$temp" --output "$temp/short-schedule"
k apply -f "$temp/short-schedule/cronjobs.yaml"
[[ $(k get cronjob scheduled-report -o jsonpath='{.spec.schedule}') == '0-59/1 * * * *' ]]
existing=$(k get job -l job-console.io/job-id=scheduled-report -o name)
scheduled=
for ((i=0; i<45; i++)); do
  scheduled=$(k get job -l job-console.io/job-id=scheduled-report -o json | jq -r --arg existing "$existing" '
    .items[] | select(any(.metadata.ownerReferences[]?; .kind == "CronJob" and .name == "scheduled-report"))
    | .metadata.name | select(. as $name | ($existing | contains("job.batch/"+$name)) | not)' | head -1)
  [[ -z $scheduled ]] || break
  sleep 2
done
[[ -n $scheduled ]]
k wait --for=condition=complete "job/$scheduled" --timeout=90s
k logs "job/$scheduled" | rg 'Zeitbericht gestartet'

echo 'E2E-08  Restart and retention'
k rollout restart deployment/launcher
k rollout status deployment/launcher --timeout=120s
curl --retry 10 --retry-all-errors -fsS "$api/jobs" | jq -e 'any(.[]; .id == "csv-analyzer")' >/dev/null
curl -fsS "$api/runs/$large" | jq -e '.status == "Succeeded"' >/dev/null
curl -fsS "$api/runs/$large/logs" | jq -e '.logs | contains("records=819200 columns=2")' >/dev/null
echo 'E2E passed on rancher-desktop'
