import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { CoreV1Api, CustomObjectsApi, KubeConfig, V1Pod } from '@kubernetes/client-node';
import { CronExpressionParser } from 'cron-parser';
import { validateValues } from './catalog.js';
import { argoClient, type Artifact, type Node, type Workflow } from './argo.js';
import { jobIdLabel, managedBy, workflow, parametersAnnotation, revisionAnnotation, imageAnnotation,
  outputLabelsAnnotation, triggerAnnotation, inputFilesAnnotation, approvalsAnnotation,
  approvalField, encodeParameter, selector, templateName, type CatalogEntry, type Source } from './workflows.js';
import type { Approval } from './flows.js';
import { sync } from './sync.js';
import { authenticator, can, isAdmin, principalId, type Action, type Principal } from './identity.js';
import { type Values } from './catalog.js';
import { fileLimit, storage, totalLimit } from './storage.js';

class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
const forbidden = () => new HttpError(403, 'Action not permitted');
const starterAnnotation = 'job-console.io/started-by';
const canceledByAnnotation = 'job-console.io/canceled-by';
const canceledByNameAnnotation = 'job-console.io/canceled-by-name';
const canceledAtAnnotation = 'job-console.io/canceled-at';
const starterNameAnnotation = 'job-console.io/started-by-name';
const bad = (message: string) => new HttpError(400, message);
const missing = () => new HttpError(404, 'Job or run not found');
const conflict = (message: string) => new HttpError(409, message);
const kubeCode = (error: unknown) => (error as { code?: number }).code;

function approvalDefinitions(run: Workflow) {
  return JSON.parse(run.metadata.annotations?.[approvalsAnnotation] ?? '{}') as Record<string, Approval>;
}
function nodeOutputs(node?: Node) {
  return Object.fromEntries((node?.outputs?.parameters ?? []).map(parameter => [parameter.name, parameter.value]));
}
function approvalNode(run: Workflow, step: string) {
  return Object.values(run.status?.nodes ?? {}).find(node => node.type === 'Suspend' && node.displayName === step);
}

export function runState(run: Workflow, candidates: V1Pod[] = []) {
  const phase = run.status?.phase;
  const terminal = ['Succeeded', 'Failed', 'Error'].includes(phase ?? '');
  if (phase === 'Succeeded') return { status: 'Succeeded' };
  if (run.spec.shutdown === 'Terminate') return { status: terminal ? 'Canceled' : 'Canceling', reason: run.status?.message };
  if (Object.values(run.status?.nodes ?? {}).some(node => node.type === 'Suspend' && nodeOutputs(node).decision === 'rejected')) {
    return { status: 'Rejected' };
  }
  if (terminal) return { status: 'Failed', reason: run.status?.message };
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
  const definitions = approvalDefinitions(run);
  const scheduled = annotations[triggerAnnotation] === 'schedule' ||
    Boolean(run.metadata.ownerReferences?.some(owner => owner.kind === 'CronWorkflow'));
  return {
    name: run.metadata.name, jobId: run.metadata.labels?.[jobIdLabel],
    created: run.metadata.creationTimestamp, started: run.status?.startedAt, finished: run.status?.finishedAt,
    revision: annotations[revisionAnnotation], image: annotations[imageAnnotation],
    parameters: JSON.parse(annotations[parametersAnnotation] ?? '{}'),
    scheduled,
    starter: annotations[starterAnnotation] ?? (scheduled ? 'system:schedule' : undefined),
    starterName: annotations[starterNameAnnotation],
    canceledBy: run.spec.shutdown === 'Terminate' ? annotations[canceledByAnnotation] : undefined,
    canceledByName: run.spec.shutdown === 'Terminate' ? annotations[canceledByNameAnnotation] : undefined,
    canceledAt: run.spec.shutdown === 'Terminate' ? annotations[canceledAtAnnotation] : undefined,
    approvals: Object.keys(definitions).flatMap(step => {
      const node = approvalNode(run, step);
      if (!node) return [];
      const output = nodeOutputs(node);
      return [{ step, ...definitions[step], phase: node.phase, decision: output.decision,
        decidedBy: output.decidedByName, decidedAt: output.decidedAt, comment: output.comment,
        values: Object.fromEntries(definitions[step].fields.flatMap(field => {
          const stored = output[approvalField(field.name)];
          return stored === undefined ? [] : [[field.name, JSON.parse(stored) as string]];
        })) }];
    }),
    steps: Object.values(run.status?.nodes ?? {}).filter(node => ['Pod', 'Suspend'].includes(node.type) && node.templateName !== 'webhook')
      .map(({ id, displayName, phase, message }) => ({ id, name: displayName, status: phase, reason: message })),
    ...runState(run, candidates),
  };
}

export async function buildApp(catalogSource: CatalogEntry[] | (() => Promise<CatalogEntry[]>), argo: ReturnType<typeof argoClient>, core: CoreV1Api,
  custom: CustomObjectsApi, namespace: string, authenticate: ReturnType<typeof authenticator>,
  s3: Pick<ReturnType<typeof storage>, 'upload' | 'remove' | 'download' | 'stat' | 'copyInput'> = storage(),
  limits = { file: fileLimit, total: totalLimit }) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 256 * 1024 });
  await app.register(multipart, { limits: { fileSize: limits.file, fieldSize: 256 * 1024, parts: 33, headerPairs: 32 } });
  const principals = new WeakMap<FastifyRequest, Principal>();
  const principal = (request: FastifyRequest) => principals.get(request);
  const permitted = (request: FastifyRequest, action: Action, job?: CatalogEntry) => {
    const user = principal(request);
    return Boolean(user && (job ? can(user, action, job.access) :
      isAdmin(user) && (action === 'view' || action === 'manage')));
  };
  const assertAction = (request: FastifyRequest, action: Action, job?: CatalogEntry) => {
    if (!permitted(request, 'view', job)) throw missing();
    if (!permitted(request, action, job)) throw forbidden();
  };
  const assertAdmin = (request: FastifyRequest) => {
    const user = principal(request);
    if (!user || !isAdmin(user)) throw forbidden();
  };
  const actions = (request: FastifyRequest, job: CatalogEntry) =>
    (['view', 'run', 'approve', 'manage'] as const).filter(action => permitted(request, action, job));
  const origins = (process.env.LOCAL_ORIGINS ?? 'http://localhost:4466,http://127.0.0.1:4466')
    .split(',').map(origin => origin.trim());
  app.addHook('onRequest', async request => {
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
        (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !origin) ||
        (origin && !origins.includes(origin))) {
      throw new HttpError(403, 'Origin not permitted');
    }
    if (request.url !== '/healthz') {
      try { principals.set(request, await authenticate(request)); }
      catch { throw new HttpError(401, 'Sign in to continue'); }
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
  const catalog = () => typeof catalogSource === 'function' ? catalogSource() : Promise.resolve(catalogSource);
  const findJob = async (id: string) => {
    const job = (await catalog()).find(item => item.id === id && item.exposed);
    if (!job) throw missing();
    return job;
  };
  const entryFor = (catalog: CatalogEntry[], run: Workflow) =>
    catalog.find(job => job.exposed && job.id === run.metadata.labels?.[jobIdLabel]);
  const findRun = async (request: FastifyRequest, name: string) => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw missing();
    const job = await argo.get(name).catch(error => {
      if (kubeCode(error) === 404) throw missing();
      throw error;
    });
    if (job.metadata?.labels?.[managedBy] !== 'job-console' || !job.metadata.labels[jobIdLabel]) throw missing();
    assertAction(request, 'view', entryFor(await catalog(), job));
    return job;
  };
  const pods = async () => (await core.listNamespacedPod({ namespace, labelSelector: 'workflows.argoproj.io/workflow' })).items;
  const podsFor = (run: Workflow, candidates: V1Pod[]) =>
    candidates.filter(p => p.metadata?.ownerReferences?.some(ref => ref.controller && ref.uid === run.metadata.uid));

  async function loadTemplate(job: CatalogEntry) {
    if (typeof catalogSource !== 'function') return undefined;
    const template = await custom.getNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', plural: 'workflowtemplates', namespace, name: templateName(job),
    }).catch(error => {
      if (kubeCode(error) === 404) throw conflict('The job definition changed. Reload it before starting.');
      throw error;
    }) as { metadata: Workflow['metadata']; spec: Workflow['spec'] };
    if (template.metadata.labels?.[managedBy] !== 'job-console' ||
        template.metadata.annotations?.[revisionAnnotation] !== job.source.revision ||
        template.metadata.annotations?.[imageAnnotation] !== job.source.image) {
      throw conflict('Workflow template changed');
    }
    return template.spec;
  }
  function createRun(request: FastifyRequest, job: CatalogEntry, name: string, values: Values, files: string[], template?: Workflow['spec']) {
    const run = workflow(job, name, values, files);
    const user = principal(request);
    if (user) Object.assign(run.metadata.annotations!, {
      [starterAnnotation]: principalId(user), [starterNameAnnotation]: user.displayName,
    });
    if (!template) return argo.create(run);
    type Task = { name: string; inputs?: { artifacts?: unknown[] }; steps?: unknown[][] };
    const expected = new Map((run.spec.templates as Task[]).map(task => [task.name, task]));
    for (const task of template.templates as Task[]) {
      const compiled = expected.get(task.name);
      if (!compiled) throw conflict('Workflow template changed');
      if (task.inputs?.artifacts && compiled.inputs?.artifacts) {
        task.inputs.artifacts = [task.inputs.artifacts[0], ...compiled.inputs.artifacts.slice(1)];
      }
      if (task.steps && compiled.steps) task.steps = compiled.steps;
    }
    if (Buffer.byteLength(JSON.stringify({ ...run, spec: template })) > 900 * 1024) {
      throw bad('Workflow parameters exceed the resource limit');
    }
    return argo.create({ ...run, spec: template });
  }

  const publicSource = ({ gitSecret: _git, notifierSecret: _webhook, ...source }: Source) => source;
  const syncLabel = 'job-console.io/sync';
  const syncRef = process.env.JOBS_REF ?? 'main';
  const previewEnabled = process.env.ALLOW_PREVIEW === 'true' && process.env.OIDC_DEV_MODE === 'true';
  const syncInfo = (run: Workflow) => ({
    ...summary(run),
    revision: run.status?.outputs?.parameters?.find(parameter => parameter.name === 'source-revision')?.value,
    ref: (run.spec.arguments as { parameters?: { name: string; value?: string }[] } | undefined)
      ?.parameters?.find(parameter => parameter.name === 'ref')?.value || syncRef,
  });
  app.get('/api/synchronizations', async request => {
    assertAdmin(request);
    const [jobs, result] = await Promise.all([catalog(), argo.list(syncLabel + '=true')]);
    return {
      repository: process.env.JOBS_REPOSITORY,
      defaultRef: syncRef,
      previewEnabled,
      active: jobs[0] && publicSource(jobs[0].source),
      runs: (result.items ?? []).filter(run => run.metadata.labels?.[syncLabel] === 'true').map(syncInfo)
        .sort((a, b) => new Date(b.created ?? 0).getTime() - new Date(a.created ?? 0).getTime()),
    };
  });
  app.get<{ Params: { name: string } }>('/api/synchronizations/:name', async request => {
    assertAdmin(request);
    const { params } = request;
    if (!/^job-console-sync-[a-z0-9-]+$/.test(params.name)) throw missing();
    const run = await argo.get(params.name).catch(error => { if (kubeCode(error) === 404) throw missing(); throw error; });
    if (run.metadata.labels?.[syncLabel] !== 'true') throw missing();
    const pods = podsFor(run, (await core.listNamespacedPod({
      namespace, labelSelector: 'workflows.argoproj.io/workflow=' + params.name,
    })).items);
    const pod = pods[0]?.metadata?.name;
    const logs = pod && await core.readNamespacedPodLog({ namespace, name: pod, container: 'main', tailLines: 60, limitBytes: 16384 })
      .catch(error => { if ([400, 404].includes(kubeCode(error) ?? 0)) return ''; throw error; });
    return { ...syncInfo(run), logs };
  });
  app.post('/api/synchronizations', async (request, reply) => {
    assertAdmin(request);
    const body = request.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'ref')) {
      throw bad('Expected an optional Git branch');
    }
    const ref = (body as { ref?: unknown }).ref ?? syncRef;
    if (typeof ref !== 'string' || !/^[-a-zA-Z0-9._/]{1,150}$/.test(ref) || ref.startsWith('-') ||
        ref.includes('..') || (ref !== syncRef && !previewEnabled)) throw bad('Git branch is not allowed');
    const user = principal(request);
    const run = await argo.create({
      apiVersion: 'argoproj.io/v1alpha1', kind: 'Workflow',
      metadata: { generateName: 'job-console-sync-', labels: { [syncLabel]: 'true' },
        annotations: user && { [starterAnnotation]: principalId(user), [starterNameAnnotation]: user.displayName } },
      spec: { workflowTemplateRef: { name: 'job-console-sync' }, arguments: { parameters: [{ name: 'ref', value: ref }] } },
    });
    return reply.code(201).send(syncInfo(run));
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/me', async request => {
    const user = principal(request);
    if (!user) throw new HttpError(401, 'Sign in to continue');
    const canApprove = (await catalog()).some(entry => entry.exposed && can(user, 'approve', entry.access));
    return { id: principalId(user), displayName: user.displayName, admin: isAdmin(user), canApprove };
  });
  app.get('/api/jobs', async request => (await catalog()).filter(job => job.exposed && permitted(request, 'view', job))
    .map(job => {
      const { id, name, description, runtime, source, parameters, schedule, resolvedCron } = job;
      return { id, name, description, runtime, kind: job.kind ?? 'job', source: publicSource(source), preview: Boolean(source.ref && source.ref !== syncRef), parameters, schedule, resolvedCron,
        allowed: actions(request, job) };
    }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async request => {
    const job = await findJob(request.params.id);
    assertAction(request, 'view', job);
    const { id, name, description, source, runtime, parameters, schedule, resolvedCron } = job;
    return { id, name, description, source: publicSource(source), runtime, parameters, schedule, resolvedCron, kind: job.kind ?? 'job', preview: Boolean(job.source.ref && job.source.ref !== syncRef), allowed: actions(request, job) };
  });
  app.get('/api/schedules', async request => {
    const schedules = await custom.listNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', plural: 'cronworkflows', namespace, labelSelector: selector,
    }) as { items: { metadata: { name: string }; spec?: { suspend?: boolean }; status?: { lastScheduledTime?: string } }[] };
    return (await catalog()).filter(job => job.schedule && permitted(request, 'view', job)).map(job => {
      const cron = schedules.items.find(item => item.metadata?.name === job.id);
      const active = cron ? !cron.spec?.suspend : null;
      const nextSchedule = active && job.resolvedCron && job.schedule ?
        CronExpressionParser.parse(job.resolvedCron, { tz: job.schedule.timeZone }).next().toISOString() : undefined;
      return { id: job.id, name: job.name, ...job.schedule, resolvedCron: job.resolvedCron, nextSchedule,
        active, canManage: permitted(request, 'manage', job), lastSchedule: cron?.status?.lastScheduledTime };
    });
  });

  for (const [action, suspend] of [['pause', true], ['resume', false]] as const) {
    app.post<{ Params: { id: string } }>(`/api/schedules/:id/${action}`, async request => {
      const job = await findJob(request.params.id);
      assertAction(request, 'manage', job);
      if (!job.schedule) throw missing();
      const resource = { group: 'argoproj.io', version: 'v1alpha1', plural: 'cronworkflows', namespace, name: job.id };
      const cron = await custom.getNamespacedCustomObject(resource).catch(error => {
        if (kubeCode(error) === 404) throw missing();
        throw error;
      }) as { metadata: Workflow['metadata'] };
      if (cron.metadata.labels?.[managedBy] !== 'job-console') throw missing();
      const user = principal(request);
      await custom.patchNamespacedCustomObject({ ...resource, body: [
        { op: 'test', path: '/metadata/resourceVersion', value: cron.metadata.resourceVersion },
        { op: 'add', path: '/metadata/annotations', value: {
          ...cron.metadata.annotations, 'job-console.io/schedule-changed-at': new Date().toISOString(),
          'job-console.io/schedule-changed-by': user ? principalId(user) : 'test',
        } },
        { op: 'add', path: '/spec/suspend', value: suspend },
      ] }).catch(error => {
        if ([409, 422].includes(kubeCode(error) ?? 0)) throw conflict('The schedule changed. Refresh and try again.');
        throw error;
      });
      return { active: !suspend };
    });
  }

  app.post<{ Params: { id: string } }>('/api/jobs/:id/runs', async (request, reply) => {
    const job = await findJob(request.params.id);
    assertAction(request, 'run', job);
    const displayedRevision = request.headers['x-job-revision'];
    if (displayedRevision !== undefined && displayedRevision !== job.source.revision) {
      throw conflict('The job definition changed. Reload it before starting.');
    }
    const template = await loadTemplate(job);
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
      try { principals.set(request, await authenticate(request)); }
      catch { throw new HttpError(401, 'Sign in to continue'); }
      assertAction(request, 'run', await findJob(job.id));
      creating = true;
      const created = await createRun(request, job, name, values, [...files], template);
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
  app.get('/api/runs', async request => {
    const [runs, candidates, jobs] = await Promise.all([argo.list(selector), pods(), catalog()]);
    return (runs.items ?? []).filter(run => permitted(request, 'view', entryFor(jobs, run))).sort((a, b) =>
      new Date(b.metadata.creationTimestamp ?? 0).getTime() - new Date(a.metadata.creationTimestamp ?? 0).getTime())
      .map(run => summary(run, podsFor(run, candidates)));
  });
  app.get('/api/runs/:name', async (request: RunRequest) => {
    const run = await findRun(request, request.params.name);
    const entry = entryFor(await catalog(), run);
    const result = summary(run, podsFor(run, await pods()));
    return { ...result, approvals: result.approvals.map(approval => ({
      ...approval, canDecide: approval.phase === 'Running' && canDecide(request, run, approval, entry),
      canApprove: permitted(request, 'approve', entry),
    })) };
  });
  app.get('/api/runs/:name/logs', async (request: RunRequest) => {
    const run = await findRun(request, request.params.name);
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
      if (!artifact.s3?.key.startsWith(prefix) || !Object.hasOwn(labels, `${node.displayName}.${artifact.name}`) && !Object.hasOwn(labels, artifact.name) || !artifact.path?.startsWith('/outputs/')) {
        return [];
      }
      return [{ id: `${node.id}.${artifact.name}`, key: artifact.s3.key, step: node.displayName,
        name: artifact.path.split('/').pop()!, label: labels[`${node.displayName}.${artifact.name}`] ?? labels[artifact.name] }];
    }));
  }
  app.get('/api/runs/:name/artifacts', async (request: RunRequest) =>
    Promise.all(artifacts(await findRun(request, request.params.name)).map(async ({ key, ...item }) =>
      ({ ...item, ...await s3.stat(key) }))));
  app.get<{ Params: { name: string; artifact: string } }>('/api/runs/:name/artifacts/:artifact', async (request, reply) => {
    const item = artifacts(await findRun(request, request.params.name)).find(a => a.id === request.params.artifact);
    if (!item || !/^[a-zA-Z0-9_.-]+$/.test(item.name)) throw missing();
    const result = await s3.download(item.key).catch(error => {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) throw missing();
      throw error;
    });
    if (result.size !== undefined) reply.header('Content-Length', result.size);
    return reply.type('application/octet-stream').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${item.name}"`).send(result.stream);
  });

  const canDecide = (request: FastifyRequest, run: Workflow, policy: Approval, entry?: CatalogEntry) => {
    const user = principal(request);
    return permitted(request, 'approve', entry) &&
      (policy.allowSelfApproval || !user || run.metadata.annotations?.[starterAnnotation] !== principalId(user));
  };
  app.get('/api/approvals', async request => {
    const [jobs, result] = await Promise.all([catalog(), argo.list(selector)]);
    return (result.items ?? []).flatMap(run => {
      const entry = entryFor(jobs, run);
      if (!entry || !permitted(request, 'approve', entry) || runState(run).status !== 'AwaitingInput') return [];
      const { name, starterName, started, revision, scheduled, approvals } = summary(run);
      const files = artifacts(run).map(({ key: _key, ...file }) => file);
      return approvals.filter(approval => approval.phase === 'Running').map(approval => ({
        ...approval, name, jobName: entry.name, starterName, started, revision, scheduled, files,
        canApprove: true, canDecide: canDecide(request, run, approval, entry),
      }));
    });
  });
  app.post<{ Params: { name: string; step: string } }>('/api/runs/:name/approvals/:step/decision', async request => {
    const { name, step } = request.params;
    const run = await findRun(request, name);
    const definitions = approvalDefinitions(run);
    if (!Object.hasOwn(definitions, step)) throw missing();
    const policy = definitions[step];
    const entry = entryFor(await catalog(), run);
    assertAction(request, 'approve', entry);
    if (!canDecide(request, run, policy, entry)) throw new HttpError(403, 'You cannot approve a run you started');
    const body = request.body as { decision?: unknown; values?: unknown; comment?: unknown } | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['decision', 'values', 'comment'].includes(key)) ||
        (body.decision !== 'approve' && body.decision !== 'reject')) throw bad('Expected an approval or rejection');
    const approved = body.decision === 'approve';
    const comment = body.comment ?? '';
    if (typeof comment !== 'string' || comment.length > 4096 || comment.includes('\0') ||
        ((policy.commentRequired || !approved) && !comment.trim())) throw bad('Enter a valid comment');
    let values;
    try {
      const fields = approved ? policy.fields : policy.fields.map(field => ({ ...field, required: false }));
      values = validateValues({ parameters: fields }, body.values ?? {});
    } catch (error) { throw bad((error as Error).message); }
    const user = principal(request)!;
    const outputs: Record<string, string> = {
      decision: approved ? 'approved' : 'rejected', decidedBy: principalId(user), decidedByName: user.displayName,
      comment,
      ...Object.fromEntries(policy.fields.map(field => [approvalField(field.name), encodeParameter(values[field.name] ?? '')])),
    };
    function saved(candidate: Workflow) {
      const output = nodeOutputs(approvalNode(candidate, step));
      if (!output.decision) return undefined;
      if (Object.entries(outputs).every(([key, value]) => key === 'decidedByName' || output[key] === value)) {
        return summary(candidate);
      }
      throw conflict('This approval has already been decided');
    }
    const already = saved(run);
    if (already) return already;
    const node = approvalNode(run, step);
    const deadline = Date.parse(run.status?.startedAt ?? '') + Number(run.spec.activeDeadlineSeconds) * 1000;
    if (run.spec.shutdown || run.status?.phase !== 'Running' || !node || node.phase !== 'Running' ||
        !Number.isFinite(deadline) || Date.now() >= deadline) throw conflict('This approval is no longer waiting');
    try {
      return summary(await argo.set(name, node.id, approved ? 'Succeeded' : 'Failed', {
        ...outputs, decidedAt: new Date().toISOString(),
      }));
    } catch (error) {
      const current = await findRun(request, name);
      const persisted = saved(current);
      if (persisted) return persisted;
      if (current.spec.shutdown || approvalNode(current, step)?.phase !== 'Running') {
        throw conflict('This approval is no longer waiting');
      }
      throw error;
    }
  });

  const finished = (run: Workflow) => ['Succeeded', 'Failed', 'Error'].includes(run.status?.phase ?? '');
  app.post('/api/runs/:name/cancel', async (request: RunRequest) => {
    const run = await findRun(request, request.params.name);
    const user = principal(request);
    const job = entryFor(await catalog(), run);
    if (user && !(run.metadata.annotations?.[starterAnnotation] === principalId(user) && permitted(request, 'run', job))) {
      assertAction(request, 'manage', job);
    }
    if (run.spec.shutdown === 'Terminate') return summary(run);
    if (finished(run)) throw conflict('Run has already finished');
    if (user && !run.metadata.annotations?.[canceledByAnnotation]) {
      await custom.patchNamespacedCustomObject({
        group: 'argoproj.io', version: 'v1alpha1', plural: 'workflows', namespace, name: request.params.name,
        body: [
          { op: 'test', path: '/metadata/resourceVersion', value: run.metadata.resourceVersion },
          { op: 'add', path: '/metadata/annotations', value: {
            ...run.metadata.annotations, [canceledByAnnotation]: principalId(user),
            [canceledByNameAnnotation]: user.displayName, [canceledAtAnnotation]: new Date().toISOString(),
          } },
        ],
      }).catch(error => {
        if ([409, 422].includes(kubeCode(error) ?? 0)) throw conflict('The run changed. Refresh and try again.');
        throw error;
      });
    }
    return summary(await argo.terminate(request.params.name));
  });
  app.post('/api/runs/:name/rerun', async (request: RunRequest, reply) => {
    const run = await findRun(request, request.params.name);
    if (!finished(run)) throw conflict('Run is still active');
    const job = await findJob(run.metadata.labels![jobIdLabel]);
    assertAction(request, 'run', job);
    const templates = run.spec.templates as { inputs?: { artifacts?: Artifact[] } }[];
    const inputs = templates[0]?.inputs?.artifacts ?? [];
    const inputFiles = JSON.parse(run.metadata.annotations?.[inputFilesAnnotation] ?? '{}') as Record<string, string>;
    const files = new Map<string, string>();
    for (const field of job.parameters.filter(parameter => parameter.type === 'file')) {
      const key = inputFiles[field.name] ?? inputs.find(item => item.name === 'upload-' + field.name)?.s3?.key;
      if (!key) continue;
      const match = key && /^runs\/([a-z0-9][a-z0-9-]{0,62})\/inputs\/([a-zA-Z0-9_]+)$/.exec(key);
      if (!match || match[2] !== field.name ||
          run.metadata.annotations?.[revisionAnnotation] !== job.source.revision || !(await s3.stat(key!)).available) {
        throw conflict('Select the input files again');
      }
      files.set(field.name, key);
    }
    let values;
    try { values = validateValues(job, summary(run).parameters, new Set(files.keys())); }
    catch (error) { throw bad((error as Error).message); }
    const name = `${job.id}-${randomBytes(6).toString('hex')}`;
    const template = await loadTemplate(job);
    const copied: string[] = [];
    let creating = false;
    try {
      for (const [field, source] of files) {
        copied.push(field);
        await s3.copyInput(source, name, field);
      }
      assertAction(request, 'run', await findJob(job.id));
      creating = true;
      return reply.code(201).send(summary(await createRun(request, job, name, values, [...files.keys()], template)));
    } catch (error) {
      const code = kubeCode(error);
      if (!creating || (code && code >= 400 && code < 500 && code !== 409)) {
        const cleanup = await Promise.allSettled(copied.map(field => s3.remove(name, field)));
        if (cleanup.some(result => result.status === 'rejected')) request.log.warn('Could not clean up all copied inputs');
      }
      throw error;
    }
  });
  app.delete('/api/runs/:name', async (request: RunRequest, reply) => {
    const run = await findRun(request, request.params.name);
    assertAction(request, 'manage', entryFor(await catalog(), run));
    if (!finished(run)) throw conflict('Run is still active');
    await argo.remove(request.params.name, run.metadata.uid);
    return reply.code(204).send();
  });
  return app;
}

async function main() {
  const [mode, ref] = process.argv.slice(2);
  if (mode === 'sync') return sync(ref || process.env.JOBS_REF || 'main');
  if (mode === 'init-storage') return storage().initialize();
  if (mode) throw new Error('Unknown command');
  const issuer = process.env.OIDC_ISSUER;
  const jwks = process.env.OIDC_JWKS;
  const audience = process.env.OIDC_AUDIENCE;
  const development = process.env.OIDC_DEV_MODE === 'true';
  if (!issuer || !jwks || !audience || !process.env.LOCAL_ORIGINS ||
      (!development && [issuer, jwks, ...process.env.LOCAL_ORIGINS.split(',')].some(url => new URL(url).protocol !== 'https:'))) {
    throw new Error('Configure OIDC issuer, JWKS, audience and browser origin');
  }
  const authenticate = authenticator({ issuer, jwks, audience, groups: process.env.OIDC_GROUPS_CLAIM ?? 'groups' });
  const config = new KubeConfig();
  config.loadFromCluster();
  const namespace = process.env.NAMESPACE ?? 'job-console';
  const core = config.makeApiClient(CoreV1Api);
  const catalog = async () => {
    const resource = await core.readNamespacedConfigMap({ namespace, name: 'job-console-catalog' });
    return JSON.parse(resource.data?.['catalog.json'] ?? '[]') as CatalogEntry[];
  };
  const endpoint = process.env.ARGO_ENDPOINT;
  if (!endpoint) throw new Error('ARGO_ENDPOINT is required');
  const app = await buildApp(catalog, argoClient(endpoint, namespace), core,
    config.makeApiClient(CustomObjectsApi), namespace, authenticate);
  await app.listen({ host: '0.0.0.0', port: 8080 });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => {
    console.error('Job console operation failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
