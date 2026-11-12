import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

const local = 'http://127.0.0.1:4466';
export const origin = { Origin: local };
type User = 'admin' | 'operator' | 'reviewer' | 'viewer' | 'outsider';

function password(user: User): string {
  const raw = execFileSync('kubectl', ['--context', 'rancher-desktop', '-n', 'job-console',
    'get', 'secret', 'job-console-local-realm', '-o', 'jsonpath={.data.realm\\.json}'], { encoding: 'utf8' });
  const realm = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const value = realm.users.find((account: { username: string }) => account.username === user)?.credentials[0]?.value;
  if (!value) throw new Error('Missing local test credential');
  return value;
}

export async function signIn(page: Page, user: User) {
  await page.goto(local + '/');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password(user));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible({ timeout: 30_000 });
}
