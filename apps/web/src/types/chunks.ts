export type ChunkStatus =
  | "local_saved"
  | "uploading"
  | "uploaded"
  | "acked"
  | "needs_repair"
  | "repaired"
  | "failed"

export interface RecorderChunk {
  chunkId: string
  recordingId: string
  sequenceNo: number
  blob: Blob
  url: string
  duration: number
  durationMs: number
  timestamp: number
  sizeBytes: number
  localOpfsPath?: string
  status: ChunkStatus
  uploadedAt?: string
  ackedAt?: string
  error?: string
}

export interface ServerChunkRow {
  chunkId: string
  sequenceNo: number
  objectKey: string
  sizeBytes: number
  durationMs: number
  ackedAt: string
}

/** Response row from GET .../audit (DB + bucket HEAD). */
export interface ServerAuditChunkRow extends ServerChunkRow {
  bucketPresent: boolean
}

export interface ServerChunksListResponse {
  ok: boolean
  recordingId: string
  chunks: ServerChunkRow[]
}

export interface ServerAuditResponse {
  ok: boolean
  recordingId: string
  chunks: ServerAuditChunkRow[]
}
