#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $(namespace_owner) == job-console/job-console ]]

if ! k get secret job-console-argo-tls >/dev/null 2>&1; then
  tls_dir=$(mktemp -d)
  trap 'rm -rf "$tls_dir"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj /CN=argo-server \
    -keyout "$tls_dir/tls.key" -out "$tls_dir/tls.crt" -extensions tls \
    -config <(printf '[req]\ndistinguished_name=dn\n[dn]\n[tls]\nsubjectAltName=DNS:argo-server\n') 2>/dev/null
  k create secret tls job-console-argo-tls --cert="$tls_dir/tls.crt" --key="$tls_dir/tls.key"
fi

curl -fsSL https://github.com/argoproj/argo-workflows/releases/download/v4.1.6/namespace-install.yaml |
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parseAllDocuments } from "yaml";
    for (const document of parseAllDocuments(readFileSync(0, "utf8"))) {
      const resource = document.toJS();
      if (resource.kind === "Deployment" && resource.metadata.name === "argo-server") {
        document.getIn(["spec", "template", "spec", "containers", 0, "args"], true)
          .add("--tls-certificate-secret-name=job-console-argo-tls");
      }
      process.stdout.write("---\n" + document.toString());
    }
  ' | k apply --server-side -f -
k apply -f deploy/argo-executor.yaml
k rollout status deployment/argo-server --timeout=180s
k rollout status deployment/workflow-controller --timeout=180s
