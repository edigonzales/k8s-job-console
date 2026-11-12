import type { Workflow, Artifact } from './argo.js';
import { type Job, type Values, validateValues } from './catalog.js';
import { inputKey } from './storage.js';

export const managedBy = 'app.kubernetes.io/managed-by';
export const jobIdLabel = 'job-console.io/job-id';
export const selector = `${managedBy}=job-console`;
export const revisionAnnotation = 'job-console.io/revision';
export const imageAnnotation = 'job-console.io/runtime-image';
export const parametersAnnotation = 'job-console.io/parameters';
export const triggerAnnotation = 'job-console.io/trigger';
export const outputLabelsAnnotation = 'job-console.io/output-labels';

export interface Source {
  repository: string;
  revision: string;
  image: string;
  ref?: string;
  gitSecret?: string;
}

export type CatalogJob = Job & { source: Source };

export const templateAnnotation = 'job-console.io/template';
export function templateName(job: CatalogJob) {
  const imageVersion = job.source.image.split(':').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 12);
  return `${job.id}-${job.source.revision.slice(0, 12)}-${imageVersion}`.replace(/-+$/g, '');
}

const restricted = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
};
const workDirectories = ['work', 'tmp', 'reports', 'outputs', 'run'];

function parametersFile(job: Job, values: Values, files: string[]) {
  const strings = {
    ...values,
    ...Object.fromEntries(files.map(name => [name, '/inputs/' + name])),
    ...Object.fromEntries(job.outputs.map(output => [output.parameter, '/outputs/' + output.path])),
  };
  // GRETL reads the original strings from JSON. Argo never sees delimiters
  // from those strings and Kubernetes receives only the fixed file path.
  return '{' + Object.entries(strings).map(([name, value]) =>
    JSON.stringify(name) + ':' + JSON.stringify(String(value)).replaceAll('{', '\\u007b')).join(',') + '}';
}

export function workflow(job: CatalogJob, name: string | undefined, values: Values, files: string[], inputRun = name): Workflow {
  const inputFiles: Artifact[] = files.map(field => ({
    name: `upload-${field}`,
    path: '/inputs/' + field,
    s3: { key: inputKey(inputRun!, field) },
  }));
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
      name,
      labels: { [managedBy]: 'job-console', [jobIdLabel]: job.id },
      annotations: {
        [revisionAnnotation]: job.source.revision,
        [imageAnnotation]: job.source.image,
        [templateAnnotation]: templateName(job),
        [parametersAnnotation]: JSON.stringify(values),
        [outputLabelsAnnotation]: JSON.stringify(Object.fromEntries(job.outputs.map(output => [output.name, output.label]))),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      executor: { serviceAccountName: 'job-console-executor' },
      entrypoint: 'process',
      activeDeadlineSeconds: job.execution.timeoutSeconds,
      ttlStrategy: { secondsAfterCompletion: 604800 },
      artifactRepositoryRef: { configMap: 'job-console-artifacts', key: 'rustfs' },
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
        seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [
        ...workDirectories.map(name => ({ name, emptyDir: {} })),
        { name: 'config', configMap: { name: 'job-console-runtime' } },
      ],
      templates: [{
        name: 'process',
        synchronization: job.execution.serial ? { mutexes: [{ name: 'job-' + job.id }] } : undefined,
        inputs: { artifacts: [
          { name: 'source', path: '/source', git: {
            repo: job.source.repository, revision: job.source.revision, disableSubmodules: true,
            ...(job.source.gitSecret ? {
              usernameSecret: { name: job.source.gitSecret, key: 'username' },
              passwordSecret: { name: job.source.gitSecret, key: 'password' },
            } : {}),
          } },
          { name: 'parameters', path: '/work/parameters.json', raw: { data: parametersFile(job, values, files) } },
          ...inputFiles,
        ] },
        outputs: { artifacts: job.outputs.map(output => ({
          name: output.name, path: '/outputs/' + output.path, optional: output.optional, archive: { none: {} },
          s3: { key: `artifacts/{{workflow.name}}/{{pod.name}}/${output.name}` },
        })) },
        container: {
          image: job.source.image,
          imagePullPolicy: 'IfNotPresent',
          command: ['/opt/gretl/bin/gretl'],
          args: ['run', `/source/jobs/${job.id}/${job.script}`, '--config', '/config/runtime.json',
            '--params-file', '/work/parameters.json', '--report', '/reports/report.json'],
          resources: { requests: job.resources, limits: job.resources },
          securityContext: restricted,
          volumeMounts: [...workDirectories.map(name => ({ name, mountPath: '/' + name })),
            { name: 'config', mountPath: '/config', readOnly: true }],
        },
      }],
    },
  };
}

export function cronWorkflow(job: CatalogJob) {
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
