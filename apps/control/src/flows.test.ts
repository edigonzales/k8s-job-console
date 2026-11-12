import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJob } from './catalog.js';
import { parseFlow } from './flows.js';
import { workflow } from './workflows.js';

const base = { schemaVersion: 2, runtime: 'gretl', script: 'job.groovy', description: 'Fixture', exposed: false };
const file = { name: 'csv', label: 'CSV', type: 'file', required: true, accept: ['.csv'] };
const note = { name: 'note', label: 'Note', type: 'text', required: true };
const prepare = parseJob({ ...base, id: 'prepare', name: 'Prepare', parameters: [file],
  outputs: [{ name: 'result', label: 'Prepared', path: 'prepared.csv', parameter: 'resultFile' }] });
const publish = parseJob({ ...base, id: 'publish', name: 'Publish', parameters: [file, note] });
const flow = {
  schemaVersion: 2, id: 'flow', name: 'Flow', description: 'Fixture',
  parameters: [file],
  steps: [
    { id: 'prepare', job: 'prepare', inputs: { csv: { fromInput: 'csv' } } },
    { id: 'review', approval: { message: 'Review', fields: [note] } },
    { id: 'publish', job: 'publish', inputs: {
      csv: { fromArtifact: { step: 'prepare', name: 'result' } },
      note: { fromApproval: { step: 'review', field: 'note' } },
    } },
  ],
};

test('a flow validates references against previous steps and declared artifact and parameter kinds', () => {
  assert.equal(parseFlow(flow, [prepare, publish]).steps.length, 3);
  const late = { ...flow, steps: [flow.steps[0], flow.steps[2], flow.steps[1]] };
  assert.throws(() => parseFlow(late, [prepare, publish]), /Incompatible parameter reference/);
  const bad = structuredClone(flow);
  bad.steps[2].inputs!.csv = { fromArtifact: { step: 'prepare', name: 'unknown' } };
  assert.throws(() => parseFlow(bad, [prepare, publish]), /Invalid artifact reference/);
  assert.throws(() => parseFlow({ ...flow, steps: [flow.steps[0], flow.steps[0]] }, [prepare, publish]), /Duplicate step/);
  assert.throws(() => parseFlow(flow, [{ ...prepare, onSuccess: { job: 'publish' } }, publish]), /Unavailable job/);
});

test('workflow uses native linearly ordered steps, same-revision tasks and a podless supplied approval', () => {
  const source = { revision: 'b'.repeat(40), image: 'gretl:test', repository: 'https://example.org/jobs.git' };
  const run = workflow({
    ...parseFlow(flow, [prepare, publish]), kind: 'flow', exposed: true, runtime: 'gretl', jobs: [prepare, publish], source,
  }, 'flow-run', {}, ['csv']);
  const templates = run.spec.templates as {
    name: string; steps?: { name: string }[][]; suspend?: object; synchronization?: { mutexes: { name: string }[] };
    inputs?: { artifacts: { name: string; git?: { revision: string } }[] };
  }[];
  assert.deepEqual(templates[0].steps!.map(([step]) => step.name), ['prepare', 'review', 'publish']);
  assert.deepEqual(templates[2].suspend, {});
  assert.equal(templates[1].synchronization?.mutexes[0].name, 'job-prepare');
  assert.equal(templates[3].synchronization?.mutexes[0].name, 'job-publish');
  assert.equal(templates[1].inputs?.artifacts[0].git?.revision, source.revision);
  assert.equal(templates[3].inputs?.artifacts[0].git?.revision, source.revision);
});
