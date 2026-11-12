import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import { parseJob, resolveCron, validateValues } from './catalog.js';
import { cronWorkflow, workflow, type Source } from './workflows.js';
import type { argoClient, Workflow } from './argo.js';
import { buildApp, runState } from './launcher.js';
import type { storage } from './storage.js';

const base = {
  id: 'hello', schemaVersion: 2, name: 'Hello', description: 'Example', runtime: 'gretl', script: 'job.groovy',
  parameters: [
    { name: 'message', label: 'Message', type: 'text', required: true },
    { name: 'number', label: 'Number', type: 'integer', default: 1 },
    { name: 'toggle', label: 'Toggle', type: 'boolean', default: false },
    { name: 'when', label: 'Date', type: 'date' },
    { name: 'separator', label: 'Separator', type: 'enum', options: [{ value: ',', label: 'Comma' }] },
  ],
};
const source: Source = { repository: 'https://example.org/jobs.git', revision: 'a'.repeat(40), image: 'gretl:test' };
const job = { ...parseJob(base), source };
const fileJob = { ...parseJob({ ...base, id: 'files', parameters: [
  { name: 'file', label: 'CSV', type: 'file', required: true, accept: ['.csv'] },
  { name: 'other', label: 'Second CSV', type: 'file', accept: ['.csv'] },
] }), source };

test('typed values, defaults, calendar dates, required values and unknown values', () => {
  assert.deepEqual(validateValues(job, { message: 'Hello', when: '2024-02-29', separator: ',' }),
    { message: 'Hello', number: 1, toggle: false, when: '2024-02-29', separator: ',' });
  for (const invalid of [{}, { message: ' ' }, { message: 'x', number: '2' },
    { message: 'x', number: 2147483648 }, { message: 'x', toggle: 'false' }, { message: 'x', when: '2026-02-29' },
    { message: 'x', separator: ';' }, { message: 'x', image: 'other' }]) {
    assert.throws(() => validateValues(job, invalid));
  }
  assert.throws(() => validateValues(fileJob, { file: '/inputs/file' }), /Unknown parameter/);
  assert.throws(() => validateValues(fileJob, {}), /Missing file/);
});

test('schema rejects duplicate parameters, path traversal, resources and invalid schedules', () => {
  for (const invalid of [
    { ...base, script: '../job.groovy' }, { ...base, parameters: [...base.parameters, base.parameters[0]] },
    { ...base, resources: { cpu: '3000m', memory: '4Gi' } }, { ...base, id: '../hello' },
    { ...base, parameters: [{ name: 'when', label: 'Date', type: 'date', default: '2026-02-29' }] },
    { ...base, schedule: { cron: '* * * * *' } },
    { ...base, parameters: fileJob.parameters, schedule: { cron: '* * * * *' } },
  ]) assert.throws(() => parseJob(invalid));
});

test('cron resolves deterministic offsets and accepts Kubernetes grammar', () => {
  const cron = (id: string, input: string) => resolveCron(id, input, 'Europe/Zurich');
  assert.match(cron('hello', 'H H(1-3) * * *'), /^\d+ [1-3] \* \* \*$/);
  assert.match(cron('hello', 'H/15 * * * *'), /^(?:[0-9]|1[0-4])-59\/15 \* \* \* \*$/);
  assert.equal(cron('hello', 'H * * * *'), cron('hello', 'H * * * *'));
  assert.ok(new Set(['a', 'b', 'c'].map(id => cron(id, 'H * * * *'))).size > 1);
  assert.equal(cron('hello', '30 2 * JAN MON-FRI'), '30 2 * JAN MON-FRI');
  assert.equal(cron('hello', '0 0 * * SUN'), '0 0 * * SUN');
  assert.equal(cron('hello', '0 0 * * */7'), '0 0 * * */7');
  for (const invalid of ['H(60-61) * * * *', 'H(9-1) * * * *', 'H/0 * * * *', '* * H * *',
    'H,H * * * *', '* * L * *', '60 0 * * *', '@hourly', '5 * * *',
    '0 0 * * 7', '0 0 * * 1-7', '0 0 * * 6-7', '0 0 * * 0,7']) assert.throws(() => cron('hello', invalid));
});

test('manual and cron use the same workflow and preserve literal values', () => {
  const scheduled = { ...parseJob({ ...base, parameters: [], schedule: { cron: 'H * * * *' } }), source };
  const cron = cronWorkflow(scheduled);
  assert.deepEqual(cron.spec.workflowSpec, workflow(scheduled, undefined, {}, []).spec);
  assert.equal(cron.spec.workflowMetadata.annotations['job-console.io/trigger'], 'schedule');
  const literal = ['$(HOME)', '$HOME', '${HOME}', '{{workflow.name}}', '{{= 1 }}', '"', 'a\nb', 'Grüezi', ';'].join(' ');
  const spec = workflow(job, 'hello-run', { message: literal }, []).spec;
  const template = (spec.templates as {
    inputs: { artifacts: { raw?: { data: string }; git?: { revision: string }; s3?: { key: string } }[] };
    container: { args: string[]; securityContext: { readOnlyRootFilesystem: boolean } };
    synchronization: { mutexes: { name: string }[] };
  }[])[0];
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(template.container.securityContext.readOnlyRootFilesystem, true);
  assert.ok(template.container.args.includes('/work/parameters.json'));
  assert.equal(template.inputs.artifacts[0].git?.revision, source.revision);
  assert.equal(template.synchronization.mutexes[0].name, 'job-hello');
  assert.equal(JSON.parse(template.inputs.artifacts[1].raw!.data).message, literal);
  assert.ok(!template.inputs.artifacts[1].raw!.data.includes('{{'));
  const upload = workflow(fileJob, 'files-run', {}, ['file']).spec.templates as typeof template[];
  assert.equal(upload[0].inputs.artifacts[2].s3?.key, 'runs/files-run/inputs/file');
  assert.equal(JSON.parse(upload[0].inputs.artifacts[1].raw!.data).file, '/inputs/file');
});

test('generator writes deterministic manifests and rejects symlink scripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'console-generator-'));
  try {
    await mkdir(join(dir, 'jobs/hello'), { recursive: true });
    await writeFile(join(dir, 'jobs/hello/job.yaml'), JSON.stringify(base));
    await writeFile(join(dir, 'jobs/hello/job.groovy'), 'println "hello"');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init');
    const commit = () => {
      git('add', 'jobs');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-m', 'fixture');
    };
    commit();
    const generate = (name: string) => execFileSync(process.execPath,
      ['build/control/generate.js', '--jobs-dir', dir, '--output', join(dir, name), '--repository', source.repository, '--image', source.image]);
    generate('one');
    generate('two');
    for (const file of ['catalog.json', 'catalog-configmap.yaml', 'workflowtemplates.yaml', 'cronworkflows.yaml']) {
      assert.deepEqual(await readFile(join(dir, 'one', file)), await readFile(join(dir, 'two', file)));
    }
    await rm(join(dir, 'jobs/hello/job.groovy'));
    const { symlink } = await import('node:fs/promises');
    await symlink(join(dir, 'jobs/hello/job.yaml'), join(dir, 'jobs/hello/job.groovy'));
    commit();
    assert.throws(() => generate('bad'), /Git symlinks/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('HTTP validation, upload limits, namespace isolation and cancellation', async t => {
  const created: Workflow[] = [];
  const deleted: string[] = [];
  let createFailure: number | undefined;
  let uploadFailure = false;
  let cleanupFailure = false;
  const managed = workflow(job, 'hello-existing', { message: 'x' }, []);
  managed.metadata.uid = 'managed-uid';
  const foreign = { ...managed, metadata: { name: 'other', labels: { app: 'other' } } };
  const argo = {
    create: async (body: Workflow) => {
      if (createFailure) throw Object.assign(new Error('sensitive Kubernetes error'), { code: createFailure });
      created.push(body);
      return body;
    },
    list: async () => ({ items: created }),
    get: async (name: string) => name === 'other' ? foreign : managed,
    terminate: async () => {
      managed.spec.shutdown = 'Terminate';
      return managed;
    },
    remove: async () => ({}),
  } as unknown as ReturnType<typeof argoClient>;
  const core = { listNamespacedPod: async () => ({ items: [] }) } as unknown as CoreV1Api;
  const s3: Pick<ReturnType<typeof storage>, 'upload' | 'remove' | 'download' | 'stat'> = {
    stat: async () => { throw new Error('Unexpected artifact'); },
    download: async () => { throw new Error('Unexpected download'); },
    upload: async (name, field, source, count) => {
      assert.match(name, /^files-[a-f0-9]{12}$/);
      assert.ok(['file', 'other'].includes(field));
      for await (const chunk of source) count(chunk.length);
      if (uploadFailure) throw new Error('sensitive S3 error');
    },
    remove: async (_name, field) => {
      deleted.push(field);
      if (cleanupFailure) throw new Error('sensitive cleanup error');
    },
  };
  const app = await buildApp([job, fileJob], argo, core, {} as CustomObjectsApi, 'job-console', s3, { file: 12, total: 15 });
  t.after(() => app.close());
  const send = (id: string, payload: unknown, origin?: string) => app.inject({
    method: 'POST', url: '/api/jobs/' + id + '/runs', headers: origin ? { origin } : {},
    payload: payload as object,
  });
  assert.equal((await send('hello', { parameters: { message: 'Hello' } })).statusCode, 201);
  assert.equal((await send('hello', { parameters: { message: 'Hi', cpu: '10' } })).statusCode, 400);
  assert.equal((await send('hello', { image: 'other' })).statusCode, 400);
  assert.equal((await send('missing', {})).statusCode, 404);
  assert.equal((await send('hello', { parameters: { message: 'x' } }, 'https://example.invalid')).statusCode, 403);
  assert.equal((await send('files', {})).statusCode, 400);
  const upload = (parts: [string, string, string][]) => app.inject({
    method: 'POST', url: '/api/jobs/files/runs', headers: { 'content-type': 'multipart/form-data; boundary=x' },
    payload: parts.map(([field, file, value]) =>
      `--x\r\nContent-Disposition: form-data; name="${field}"; filename="${file}"\r\nContent-Type: text/csv\r\n\r\n${value}\r\n`).join('') + '--x--\r\n',
  });
  assert.equal((await upload([['file', 'wrong.txt', '1,2']])).statusCode, 400);
  assert.equal((await upload([['file', 'yes.csv', '1,2']])).statusCode, 201);
  assert.equal((await upload([['file', 'large.csv', 'a'.repeat(13)]])).statusCode, 413);
  assert.equal((await upload([['file', 'a.csv', 'a'.repeat(9)], ['other', 'b.csv', 'b'.repeat(9)]])).statusCode, 413);
  assert.deepEqual(deleted, ['file', 'file', 'other']);
  assert.deepEqual(created[0].metadata?.labels, managed.metadata.labels);

  uploadFailure = true;
  cleanupFailure = true;
  let failure = await upload([['file', 'yes.csv', '1,2']]);
  assert.equal(failure.statusCode, 502);
  assert.deepEqual(failure.json(), { error: 'Kubernetes or object storage operation failed' });
  assert.equal(created.length, 2);
  assert.equal(deleted.length, 4);
  uploadFailure = false;
  cleanupFailure = false;
  createFailure = 422;
  failure = await upload([['file', 'yes.csv', '1,2']]);
  assert.equal(failure.statusCode, 502);
  assert.equal(deleted.length, 5);
  createFailure = 500;
  failure = await upload([['file', 'yes.csv', '1,2']]);
  assert.equal(failure.statusCode, 502);
  assert.equal(deleted.length, 5, 'retain inputs when the create result is ambiguous');
  assert.equal(created.length, 2);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/runs/other' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/runs/hello-existing' })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/runs/hello-existing/cancel' })).json().status, 'Canceling');
  assert.equal(managed.spec.shutdown, 'Terminate');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/runs/hello-existing' })).statusCode, 409);
  managed.status = { phase: 'Failed' };
  assert.equal(runState(managed).status, 'Canceled');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/runs/hello-existing' })).statusCode, 204);
});

test('aggregate parameter values stay within the annotation and command budget', () => {
  const parameters = Array.from({ length: 32 }, (_, i) => ({ name: 'p' + i, label: 'Text', type: 'text' }));
  const largeJob = parseJob({ ...base, parameters });
  const values = Object.fromEntries(parameters.map(p => [p.name, 'ä'.repeat(4096)]));
  assert.throws(() => validateValues(largeJob, values), /Total parameter size/);
});

test('Argo failure and Kubernetes waiting reasons surface', () => {
  const pending = workflow(job, 'hello-wait', { message: 'x' }, []);
  assert.deepEqual(runState({ ...pending, status: { phase: 'Failed', message: 'DeadlineExceeded' } }),
    { status: 'Failed', reason: 'DeadlineExceeded' });
  assert.deepEqual(runState(pending, [{ status: { phase: 'Pending', containerStatuses: [{
    name: 'gretl', image: 'gretl', imageID: '', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } },
  }] } }]), { status: 'Pending', reason: 'ImagePullBackOff' });
});
