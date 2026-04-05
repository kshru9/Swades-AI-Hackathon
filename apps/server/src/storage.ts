import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
