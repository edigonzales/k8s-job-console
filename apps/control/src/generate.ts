import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { generateResources, validateGitTree } from './generator.js';

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
if (git('status', '--porcelain', '--untracked-files=all')) {
  throw new Error('Commit all job definitions and code before generating workflows');
}
await validateGitTree(jobsDir, git);
const repository = new URL(values.repository ?? git('remote', 'get-url', 'origin'));
if (!['https:', 'http:'].includes(repository.protocol) || repository.username || repository.password ||
    repository.search || repository.hash) throw new Error('Expected a Git HTTP(S) URL without credentials');
const image = values.image ?? process.env.GRETL_IMAGE;
if (!image) throw new Error('Set GRETL_IMAGE or --image');
const generated = await generateResources(jobsDir, { repository: repository.href, revision, image });
const list = (items: unknown[]) => stringify({ apiVersion: 'v1', kind: 'List', items });
await mkdir(values.output!, { recursive: true });
for (const [file, content] of Object.entries({
  'catalog.json': generated.configMap.data['catalog.json'],
  'catalog-configmap.yaml': stringify(generated.configMap),
  'workflowtemplates.yaml': list(generated.templates),
  'cronworkflows.yaml': list(generated.crons),
})) await writeFile(join(values.output!, file), content);
