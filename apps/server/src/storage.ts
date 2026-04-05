import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "@my-better-t-app/env/server";

const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export async function uploadChunk(objectKey: string, body: Uint8Array) {
  return s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: objectKey,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: "audio/wav",
    }),
  );
}

/** Returns false if the object is missing (404); rethrows other errors. */
export async function objectExistsInBucket(objectKey: string): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: objectKey,
      }),
    );
    return true;
  } catch (error: unknown) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) {
      return false;
    }
    const name = (error as { name?: string }).name;
    if (name === "NotFound") {
      return false;
    }
    throw error;
  }
}
