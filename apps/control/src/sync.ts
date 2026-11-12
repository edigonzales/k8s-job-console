import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import { generateResources, validateGitTree } from './generator.js';
import { managedBy, selector, templateAnnotation } from './workflows.js';

const group = 'argoproj.io';
const version = 'v1alpha1';
const manager = 'job-console-seeder';
const previewRef = /^[-a-zA-Z0-9._/]{1,150}$/;
const code = (error: unknown) => (error as { code?: number }).code;

export async function sync(ref: string) {
  const repository = process.env.JOBS_REPOSITORY;
  const main = process.env.JOBS_REF ?? 'main';
  const image = process.env.GRETL_IMAGE;
  const namespace = process.env.NAMESPACE ?? 'job-console';
  if (!repository || !image) throw new Error('JOBS_REPOSITORY and GRETL_IMAGE are required');
  if (!previewRef.test(ref) || ref.startsWith('-') || ref.includes('..') ||
      (ref !== main && process.env.ALLOW_PREVIEW !== 'true')) throw new Error('Git branch is not allowed');
  const url = new URL(repository);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Expected a Git HTTP(S) URL without credentials');
  }
  const config = new KubeConfig();
  config.loadFromCluster();
  const custom = config.makeApiClient(CustomObjectsApi);
  const core = config.makeApiClient(CoreV1Api);
  const resource = (plural: string) => ({ group, version, namespace, plural });
  const checkout = await mkdtemp(join(tmpdir(), 'console-sync-'));
  try {
    const authenticated = Boolean(process.env.JOBS_GIT_USERNAME && process.env.JOBS_GIT_PASSWORD);
    if (Boolean(process.env.JOBS_GIT_USERNAME) !== Boolean(process.env.JOBS_GIT_PASSWORD)) {
      throw new Error('Configure both Git credential fields');
    }
    const askpass = join(checkout, 'git-askpass');
    if (authenticated) await writeFile(askpass, [
      '#!/bin/sh',
      'case "$1" in',
      '  Username*) printf "%s\\n" "$JOBS_GIT_USERNAME" ;;',
      '  Password*) printf "%s\\n" "$JOBS_GIT_PASSWORD" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'), { mode: 0o700 });
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
        ...(authenticated ? { GIT_ASKPASS: askpass } : {}) },
    }).trim();
    git('init');
    git('check-ref-format', 'refs/heads/' + ref);
    try { git('fetch', '--no-tags', '--depth=1', repository, 'refs/heads/' + ref); }
    catch { throw new Error('Could not fetch the configured Git branch'); }
    git('checkout', '--detach', 'FETCH_HEAD');
    const revision = git('rev-parse', 'HEAD');
    await validateGitTree(checkout, git);
    const generated = await generateResources(checkout, { repository, image, revision, ref, gitSecret: authenticated ? 'job-console-git' : undefined }, ref !== main);
    const templates = resource('workflowtemplates');
    const crons = resource('cronworkflows');
    for (const template of generated.templates) {
      const name = template.metadata.name!;
      const existing = await custom.getNamespacedCustomObject({ ...templates, name }).catch(error => {
        if (code(error) === 404) return undefined;
        throw error;
      }) as typeof template | undefined;
      if (existing) {
        if (existing.metadata.labels?.[managedBy] !== 'job-console' ||
            !isDeepStrictEqual(existing.spec, JSON.parse(JSON.stringify(template.spec)))) throw new Error(`Template collision: ${name}`);
      } else {
        await custom.createNamespacedCustomObject({ ...templates, dryRun: 'All', body: template });
      }
    }
    const catalogName = generated.configMap.metadata!.name!;
    const active = await core.readNamespacedConfigMap({ namespace, name: catalogName }).catch(error => {
      if (code(error) === 404) return undefined;
      throw error;
    });
    if (active && active.metadata?.labels?.[managedBy] !== 'job-console') throw new Error('Catalog ownership conflict');
    const catalog = { ...generated.configMap, metadata: {
      ...generated.configMap.metadata, resourceVersion: active?.metadata?.resourceVersion,
    } };
    for (const dryRun of ['All', undefined]) {
      for (const template of generated.templates) {
        try { await custom.createNamespacedCustomObject({ ...templates, body: template, dryRun }); }
        catch (error) { if (code(error) !== 409) throw error; }
      }
      if (ref === main) {
        for (const cron of generated.crons) {
          await applyCron(cron, dryRun);
        }
      }
      if (active) await core.replaceNamespacedConfigMap({ namespace, name: catalogName, body: catalog, dryRun, fieldManager: manager });
      else await core.createNamespacedConfigMap({ namespace, body: catalog, dryRun, fieldManager: manager });
    }
    if (ref === main) {
      const existing = await custom.listNamespacedCustomObject({ ...crons, labelSelector: selector }) as
        { items: { metadata: { name: string; uid: string } }[] };
      for (const item of existing.items) {
        if (!generated.crons.some(cron => cron.metadata.name === item.metadata.name)) {
          await custom.deleteNamespacedCustomObject({
            ...crons, name: item.metadata.name,
            body: { propagationPolicy: 'Orphan', preconditions: { uid: item.metadata.uid } },
          });
        }
      }
    }
    await pruneTemplates();
    console.log(`Synchronized ${ref} at ${revision}`);

    async function pruneTemplates() {
      type Item = { metadata: { name: string; uid: string; creationTimestamp?: string; annotations?: Record<string, string> };
        spec?: { workflowMetadata?: { annotations?: Record<string, string> } } };
      const list = async (plural: string) => (await custom.listNamespacedCustomObject({
        ...resource(plural), labelSelector: selector,
      }) as { items: Item[] }).items;
      const [stored, scheduled, retained] = await Promise.all([
        list('workflowtemplates'), list('cronworkflows'), list('workflows'),
      ]);
      const used = new Set([
        ...generated.templates.map(template => template.metadata.name),
        ...retained.map(run => run.metadata.annotations?.[templateAnnotation]),
        ...scheduled.map(cron => cron.spec?.workflowMetadata?.annotations?.[templateAnnotation]),
      ]);
      const cutoff = Date.now() - 30 * 86400_000;
      for (const template of stored) {
        if (!used.has(template.metadata.name) && Date.parse(template.metadata.creationTimestamp ?? '') < cutoff) {
          await custom.deleteNamespacedCustomObject({ ...templates, name: template.metadata.name,
            body: { preconditions: { uid: template.metadata.uid } } });
        }
      }
    }

    async function applyCron(cron: typeof generated.crons[number], dryRun: string | undefined) {
      const name = cron.metadata.name;
      const previous = await custom.getNamespacedCustomObject({ ...crons, name }).catch(error => {
        if (code(error) === 404) return undefined;
        throw error;
      }) as (typeof cron & { metadata: { resourceVersion: string }; spec: { suspend?: boolean } }) | undefined;
      if (!previous) {
        await custom.createNamespacedCustomObject({ ...crons, dryRun, body: cron });
        return;
      }
      if (previous.metadata.labels?.[managedBy] !== 'job-console') throw new Error(`Schedule ownership conflict: ${name}`);
      await custom.replaceNamespacedCustomObject({ ...crons, name, dryRun, body: {
        ...previous, metadata: { ...previous.metadata, labels: cron.metadata.labels },
        spec: { ...cron.spec, suspend: previous.spec.suspend },
      } });
    }
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
