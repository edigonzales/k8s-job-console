import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const context = ['--context', 'rancher-desktop', '-n', 'job-console'];
const realm = JSON.parse(Buffer.from(execFileSync('kubectl', [...context, 'get', 'secret', 'job-console-local-realm',
  '-o', 'jsonpath={.data.realm\\.json}'], { encoding: 'utf8' }), 'base64').toString('utf8'));
const user = realm.users.find((account: { username: string }) => account.username === 'viewer');
const provider = 'http://127.0.0.1:4466/identity/realms/job-console/protocol/openid-connect/token';
const response = await fetch(provider, { method: 'POST', body: new URLSearchParams({
  client_id: 'job-console', client_secret: realm.clients[0].secret, username: 'viewer',
  password: user.credentials[0].value, grant_type: 'password', scope: 'openid',
}) });
assert.equal(response.status, 200);
const session = await response.json() as { access_token: string; id_token: string };
const child = spawn('kubectl', [...context, 'port-forward', '--address', '127.0.0.1', 'deploy/launcher', ':8080'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Launcher port-forward did not become ready')), 15_000);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Launcher port-forward stopped')); });
    child.stdout.on('data', (chunk: Buffer) => {
      const match = /Forwarding from 127\.0\.0\.1:(\d+) -> 8080/.exec(chunk.toString());
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const me = async (token: string) => fetch('http://127.0.0.1:' + port + '/api/me', {
    headers: { Authorization: 'Bearer ' + token, 'X-User': 'admin', 'X-Groups': 'console-admins' },
  });
  const access = await me(session.access_token);
  assert.equal(access.status, 200);
  assert.equal((await access.json() as { displayName: string }).displayName, 'viewer');
  assert.equal((await me(session.id_token)).status, 401);
  const parts = session.access_token.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  assert.equal((await me(parts.join('.'))).status, 401);
  console.log('Signed Keycloak access token accepted; ID token and modified signature rejected');
} finally {
  if (child.exitCode === null) {
    const finished = once(child, 'exit');
    child.kill();
    await finished;
  }
}
