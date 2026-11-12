import type { Workflow, Artifact } from './argo.js';
import { type Job, type Values, validateValues } from './catalog.js';
import type { Approval, Flow } from './flows.js';
import { inputKey } from './storage.js';

export const managedBy = 'app.kubernetes.io/managed-by';
export const jobIdLabel = 'job-console.io/job-id';
export const selector = `${managedBy}=job-console`;
export const revisionAnnotation = 'job-console.io/revision';
export const imageAnnotation = 'job-console.io/runtime-image';
export const parametersAnnotation = 'job-console.io/parameters';
export const triggerAnnotation = 'job-console.io/trigger';
export const outputLabelsAnnotation = 'job-console.io/output-labels';
export const inputFilesAnnotation = 'job-console.io/input-files';
export const approvalsAnnotation = 'job-console.io/approvals';
export const templateAnnotation = 'job-console.io/template';

export interface Source {
  repository: string;
  revision: string;
  image: string;
  ref?: string;
  gitSecret?: string;
  notifierImage?: string;
  notifierSecret?: string;
}

export type CatalogJob = Job & { source: Source; successor?: Job; kind?: 'job' };
export type CatalogFlow = Flow & { source: Source; jobs: Job[]; kind: 'flow'; exposed: true; runtime: 'gretl' };
export type CatalogEntry = CatalogJob | CatalogFlow;

export function templateName(job: CatalogEntry) {
  const imageTag = (image: string) => image.split(':').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 12);
  const imageVersion = imageTag(job.source.image);
  const notifier = job.source.notifierImage ? '-notify-' + imageTag(job.source.notifierImage) : '';
  const secret = job.source.notifierSecret ? '-' + job.source.notifierSecret : '';
  return `${job.id}-${job.source.revision.slice(0, 12)}-${imageVersion}${notifier}${secret}`.replace(/-+$/g, '');
}

const restricted = {
  allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] },
};
const workDirectories = ['work', 'tmp', 'reports', 'outputs', 'run'];

export const encodeParameter = (value: string | number | boolean) => JSON.stringify(String(value)).replaceAll('{', '\\u007b');
export const approvalField = (name: string) => 'field-' + name;

type Bindings = { values: Record<string, string>; artifacts: Artifact[] };
function taskTemplate(job: Job, name: string, source: Source, bindings: Bindings, parameters: string[] = []) {
  const values = { ...bindings.values };
  for (const artifact of bindings.artifacts) values[artifact.name.slice('upload-'.length)] = encodeParameter(artifact.path!);
  for (const output of job.outputs) values[output.parameter] = encodeParameter('/outputs/' + output.path);
  const data = '{' + Object.entries(values).map(([name, value]) => JSON.stringify(name) + ':' + value).join(',') + '}';
  return {
    name,
    synchronization: job.execution.serial ? { mutexes: [{ name: 'job-' + job.id }] } : undefined,
    activeDeadlineSeconds: job.execution.timeoutSeconds,
    inputs: {
      artifacts: [
        { name: 'source', path: '/source', git: {
          repo: source.repository, revision: source.revision, disableSubmodules: true,
          ...(source.gitSecret ? {
            usernameSecret: { name: source.gitSecret, key: 'username' },
            passwordSecret: { name: source.gitSecret, key: 'password' },
          } : {}),
        } },
        { name: 'parameters', path: '/work/parameters.json', raw: { data } },
        ...bindings.artifacts,
      ],
      ...(parameters.length ? { parameters: parameters.map(name => ({ name })) } : {}),
    },
    outputs: { artifacts: job.outputs.map(output => ({
      name: output.name, path: '/outputs/' + output.path, optional: output.optional, archive: { none: {} },
      s3: { key: `artifacts/{{workflow.name}}/{{pod.name}}/${output.name}` },
    })) },
    container: {
      image: source.image,
      imagePullPolicy: 'IfNotPresent',
      command: ['/opt/gretl/bin/gretl'],
      args: ['run', `/source/jobs/${job.id}/${job.script}`, '--config', '/config/runtime.json',
        '--params-file', '/work/parameters.json', '--report', '/reports/report.json'],
      resources: { requests: job.resources, limits: job.resources },
      securityContext: restricted,
      volumeMounts: [...workDirectories.map(name => ({ name, mountPath: '/' + name })),
        { name: 'config', mountPath: '/config', readOnly: true }],
    },
  };
}

export function workflow(entry: CatalogEntry, name: string | undefined, values: Values, files: string[]): Workflow {
  const uploaded = Object.fromEntries(files.map(field => [field, inputKey(name!, field)]));
  const outputLabels: Record<string, string> = {};
  const approvals: Record<string, Approval> = {};
  const steps: Record<string, unknown>[][] = [];
  const templates: Record<string, unknown>[] = [];
  const upload = (field: string, key?: string, optional?: boolean): Artifact => ({
    name: 'upload-' + field, path: '/inputs/' + field, ...(key ? { s3: { key } } : {}), ...(optional ? { optional } : {}),
  });
  const encodeValues = (params: Values) => Object.fromEntries(Object.entries(params).map(([name, value]) => [name, encodeParameter(value)]));
  function addTask(job: Job, step: string, bindings: Bindings, parameters: string[] = [], template = step) {
    templates.push(taskTemplate(job, template, entry.source, bindings, parameters));
    for (const output of job.outputs) outputLabels[`${step}.${output.name}`] = output.label;
  }

  const notifierImage = entry.source.notifierImage;
  const notice = (name: string, event: string, status: string) => ({
    name, template: 'webhook', continueOn: { failed: true, error: true },
    arguments: { parameters: [{ name: 'event', value: event }, { name: 'status', value: status }] },
  });
  if (entry.kind === 'flow') {
    for (const step of entry.steps) {
      if ('approval' in step) {
        approvals[step.id] = step.approval;
        templates.push({
          name: 'step-' + step.id, suspend: {},
          outputs: { parameters: ['decision', 'decidedBy', 'decidedByName', 'decidedAt', 'comment',
            ...step.approval.fields.map(field => approvalField(field.name))]
            .map(name => ({ name, valueFrom: { supplied: {} } })) },
        });
        if (notifierImage) steps.push([notice('notify--' + step.id, 'approval_required', 'AwaitingInput')]);
        steps.push([{ name: step.id, template: 'step-' + step.id }]);
        continue;
      }
      const job = entry.jobs.find(job => job.id === step.job)!;
      const bindings: Bindings = { values: {}, artifacts: [] };
      const parameters: { name: string; value: string }[] = [];
      const artifacts: { name: string; from: string; optional?: boolean }[] = [];
      for (const target of job.parameters) {
        const source = step.inputs[target.name];
        const concrete = source && 'value' in source ? source.value
          : source && 'fromInput' in source ? values[source.fromInput] ?? target.default : target.default;
        if (concrete !== undefined && target.type !== 'file') bindings.values[target.name] = encodeParameter(concrete);
        if (!source) continue;
        if ('fromInput' in source && target.type === 'file' && Object.hasOwn(uploaded, source.fromInput)) {
          bindings.artifacts.push(upload(target.name, uploaded[source.fromInput]));
        } else if ('fromArtifact' in source) {
          bindings.artifacts.push(upload(target.name, undefined, !target.required));
          artifacts.push({ name: 'upload-' + target.name,
            from: `{{steps.${source.fromArtifact.step}.outputs.artifacts.${source.fromArtifact.name}}}`,
            optional: !target.required });
        } else if ('fromApproval' in source) {
          const name = 'arg-' + target.name;
          parameters.push({ name, value: `{{steps.${source.fromApproval.step}.outputs.parameters.${approvalField(source.fromApproval.field)}}}` });
          bindings.values[target.name] = `{{inputs.parameters.${name}}}`;
        }
      }
      addTask(job, step.id, bindings, parameters.map(parameter => parameter.name), 'step-' + step.id);
      steps.push([{ name: step.id, template: 'step-' + step.id, arguments: { parameters, artifacts } }]);
    }
  } else {
    const bindings = { values: encodeValues(values), artifacts: files.map(field => upload(field, uploaded[field])) };
    if (entry.successor) {
      addTask(entry, entry.id, bindings, [], 'process');
      addTask(entry.successor, entry.successor.id,
        { values: encodeValues(validateValues(entry.successor, {})), artifacts: [] }, [], 'successor');
      steps.push([{ name: entry.id, template: 'process' }], [{ name: entry.successor.id, template: 'successor' }]);
    } else {
      addTask(entry, 'process', bindings);
      for (const output of entry.outputs) outputLabels[output.name] = output.label;
    }
  }
  if (steps.length) templates.unshift({ name: 'sequence', steps });
  if (notifierImage) templates.push({
    name: 'webhook',
    inputs: { parameters: [{ name: 'event' }, { name: 'status' }] },
    container: {
      image: notifierImage, imagePullPolicy: 'IfNotPresent',
      command: ['node', '/app/build/control/notify.js'],
      args: [ '{{inputs.parameters.event}}', entry.id, encodeURIComponent(entry.name),
        '{{workflow.name}}', entry.source.revision, '{{inputs.parameters.status}}'],
      envFrom: [{ secretRef: { name: entry.source.notifierSecret ?? 'job-console-webhook', optional: true } }],
      securityContext: restricted,
      resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
    },
  }, {
    name: 'notify-exit',
    steps: [[{ ...notice('notify--failure', 'workflow_failed', '{{workflow.status}}'),
      when: '{{workflow.status}} == Failed || {{workflow.status}} == Error' }]],
  });

  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
      name, labels: { [managedBy]: 'job-console', [jobIdLabel]: entry.id },
      annotations: {
        [revisionAnnotation]: entry.source.revision,
        [imageAnnotation]: entry.source.image,
        [templateAnnotation]: templateName(entry),
        [parametersAnnotation]: JSON.stringify(values),
        [outputLabelsAnnotation]: JSON.stringify(outputLabels),
        [inputFilesAnnotation]: JSON.stringify(uploaded),
        [approvalsAnnotation]: JSON.stringify(approvals),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      executor: { serviceAccountName: 'job-console-executor' },
      entrypoint: steps.length ? 'sequence' : 'process',
      onExit: notifierImage ? 'notify-exit' : undefined,
      activeDeadlineSeconds: entry.execution.timeoutSeconds,
      synchronization: entry.kind === 'flow' && entry.execution.serial ? { mutexes: [{ name: 'flow-' + entry.id }] } : undefined,
      ttlStrategy: { secondsAfterCompletion: 604800 },
      artifactRepositoryRef: { configMap: 'job-console-artifacts', key: 'rustfs' },
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
        seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [
        ...workDirectories.map(name => ({ name, emptyDir: {} })),
        { name: 'config', configMap: { name: 'job-console-runtime' } },
      ],
      templates,
    },
  };
}

export function cronWorkflow(job: CatalogEntry) {
  const run = workflow(job, undefined, validateValues(job, {}), []);
  return {
    apiVersion: run.apiVersion,
    kind: 'CronWorkflow',
    metadata: { name: job.id, labels: run.metadata.labels },
    spec: {
      schedules: [job.resolvedCron],
      timezone: job.schedule!.timeZone,
      concurrencyPolicy: 'Allow',
      successfulJobsHistoryLimit: 10080,
      failedJobsHistoryLimit: 10080,
      workflowMetadata: { labels: run.metadata.labels,
        annotations: { ...run.metadata.annotations, [triggerAnnotation]: 'schedule' } },
      workflowSpec: run.spec,
    },
  };
}
