import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { parseJob, validateValues } from './catalog.js';
import { cronWorkflow, type CatalogJob } from './workflows.js';

const { values } = parseArgs({ options: {
  'jobs-dir': { type: 'string', default: '../gretl-runtime-jobs' },
  output: { type: 'string', default: 'build/generated' },
  repository: { type: 'string' },
  image: { type: 'string' },
} });
const jobsDir = values['jobs-dir']!;
const git = (...args: string[]) => execFileSync('git', args, { cwd: jobsDir, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full Git commit');
if (git('status', '--porcelain', '--untracked-files=all', '--', 'jobs', 'flows')) {
  throw new Error('Commit all job definitions and code before generating workflows');
}
if (/^(120000|160000) /m.test(git('ls-tree', '-r', 'HEAD'))) {
  throw new Error('Git symlinks and submodules are unsupported');
}
const repository = new URL(values.repository ?? git('remote', 'get-url', 'origin'));
if (!['https:', 'http:'].includes(repository.protocol) || repository.username || repository.password ||
    repository.search || repository.hash) throw new Error('Expected a Git HTTP(S) URL without credentials');
const image = values.image ?? process.env.GRETL_IMAGE;
if (!image || !/(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$/.test(image) || image.endsWith(':latest')) {
  throw new Error('Set GRETL_IMAGE or --image to a versioned runtime image');
}

const root = join(jobsDir, 'jobs');
const jobs: CatalogJob[] = [];
for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
  if (!entry.isDirectory()) throw new Error(`Expected a job directory: ${entry.name}`);
  const directory = join(root, entry.name);
  const file = join(directory, 'job.yaml');
  try {
    if (!(await lstat(file)).isFile()) throw new Error('Expected a regular definition');
    const job = parseJob(parse(await readFile(file, 'utf8')));
    if (job.id !== entry.name) throw new Error('Job ID must match directory name');
    const stat = await lstat(join(directory, job.script));
    if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid script: ${job.script}`);
    if (job.schedule) validateValues(job, {});
    jobs.push({ ...job, source: { repository: repository.href, revision, image } });
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}
const catalog = JSON.stringify(jobs, null, 2) + '\n';
if (Buffer.byteLength(catalog) > 900 * 1024) throw new Error('Catalog exceeds ConfigMap budget');
await mkdir(values.output!, { recursive: true });
for (const [file, content] of Object.entries({
  'catalog.json': catalog,
  'catalog-configmap.yaml': stringify({
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'job-console-catalog' }, data: { 'catalog.json': catalog },
  }),
  'cronworkflows.yaml': stringify({ apiVersion: 'v1', kind: 'List', items: jobs.filter(job => job.schedule).map(cronWorkflow) }),
})) await writeFile(join(values.output!, file), content);
