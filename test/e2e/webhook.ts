import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { origin, signIn } from './login.ts';

const api = 'http://127.0.0.1:4466/job-console-api/api';
const k = (...args: string[]) => execFileSync('kubectl', ['--context', 'rancher-desktop', '-n', 'job-console', ...args],
  { encoding: 'utf8' }).trim();
const fixture = 'test/e2e/fixtures/webhook.yaml';
const secret = 'job-console-test-webhook';
const previous = JSON.parse(k('get', 'configmap', 'job-console-sync', '-o', 'json')).data;
const patch = (data: Record<string, string | null>) => k('patch', 'configmap', 'job-console-sync', '--type=merge',
  '-p', JSON.stringify({ data }));
const sync = () => execFileSync('./scripts/deploy-jobs.sh', [], { encoding: 'utf8' });
const events = () => k('logs', 'deployment/job-console-test-webhook').split('\n').filter(Boolean)
  .map(line => JSON.parse(line));
const wait = (page: Page, run: string, phase: string) => expect.poll(async () =>
  (await (await page.request.get(api + '/runs/' + run)).json()).status, { timeout: 120_000 }).toBe(phase);

const browser = await chromium.launch();
let receiver = false;
let credential = false;
let configured = false;
let waiting: string | undefined;
let admin: Page | undefined;
try {
  k('create', '-f', fixture);
  receiver = true;
  k('rollout', 'status', 'deployment/job-console-test-webhook', '--timeout=120s');
  k('create', 'secret', 'generic', secret, '--from-literal=WEBHOOK_URL=http://job-console-test-webhook:8080/');
  credential = true;
  patch({ NOTIFIER_IMAGE: 'job-console-control:local', NOTIFIER_SECRET_NAME: secret });
  configured = true;
  sync();

  admin = await browser.newPage();
  const reviewer = await browser.newPage();
  await signIn(admin, 'admin');
  await signIn(reviewer, 'reviewer');
  const failed = await admin.request.post(api + '/jobs/hello-gretl/runs', {
    headers: origin, data: { parameters: { message: 'Webhook test', count: 0 } },
  });
  assert.equal(failed.status(), 201);
  const failedRun = (await failed.json()).name;
  await wait(admin, failedRun, 'Failed');
  assert.ok(events().some(item => item.status === 202 && item.event.run === failedRun &&
    item.event.event === 'workflow_failed' && item.event.status === 'Failed'));
  console.log('Technical failure reached the local webhook receiver');

  const buffer = readFileSync(resolve(process.env.JOBS_DIR ?? '../gretl-runtime-jobs', 'testdata/publication.csv'));
  const started = await admin.request.post(api + '/jobs/csv-publication/runs', {
    headers: origin, multipart: { parameters: '{}', inputFile: { name: 'publication.csv', mimeType: 'text/csv', buffer } },
  });
  assert.equal(started.status(), 201);
  waiting = (await started.json()).name as string;
  await wait(admin, waiting, 'AwaitingInput');
  const notices = events().filter(item => item.event.run === waiting && item.event.event === 'approval_required');
  assert.equal(notices.length, 2);
  assert.ok(notices.every(item => item.status === 503 && item.event.status === 'AwaitingInput'));
  assert.equal((await reviewer.request.post(api + '/runs/' + waiting + '/approvals/review/decision', {
    headers: origin, data: { decision: 'approve', values: { publicationNote: 'Webhook test' } },
  })).status(), 200);
  await wait(admin, waiting, 'Succeeded');
  console.log('Two failed webhook attempts preserved the approval and successful publication');
  waiting = undefined;
} finally {
  if (waiting && admin) await admin.request.post(api + '/runs/' + waiting + '/cancel', { headers: origin }).catch(() => {});
  try {
    if (configured) {
      patch({ NOTIFIER_IMAGE: previous.NOTIFIER_IMAGE ?? null, NOTIFIER_SECRET_NAME: previous.NOTIFIER_SECRET_NAME ?? null });
      sync();
    }
  } finally {
    if (credential) k('delete', 'secret', secret);
    if (receiver) k('delete', '-f', fixture);
    await browser.close();
  }
}
