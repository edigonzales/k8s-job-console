import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { BatchV1Api, CoreV1Api, KubeConfig, V1Job, V1Pod } from '@kubernetes/client-node';
import { type Job, validateValues } from './catalog.js';
import { canceled, jobIdLabel, managedBy, manualJob, parameters, selector } from './manifests.js';
import { fetchInputs, fileLimit, storage, totalLimit } from './storage.js';

class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
const bad = (message: string) => new HttpError(400, message);
const missing = () => new HttpError(404, 'Job or run not found');
const conflict = (message: string) => new HttpError(409, message);
const kubeCode = (error: unknown) => (error as { code?: number }).code;

export function runState(job: V1Job, pod?: V1Pod) {
  const conditions = job.status?.conditions ?? [];
  const condition = (type: string) => conditions.find(c => c.type === type && c.status === 'True');
  const containers = [...pod?.status?.initContainerStatuses ?? [], ...pod?.status?.containerStatuses ?? []];
  const failedContainer = containers.find(c => c.state?.terminated?.exitCode);
  const waiting = containers.map(c => c.state?.waiting?.reason)
    .find(reason => reason && !['PodInitializing', 'ContainerCreating'].includes(reason));
  const failed = condition('Failed') ?? condition('FailureTarget');
  if (job.metadata?.annotations?.[canceled]) return { status: 'Canceled', reason: 'Canceled by user' };
  if (condition('Complete')) return { status: 'Succeeded' };
  if (failed) return { status: 'Failed', reason: failedContainer?.state?.terminated?.reason ?? failed.reason };
  return {
    status: pod?.status?.phase === 'Running' ? 'Running' : 'Pending',
    reason: waiting ?? conditions.find(c => c.type === 'Suspended' && c.status === 'True')?.reason
      ?? pod?.status?.conditions?.find(c => c.type === 'PodScheduled' && c.status === 'False')?.reason,
  };
}

function summary(job: V1Job, pod?: V1Pod) {
  return {
    name: job.metadata?.name, jobId: job.metadata?.labels?.[jobIdLabel],
    created: job.metadata?.creationTimestamp, started: job.status?.startTime,
    finished: job.status?.completionTime ?? job.status?.conditions?.find(c => c.type === 'Failed' && c.status === 'True')?.lastTransitionTime
      ?? job.metadata?.annotations?.[canceled],
    parameters: JSON.parse(job.metadata?.annotations?.[parameters] ?? '{}'),
    scheduled: job.metadata?.ownerReferences?.some(owner => owner.kind === 'CronJob') ?? false,
    ...runState(job, pod),
  };
}

export async function buildApp(catalog: Job[], batch: BatchV1Api, core: CoreV1Api, namespace: string,
  s3: Pick<ReturnType<typeof storage>, 'upload' | 'remove'> = storage(), limits = { file: fileLimit, total: totalLimit }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 256 * 1024 });
  await app.register(multipart, { limits: { fileSize: limits.file, fieldSize: 256 * 1024, parts: 33, headerPairs: 32 } });
  app.addHook('onRequest', async request => {
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && !(process.env.LOCAL_ORIGINS ?? 'http://localhost:4466,http://127.0.0.1:4466').split(',').includes(origin))) {
      throw new HttpError(403, 'Origin not permitted');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof HttpError || (status && status >= 400 && status < 500)) {
      return reply.code(status ?? 400).send({ error: (error as Error).message });
    }
    request.log.error({ kind: (error as Error).name, code: kubeCode(error) }, 'Backend operation failed');
    return reply.code(502).send({ error: 'Kubernetes or object storage operation failed' });
  });
  const findJob = (id: string) => {
    const job = catalog.find(item => item.id === id);
    if (!job) throw missing();
    return job;
  };
  const findRun = async (name: string) => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw missing();
    const job = await batch.readNamespacedJob({ namespace, name }).catch(error => {
      if (kubeCode(error) === 404) throw missing();
      throw error;
    });
    if (job.metadata?.labels?.[managedBy] !== 'job-console' || !job.metadata.labels[jobIdLabel]) throw missing();
    return job;
  };
  const pods = async () => (await core.listNamespacedPod({ namespace, labelSelector: selector })).items;
  const podFor = (job: V1Job, candidates: V1Pod[]) => candidates
    .filter(p => p.metadata?.ownerReferences?.some(ref => ref.controller && ref.uid === job.metadata?.uid))
    .sort((a, b) => Number(b.metadata?.creationTimestamp) - Number(a.metadata?.creationTimestamp))[0];

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/jobs', async () => catalog.map(({ id, name, description, runtime, schedule, resolvedCron }) =>
    ({ id, name, description, runtime, scheduled: Boolean(schedule), schedule, resolvedCron })));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async ({ params }) => {
    const { script: _script, resources: _resources, ...details } = findJob(params.id);
    return details;
  });
  app.get('/api/schedules', async () => {
    const schedules = await batch.listNamespacedCronJob({ namespace, labelSelector: selector });
    return catalog.filter(job => job.schedule).map(job => {
      const cron = schedules.items.find(item => item.metadata?.name === job.id);
      return { id: job.id, name: job.name, ...job.schedule, resolvedCron: job.resolvedCron,
        active: cron ? !cron.spec?.suspend : null, lastSchedule: cron?.status?.lastScheduleTime };
    });
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/runs', async (request, reply) => {
    const job = findJob(request.params.id);
    const name = `${job.id}-${randomBytes(6).toString('hex')}`;
    const files = new Set<string>();
    const attempted = new Set<string>();
    let input: unknown = {};
    let creating = false;
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    request.raw.once('aborted', disconnected);
    reply.raw.once('close', disconnected);
    try {
      if (request.isMultipart()) {
        let total = 0;
        let hasParameters = false;
        for await (const part of request.parts()) {
          if (part.type === 'field') {
            if (hasParameters || part.fieldname !== 'parameters' || part.valueTruncated || typeof part.value !== 'string') {
              throw bad('Expected one JSON parameters field');
            }
            hasParameters = true;
            try { input = JSON.parse(part.value); } catch { throw bad('Invalid JSON parameters'); }
            continue;
          }
          const field = job.parameters.find(p => p.name === part.fieldname && p.type === 'file');
          const filename = part.filename ?? '';
          if (!field || attempted.has(part.fieldname) || /[/\\\x00-\x1f]/.test(filename) ||
            !field.accept?.some(extension => extension.toLowerCase() === extname(filename).toLowerCase())) {
            part.file.resume();
            throw bad('Invalid file field or extension');
          }
          attempted.add(field.name);
          let tooLarge = false;
          part.file.on('limit', () => { tooLarge = true; });
          try {
            await s3.upload(name, field.name, part.file, bytes => {
              total += bytes;
              if (total > limits.total) throw new HttpError(413, 'Total upload limit exceeded');
            }, controller.signal);
          } catch (error) {
            if (tooLarge) throw new HttpError(413, 'File size limit exceeded');
            throw error;
          }
          if (part.file.truncated) throw new HttpError(413, 'File size limit exceeded');
          files.add(field.name);
        }
      } else if (request.body !== undefined) {
        const body = request.body as { parameters?: unknown };
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'parameters')) {
          throw bad('Expected a JSON object containing parameters');
        }
        input = Object.hasOwn(body, 'parameters') ? body.parameters : {};
      }
      let values;
      try { values = validateValues(job, input, files); }
      catch (error) { throw bad((error as Error).message); }
      if (controller.signal.aborted) throw bad('Upload interrupted');
      creating = true;
      const created = await batch.createNamespacedJob({ namespace, body: manualJob(job, name, values, [...files]) });
      return reply.code(201).send(summary(created));
    } catch (error) {
      // A transport failure during creation can mean the Job already exists.
      // Keep its inputs until lifecycle expiry when the outcome is ambiguous.
      const code = kubeCode(error);
      if (!creating || (code && code >= 400 && code < 500 && code !== 409)) {
        const cleanup = await Promise.allSettled([...attempted].map(field => s3.remove(name, field)));
        if (cleanup.some(result => result.status === 'rejected')) request.log.warn('Could not clean up all failed uploads');
      }
      throw error;
    } finally {
      request.raw.off('aborted', disconnected);
      reply.raw.off('close', disconnected);
    }
  });

  type RunRequest = FastifyRequest<{ Params: { name: string } }>;
  app.get('/api/runs', async () => {
    const [jobs, candidates] = await Promise.all([batch.listNamespacedJob({ namespace, labelSelector: selector }), pods()]);
    return jobs.items.sort((a, b) => Number(b.metadata?.creationTimestamp) - Number(a.metadata?.creationTimestamp))
      .map(job => summary(job, podFor(job, candidates)));
  });
  app.get('/api/runs/:name', async (request: RunRequest) => {
    const job = await findRun(request.params.name);
    return summary(job, podFor(job, await pods()));
  });
  app.get('/api/runs/:name/logs', async (request: RunRequest) => {
    const job = await findRun(request.params.name);
    const pod = podFor(job, await pods());
    if (!pod?.metadata?.name) return { logs: '', message: 'No pod available' };
    const name = pod.metadata.name;
    const containers = [...pod.status?.initContainerStatuses ?? [], ...pod.status?.containerStatuses ?? []]
      .filter(container => container.state?.running || container.state?.terminated);
    const logs = await Promise.all(containers.map(async container => {
      try {
        const text = await core.readNamespacedPodLog({
          namespace, name, container: container.name, tailLines: 500, limitBytes: 128 * 1024,
        });
        return `[${container.name}]\n${text}`;
      } catch (error) {
        if ([400, 404].includes(kubeCode(error) ?? 0)) return '';
        throw error;
      }
    }));
    const text = logs.filter(Boolean).join('\n');
    return { logs: text, message: text ? undefined : 'No logs available yet' };
  });
  app.post('/api/runs/:name/cancel', async (request: RunRequest) => {
    const name = request.params.name;
    const job = await findRun(name);
    const state = runState(job).status;
    if (state === 'Canceled') return summary(job);
    if (state === 'Succeeded' || state === 'Failed' ||
        job.status?.conditions?.some(c => c.type === 'SuccessCriteriaMet' && c.status === 'True')) {
      throw conflict('Run has already finished');
    }
    try {
      const patched = await batch.patchNamespacedJob({ namespace, name, body: [
        { op: 'test', path: '/metadata/resourceVersion', value: job.metadata?.resourceVersion },
        { op: 'add', path: '/metadata/annotations', value: { ...job.metadata?.annotations, [canceled]: new Date().toISOString() } },
        { op: 'add', path: '/spec/suspend', value: true },
      ] });
      return summary(patched);
    } catch (error) {
      if ([409, 422].includes(kubeCode(error) ?? 0)) throw conflict('Run changed. Refresh and retry.');
      throw error;
    }
  });
  app.delete('/api/runs/:name', async (request: RunRequest, reply) => {
    const job = await findRun(request.params.name);
    const state = runState(job).status;
    if (!['Canceled', 'Succeeded', 'Failed'].includes(state)) throw conflict('Run is still active');
    await batch.deleteNamespacedJob({ namespace, name: request.params.name, body: {
      propagationPolicy: 'Background', preconditions: { uid: job.metadata?.uid },
    } });
    return reply.code(204).send();
  });
  return app;
}

async function main() {
  const [mode, name, ...fields] = process.argv.slice(2);
  if (mode === 'fetch') return fetchInputs(name, fields);
  if (mode === 'init-storage') return storage().initialize();
  if (mode) throw new Error('Unknown command');
  if (process.env.LOCAL_UNAUTHENTICATED !== 'true') throw new Error('Local mode must be enabled explicitly');
  const config = new KubeConfig();
  config.loadFromCluster();
  const namespace = process.env.NAMESPACE ?? 'job-console';
  const catalog = JSON.parse(await readFile('/catalog/catalog.json', 'utf8')) as Job[];
  const app = await buildApp(catalog, config.makeApiClient(BatchV1Api), config.makeApiClient(CoreV1Api), namespace);
  await app.listen({ host: '0.0.0.0', port: 8080 });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => {
    console.error('Job console operation failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
