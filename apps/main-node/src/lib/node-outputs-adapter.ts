// Node OutputsAdapter — exposes /mnt/session/outputs for self-hosted sessions.
//
// Local subprocess/litebox providers symlink /mnt/session/outputs to a host
// directory. Remote providers such as Daytona mount the same path through an
// S3-compatible bucket, so the API has to read the matching bucket prefix.

import { createReadStream } from "node:fs";
import { stat as fsStat, readdir as fsReaddir, rm as fsRm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { guessSessionOutputMime } from "@open-managed-agents/shared";

export interface S3OutputsAdapterOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

export function nodeOutputsAdapter(outputsRoot: string) {
  return {
    async list(tenantId: string, sessionId: string) {
      const dir = resolvePath(outputsRoot, tenantId, sessionId);
      let entries: string[];
      try {
        entries = await fsReaddir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: Array<{
        filename: string;
        size_bytes: number;
        uploaded_at: string;
        media_type: string;
      }> = [];
      for (const filename of entries) {
        try {
          const st = await fsStat(join(dir, filename));
          if (!st.isFile()) continue;
          out.push({
            filename,
            size_bytes: st.size,
            uploaded_at: new Date(st.mtimeMs).toISOString(),
            media_type: guessSessionOutputMime(filename),
          });
        } catch {
          /* skip unreadable entries */
        }
      }
      return out;
    },
    async read(tenantId: string, sessionId: string, filename: string) {
      const full = join(resolvePath(outputsRoot, tenantId, sessionId), filename);
      let st;
      try {
        st = await fsStat(full);
        if (!st.isFile()) return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      const nodeStream = createReadStream(full);
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
      return {
        body: webStream,
        size: st.size,
        contentType: guessSessionOutputMime(filename),
      };
    },
    async deleteAll(tenantId: string, sessionId: string) {
      const dir = resolvePath(outputsRoot, tenantId, sessionId);
      await fsRm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function nodeS3OutputsAdapter(opts: S3OutputsAdapterOptions) {
  let clientPromise: Promise<{
    client: S3Client;
    ListObjectsV2Command: S3CommandCtor<unknown, ListObjectsV2Output>;
    GetObjectCommand: S3CommandCtor<unknown, GetObjectOutput>;
    DeleteObjectsCommand: S3CommandCtor<unknown, unknown>;
  }> | null = null;

  const ensureClient = async () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const sdk = (await import(
          /* @vite-ignore */ "@aws-sdk/client-s3" as string
        )) as {
          S3Client: new (cfg: unknown) => S3Client;
          ListObjectsV2Command: S3CommandCtor<unknown, ListObjectsV2Output>;
          GetObjectCommand: S3CommandCtor<unknown, GetObjectOutput>;
          DeleteObjectsCommand: S3CommandCtor<unknown, unknown>;
        };
        const client = new sdk.S3Client({
          endpoint: opts.endpoint,
          region: opts.region ?? "us-east-1",
          forcePathStyle: opts.forcePathStyle ?? true,
          credentials: {
            accessKeyId: opts.accessKeyId,
            secretAccessKey: opts.secretAccessKey,
          },
        });
        return {
          client,
          ListObjectsV2Command: sdk.ListObjectsV2Command,
          GetObjectCommand: sdk.GetObjectCommand,
          DeleteObjectsCommand: sdk.DeleteObjectsCommand,
        };
      })();
    }
    return clientPromise;
  };

  const keyPrefix = (tenantId: string, sessionId: string) =>
    `${opts.prefix ?? ""}session-outputs/${tenantId}/${sessionId}/`;

  return {
    async list(tenantId: string, sessionId: string) {
      const { client, ListObjectsV2Command } = await ensureClient();
      const prefix = keyPrefix(tenantId, sessionId);
      const out: Array<{
        filename: string;
        size_bytes: number;
        uploaded_at: string;
        media_type: string;
      }> = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: opts.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const obj of page.Contents ?? []) {
          if (!obj.Key || obj.Key.endsWith("/")) continue;
          const filename = obj.Key.slice(prefix.length);
          if (!filename || filename.includes("/")) continue;
          out.push({
            filename,
            size_bytes: obj.Size ?? 0,
            uploaded_at: (obj.LastModified ?? new Date(0)).toISOString(),
            media_type: guessSessionOutputMime(filename),
          });
        }
        token = page.NextContinuationToken;
      } while (token);
      return out;
    },
    async read(_tenantId: string, _sessionId: string, filename: string) {
      if (!isFlatOutputFilename(filename)) return null;
      const { client, GetObjectCommand } = await ensureClient();
      const key = `${keyPrefix(_tenantId, _sessionId)}${filename}`;
      try {
        const obj = await client.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: key }),
        );
        const bytes = obj.Body ? await obj.Body.transformToByteArray() : new Uint8Array();
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          size: obj.ContentLength ?? bytes.byteLength,
          contentType: obj.ContentType ?? guessSessionOutputMime(filename),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async deleteAll(tenantId: string, sessionId: string) {
      const { client, ListObjectsV2Command, DeleteObjectsCommand } = await ensureClient();
      const prefix = keyPrefix(tenantId, sessionId);
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: opts.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        const keys = (page.Contents ?? [])
          .map((obj) => obj.Key)
          .filter((key): key is string => typeof key === "string" && key.length > 0);
        for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000);
          if (batch.length === 0) continue;
          await client.send(
            new DeleteObjectsCommand({
              Bucket: opts.bucket,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
            }),
          );
        }
        token = page.NextContinuationToken;
      } while (token);
    },
  };
}

interface S3Client {
  send<O>(command: { output?: O }): Promise<O>;
}

type S3CommandCtor<I, O> = new (input: I) => { output?: O };

interface ListObjectsV2Output {
  Contents?: Array<{
    Key?: string;
    Size?: number;
    LastModified?: Date;
  }>;
  NextContinuationToken?: string;
}

interface GetObjectOutput {
  ContentLength?: number;
  ContentType?: string;
  Body?: {
    transformToByteArray(): Promise<Uint8Array>;
  };
}

function isFlatOutputFilename(filename: string): boolean {
  return filename.length > 0 &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    filename !== "." &&
    filename !== "..";
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404;
}
