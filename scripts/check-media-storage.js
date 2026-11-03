import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { loadConfig } from "../dist/platform/config.js";

export async function probeMediaStorage(storage, bucket, key) {
  const created = await storage.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(10_000) },
  );
  if (!created.UploadId) throw new Error("missing multipart upload ID");
  await storage.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: created.UploadId,
    }),
    { abortSignal: AbortSignal.timeout(10_000) },
  );
}

async function main() {
  const config = loadConfig().media;
  if (!config) return;
  // Probes the key LiveKit Egress uploads recordings with: the separate
  // recording upload key when set, so the app's own key can be read-only.
  const storage = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: Boolean(config.s3Endpoint),
    credentials: {
      accessKeyId: config.s3EgressAccessKey ?? config.s3AccessKey,
      secretAccessKey: config.s3EgressSecretKey ?? config.s3SecretKey,
    },
    maxAttempts: 1,
  });
  try {
    await probeMediaStorage(
      storage,
      config.s3Bucket,
      `diagnostics/${randomUUID()}.mp4`,
    );
    console.log(JSON.stringify({ event: "media_storage_probe", result: "ok" }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "media_storage_probe",
        result: "failed",
        name: error?.name,
        status: error?.$metadata?.httpStatusCode,
      }),
    );
    process.exitCode = 1;
  } finally {
    storage.destroy();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
