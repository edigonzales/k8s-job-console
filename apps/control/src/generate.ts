import { mkdir, readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { parseJob, type Job } from './catalog.js';
import { cronJob, labels, scriptName } from './manifests.js';

const { values } = parseArgs({ options: {
  'jobs-dir': { type: 'string', default: '../gretl-runtime-jobs' },
  output: { type: 'string', default: 'build/generated' },
} });
const root = join(values['jobs-dir']!, 'jobs');
const jobs: Job[] = [];
const scripts = [];
for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
  if (!entry.isDirectory()) throw new Error(`Expected a job directory: ${entry.name}`);
  const directory = join(root, entry.name);
  const yaml = join(directory, 'job.yaml');
  if (!(await lstat(yaml)).isFile()) throw new Error(`Expected a regular definition: ${yaml}`);
  const job = parseJob(parse(await readFile(yaml, 'utf8')));
  if (jobs.some(previous => previous.id === job.id)) throw new Error(`Duplicate job ID: ${job.id}`);
  const script = join(directory, job.script);
  const stat = await lstat(script);
  if (!stat.isFile() || stat.size === 0 || stat.size > 900 * 1024) throw new Error(`Invalid script: ${script}`);
  scripts.push({
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: scriptName(job.id), labels: labels(job.id) },
    data: { [job.script]: await readFile(script, 'utf8') },
  });
  jobs.push(job);
}
const catalog = JSON.stringify(jobs, null, 2) + '\n';
if (Buffer.byteLength(catalog) > 900 * 1024) throw new Error('Catalog exceeds ConfigMap budget');
await mkdir(values.output!, { recursive: true });
for (const [file, content] of Object.entries({
  'catalog.json': catalog,
  'catalog-configmap.yaml': stringify({
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'job-console-catalog' }, data: { 'catalog.json': catalog },
  }),
  'scripts.yaml': stringify({ apiVersion: 'v1', kind: 'List', items: scripts }),
  'cronjobs.yaml': stringify({ apiVersion: 'v1', kind: 'List', items: jobs.filter(job => job.schedule).map(cronJob) }),
})) await writeFile(join(values.output!, file), content);
