import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { parseFlow } from './flows.js';
import { parseJob, validateValues } from './catalog.js';
import { cronWorkflow, workflow, managedBy, templateName, type CatalogEntry, type CatalogJob, type Source } from './workflows.js';

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
  for (const job of jobs) {
    if (!job.onSuccess) continue;
    const target = jobs.find(item => item.id === job.onSuccess!.job);
    if (!target || target.id === job.id || target.onSuccess) throw new Error(`Invalid onSuccess target for ${job.id}`);
    try { validateValues(target, {}); }
    catch (error) { throw new Error(`${job.id} onSuccess: ${(error as Error).message}`); }
    const { source: _source, ...successor } = target;
    job.successor = successor;
  }
  const entries: CatalogEntry[] = [...jobs];
  const flowsRoot = join(jobsDir, 'flows');
  const flowDirectories = await readdir(flowsRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const directory of flowDirectories.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!directory.isDirectory()) throw new Error(`Expected a flow directory: ${directory.name}`);
    const file = join(flowsRoot, directory.name, 'flow.yaml');
    try {
      if (!(await lstat(file)).isFile()) throw new Error('Expected a regular definition');
      const flow = parseFlow(parse(await readFile(file, 'utf8')), jobs);
      if (flow.id !== directory.name) throw new Error('Flow ID must match directory name');
      if (entries.some(entry => entry.id === flow.id)) throw new Error(`Duplicate entry ID: ${flow.id}`);
      const references = new Set(flow.steps.flatMap(step => 'job' in step ? [step.job] : []));
      entries.push({ ...flow, source, kind: 'flow', exposed: true, runtime: 'gretl',
        jobs: jobs.filter(job => references.has(job.id)).map(({ source: _source, ...job }) => job) });
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
  const catalog = JSON.stringify(entries, null, 2) + '\n';
  if (Buffer.byteLength(catalog) > 900 * 1024) throw new Error('Catalog exceeds ConfigMap budget');
  const configMap = {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'job-console-catalog',
      labels: { [managedBy]: 'job-console' }, annotations: { 'job-console.io/revision': source.revision,
        'job-console.io/ref': source.ref ?? '', 'job-console.io/preview': String(preview) } },
    data: { 'catalog.json': catalog },
  };
  const templates = entries.filter(entry => entry.exposed).map(job => {
    const run = workflow(job, undefined, {}, []);
    return { apiVersion: run.apiVersion, kind: 'WorkflowTemplate', metadata: {
      ...run.metadata, name: templateName(job),
    }, spec: run.spec };
  });
  return { jobs: entries, configMap, templates, crons: preview ? [] : entries.filter(job => job.schedule).map(cronWorkflow) };
}
