import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import { authenticator, can, principalId } from './identity.js';

test('verifies the access token and compares exact user and group grants', async t => {
  const issuer = 'https://identity.example';
  const audience = 'job-console-api';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const verify = authenticator({ issuer, audience, groups: 'groups', jwks: `http://127.0.0.1:${address.port}` });
  const sign = (iss = issuer, aud = audience, exp = Math.floor(Date.now() / 1000) + 300) =>
    new SignJWT({ groups: ['Console-Operators'], preferred_username: 'Alex' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(iss).setAudience(aud).setSubject('account-1')
      .setExpirationTime(exp).sign(privateKey);
  const request = (token?: string) => ({ headers: {
    authorization: token && 'Bearer ' + token, 'x-user': 'admin', 'x-groups': 'console-admins',
  } }) satisfies Pick<FastifyRequest, 'headers'>;
  const token = await sign();
  const user = await verify(request(token));
  assert.equal(user.displayName, 'Alex');
  assert.deepEqual(user.groups, ['Console-Operators']);
  assert.equal(can(user, 'run', { run: { users: [principalId(user)], groups: [] } }), true);
  assert.equal(can(user, 'view', { run: { users: [principalId(user)], groups: [] } }), true);
  assert.equal(can(user, 'run', { run: { users: [], groups: ['console-operators'] } }), false);
  assert.equal(can(user, 'approve', { manage: { users: [principalId(user)], groups: [] } }), false);
  await assert.rejects(verify(request()));
  await assert.rejects(verify(request(await sign('https://wrong.example'))));
  await assert.rejects(verify(request(await sign(issuer, 'job-console'))));
  await assert.rejects(verify(request(await sign(issuer, audience, Math.floor(Date.now() / 1000) - 60))));
  const parts = token.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(verify(request(parts.join('.'))));
});
