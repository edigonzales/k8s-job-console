import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { origin, signIn } from './login';

const base = 'http://127.0.0.1:4466';
const api = base + '/job-console-api/api';
const sample = resolve(process.env.JOBS_DIR ?? '../gretl-runtime-jobs', 'testdata/publication.csv');
const file = () => ({ name: 'publication.csv', mimeType: 'text/csv', buffer: readFileSync(sample) });
const kubectl = (...args: string[]) => execFileSync('kubectl', ['--context', 'rancher-desktop', '-n', 'job-console', ...args],
  { encoding: 'utf8' });
const runURL = (name: string) => api + '/runs/' + name;
const decisionURL = (name: string) => runURL(name) + '/approvals/review/decision';
const approve = { decision: 'approve', values: { publicationNote: 'Geprüft $(HOME) {{workflow.name}} "Grüezi";' } };
const reject = { decision: 'reject', comment: 'Prüfbericht zurückgewiesen' };

async function start(actor: Page) {
  const response = await actor.request.post(api + '/jobs/csv-publication/runs', {
    headers: origin, multipart: { parameters: '{}', inputFile: file() },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).name as string;
}
async function wait(actor: Page, name: string, status: string) {
  await expect.poll(async () => (await (await actor.request.get(runURL(name))).json()).status,
    { timeout: 90_000 }).toBe(status);
}

test('a separate reviewer approves the pinned CSV and the decision survives restarts', async ({ browser, page }) => {
  test.setTimeout(210_000);
  await signIn(page, 'admin');
  await page.goto(base + '/job-console/jobs/csv-publication');
  await page.getByLabel('CSV-Datei').setInputFiles(sample);
  await page.getByRole('button', { name: 'Ablauf starten' }).click();
  await expect(page.getByText('AwaitingInput', { exact: true })).toBeVisible({ timeout: 90_000 });
  const name = page.url().split('/').pop()!;
  await expect(page.getByText('Du hast diese Ausführung gestartet.')).toBeVisible();
  expect((await page.request.post(decisionURL(name), { headers: origin, data: approve })).status()).toBe(403);
  expect((await page.request.post(api + '/jobs/publish-csv/runs', { headers: origin, data: {} })).status()).toBe(404);
  expect(kubectl('get', 'pod', '-l', 'workflows.argoproj.io/workflow=' + name,
    '-o', 'jsonpath={.items[*].status.phase}')).not.toMatch(/Running|Pending/);
  const queued = await start(page);
  await wait(page, queued, 'Queued');
  expect(kubectl('get', 'pod', '-l', 'workflows.argoproj.io/workflow=' + queued, '-o', 'name').trim()).toBe('');
  expect((await page.request.post(runURL(queued) + '/cancel', { headers: origin })).status()).toBe(200);
  await wait(page, queued, 'Canceled');
  for (const deployment of ['launcher', 'workflow-controller']) kubectl('rollout', 'restart', 'deployment/' + deployment);
  for (const deployment of ['launcher', 'workflow-controller']) kubectl('rollout', 'status', 'deployment/' + deployment, '--timeout=90s');
  const reviewer = await browser.newPage();
  try {
    await signIn(reviewer, 'reviewer');
    await reviewer.goto(base + '/job-console/approvals');
    await expect(reviewer.getByText('admin ·', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(reviewer.getByRole('link', { name: 'Prüfbericht · review.json' })).toBeVisible();
    await expect(reviewer.getByLabel('Publikationshinweis')).toBeVisible();
    await reviewer.getByRole('link', { name, exact: true }).click();
    await expect(reviewer.getByText('Prüfbericht · review.json')).toBeVisible();
    await reviewer.getByLabel('Publikationshinweis').fill(approve.values.publicationNote);
    await reviewer.getByRole('button', { name: 'Freigeben' }).click();
    await wait(reviewer, name, 'Succeeded');
    expect((await reviewer.request.post(decisionURL(name), { headers: origin, data: approve })).status()).toBe(200);
    const files = await (await reviewer.request.get(runURL(name) + '/artifacts')).json();
    const published = files.find((item: { name: string }) => item.name === 'published.csv');
    const manifest = files.find((item: { name: string }) => item.name === 'publication.json');
    expect(await (await reviewer.request.get(runURL(name) + '/artifacts/' + published.id)).body()).toEqual(readFileSync(sample));
    expect(await (await reviewer.request.get(runURL(name) + '/artifacts/' + manifest.id)).json()).toEqual({
      note: approve.values.publicationNote,
    });
    expect((await (await reviewer.request.get(runURL(name))).json()).steps
      .filter((step: { name: string }) => step.name === 'publish')).toHaveLength(1);
    const rerun = await page.request.post(runURL(name) + '/rerun', { headers: origin });
    expect(rerun.status()).toBe(201);
    const next = (await rerun.json()).name as string;
    expect(next).not.toBe(name);
    await wait(page, next, 'AwaitingInput');
    expect((await (await page.request.get(runURL(next))).json()).approvals[0].decision).toBeUndefined();
    const inputKeys = (id: string) => JSON.parse(JSON.parse(kubectl('get', 'workflow', id, '-o', 'json'))
      .metadata.annotations['job-console.io/input-files']);
    expect(inputKeys(next).inputFile).toBe('runs/' + next + '/inputs/inputFile');
    expect(inputKeys(next).inputFile).not.toBe(inputKeys(name).inputFile);
    await page.request.post(runURL(next) + '/cancel', { headers: origin });
    await wait(page, next, 'Canceled');
  } finally { await reviewer.close(); }
});

test('rejection blocks publication and conflicting decisions do not overwrite each other', async ({ browser, page }) => {
  await signIn(page, 'operator');
  const reviewer = await browser.newPage();
  const admin = await browser.newPage();
  try {
    await signIn(reviewer, 'reviewer');
    await signIn(admin, 'admin');
    const rejected = await start(page);
    await wait(page, rejected, 'AwaitingInput');
    expect((await page.request.post(decisionURL(rejected), { headers: origin, data: approve })).status()).toBe(403);
    expect((await reviewer.request.post(decisionURL(rejected), { headers: origin, data: reject })).status()).toBe(200);
    await wait(reviewer, rejected, 'Rejected');
    expect((await (await reviewer.request.get(runURL(rejected) + '/artifacts')).json())
      .some((item: { name: string }) => item.name === 'published.csv')).toBe(false);
    const competing = await start(page);
    await wait(page, competing, 'AwaitingInput');
    const [left, right] = await Promise.all([
      reviewer.request.post(decisionURL(competing), { headers: origin, data: approve }),
      admin.request.post(decisionURL(competing), { headers: origin, data: reject }),
    ]);
    expect([left.status(), right.status()].sort()).toEqual([200, 409]);
    await wait(page, competing, left.ok() ? 'Succeeded' : 'Rejected');
    expect((await (await page.request.get(runURL(competing))).json()).approvals[0].decision)
      .toBe(left.ok() ? 'approved' : 'rejected');
  } finally {
    await Promise.all([reviewer.close(), admin.close()]);
  }
});

test('deadline and cancellation prevent approval of a waiting workflow', async ({ browser, page }) => {
  await signIn(page, 'operator');
  const reviewer = await browser.newPage();
  try {
    await signIn(reviewer, 'reviewer');
    const expired = await start(page);
    await wait(page, expired, 'AwaitingInput');
    kubectl('patch', 'workflow', expired, '--type=merge', '-p', '{"spec":{"activeDeadlineSeconds":1}}');
    await wait(page, expired, 'Failed');
    expect((await reviewer.request.post(decisionURL(expired), { headers: origin, data: approve })).status()).toBe(409);
    const canceled = await start(page);
    await wait(page, canceled, 'AwaitingInput');
    expect((await page.request.post(runURL(canceled) + '/cancel', { headers: origin })).status()).toBe(200);
    await wait(page, canceled, 'Canceled');
    const audit = await (await page.request.get(runURL(canceled))).json();
    expect(audit.canceledBy).toBe(audit.starter);
    expect(Date.parse(audit.canceledAt)).toBeGreaterThan(Date.parse(audit.created));
    expect((await reviewer.request.post(decisionURL(canceled), { headers: origin, data: approve })).status()).toBe(409);
    for (const name of [expired, canceled]) {
      expect((await (await page.request.get(runURL(name))).json()).steps
        .some((step: { name: string }) => step.name === 'publish')).toBe(false);
    }
  } finally { await reviewer.close(); }
});
