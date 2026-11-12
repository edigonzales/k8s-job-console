import { extname } from 'node:path';
import { z } from 'zod';
import { access, execution, fieldName, jobId, parameter, resolveCron, validateParameters, validateValues,
  type Job, type Parameter } from './catalog.js';

const reference = z.union([
  z.strictObject({ value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.strictObject({ fromInput: fieldName }),
  z.strictObject({ fromArtifact: z.strictObject({ step: jobId, name: jobId }) }),
  z.strictObject({ fromApproval: z.strictObject({ step: jobId, field: fieldName }) }),
]);
const approval = z.strictObject({
  message: z.string().min(1).max(2000),
  allowSelfApproval: z.boolean().default(false),
  commentRequired: z.boolean().default(false),
  fields: z.array(parameter).max(16).default([]),
});
const jobStep = z.strictObject({ id: jobId, job: jobId, inputs: z.record(fieldName, reference).default({}) });
const approvalStep = z.strictObject({ id: jobId, approval });
const flowSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: jobId,
  name: z.string().min(1),
  description: z.string().min(1),
  access: access.default({}),
  parameters: z.array(parameter).max(32).default([]),
  execution: execution.default({ serial: true, timeoutSeconds: 604800 }),
  steps: z.array(z.union([jobStep, approvalStep])).min(1).max(24),
  schedule: z.strictObject({ cron: z.string(), timeZone: z.string().default('Europe/Zurich') }).optional(),
});
export type Flow = z.infer<typeof flowSchema> & { resolvedCron?: string };
export type Approval = z.infer<typeof approval>;
export type Step = Flow['steps'][number];

export function parseFlow(input: unknown, jobs: Job[]): Flow {
  const flow = flowSchema.parse(input);
  validateParameters(flow.parameters);
  if (flow.schedule) {
    if (flow.parameters.some(parameter => parameter.type === 'file')) throw new Error('Scheduled flows cannot upload files');
    validateValues(flow, {});
  }
  const previous = new Map<string, Step>();
  for (const step of flow.steps) {
    if (previous.has(step.id)) throw new Error(`Duplicate step: ${step.id}`);
    if ('approval' in step) {
      validateParameters(step.approval.fields);
      if (step.approval.fields.some(field => field.type === 'file')) throw new Error(`Approval cannot upload files: ${step.id}`);
    } else {
      const job = jobs.find(job => job.id === step.job);
      if (!job || job.onSuccess) throw new Error(`Unavailable job for step ${step.id}: ${step.job}`);
      for (const field of Object.keys(step.inputs)) {
        if (!job.parameters.some(parameter => parameter.name === field)) throw new Error(`Unknown input: ${step.id}.${field}`);
      }
      for (const target of job.parameters) {
        const source = step.inputs[target.name];
        const label = `${step.id}.${target.name}`;
        if (!source) {
          if (target.required && target.default === undefined) throw new Error(`Missing input: ${label}`);
        } else if ('value' in source) {
          validateValues({ parameters: [target] }, { [target.name]: source.value });
        } else if ('fromInput' in source) {
          compatible(flow.parameters.find(input => input.name === source.fromInput), target, label);
        } else if ('fromApproval' in source) {
          const previousStep = previous.get(source.fromApproval.step);
          const field = previousStep && 'approval' in previousStep
            ? previousStep.approval.fields.find(field => field.name === source.fromApproval.field) : undefined;
          compatible(field, target, label);
          if (!field?.required && field?.default === undefined) throw new Error(`Approval field needs a value: ${label}`);
        } else {
          const previousStep = previous.get(source.fromArtifact.step);
          const output = previousStep && 'job' in previousStep
            ? jobs.find(job => job.id === previousStep.job)?.outputs.find(output => output.name === source.fromArtifact.name) : undefined;
          if (target.type !== 'file' || !output || (target.required && output.optional) ||
              !target.accept?.some(extension => extension.toLowerCase() === extname(output.path).toLowerCase())) {
            throw new Error(`Invalid artifact reference: ${label}`);
          }
        }
      }
    }
    previous.set(step.id, step);
  }
  return { ...flow, resolvedCron: flow.schedule && resolveCron(flow.id, flow.schedule.cron, flow.schedule.timeZone) };
}

function compatible(source: Parameter | undefined, target: Parameter, label: string) {
  if (!source || source.type !== target.type ||
      (target.required && target.default === undefined && !source.required && source.default === undefined) ||
      (source.accept && source.accept.some(extension =>
        !target.accept?.some(candidate => candidate.toLowerCase() === extension.toLowerCase()))) ||
      (source.options && source.options.some(option => !target.options?.some(candidate => candidate.value === option.value)))) {
    throw new Error(`Incompatible parameter reference: ${label}`);
  }
}
