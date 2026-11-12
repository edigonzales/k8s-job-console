/// <reference types="vite/client" />

export type Value = string | number | boolean;
export interface Parameter {
  name: string;
  label: string;
  type: 'text' | 'multiline' | 'integer' | 'boolean' | 'enum' | 'date' | 'file';
  required: boolean;
  default?: Value;
  accept?: string[];
  options?: { value: string; label: string }[];
}
export interface Job {
  id: string;
  name: string;
  description: string;
  runtime: string;
  source?: { revision: string; ref?: string };
  schedule?: { cron: string; timeZone: string };
  resolvedCron?: string;
}
export type JobDetail = Job & { parameters: Parameter[] };
export interface Schedule {
  id: string;
  name: string;
  cron: string;
  timeZone: string;
  resolvedCron: string;
  active: boolean | null;
  lastSchedule?: string;
}
export interface Run {
  name: string;
  jobId: string;
  created?: string;
  started?: string;
  finished?: string;
  status: 'Pending' | 'Queued' | 'Running' | 'AwaitingInput' | 'Canceling' | 'Succeeded' | 'Failed' | 'Canceled' | 'Rejected';
  revision?: string;
  image?: string;
  steps: { id: string; name: string; status: string; reason?: string }[];
  reason?: string;
  parameters: Record<string, Value>;
  scheduled: boolean;
}

const apiBase = import.meta.env.VITE_JOB_CONSOLE_API?.replace(/\/+$/, '') || '/job-console-api';
export interface ResultFile {
  id: string;
  name: string;
  label: string;
  step: string;
  available: boolean;
  size?: number;
}

export const prefix = apiBase + '/api';
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(prefix + path, { cache: 'no-store', ...options });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload as T;
}

export function launch(id: string, revision: string, values: Record<string, Value>, files: File[], fields: string[],
  progress: (value: number | null) => void, signal: AbortSignal): Promise<Run> {
  if (!files.length) return api('/jobs/' + id + '/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Job-Revision': revision }, body: JSON.stringify({ parameters: values }), signal,
  });
  const form = new FormData();
  form.set('parameters', JSON.stringify(values));
  files.forEach((file, index) => form.set(fields[index], file));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open('POST', prefix + '/jobs/' + id + '/runs');
    xhr.setRequestHeader('X-Job-Revision', revision);
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => progress(event.lengthComputable ? 100 * event.loaded / event.total : null);
    xhr.onload = () => xhr.status === 201
      ? resolve(xhr.response as Run) : reject(new Error(xhr.response?.error ?? `HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Verbindung beim Upload unterbrochen'));
    xhr.onabort = () => reject(new Error('Upload abgebrochen'));
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) return reject(new Error('Upload abgebrochen'));
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(form);
  });
}
