import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseJob, validateValues } from './catalog.js';
import { cronWorkflow, workflow, managedBy, templateName, type CatalogJob, type Source } from './workflows.js';

export async function validateGitTree(root: string, git: (...args: string[]) => string) {
  if (/^(120000|160000) /m.test(git('ls-tree', '-r', 'HEAD'))) throw new Error('Git symlinks and submodules are unsupported');
  for (const name of git('ls-files', '-z', '--', '.gitattributes', ':(glob)**/.gitattributes').split('\0').filter(Boolean)) {
    if (/(?:^|\s)filter=lfs(?:\s|$)/m.test(await readFile(join(root, name), 'utf8'))) {
      throw new Error(`Git LFS is unsupported: ${name}`);
    }
  }
}

export async function generateResources(jobsDir: string, source: Source, preview = false) {
  if (!/(?::[a-zA-Z0-9_.-]+|@sha256:[a-f0-9]{64})$/.test(source.image) || source.image.endsWith(':latest')) {
    throw new Error('Set a versioned runtime image');
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
      jobs.push({ ...job, source });
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
  const catalog = JSON.stringify(jobs, null, 2) + '\n';
  if (Buffer.byteLength(catalog) > 900 * 1024) throw new Error('Catalog exceeds ConfigMap budget');
  const configMap = {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'job-console-catalog',
      labels: { [managedBy]: 'job-console' }, annotations: { 'job-console.io/revision': source.revision,
        'job-console.io/ref': source.ref ?? '', 'job-console.io/preview': String(preview) } },
    data: { 'catalog.json': catalog },
  };
  const templates = jobs.map(job => {
    const run = workflow(job, undefined, {}, []);
    return { apiVersion: run.apiVersion, kind: 'WorkflowTemplate', metadata: {
      ...run.metadata, name: templateName(job),
    }, spec: run.spec };
  });
  return { jobs, configMap, templates, crons: preview ? [] : jobs.filter(job => job.schedule).map(cronWorkflow) };
}
