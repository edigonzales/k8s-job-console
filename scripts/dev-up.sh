#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
for dependency in docker git java node npm openssl python3 jq; do command -v "$dependency" >/dev/null; done
[[ $(docker context show) == rancher-desktop ]] || { echo 'Select the rancher-desktop Docker context.' >&2; exit 1; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'Node.js 22 is required.' >&2; exit 1; }
runtime=$(cd "${GRETL_DIR:-../gretl-runtime}" && pwd)
(
  cd "$runtime"
  ./mvnw -B -pl gretl-dist -am -DskipTests clean package
  "$runtime/scripts/build-runtime-image.sh" --distribution gretl-dist/target/dist \
    --output "$ROOT/build/runtime-image" --source "$(git rev-parse HEAD)"
)
runtime_id=$(cat build/runtime-image/image-id.txt)
runtime_id=${runtime_id#sha256:}
export GRETL_IMAGE=job-console-gretl:${runtime_id:0:12}
docker tag "$runtime_id" "$GRETL_IMAGE"
npm ci
npm run build
docker build -t job-console-control:local -f apps/control/Dockerfile .
npm --prefix apps/headlamp-plugin ci
npm --prefix apps/headlamp-plugin run check
npm run plugin
docker build -t job-console-headlamp:local apps/headlamp-plugin
case $(namespace_owner) in
  "") k create namespace job-console --dry-run=client -o yaml |
    k label --local -f - app.kubernetes.io/managed-by=job-console -o yaml | k create -f - ;;
  job-console/job-console) ;;
  *) echo 'Namespace job-console already exists and is not owned by Job Console.' >&2; exit 1 ;;
esac
if ! k get secret job-console-storage >/dev/null 2>&1; then
  { printf 'AWS_ACCESS_KEY_ID=console-%s\n' "$(openssl rand -hex 8)"; printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$(openssl rand -hex 24)"; } |
    k create secret generic job-console-storage --from-env-file=/dev/stdin
fi
k apply -f deploy/storage.yaml
k rollout status deployment/rustfs --timeout=180s
init=$(k create -f deploy/init-storage.yaml -o name)
if ! k wait --for=condition=complete "$init" --timeout=100s; then
  k logs "$init" || true
  exit 1
fi
./scripts/install-argo.sh
./scripts/deploy-jobs.sh
k apply -f deploy/launcher.yaml -f deploy/headlamp.yaml
k rollout restart deployment/launcher deployment/headlamp
k rollout status deployment/launcher --timeout=180s
k rollout status deployment/headlamp --timeout=180s
echo 'Run ./scripts/dev-open.sh to access http://127.0.0.1:4466/'
