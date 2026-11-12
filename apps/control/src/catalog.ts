import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

export const jobId = z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const fieldName = z.string().max(48).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .refine(name => !['constructor', 'prototype'].includes(name));

export const parameter = z.strictObject({
  name: fieldName,
  label: z.string().min(1),
  type: z.enum(['text', 'multiline', 'integer', 'boolean', 'enum', 'date', 'file']),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.boolean(), z.number()]).optional(),
  accept: z.array(z.string().regex(/^\.[a-z0-9]+$/i)).min(1).optional(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string().min(1) })).min(1).optional(),
});

const quantities = z.strictObject({
  cpu: z.string().regex(/^(?:[1-9]\d{0,3}m|[1-2])$/).refine(v => !v.endsWith('m') || parseInt(v) <= 2000),
  memory: z.string().regex(/^(?:[1-9]\d{0,3}Mi|[1-2]Gi)$/).refine(v => !v.endsWith('Mi') || parseInt(v) <= 2048),
});

const grant = z.strictObject({
  users: z.array(z.string().min(1).max(1024)).default([]),
  groups: z.array(z.string().min(1).max(256)).default([]),
});

export const access = z.strictObject({
  view: grant.optional(),
  run: grant.optional(),
  approve: grant.optional(),
  manage: grant.optional(),
});

export const execution = z.strictObject({
  serial: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(1).max(604800).default(3600),
});

const output = z.strictObject({
  name: jobId,
  label: z.string().min(1),
  path: z.string().max(240).regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/),
  parameter: fieldName,
  optional: z.boolean().default(false),
});

export const definition = z.strictObject({
  schemaVersion: z.literal(2),
  id: jobId,
  name: z.string().min(1),
  description: z.string().min(1),
  runtime: z.literal('gretl'),
  script: z.string().regex(/^[\w-]+\.groovy$/),
  exposed: z.boolean().default(true),
  onSuccess: z.strictObject({ job: jobId }).optional(),
  access: access.default({}),
  outputs: z.array(output).max(32).default([]),
  execution: execution.default({ serial: true, timeoutSeconds: 3600 }),
  parameters: z.array(parameter).max(32).default([]),
  resources: quantities.default({ cpu: '250m', memory: '512Mi' }),
  schedule: z.strictObject({ cron: z.string(), timeZone: z.string().default('Europe/Zurich') }).optional(),
});

export type Parameter = z.infer<typeof parameter>;
export type Job = z.infer<typeof definition> & { resolvedCron?: string };
export type Values = Record<string, string | number | boolean>;

export function resolveCron(id: string, expression: string, timeZone: string) {
  new Intl.DateTimeFormat('en', { timeZone });
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires five fields');
  const resolved = fields.map((field, index) => {
    if (index > 1 || !field.includes('H')) return field;
    const match = /^H(?:\((\d+)-(\d+)\)|\/(\d+))?$/.exec(field);
    if (!match) throw new Error('Unsupported H syntax');
    const max = index === 0 ? 59 : 23;
    const low = Number(match[1] ?? 0);
    const high = Number(match[2] ?? max);
    const step = match[3] === undefined ? undefined : Number(match[3]);
    if (low > high || high > max || (step !== undefined && (step < 1 || step > max + 1))) {
      throw new Error('Invalid H range or step');
    }
    const hash = createHash('sha256').update(id + ':' + index).digest().readUInt32BE();
    const offset = low + hash % (step ?? (high - low + 1));
    return step === undefined ? String(offset) : `${offset}-${max}/${step}`;
  });
  // Keep the Kubernetes numeric cron grammar and supported month/day aliases.
  if (resolved.some((field, index) => {
    const normalized = index === 3 ? field.replace(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/gi, '1')
      : index === 4 ? field.replace(/SUN|MON|TUE|WED|THU|FRI|SAT/gi, '1') : field;
    if (!/^(?:\*|\?|\d+(?:-\d+)?)(?:\/\d+)?(?:,(?:\*|\?|\d+(?:-\d+)?)(?:\/\d+)?)*$/.test(normalized)) return true;
    // cron-parser also accepts Sunday as 7. Kubernetes requires 0 or SUN.
    return index === 4 && normalized.split(',').some(item =>
      item.split('/')[0].split('-').some(value => Number(value) > 6));
  })) throw new Error('Unsupported Kubernetes cron syntax');
  const cron = resolved.join(' ');
  CronExpressionParser.parse(cron.replaceAll('?', '*'), { tz: timeZone });
  return cron;
}

function validValue(p: Parameter, value: unknown) {
  switch (p.type) {
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return p.options?.some(option => option.value === value);
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }
    case 'text':
    case 'multiline': return typeof value === 'string' && !value.includes('\0') && value.length <= 4096 && (!p.required || value.trim().length > 0);
    default: return false;
  }
}

export function parseJob(input: unknown): Job {
  const job = definition.parse(input);
  if (job.schedule && !job.exposed) throw new Error('An internal job cannot be scheduled');
  const names = new Set<string>();
  const outputNames = new Set<string>();
  const outputPaths = new Set<string>();
  for (const item of job.outputs) {
    if (names.has(item.parameter) || outputNames.has(item.name) || outputPaths.has(item.path) ||
      [...outputPaths].some(path => item.path.startsWith(path + '/') || path.startsWith(item.path + '/'))) {
      throw new Error(`Conflicting output: ${item.name}`);
    }
    names.add(item.parameter);
    outputNames.add(item.name);
    outputPaths.add(item.path);
  }
  validateParameters(job.parameters, names);
  if (job.schedule) {
    if (job.parameters.some(p => p.type === 'file')) throw new Error('Scheduled jobs cannot upload files');
    validateValues(job, {});
  }
  if (!job.exposed && job.onSuccess) throw new Error('Internal jobs cannot declare a successor');
  return { ...job, resolvedCron: job.schedule && resolveCron(job.id, job.schedule.cron, job.schedule.timeZone) };
}

export function validateParameters(parameters: Parameter[], names = new Set<string>()) {
  for (const p of parameters) {
    if (names.has(p.name)) throw new Error(`Duplicate parameter: ${p.name}`);
    names.add(p.name);
    if ((p.type === 'enum') !== Boolean(p.options) || (p.type === 'file') !== Boolean(p.accept)) {
      throw new Error(`Invalid options or extensions for ${p.name}`);
    }
    if (p.options && (new Set(p.options.map(option => option.value)).size !== p.options.length ||
      p.options.some(option => option.value.includes('\0') || option.value.length > 4096))) {
      throw new Error(`Invalid enum options for ${p.name}`);
    }
    if (p.default !== undefined && !validValue(p, p.default)) throw new Error(`Invalid default for ${p.name}`);
  }
}

export function validateValues(job: Pick<Job, 'parameters'>, input: unknown, files = new Set<string>()): Values {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Expected a parameters object');
  const entries = input as Record<string, unknown>;
  const result: Values = {};
  for (const name of Object.keys(entries)) {
    if (!job.parameters.some(p => p.name === name && p.type !== 'file')) throw new Error(`Unknown parameter: ${name}`);
  }
  for (const p of job.parameters) {
    if (p.type === 'file') {
      if (p.required && !files.has(p.name)) throw new Error(`Missing file: ${p.name}`);
      continue;
    }
    const value = Object.hasOwn(entries, p.name) ? entries[p.name] : p.default;
    if (value === undefined && !p.required) continue;
    if (!validValue(p, value)) throw new Error(`Missing or invalid parameter: ${p.name}`);
    result[p.name] = value as Values[string];
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new Error('Total parameter size exceeds 128 KiB');
  return result;
}
