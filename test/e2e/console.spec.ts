import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { origin, signIn } from './login';

const sample = resolve(process.env.JOBS_DIR ?? '../gretl-runtime-jobs', 'testdata/sample.csv');
const pageRoot = '/job-console';
const apiRoot = '/job-console-api/api';
const kubectl = (...args: string[]) => execFileSync('kubectl', [
  '--context', 'rancher-desktop', '-n', 'job-console', ...args,
], { encoding: 'utf8' });

test.beforeEach(async ({ page }) => { await signIn(page, 'admin'); });

test('E2E-01/02: Headlamp navigation, defaults, validation and typed GRETL parameters', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  for (const name of ['Jobs', 'Ausführungen', 'Zeitpläne']) {
    await expect(page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: 'Workloads' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Hello GRETL starten' }).click();
  await page.reload();
  await expect(page.getByLabel('Wiederholungen')).toHaveValue('1');
  await page.getByRole('button', { name: 'Job starten' }).click();
  await expect(page.getByText('Gib einen Wert ein.')).toBeVisible();
  await page.getByLabel('Nachricht').fill('E2E typed $(HOME)');
  await page.getByLabel('Wiederholungen').fill('2');
  await page.getByRole('checkbox', { name: 'Grossbuchstaben' }).check();
  await page.getByRole('button', { name: 'Job starten' }).click();
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('pre')).toContainText('E2E TYPED $(HOME)');
  const logs = await page.locator('pre').textContent();
  expect(logs?.match(/E2E TYPED \$\(HOME\)/g)).toHaveLength(2);
  const run = page.url().split('/').pop()!;
  expect(kubectl('get', 'workflow', run, '-o', 'jsonpath={.status.phase}')).toBe('Succeeded');
});

test('E2E-03: Browser upload, enum, RustFS object and GRETL CSV analysis', async ({ page }) => {
  await page.goto(pageRoot + '/jobs/csv-analyzer');
  await page.getByRole('button', { name: 'Job starten' }).click();
  await expect(page.getByText('Wähle eine Datei aus.')).toBeVisible();
  const input = page.getByLabel('CSV-Datei');
  const label = page.locator('label').filter({ has: input });
  await expect(input).toHaveAccessibleDescription('Wähle eine Datei aus.');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(label).toHaveAttribute('tabindex', '-1');
  await expect(label).not.toHaveAttribute('role', 'button');
  await page.getByRole('combobox', { name: 'Trennzeichen' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  await expect(label).toHaveCSS('outline-style', 'solid');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(sample);
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await expect(input).not.toHaveAttribute('aria-describedby', /.+/);
  await expect(page.getByText('Wähle eine Datei aus.')).toHaveCount(0);
  await expect(page.getByText('sample.csv', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'Trennzeichen' }).click();
  await expect(page.getByRole('option', { name: 'Tabulator' })).toBeVisible();
  await page.getByRole('option', { name: 'Komma' }).click();
  const network = await page.context().newCDPSession(page);
  await network.send('Network.emulateNetworkConditions', {
    offline: false, latency: 400, downloadThroughput: -1, uploadThroughput: -1,
  });
  await page.getByRole('button', { name: 'Job starten' }).click();
  await expect(page.getByRole('progressbar', { name: 'Startfortschritt' })).toBeVisible();
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('pre')).toContainText('records=3 columns=2');
  const run = page.url().split('/').pop()!;
  const key = 'runs/' + run + '/inputs/inputFile';
  const head = `
    import {S3Client, HeadObjectCommand} from '@aws-sdk/client-s3';
    const result = await new S3Client({endpoint:process.env.S3_ENDPOINT,forcePathStyle:true,
      requestChecksumCalculation:'WHEN_REQUIRED'}).send(new HeadObjectCommand({Bucket:process.env.S3_BUCKET,Key:process.argv[1]}));
    console.log(result.ContentLength);
  `;
  expect(Number(kubectl('exec', 'deploy/launcher', '--', 'node', '--input-type=module', '-e', head, key))).toBeGreaterThan(0);
  const initStatus = kubectl('get', 'pod', '-l', 'workflows.argoproj.io/workflow=' + run,
    '-o', 'jsonpath={.items[0].status.initContainerStatuses[0].state.terminated.exitCode}');
  expect(initStatus).toBe('0');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Herunterladen' }).click();
  expect((await download).suggestedFilename()).toBe('report.json');
  const artifacts = await page.request.get(apiRoot + '/runs/' + run + '/artifacts');
  const [report] = await artifacts.json();
  const result = await page.request.get(apiRoot + '/runs/' + run + '/artifacts/' + report.id);
  expect(await result.json()).toEqual({ records: 3, columns: 2 });
});

test('E2E-05: failed GRETL run retains its error log', async ({ page }) => {
  await page.goto(pageRoot + '/jobs/hello-gretl');
  await page.getByLabel('Nachricht').fill('E2E failure');
  await page.getByLabel('Wiederholungen').fill('0');
  await page.getByRole('button', { name: 'Job starten' }).click();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('pre')).toContainText('count must be between 1 and 1000');
});

test('E2E-06: cancel in Headlamp terminates the Pod and allows deletion', async ({ page }) => {
  const fixture = kubectl('create', '-f', 'test/e2e/fixtures/wait-workflow.yaml', '-o', 'jsonpath={.metadata.name}');
  try {
    await page.goto(pageRoot + '/runs/' + fixture);
    await expect(page.locator('pre')).toContainText('waiting for cancellation', { timeout: 90_000 });
    const run = page.url().split('/').pop()!;
    const pods = () => kubectl('get', 'pod', '-l', 'workflows.argoproj.io/workflow=' + run, '-o', 'name').trim();
    expect(pods()).toMatch(/^pod\//);
    await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await expect(page.getByText('Canceled', { exact: true })).toBeVisible({ timeout: 90_000 });
    expect(kubectl('get', 'workflow', run, '-o', 'jsonpath={.spec.shutdown}')).toBe('Terminate');
    expect(kubectl('get', 'pod', '-l', 'workflows.argoproj.io/workflow=' + run, '-o', 'jsonpath={.items[*].status.phase}'))
      .not.toMatch(/Running|Pending/);
    expect((await (await page.request.get(apiRoot + '/runs/' + run)).json()).status).toBe('Canceled');
    await page.getByRole('button', { name: 'Löschen', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ausführungen' })).toBeVisible();
    expect((await page.request.get(apiRoot + '/runs/' + run)).status()).toBe(404);
  } finally {
    kubectl('delete', 'workflow', fixture, '--ignore-not-found');
  }
});

test('schedule details and inherited light and dark Headlamp themes', async ({ browser }) => {
  const colors: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme: mode });
    try {
      const page = await context.newPage();
      await signIn(page, 'admin');
      await page.goto('http://127.0.0.1:4466' + pageRoot + '/schedules');
      await expect(page.getByRole('heading', { name: 'Zeitpläne' })).toBeVisible();
      await expect(page.getByRole('cell', { name: 'Europe/Zurich' })).toBeVisible();
      await expect(page.getByRole('cell', { name: 'H H(1-3) * * *' })).toBeVisible();
      colors.push(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor));
      if (mode === 'light') {
        await page.getByRole('link', { name: 'Zeitbericht' }).click();
        await expect(page.getByLabel('Nachricht')).toHaveValue('Zeitbericht gestartet');
        await page.getByRole('button', { name: 'Job starten' }).click();
        await expect(page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 90_000 });
        await expect(page.locator('pre')).toContainText('Zeitbericht gestartet');
      }
    } finally { await context.close(); }
  }
  expect(colors[0]).not.toBe(colors[1]);
});

test('cross-origin browser requests are denied in local mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  const target = 'http://localhost:4466' + apiRoot + '/jobs';
  const result = await page.evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), target);
  expect(result).toBe('blocked');
  const response = await page.request.get('http://127.0.0.1:4466' + apiRoot + '/jobs', {
    headers: { Origin: 'http://localhost:4466', 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(response.status()).toBe(403);
  expect(response.headers()['access-control-allow-origin']).toBeUndefined();
});


test('configured Git source and manual synchronization are visible in Headlamp', async ({ page }) => {
  await page.goto(pageRoot + '/deployment');
  await expect(page.getByRole('heading', { name: 'Bereitstellung' })).toBeVisible();
  await expect(page.getByText(/github\.com.*gretl-runtime-jobs/)).toBeVisible();
  await expect(page.getByText(/feature\/v2-job-console · [a-f0-9]{40}/)).toBeVisible();
  await page.getByRole('button', { name: 'Jetzt synchronisieren' }).click();
  await expect(page.getByText(/Synchronized feature\/v2-job-console at [a-f0-9]{40}/)).toBeVisible({ timeout: 90_000 });
});


test('OIDC identities enforce catalogue, start, run and sync permissions', async ({ browser, page }) => {
  const me = await page.request.get(apiRoot + '/me');
  expect(await me.json()).toMatchObject({ displayName: 'admin', admin: true });
  const operator = await browser.newPage();
  const viewer = await browser.newPage();
  const outsider = await browser.newPage();
  try {
    expect((await outsider.request.get('http://127.0.0.1:4466' + apiRoot + '/jobs')).status()).toBe(401);
    await signIn(operator, 'operator');
    await signIn(viewer, 'viewer');
    await signIn(outsider, 'outsider');
    const path = 'http://127.0.0.1:4466' + apiRoot;
    const start = path + '/jobs/hello-gretl/runs';
    const data = { parameters: { message: 'OIDC operator' } };
    expect((await operator.request.post(start, { data })).status()).toBe(403);
    const created = await operator.request.post(start, { data, headers: origin });
    expect(created.status()).toBe(201);
    const run = await created.json();
    expect(run.starterName).toBe('operator');
    expect((await viewer.request.post(start, { data, headers: origin })).status()).toBe(403);
    expect((await viewer.request.get(path + '/runs/' + run.name)).status()).toBe(200);
    for (const suffix of ['', '/logs', '/artifacts']) {
      expect((await outsider.request.get(path + '/runs/' + run.name + suffix)).status()).toBe(404);
    }
    const headers = { ...origin, 'X-User': 'admin', 'X-Groups': 'console-admins' };
    expect(await (await outsider.request.get(path + '/jobs', { headers })).json()).toEqual([]);
    expect((await outsider.request.post(path + '/synchronizations', { headers, data: {} })).status()).toBe(403);
    await outsider.getByRole('link', { name: 'Abmelden' }).click();
    await expect(outsider.getByRole('heading', { name: 'Abgemeldet' })).toBeVisible({ timeout: 30_000 });
    expect((await outsider.request.get(path + '/jobs')).status()).toBe(401);
    await outsider.getByRole('link', { name: 'Anmelden', exact: true }).click();
    await expect(outsider.locator('#username')).toBeVisible({ timeout: 30_000 });
  } finally {
    await Promise.all([operator.close(), viewer.close(), outsider.close()]);
  }
});

test('administrator pauses a schedule and the pause survives synchronization and launcher restart', async ({ page }) => {
  const path = apiRoot + '/schedules/scheduled-report';
  try {
    await page.goto(pageRoot + '/schedules');
    await page.getByRole('button', { name: 'Pausieren' }).click();
    await expect(page.getByRole('cell', { name: 'Suspendiert' })).toBeVisible();
    const result = await page.request.post(apiRoot + '/synchronizations', { headers: origin, data: {} });
    expect(result.status()).toBe(201);
    const sync = await result.json();
    await expect.poll(async () => (await (await page.request.get(apiRoot + '/synchronizations/' + sync.name)).json()).status,
      { timeout: 90_000 }).toBe('Succeeded');
    const launcherUID = () => kubectl('get', 'pod', '-l', 'app=launcher', '-o',
      'jsonpath={.items[?(@.status.phase=="Running")].metadata.uid}');
    const previous = launcherUID();
    expect(previous).not.toBe('');
    kubectl('rollout', 'restart', 'deployment/launcher');
    kubectl('rollout', 'status', 'deployment/launcher', '--timeout=90s');
    await expect.poll(() => {
      const current = launcherUID();
      return Boolean(current && current !== previous);
    }, { timeout: 45_000 }).toBe(true);
    expect(kubectl('get', 'cronworkflow', 'scheduled-report', '-o', 'jsonpath={.spec.suspend}')).toBe('true');
    await page.reload();
    await expect(page.getByRole('cell', { name: 'Suspendiert' })).toBeVisible({ timeout: 45_000 });
  } finally {
    expect((await page.request.post(path + '/resume', { headers: origin })).status()).toBe(200);
  }
});

test('an expired browser session returns to the configured OIDC login', async ({ page, context }) => {
  const cookies = (await context.cookies()).filter(cookie => cookie.name.startsWith('_oauth2_proxy'));
  expect(cookies.length).toBeGreaterThan(0);
  await context.addCookies(cookies.map(cookie => ({ ...cookie, expires: Math.floor(Date.now() / 1000) + 1 })));
  await expect(page.locator('#password')).toBeVisible({ timeout: 30_000 });
});

test('reviewer login survives another Headlamp request in the same browser session', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await signIn(page, 'reviewer', async () => {
      const background = await page.request.get('/config', { maxRedirects: 0 });
      expect(background.status()).toBe(302);
    });
    const response = await page.request.get(apiRoot + '/me');
    expect(await response.json()).toMatchObject({ displayName: 'reviewer', canApprove: true });
    await page.getByRole('navigation', { name: 'Navigation' }).getByRole('button', { name: 'Freigaben' }).click();
    await expect(page.getByRole('heading', { name: 'Freigaben', exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
});
