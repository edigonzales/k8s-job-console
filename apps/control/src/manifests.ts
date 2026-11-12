import type { V1CronJob, V1Job, V1JobSpec, V1Volume } from '@kubernetes/client-node';
import { type Job, type Values, validateValues } from './catalog.js';

export const managedBy = 'app.kubernetes.io/managed-by';
export const jobIdLabel = 'job-console.io/job-id';
export const canceled = 'job-console.io/canceled';
export const parameters = 'job-console.io/parameters';
export const selector = `${managedBy}=job-console`;
export const labels = (id: string) => ({ [managedBy]: 'job-console', [jobIdLabel]: id });
export const scriptName = (id: string) => 'job-console-script-' + id;
export const storageEnv = [{ secretRef: { name: 'job-console-storage' } }];
export const storageConfig = { configMapRef: { name: 'job-console-storage' } };
export const ttl = 7 * 24 * 3600;

const restricted = {
  allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] },
};

export function jobSpec(job: Job, values: Values, files: string[], name?: string): V1JobSpec {
  const volumes: V1Volume[] = ['work', 'tmp', 'reports', 'outputs', 'run']
    .map(path => ({ name: path, emptyDir: {} }));
  const volumeMounts = volumes.map(({ name }) => ({ name, mountPath: '/' + name }));
  volumes.push({ name: 'script', configMap: { name: scriptName(job.id), defaultMode: 0o444 } },
    { name: 'config', configMap: { name: 'job-console-runtime', defaultMode: 0o444 } });
  const args = ['run', '/job/' + job.script, '--config', '/config/runtime.json', '--report', '/reports/report.json'];
  for (const [key, value] of Object.entries(values)) args.push('--param', key + '=' + String(value).replaceAll('$', '$$$$'));
  for (const field of files) args.push('--param', field + '=/inputs/' + field);
  if (files.length) volumes.push({ name: 'inputs', emptyDir: { sizeLimit: '1Gi' } });
  return {
    backoffLimit: 0, ttlSecondsAfterFinished: ttl, activeDeadlineSeconds: 3600,
    template: {
      metadata: { labels: labels(job.id) },
      spec: {
        restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
        terminationGracePeriodSeconds: 15,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001,
          seccompProfile: { type: 'RuntimeDefault' } },
        volumes,
        containers: [{
          name: 'gretl', image: process.env.GRETL_IMAGE ?? 'job-console-gretl:local', imagePullPolicy: 'IfNotPresent',
          args, resources: { requests: job.resources, limits: job.resources }, securityContext: restricted,
          volumeMounts: [...volumeMounts, { name: 'script', mountPath: '/job', readOnly: true },
            { name: 'config', mountPath: '/config', readOnly: true },
            ...files.length ? [{ name: 'inputs', mountPath: '/inputs', readOnly: true }] : []],
        }],
        initContainers: files.length ? [{
          name: 'fetch-inputs', image: process.env.CONTROL_IMAGE ?? 'job-console-control:local',
          imagePullPolicy: 'IfNotPresent', args: ['fetch', name!, ...files],
          envFrom: [storageConfig, ...storageEnv], securityContext: restricted,
          resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '128Mi' } },
          volumeMounts: [{ name: 'inputs', mountPath: '/inputs' }],
        }] : undefined,
      },
    },
  };
}

export function manualJob(job: Job, name: string, values: Values, files: string[]): V1Job {
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name, labels: labels(job.id), annotations: { [parameters]: JSON.stringify(values) } },
    spec: jobSpec(job, values, files, name),
  };
}

export function cronJob(job: Job): V1CronJob {
  const values = validateValues(job, {});
  return {
    apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: job.id, labels: labels(job.id) },
    spec: {
      schedule: job.resolvedCron!, timeZone: job.schedule!.timeZone, concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 2,
      jobTemplate: { metadata: { labels: labels(job.id), annotations: { [parameters]: JSON.stringify(values) } },
        spec: jobSpec(job, values, []) },
    },
  };
}
