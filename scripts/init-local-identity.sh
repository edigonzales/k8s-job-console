#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/local.sh"
[[ $(namespace_owner) == job-console/job-console ]]
if ! k get secret job-console-local-realm >/dev/null 2>&1; then
  python3 - <<'PY' | k create secret generic job-console-local-realm --from-file=realm.json=/dev/stdin
import json, secrets, uuid
users = {
    'admin': ['console-admins', 'console-maintainers', 'console-operators'],
    'operator': ['console-operators'],
    'reviewer': ['console-reviewers'],
    'viewer': ['console-viewers'],
    'outsider': [],
}
client = {
    'clientId': 'job-console',
    'enabled': True,
    'publicClient': False,
    'secret': secrets.token_urlsafe(32),
    'standardFlowEnabled': True,
    'directAccessGrantsEnabled': True,
    'redirectUris': ['http://127.0.0.1:4466/oauth2/callback'],
    'protocolMappers': [
        {'name': 'console-groups', 'protocol': 'openid-connect', 'protocolMapper': 'oidc-group-membership-mapper',
         'config': {'full.path': 'false', 'claim.name': 'groups', 'access.token.claim': 'true', 'id.token.claim': 'false'}},
        {'name': 'console-api-audience', 'protocol': 'openid-connect', 'protocolMapper': 'oidc-audience-mapper',
         'config': {'included.custom.audience': 'job-console-api', 'access.token.claim': 'true', 'id.token.claim': 'false'}},
    ],
}
json.dump({
    'realm': 'job-console',
    'enabled': True,
    'sslRequired': 'none',
    'accessTokenLifespan': 300,
    'clients': [client],
    'groups': [{'name': group} for group in sorted({g for roles in users.values() for g in roles})],
    'users': [
        {'id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'urn:gretl-console:local:' + user)), 'username': user,
         'enabled': True, 'emailVerified': True, 'firstName': user, 'lastName': 'Test',
         'email': user + '@example.invalid', 'groups': groups,
         'credentials': [{'type': 'password', 'value': secrets.token_urlsafe(20), 'temporary': False}]}
        for user, groups in users.items()
    ],
}, __import__('sys').stdout)
PY
fi
if ! k get secret job-console-oauth2-proxy >/dev/null 2>&1; then
  {
    printf 'OAUTH2_PROXY_CLIENT_SECRET='
    k get secret job-console-local-realm -o jsonpath='{.data.realm\.json}' |
      base64 --decode | jq -er '.clients[0].secret'
    printf 'OAUTH2_PROXY_COOKIE_SECRET=%s\n' "$(openssl rand -base64 32 | tr '+/' '-_')"
  } | k create secret generic job-console-oauth2-proxy --from-env-file=/dev/stdin
fi
k apply -f deploy/local-identity.yaml
k rollout status deployment/job-console-keycloak --timeout=180s
k rollout status deployment/job-console-oauth2-proxy --timeout=180s
