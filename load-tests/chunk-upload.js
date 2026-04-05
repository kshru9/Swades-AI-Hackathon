/**
 * k6 multipart upload against Beta 1 POST /api/chunks/upload
 *
 * Post-load validation (run manually after k6):
 * - Successful HTTP: k6 handles `http_req_failed` rate and checks below.
 * - DB ack rows: psql or drizzle studio — count rows for test recordingIds.
 * - Bucket objects: MinIO console / mc ls — compare count to sequences uploaded.
 * - Mismatch: delete one object in MinIO, open recorder UI, Reconcile — expect repaired.
 *
 * Run tiny profile:
 *   k6 run load-tests/chunk-upload.js -e PROFILE=tiny
 *
 * Run heavier (~5s WAV-sized) profile:
 *   k6 run load-tests/chunk-upload.js -e PROFILE=chunk5s
 *
 * Target server (not Next):
 *   k6 run load-tests/chunk-upload.js -e BASE_URL=http://localhost:3000
 */

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const PROFILE = __ENV.PROFILE || "tiny";

/** ~16000 Hz * 5 s * 2 bytes PCM + 44 byte WAV header */
const CHUNK_5S_PCM_BYTES = 16000 * 5 * 2;
const WAV_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x08, 0x00, 0x00,
]);

function buildDummyWav(pcmBytes) {
  const pcm = new Uint8Array(pcmBytes);
  const body = new Uint8Array(WAV_HEADER.length + pcm.length);
  body.set(WAV_HEADER, 0);
  body.set(pcm, WAV_HEADER.length);
  const riffSize = body.byteLength - 8;
  body[4] = riffSize & 0xff;
  body[5] = (riffSize >> 8) & 0xff;
  body[6] = (riffSize >> 16) & 0xff;
  body[7] = (riffSize >> 24) & 0xff;
  const dataSize = pcm.length;
  body[40] = dataSize & 0xff;
  body[41] = (dataSize >> 8) & 0xff;
  body[42] = (dataSize >> 16) & 0xff;
  body[43] = (dataSize >> 24) & 0xff;
  return body;
}

/** k6 http.file() requires ArrayBuffer, not Uint8Array. */
function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

const tinyPayload = buildDummyWav(256);
const chunk5sPayload = buildDummyWav(CHUNK_5S_PCM_BYTES);

export const options =
  PROFILE === "chunk5s"
    ? {
        scenarios: {
          uploads: {
            executor: "constant-vus",
            vus: 4,
            duration: "30s",
          },
        },
        thresholds: {
          http_req_failed: ["rate<0.05"],
          http_req_duration: ["p(95)<8000"],
        },
      }
    : {
        scenarios: {
          uploads: {
            executor: "constant-vus",
            vus: 8,
            duration: "20s",
          },
        },
        thresholds: {
          http_req_failed: ["rate<0.05"],
          http_req_duration: ["p(95)<3000"],
        },
      };

const recordingId = () => `k6-${__VU}-${Date.now()}`;

export default function () {
  const recId = recordingId();
  const seq = __ITER + 1;
  const chunkId = `${recId}-${String(seq).padStart(4, "0")}`;
  const audio = PROFILE === "chunk5s" ? chunk5sPayload : tinyPayload;
  const durationMs = PROFILE === "chunk5s" ? 5000 : 50;

  const form = {
    recordingId: recId,
    chunkId,
    sequenceNo: String(seq),
    durationMs: String(durationMs),
    sizeBytes: String(audio.byteLength),
    audio: http.file(toArrayBuffer(audio), `${chunkId}.wav`, "audio/wav"),
  };

  const res = http.post(`${BASE_URL}/api/chunks/upload`, form);

  check(res, {
    "status 200": (r) => r.status === 200,
    "ok json": (r) => {
      try {
        const j = r.json();
        return j && j.ok === true && typeof j.objectKey === "string";
      } catch {
        return false;
      }
    },
  });

  sleep(0.05);
}
