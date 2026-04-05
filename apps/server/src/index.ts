import { env } from "@my-better-t-app/env/server";
import { chunkAcks, db } from "@my-better-t-app/db";
import { and, asc, eq } from "drizzle-orm";
import { TLSSocket } from "node:tls";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { objectExistsInBucket, uploadChunk } from "./storage";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

const errorResponse = (message: string, details?: string) => ({
  ok: false,
  error: message,
  ...(details ? { details } : {}),
});

app.get("/", (c) => c.text("OK"));

app.post("/api/chunks/upload", async (c) => {
  let formData: FormData;

  try {
    formData = await c.req.formData();
  } catch (error) {
    return c.json(
      errorResponse("invalid form data", error instanceof Error ? error.message : String(error)),
      400,
    );
  }

  const getString = (key: string) => {
    const value = formData.get(key);
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const recordingId = getString("recordingId");
  if (!recordingId) {
    return c.json(errorResponse("recordingId is required"), 400);
  }

  const chunkId = getString("chunkId");
  if (!chunkId) {
    return c.json(errorResponse("chunkId is required"), 400);
  }

  const sequenceValue = formData.get("sequenceNo");
  const sequenceNo = typeof sequenceValue === "string" ? Number(sequenceValue) : NaN;
  if (!Number.isInteger(sequenceNo) || sequenceNo < 0) {
    return c.json(errorResponse("sequenceNo must be a non-negative integer"), 400);
  }

  const durationValue = formData.get("durationMs");
  const durationMs = typeof durationValue === "string" ? Number(durationValue) : NaN;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return c.json(errorResponse("durationMs must be greater than 0"), 400);
  }

  const audioPart = formData.get("audio");
  if (!audioPart || typeof (audioPart as Blob).arrayBuffer !== "function") {
    return c.json(errorResponse("audio chunk is required"), 400);
  }

  const arrayBuffer = await (audioPart as Blob).arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    return c.json(errorResponse("audio chunk cannot be empty"), 400);
  }

  const bytes = new Uint8Array(arrayBuffer);
  const sizeValue = formData.get("sizeBytes");
  const parsedSize = typeof sizeValue === "string" ? Number(sizeValue) : NaN;
  const sizeBytes = Number.isFinite(parsedSize) && parsedSize > 0 ? Math.floor(parsedSize) : bytes.byteLength;

  const checksumValue = formData.get("checksum");
  const checksum = typeof checksumValue === "string" && checksumValue.trim().length > 0 ? checksumValue.trim() : null;

  const objectKey = `recordings/${recordingId}/${sequenceNo}.wav`;

  try {
    await uploadChunk(objectKey, bytes);
  } catch (error) {
    return c.json(
      errorResponse("failed to upload chunk", error instanceof Error ? error.message : String(error)),
      500,
    );
  }

  const now = new Date();

  const insertResult = await db
    .insert(chunkAcks)
    .values({
      recordingId,
      chunkId,
      sequenceNo,
      objectKey,
      sizeBytes,
      durationMs: Math.round(durationMs),
      checksum,
      createdAt: now,
      ackedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  type ChunkAckSummary = {
    chunkId: string;
    sequenceNo: number;
    objectKey: string;
    sizeBytes: number;
    durationMs: number;
    ackedAt: Date;
  };

  let ackRow: ChunkAckSummary | undefined = insertResult[0];
  const alreadyExisted = insertResult.length === 0;

  if (!ackRow) {
    const existing = await db
      .select({
        chunkId: chunkAcks.chunkId,
        sequenceNo: chunkAcks.sequenceNo,
        objectKey: chunkAcks.objectKey,
        sizeBytes: chunkAcks.sizeBytes,
        durationMs: chunkAcks.durationMs,
        ackedAt: chunkAcks.ackedAt,
      })
      .from(chunkAcks)
      .where(and(eq(chunkAcks.recordingId, recordingId), eq(chunkAcks.sequenceNo, sequenceNo)))
      .orderBy(asc(chunkAcks.sequenceNo))
      .limit(1);

    ackRow = existing[0];
  }

  if (!ackRow) {
    return c.json(errorResponse("failed to persist chunk acknowledgment"), 500);
  }

  return c.json({
    ok: true,
    recordingId,
    chunkId: ackRow.chunkId,
    sequenceNo: ackRow.sequenceNo,
    objectKey: ackRow.objectKey,
    bucket: env.S3_BUCKET,
    ackedAt: ackRow.ackedAt.toISOString(),
    sizeBytes: ackRow.sizeBytes,
    alreadyExisted,
  });
});

app.get("/api/chunks/recordings/:recordingId", async (c) => {
  const recordingId = c.req.param("recordingId");
  if (!recordingId) {
    return c.json(errorResponse("recordingId is required"), 400);
  }

  const rows = await db
    .select({
      chunkId: chunkAcks.chunkId,
      sequenceNo: chunkAcks.sequenceNo,
      objectKey: chunkAcks.objectKey,
      sizeBytes: chunkAcks.sizeBytes,
      durationMs: chunkAcks.durationMs,
      ackedAt: chunkAcks.ackedAt,
    })
    .from(chunkAcks)
    .where(eq(chunkAcks.recordingId, recordingId))
    .orderBy(asc(chunkAcks.sequenceNo));

  return c.json({
    ok: true,
    recordingId,
    chunks: rows.map((row) => ({
      chunkId: row.chunkId,
      sequenceNo: row.sequenceNo,
      objectKey: row.objectKey,
      sizeBytes: row.sizeBytes,
      durationMs: row.durationMs,
      ackedAt: row.ackedAt.toISOString(),
    })),
  });
});

/** DB rows plus HEAD check so the client can repair missing bucket objects. */
app.get("/api/chunks/recordings/:recordingId/audit", async (c) => {
  const recordingId = c.req.param("recordingId");
  if (!recordingId) {
    return c.json(errorResponse("recordingId is required"), 400);
  }

  const rows = await db
    .select({
      chunkId: chunkAcks.chunkId,
      sequenceNo: chunkAcks.sequenceNo,
      objectKey: chunkAcks.objectKey,
      sizeBytes: chunkAcks.sizeBytes,
      durationMs: chunkAcks.durationMs,
      ackedAt: chunkAcks.ackedAt,
    })
    .from(chunkAcks)
    .where(eq(chunkAcks.recordingId, recordingId))
    .orderBy(asc(chunkAcks.sequenceNo));

  const chunks = await Promise.all(
    rows.map(async (row) => {
      let bucketPresent = false;
      try {
        bucketPresent = await objectExistsInBucket(row.objectKey);
      } catch {
        bucketPresent = false;
      }
      return {
        chunkId: row.chunkId,
        sequenceNo: row.sequenceNo,
        objectKey: row.objectKey,
        sizeBytes: row.sizeBytes,
        durationMs: row.durationMs,
        ackedAt: row.ackedAt.toISOString(),
        bucketPresent,
      };
    }),
  );

  return c.json({
    ok: true,
    recordingId,
    chunks,
  });
});

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? `localhost:${port}`;
    const protocol =
      req.socket instanceof TLSSocket && req.socket.encrypted ? "https" : "http";
    const pathname = req.url ?? "/";
    const requestInit: RequestInit = {
      method: req.method,
      headers: req.headers as unknown as Headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      requestInit.body = Readable.toWeb(req);
      requestInit.duplex = "half";
    }

    const request = new Request(`${protocol}://${host}${pathname}`, requestInit);

    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));

    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`server listening on port ${port}`);
  });
}

export default app;
