import { readFile } from 'node:fs/promises';
import type { V1ObjectMeta } from '@kubernetes/client-node';

export interface Artifact {
  name: string;
  path?: string;
  s3?: { key: string };
  optional?: boolean;
}

export interface Node {
  id: string;
  displayName: string;
  templateName?: string;
  type: string;
  phase: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  synchronizationStatus?: { waiting?: string };
  outputs?: { artifacts?: Artifact[]; parameters?: { name: string; value?: string }[] };
}

export interface Workflow {
  apiVersion: 'argoproj.io/v1alpha1';
  kind: 'Workflow';
  metadata: V1ObjectMeta;
  spec: { shutdown?: string; [key: string]: unknown };
  status?: {
    phase?: string;
    message?: string;
    startedAt?: string;
    finishedAt?: string;
    nodes?: Record<string, Node>;
    outputs?: Node['outputs'];
    synchronization?: { mutex?: { waiting?: { mutex: string }[] } };
  };
}

export class ArgoError extends Error {
  constructor(public readonly code: number) { super(`Argo returned HTTP ${code}`); }
}

const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

export function argoClient(endpoint: string, namespace: string) {
  const path = (kind: string, name?: string) =>
    `/api/v1/${kind}/${encodeURIComponent(namespace)}${name ? '/' + encodeURIComponent(name) : ''}`;
  async function request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const response = await fetch(new URL(path, endpoint), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArgoError(response.status);
    }
    return response.json() as Promise<T>;
  }
  return {
    create: (workflow: Workflow) => request<Workflow>(path('workflows'), 'POST', { namespace, workflow }),
    get: (name: string) => request<Workflow>(path('workflows', name)),
    list: (selector: string) => request<{ items?: Workflow[] }>(
      path('workflows') + '?' + new URLSearchParams({ 'listOptions.labelSelector': selector })),
    terminate: (name: string) => request<Workflow>(path('workflows', name) + '/terminate', 'PUT', { namespace, name }),
    remove: (name: string, uid?: string) => request<unknown>(path('workflows', name) + (uid
      ? '?' + new URLSearchParams({ 'deleteOptions.preconditions.uid': uid }) : ''), 'DELETE'),
    set: (name: string, node: string, phase: 'Succeeded' | 'Failed', outputs: Record<string, string>) =>
      request<Workflow>(path('workflows', name) + '/set', 'PUT', {
        namespace, name, phase, nodeFieldSelector: 'id=' + node, outputParameters: JSON.stringify(outputs),
      }),
  };
}
