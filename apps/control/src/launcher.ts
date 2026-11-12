import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { CoreV1Api, CustomObjectsApi, KubeConfig, V1Pod } from '@kubernetes/client-node';
import { validateValues } from './catalog.js';
import { argoClient, type Workflow } from './argo.js';
import { jobIdLabel, managedBy, workflow, parametersAnnotation, revisionAnnotation, imageAnnotation,
  outputLabelsAnnotation, selector, type CatalogJob } from './workflows.js';
import { fileLimit, storage, totalLimit } from './storage.js';

class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
const bad = (message: string) => new HttpError(400, message);
const missing = () => new HttpError(404, 'Job or run not found');
const conflict = (message: string) => new HttpError(409, message);
const kubeCode = (error: unknown) => (error as { code?: number }).code;

export function runState(run: Workflow, candidates: V1Pod[] = []) {
  const phase = run.status?.phase;
  const terminal = ['Succeeded', 'Failed', 'Error'].includes(phase ?? '');
  if (run.spec.shutdown === 'Terminate') return { status: terminal ? 'Canceled' : 'Canceling', reason: run.status?.message };
  if (terminal) return { status: phase === 'Succeeded' ? 'Succeeded' : 'Failed', reason: run.status?.message };
  const nodes = Object.values(run.status?.nodes ?? {});
  if (nodes.some(node => node.type === 'Suspend' && node.phase === 'Running')) return { status: 'AwaitingInput' };
  if (nodes.some(node => node.synchronizationStatus?.waiting) || run.status?.synchronization?.mutex?.waiting?.length) {
    return { status: 'Queued', reason: 'Waiting for the job lock' };
  }
  const waiting = candidates.flatMap(pod =>
    [...pod.status?.initContainerStatuses ?? [], ...pod.status?.containerStatuses ?? []])
    .map(container => container.state?.waiting?.reason)
    .find(reason => reason && !['PodInitializing', 'ContainerCreating'].includes(reason));
  return { status: phase === 'Running' ? 'Running' : 'Pending', reason: waiting ?? run.status?.message };
}

function summary(run: Workflow, candidates: V1Pod[] = []) {
  const annotations = run.metadata.annotations ?? {};
  return {
    name: run.metadata.name, jobId: run.metadata.labels?.[jobIdLabel],
    created: run.metadata.creationTimestamp, started: run.status?.startedAt, finished: run.status?.finishedAt,
    revision: annotations[revisionAnnotation], image: annotations[imageAnnotation],
    parameters: JSON.parse(annotations[parametersAnnotation] ?? '{}'),
    scheduled: run.metadata.ownerReferences?.some(owner => owner.kind === 'CronWorkflow') ?? false,
    steps: Object.values(run.status?.nodes ?? {}).filter(node => ['Pod', 'Suspend'].includes(node.type))
      .map(({ id, displayName, phase, message }) => ({ id, name: displayName, status: phase, reason: message })),
    ...runState(run, candidates),
  };
}

export async function buildApp(catalog: CatalogJob[], argo: ReturnType<typeof argoClient>, core: CoreV1Api,
  custom: CustomObjectsApi, namespace: string,
  s3: Pick<ReturnType<typeof storage>, 'upload' | 'remove' | 'download' | 'stat'> = storage(),
  limits = { file: fileLimit, total: totalLimit }) {
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
  let uploading = false;
  const findJob = (id: string) => {
    const job = catalog.find(item => item.id === id && item.exposed);
    if (!job) throw missing();
    return job;
  };
  const findRun = async (name: string) => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw missing();
    const job = await argo.get(name).catch(error => {
      if (kubeCode(error) === 404) throw missing();
      throw error;
    });
    if (job.metadata?.labels?.[managedBy] !== 'job-console' || !job.metadata.labels[jobIdLabel]) throw missing();
    return job;
  };
  const pods = async () => (await core.listNamespacedPod({ namespace, labelSelector: 'workflows.argoproj.io/workflow' })).items;
  const podsFor = (run: Workflow, candidates: V1Pod[]) =>
    candidates.filter(p => p.metadata?.ownerReferences?.some(ref => ref.controller && ref.uid === run.metadata.uid));

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/jobs', async () => catalog.filter(job => job.exposed).map(({ id, name, description, runtime, schedule, resolvedCron }) =>
    ({ id, name, description, runtime, scheduled: Boolean(schedule), schedule, resolvedCron })));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async ({ params }) => {
    const { script: _script, resources: _resources, ...details } = findJob(params.id);
    return details;
  });
  app.get('/api/schedules', async () => {
    const schedules = await custom.listNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', plural: 'cronworkflows', namespace, labelSelector: selector,
    }) as { items: { metadata: { name: string }; spec?: { suspend?: boolean }; status?: { lastScheduledTime?: string } }[] };
    return catalog.filter(job => job.schedule).map(job => {
      const cron = schedules.items.find(item => item.metadata?.name === job.id);
      return { id: job.id, name: job.name, ...job.schedule, resolvedCron: job.resolvedCron,
        active: cron ? !cron.spec?.suspend : null, lastSchedule: cron?.status?.lastScheduledTime };
    });
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/runs', async (request, reply) => {
    const job = findJob(request.params.id);
    const hasUpload = request.isMultipart();
    if (hasUpload && uploading) throw new HttpError(429, 'Another upload is in progress');
    const name = `${job.id}-${randomBytes(6).toString('hex')}`;
    const files = new Set<string>();
    const attempted = new Set<string>();
    let input: unknown = {};
    let creating = false;
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    request.raw.once('aborted', disconnected);
    reply.raw.once('close', disconnected);
    if (hasUpload) uploading = true;
    try {
      if (hasUpload) {
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
      const created = await argo.create(workflow(job, name, values, [...files]));
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
      if (hasUpload) uploading = false;
      request.raw.off('aborted', disconnected);
      reply.raw.off('close', disconnected);
    }
  });

  type RunRequest = FastifyRequest<{ Params: { name: string } }>;
  app.get('/api/runs', async () => {
    const [runs, candidates] = await Promise.all([argo.list(selector), pods()]);
    return (runs.items ?? []).sort((a, b) =>
      new Date(b.metadata.creationTimestamp ?? 0).getTime() - new Date(a.metadata.creationTimestamp ?? 0).getTime())
      .map(run => summary(run, podsFor(run, candidates)));
  });
  app.get('/api/runs/:name', async (request: RunRequest) => {
    const run = await findRun(request.params.name);
    return summary(run, podsFor(run, await pods()));
  });
  app.get('/api/runs/:name/logs', async (request: RunRequest) => {
    const run = await findRun(request.params.name);
    const candidates = podsFor(run, await pods());
    const logs = await Promise.all(candidates.map(async pod => {
      const containers = [...pod.status?.initContainerStatuses ?? [], ...pod.status?.containerStatuses ?? []]
        .filter(container => container.state?.running || container.state?.terminated);
      const entries = await Promise.all(containers.map(async container => {
        try {
          const text = await core.readNamespacedPodLog({
            namespace, name: pod.metadata!.name!, container: container.name, tailLines: 500, limitBytes: 128 * 1024,
          });
          return `[${pod.metadata!.name} / ${container.name}]\n${text}`;
        } catch (error) {
          if ([400, 404].includes(kubeCode(error) ?? 0)) return '';
          throw error;
        }
      }));
      return entries.filter(Boolean).join('\n');
    }));
    const text = logs.filter(Boolean).join('\n');
    return { logs: text, message: text ? undefined : 'No logs available yet' };
  });

  function artifacts(run: Workflow) {
    const labels = JSON.parse(run.metadata.annotations?.[outputLabelsAnnotation] ?? '{}') as Record<string, string>;
    const prefix = `artifacts/${run.metadata.name}/`;
    return Object.values(run.status?.nodes ?? {}).flatMap(node => (node.outputs?.artifacts ?? []).flatMap(artifact => {
      if (!artifact.s3?.key.startsWith(prefix) || !Object.hasOwn(labels, artifact.name) || !artifact.path?.startsWith('/outputs/')) {
        return [];
      }
      return [{ id: `${node.id}.${artifact.name}`, key: artifact.s3.key, step: node.displayName,
        name: artifact.path.split('/').pop()!, label: labels[artifact.name] }];
    }));
  }
  app.get('/api/runs/:name/artifacts', async (request: RunRequest) =>
    Promise.all(artifacts(await findRun(request.params.name)).map(async ({ key, ...item }) =>
      ({ ...item, ...await s3.stat(key) }))));
  app.get<{ Params: { name: string; artifact: string } }>('/api/runs/:name/artifacts/:artifact', async (request, reply) => {
    const item = artifacts(await findRun(request.params.name)).find(a => a.id === request.params.artifact);
    if (!item || !/^[a-zA-Z0-9_.-]+$/.test(item.name)) throw missing();
    const result = await s3.download(item.key).catch(error => {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) throw missing();
      throw error;
    });
    if (result.size !== undefined) reply.header('Content-Length', result.size);
    return reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${item.name}"`).send(result.stream);
  });

  const finished = (run: Workflow) => ['Succeeded', 'Failed', 'Error'].includes(run.status?.phase ?? '');
  app.post('/api/runs/:name/cancel', async (request: RunRequest) => {
    const run = await findRun(request.params.name);
    if (run.spec.shutdown === 'Terminate') return summary(run);
    if (finished(run)) throw conflict('Run has already finished');
    return summary(await argo.terminate(request.params.name));
  });
  app.post('/api/runs/:name/repeat', async (request: RunRequest, reply) => {
    const run = await findRun(request.params.name);
    if (!finished(run)) throw conflict('Run is still active');
    const job = findJob(run.metadata.labels![jobIdLabel]);
    if (job.parameters.some(parameter => parameter.type === 'file')) throw bad('Select the input files again');
    let values;
    try { values = validateValues(job, summary(run).parameters); }
    catch (error) { throw bad((error as Error).message); }
    const name = `${job.id}-${randomBytes(6).toString('hex')}`;
    return reply.code(201).send(summary(await argo.create(workflow(job, name, values, []))));
  });
  app.delete('/api/runs/:name', async (request: RunRequest, reply) => {
    if (!finished(await findRun(request.params.name))) throw conflict('Run is still active');
    await argo.remove(request.params.name);
    return reply.code(204).send();
  });
  return app;
}

async function main() {
  const [mode] = process.argv.slice(2);
  if (mode === 'init-storage') return storage().initialize();
  if (mode) throw new Error('Unknown command');
  if (process.env.LOCAL_UNAUTHENTICATED !== 'true') throw new Error('Local mode must be enabled explicitly');
  const config = new KubeConfig();
  config.loadFromCluster();
  const namespace = process.env.NAMESPACE ?? 'job-console';
  const catalog = JSON.parse(await readFile('/catalog/catalog.json', 'utf8')) as CatalogJob[];
  const endpoint = process.env.ARGO_ENDPOINT;
  if (!endpoint) throw new Error('ARGO_ENDPOINT is required');
  const app = await buildApp(catalog, argoClient(endpoint, namespace), config.makeApiClient(CoreV1Api),
    config.makeApiClient(CustomObjectsApi), namespace);
  await app.listen({ host: '0.0.0.0', port: 8080 });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => {
    console.error('Job console operation failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
