import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { signIn } from './login.ts';

const base = 'http://127.0.0.1:4466';
const k = (args: string[], input?: string) => execFileSync('kubectl', [
  '--context', 'rancher-desktop', '-n', 'job-console', ...args,
], { input, encoding: 'utf8' }).trim();
const bytes = 100 * 1024 ** 2;
const run = k(['create', '-f', '-', '-o', 'jsonpath={.metadata.name}'], JSON.stringify({
  apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow',
  metadata: {
    generateName: 'console-stream-download-',
    labels: { 'app.kubernetes.io/managed-by': 'job-console', 'job-console.io/job-id': 'csv-analyzer',
      'job-console.io/test-fixture': 'true' },
    annotations: { 'job-console.io/output-labels': '{"payload":"Streaming fixture"}' },
  },
  spec: {
    entrypoint: 'data', activeDeadlineSeconds: 150, automountServiceAccountToken: false,
    executor: { serviceAccountName: 'job-console-executor' },
    artifactRepositoryRef: { configMap: 'job-console-artifacts', key: 'rustfs' },
    securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
    volumes: [{ name: 'outputs', emptyDir: {} }],
    templates: [{
      name: 'data',
      container: {
        image: 'node:22-bookworm-slim', command: ['node', '-e'],
        args: [`const fs = require('node:fs'); fs.ftruncateSync(fs.openSync('/outputs/payload.bin', 'w'), ${bytes})`],
        volumeMounts: [{ name: 'outputs', mountPath: '/outputs' }],
      },
      outputs: { artifacts: [{ name: 'payload', path: '/outputs/payload.bin', archive: { none: {} } }] },
    }],
  },
}));

const browser = await chromium.launch();
try {
  const viewer = await browser.newPage();
  await signIn(viewer, 'viewer');
  k(['wait', '--for=jsonpath={.status.phase}=Succeeded', 'workflow/' + run, '--timeout=150s']);
  const path = base + '/job-console-api/api/runs/' + run + '/artifacts';
  const [artifact] = await (await viewer.request.get(path)).json();
  assert.equal(artifact.size, bytes);
  assert.equal(artifact.available, true);
  const url = path + '/' + encodeURIComponent(artifact.id);
  const cookie = (await viewer.context().cookies(base)).map(item => item.name + '=' + item.value).join('; ');
  const rss = () => Number(k(['exec', 'deploy/launcher', '--', 'awk', '/VmRSS/{print $2}', '/proc/1/status']));
  const baseline = rss();
  let peak = baseline;
  let total = 0;
  let lastCheck = 0;
  const response = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="payload.bin"');
  const reader = response.body!.getReader();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.length;
    if (total - lastCheck >= 4 * 1024 ** 2) {
      peak = Math.max(peak, rss());
      lastCheck = total;
      await delay(150);
    }
  }
  assert.equal(total, bytes);
  assert.ok(peak - baseline < 80 * 1024);
  const outsider = await browser.newPage();
  await signIn(outsider, 'outsider');
  assert.equal((await outsider.request.get(url)).status(), 404);
  console.log(`Authenticated download ${total} bytes, launcher RSS baseline ${baseline} KiB, peak ${peak} KiB; outsider rejected`);
} finally {
  await browser.close();
  k(['delete', 'workflow', run, '--ignore-not-found']);
}
