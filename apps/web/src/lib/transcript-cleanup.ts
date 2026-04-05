import { getServerApiBase } from "@/lib/chunk-upload"

export type TranscriptCleanupResponse = {
  ok: boolean
  cleanedText?: string
  error?: string
  details?: string
}

export async function requestTranscriptCleanup(text: string): Promise<string> {
  const res = await fetch(`${getServerApiBase()}/api/transcription/cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })

  let body: TranscriptCleanupResponse
  try {
    body = (await res.json()) as TranscriptCleanupResponse
  } catch {
    throw new Error(`cleanup failed (${res.status})`)
  }

  if (!res.ok || !body.ok || typeof body.cleanedText !== "string") {
    const message =
      body.error ?? body.details ?? `cleanup failed (${res.status})`
    throw new Error(message)
  }

  return body.cleanedText
}
