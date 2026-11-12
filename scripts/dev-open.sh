#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
echo 'Headlamp  http://127.0.0.1:4466/'
k port-forward --address 127.0.0.1 svc/headlamp 4466:8080
