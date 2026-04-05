import { env } from "@my-better-t-app/env/web"

export function getServerApiBase(): string {
  return env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, "")
}

export interface ChunkUploadResult {
  ok: boolean
  recordingId: string
  chunkId: string
  sequenceNo: number
  objectKey: string
  bucket: string
  ackedAt: string
  sizeBytes: number
  alreadyExisted?: boolean
}

export async function uploadChunk({
  recordingId,
  chunkId,
  sequenceNo,
  durationMs,
  blob,
}: {
  recordingId: string
  chunkId: string
  sequenceNo: number
  durationMs: number
  blob: Blob
}) {
  const form = new FormData()
  form.append("recordingId", recordingId)
  form.append("chunkId", chunkId)
  form.append("sequenceNo", sequenceNo.toString())
  form.append("durationMs", durationMs.toString())
  form.append("sizeBytes", blob.size.toString())
  form.append("audio", blob, `${chunkId}.wav`)

  const res = await fetch(`${getServerApiBase()}/api/chunks/upload`, {
    method: "POST",
    body: form,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`upload failed: ${text}`)
  }
  return (await res.json()) as ChunkUploadResult
}
