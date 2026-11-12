import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const k = (args: string[], input?: string) => execFileSync('kubectl', [
  '--context', 'rancher-desktop', '-n', 'job-console', ...args,
], { input, encoding: 'utf8' }).trim();
const template = JSON.parse(k(['get', 'workflowtemplate', 'job-console-sync', '-o', 'json']));
const spec = template.spec;
spec.templates[0].container.env.push({ name: 'OIDC_DEV_MODE', value: 'false' }, { name: 'ALLOW_PREVIEW', value: 'true' });
spec.arguments.parameters[0].value = 'preview-should-be-denied';
const active = () => k(['get', 'configmap', 'job-console-catalog', '-o', 'jsonpath={.metadata.annotations.job-console\\.io/revision}']);
const previous = active();
const name = k(['create', '-f', '-', '-o', 'jsonpath={.metadata.name}'], JSON.stringify({
  apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow',
  metadata: { generateName: 'console-production-preview-', labels: { 'job-console.io/test-fixture': 'true' } },
  spec,
}));
try {
  let phase = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    phase = k(['get', 'workflow', name, '-o', 'jsonpath={.status.phase}']);
    if (['Succeeded', 'Failed', 'Error'].includes(phase)) break;
    await delay(2000);
  }
  assert.equal(phase, 'Failed');
  assert.match(k(['logs', '-l', 'workflows.argoproj.io/workflow=' + name, '-c', 'main']), /Git branch is not allowed/);
  assert.equal(active(), previous);
  console.log('The seeder rejected a branch preview with development mode disabled');
} finally {
  k(['delete', 'workflow', name, '--ignore-not-found']);
}
