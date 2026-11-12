import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { S3Client, GetObjectCommand, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const MiB = 1024 ** 2;
export const fileLimit = 512 * MiB;
export const totalLimit = 1024 * MiB;
export const inputKey = (name: string, field: string) => `runs/${name}/inputs/${field}`;

export function storage() {
  const bucket = process.env.S3_BUCKET ?? 'job-console';
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_PATH_STYLE !== 'false',
    requestHandler: {
      connectionTimeout: Number(process.env.S3_CONNECT_TIMEOUT_MS ?? 5000),
      socketTimeout: Number(process.env.S3_SOCKET_TIMEOUT_MS ?? 30000),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async upload(name: string, field: string, source: Readable, count: (bytes: number) => void, signal: AbortSignal) {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try { count(chunk.length); callback(null, chunk); }
          catch (error) { callback(error as Error); }
        },
      });
      const upload = new Upload({
        client, params: { Bucket: bucket, Key: inputKey(name, field), Body: meter },
        partSize: 5 * MiB, queueSize: 1,
      });
      const sending = upload.done().catch(error => { meter.destroy(error as Error); throw error; });
      // Destroying the stream makes the SDK abort its multipart upload and
      // settle after cleanup, even when an S3 request was already in flight.
      const results = await Promise.allSettled([pipeline(source, meter, { signal }), sending]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
    async copyInput(source: string, name: string, field: string) {
      const copySource = [bucket, ...source.split('/')].map(encodeURIComponent).join('/');
      await client.send(new CopyObjectCommand({ Bucket: bucket, Key: inputKey(name, field), CopySource: copySource }));
    },
    async remove(name: string, field: string) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: inputKey(name, field) }));
    },
    async stat(key: string) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { available: true, size: result.ContentLength };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
          return { available: false };
        }
        throw error;
      }
    },
    async download(key: string) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { stream: response.Body as Readable, size: response.ContentLength };
    },
    async initialize() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
      const days = Number(process.env.S3_RETENTION_DAYS ?? 30);
      if (!Number.isInteger(days) || days < 30) throw new Error('Invalid S3_RETENTION_DAYS');
      const existing = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))
        .catch(error => {
          if (error.name === 'NoSuchLifecycleConfiguration') return { Rules: [] };
          throw error;
        });
      const rules = existing.Rules ?? [];
      const managed = { 'expire-run-inputs': 'runs/', 'expire-runs': 'runs/', 'expire-artifacts': 'artifacts/' };
      const isManaged = (rule: typeof rules[number]) =>
        Object.hasOwn(managed, rule.ID ?? '') && managed[rule.ID as keyof typeof managed] === rule.Filter?.Prefix;
      await client.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket, LifecycleConfiguration: { Rules: [
          ...rules.filter(rule => !isManaged(rule)),
          ...['runs/', 'artifacts/'].map(prefix => ({
            ID: 'expire-' + prefix.slice(0, -1), Status: 'Enabled' as const, Filter: { Prefix: prefix },
            Expiration: { Days: Math.max(days, ...rules.filter(rule => isManaged(rule) && rule.Filter?.Prefix === prefix)
              .map(rule => rule.Expiration?.Days ?? 0)) },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          })),
        ] },
      }));
    },
  };
}
