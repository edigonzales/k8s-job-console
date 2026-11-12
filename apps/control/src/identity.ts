import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { access } from './catalog.js';

export interface Principal {
  issuer: string;
  subject: string;
  displayName: string;
  groups: string[];
}
export type Access = z.infer<typeof access>;
export type Action = keyof Access;

export const principalId = (user: Principal) => JSON.stringify([user.issuer, user.subject]);
export const isAdmin = (user: Principal) =>
  user.groups.some(group => (process.env.CONSOLE_ADMIN_GROUPS ?? '').split(',').includes(group));

function granted(user: Principal, rule: Access[Action]) {
  return Boolean(rule && (rule.users.includes(principalId(user)) || rule.groups.some(group => user.groups.includes(group))));
}

export function can(user: Principal, action: Action, policy: Access) {
  if (action === 'view') return isAdmin(user) || Object.values(policy).some(rule => granted(user, rule));
  if (action === 'manage' && isAdmin(user)) return true;
  return granted(user, policy[action]);
}

export function authenticator(settings: { issuer: string; jwks: string; audience: string; groups: string }) {
  const jwks = createRemoteJWKSet(new URL(settings.jwks));
  return async (request: Pick<FastifyRequest, 'headers'>): Promise<Principal> => {
    const token = request.headers.authorization?.match(/^Bearer ([^ ]+)$/i)?.[1];
    if (!token) throw new Error('Missing access token');
    const { payload } = await jwtVerify(token, jwks, {
      issuer: settings.issuer,
      audience: settings.audience,
      algorithms: ['RS256'],
      requiredClaims: ['iss', 'sub', 'aud', 'exp'],
    });
    const groups = payload[settings.groups];
    if (!payload.iss || !payload.sub || (groups !== undefined &&
        (!Array.isArray(groups) || !groups.every(group => typeof group === 'string' && group.length)))) {
      throw new Error('Invalid access-token claims');
    }
    return {
      issuer: payload.iss,
      subject: payload.sub,
      displayName: typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub,
      groups: groups ?? [],
    };
  };
}
