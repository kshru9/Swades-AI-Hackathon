import { useCallback, useEffect, useRef, useState } from "react"

import { readChunkFromOpfs, saveChunkToOpfs } from "@/lib/opfs"
import { getServerApiBase, uploadChunk } from "@/lib/chunk-upload"
import {
  getBrowserSpeechRecognitionCtor,
  type BrowserSpeechRecognition,
} from "@/lib/speech-recognition"
import { requestTranscriptCleanup } from "@/lib/transcript-cleanup"
import type { ChunkStatus, RecorderChunk, ServerAuditResponse } from "@/types/chunks"

export type { RecorderChunk } from "@/types/chunks"

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096

const createRecordingId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `recording-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: "audio/wav" })
}

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.round(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const srcIndex = i * ratio
    const low = Math.floor(srcIndex)
    const high = Math.min(low + 1, input.length - 1)
    const frac = srcIndex - low
    output[i] = input[low] * (1 - frac) + input[high] * frac
  }
  return output
}

export interface UseRecorderOptions {
  chunkDuration?: number
  deviceId?: string
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused"

export type TranscriptionStatus =
  | "idle"
  | "listening"
  | "unsupported"
  | "cleaning"
  | "cleaned"
  | "failed"

export function useRecorder(options: UseRecorderOptions = {}) {
  const { chunkDuration = 5, deviceId } = options

  const [status, setStatus] = useState<RecorderStatus>("idle")
  const [chunks, setChunks] = useState<RecorderChunk[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [recordingId, setRecordingId] = useState(() => createRecordingId())

  const [rawTranscript, setRawTranscript] = useState("")
  const [interimTranscript, setInterimTranscript] = useState("")
  const [cleanedTranscript, setCleanedTranscript] = useState("")
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus>("idle")
  const [transcriptionError, setTranscriptionError] = useState<string | undefined>()
  const [transcriptCleanedAt, setTranscriptCleanedAt] = useState<string | undefined>()

  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const sampleCountRef = useRef(0)
  const chunkSequenceRef = useRef(0)
  const chunkThreshold = SAMPLE_RATE * chunkDuration
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const pausedElapsedRef = useRef(0)
  const statusRef = useRef<RecorderStatus>("idle")
  const pendingUploadsRef = useRef<RecorderChunk[]>([])
  const uploadingRef = useRef(false)
  const chunksRef = useRef<RecorderChunk[]>([])

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const speechIntentRef = useRef<"off" | "listen" | "paused">("off")
  const rawTranscriptRef = useRef("")
  const interimTranscriptRef = useRef("")

  statusRef.current = status
  chunksRef.current = chunks

  const mergeBufferedSamples = useCallback(() => {
    const totalLen = samplesRef.current.reduce((len, buf) => len + buf.length, 0)
    if (totalLen === 0) return null
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const buf of samplesRef.current) {
      merged.set(buf, offset)
      offset += buf.length
    }
    samplesRef.current = []
    sampleCountRef.current = 0
    return merged
  }, [])

  const updateChunkState = useCallback(
    (chunkId: string, patch: Partial<RecorderChunk>) => {
      setChunks((prev) =>
        prev.map((chunk) => (chunk.chunkId === chunkId ? { ...chunk, ...patch } : chunk))
      )
    },
    []
  )

  const uploadChunkInternal = useCallback(
    async (chunk: RecorderChunk) => {
      updateChunkState(chunk.chunkId, { status: "uploading", error: undefined })
      try {
        const result = await uploadChunk({
          recordingId: chunk.recordingId,
          chunkId: chunk.chunkId,
          sequenceNo: chunk.sequenceNo,
          durationMs: chunk.durationMs,
          blob: chunk.blob,
        })
        updateChunkState(chunk.chunkId, {
          status: (result.ackedAt ? "acked" : "uploaded") as ChunkStatus,
          uploadedAt: new Date().toISOString(),
          ackedAt: result.ackedAt,
          sizeBytes: result.sizeBytes,
          error: undefined,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateChunkState(chunk.chunkId, { status: "failed", error: message })
      }
    },
    [updateChunkState]
  )

  const runUploadQueue = useCallback(async () => {
    if (uploadingRef.current) return
    uploadingRef.current = true
    try {
      while (pendingUploadsRef.current.length > 0) {
        const next = pendingUploadsRef.current.shift()
        if (!next) continue
        await uploadChunkInternal(next)
      }
    } finally {
      uploadingRef.current = false
    }
  }, [uploadChunkInternal])

  const enqueueUpload = useCallback(
    (chunk: RecorderChunk) => {
      pendingUploadsRef.current.push(chunk)
      void runUploadQueue()
    },
    [runUploadQueue]
  )

  const handleBufferedChunk = useCallback(
    async (samples: Float32Array) => {
      if (!recordingId) return
      const sequenceNo = chunkSequenceRef.current + 1
      chunkSequenceRef.current = sequenceNo
      const chunkId = `${recordingId}-${String(sequenceNo).padStart(4, "0")}`
      const durationSeconds = samples.length / SAMPLE_RATE
      const durationMs = Math.round(durationSeconds * 1000)
      const blob = encodeWav(samples, SAMPLE_RATE)
      const url = URL.createObjectURL(blob)

      const baseChunk: RecorderChunk = {
        chunkId,
        recordingId,
        sequenceNo,
        blob,
        url,
        duration: durationSeconds,
        durationMs,
        timestamp: Date.now(),
        sizeBytes: blob.size,
        status: "local_saved",
      }

      let localOpfsPath: string | undefined
      try {
        localOpfsPath = await saveChunkToOpfs(recordingId, sequenceNo, chunkId, blob)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setChunks((prev) => [
          ...prev,
          { ...baseChunk, status: "failed", error: `OPFS save failed: ${message}` },
        ])
        return
      }

      const savedChunk: RecorderChunk = { ...baseChunk, localOpfsPath }
      setChunks((prev) => [...prev, savedChunk])
      enqueueUpload(savedChunk)
    },
    [enqueueUpload, recordingId]
  )

  const flushChunk = useCallback(async () => {
    const merged = mergeBufferedSamples()
    if (!merged) return
    await handleBufferedChunk(merged)
  }, [handleBufferedChunk, mergeBufferedSamples])

  const reconcileRecording = useCallback(async () => {
    if (!recordingId) return
    const res = await fetch(
      `${getServerApiBase()}/api/chunks/recordings/${recordingId}/audit`
    )
    const body = (await res.json()) as ServerAuditResponse | { ok?: false; error?: string }
    if (!res.ok || !("chunks" in body) || body.ok !== true) {
      const detail = "error" in body && body.error ? body.error : JSON.stringify(body)
      throw new Error(`reconcile failed: ${detail}`)
    }
    const bySeq = new Map(body.chunks.map((row) => [row.sequenceNo, row]))
    for (const chunk of chunksRef.current) {
      const row = bySeq.get(chunk.sequenceNo)
      const serverAndBucketOk = row?.bucketPresent === true
      if (serverAndBucketOk) continue

      updateChunkState(chunk.chunkId, { status: "needs_repair", error: undefined })
      try {
        const opfsBlob = await readChunkFromOpfs(recordingId, chunk.sequenceNo, chunk.chunkId)
        const result = await uploadChunk({
          recordingId,
          chunkId: chunk.chunkId,
          sequenceNo: chunk.sequenceNo,
          durationMs: chunk.durationMs,
          blob: opfsBlob,
        })
        updateChunkState(chunk.chunkId, {
          status: "repaired",
          uploadedAt: new Date().toISOString(),
          ackedAt: result.ackedAt,
          sizeBytes: result.sizeBytes,
          error: undefined,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        updateChunkState(chunk.chunkId, { status: "failed", error: message })
      }
    }
  }, [recordingId, updateChunkState])

  const setupSpeechRecognition = useCallback(() => {
    const Ctor = getBrowserSpeechRecognitionCtor()
    if (!Ctor) {
      speechIntentRef.current = "off"
      setTranscriptionStatus("unsupported")
      return
    }

    setTranscriptionStatus("listening")
    setTranscriptionError(undefined)

    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = "en-US"

    rec.onresult = (event) => {
      let interim = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const piece = result[0]?.transcript ?? ""
        if (result.isFinal) {
          const base = rawTranscriptRef.current
          const next = `${base}${base && piece.trim() ? " " : ""}${piece}`.trim()
          rawTranscriptRef.current = next
          setRawTranscript(next)
        } else {
          interim += piece
        }
      }
      interimTranscriptRef.current = interim
      setInterimTranscript(interim)
    }

    rec.onerror = (ev) => {
      if (ev.error === "aborted" || ev.error === "no-speech") {
        return
      }
      setTranscriptionError(ev.error)
      setTranscriptionStatus("failed")
    }

    rec.onend = () => {
      if (speechIntentRef.current === "listen") {
        try {
          rec.start()
        } catch {
          // ignore duplicate start
        }
      } else if (speechIntentRef.current === "paused") {
        return
      } else {
        const merged = [rawTranscriptRef.current, interimTranscriptRef.current]
          .filter(Boolean)
          .join(" ")
          .trim()
        rawTranscriptRef.current = merged
        setRawTranscript(merged)
        interimTranscriptRef.current = ""
        setInterimTranscript("")
        recognitionRef.current = null
        setTranscriptionStatus((prev) =>
          prev === "unsupported" || prev === "failed" ? prev : "idle"
        )
      }
    }

    recognitionRef.current = rec
    try {
      rec.start()
    } catch (error) {
      speechIntentRef.current = "off"
      const message = error instanceof Error ? error.message : String(error)
      setTranscriptionError(message)
      setTranscriptionStatus("failed")
      recognitionRef.current = null
    }
  }, [])

  const start = useCallback(async () => {
    if (statusRef.current === "recording") return

    setStatus("requesting")
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      })

      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(mediaStream)
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1)
      const nativeSampleRate = audioCtx.sampleRate

      processor.onaudioprocess = (e) => {
        if (statusRef.current !== "recording") return

        const input = e.inputBuffer.getChannelData(0)
        const resampled = resample(new Float32Array(input), nativeSampleRate, SAMPLE_RATE)

        samplesRef.current.push(resampled)
        sampleCountRef.current += resampled.length

        if (sampleCountRef.current >= chunkThreshold) {
          const merged = mergeBufferedSamples()
          if (merged) void handleBufferedChunk(merged)
        }
      }

      source.connect(processor)
      processor.connect(audioCtx.destination)

      streamRef.current = mediaStream
      audioCtxRef.current = audioCtx
      processorRef.current = processor
      setStream(mediaStream)

      samplesRef.current = []
      sampleCountRef.current = 0
      pausedElapsedRef.current = 0
      startTimeRef.current = Date.now()
      setElapsed(0)

      setRawTranscript("")
      setInterimTranscript("")
      setCleanedTranscript("")
      setTranscriptionError(undefined)
      setTranscriptCleanedAt(undefined)
      rawTranscriptRef.current = ""
      interimTranscriptRef.current = ""

      speechIntentRef.current = "listen"
      setStatus("recording")
      setupSpeechRecognition()

      timerRef.current = setInterval(() => {
        if (statusRef.current === "recording") {
          setElapsed(pausedElapsedRef.current + (Date.now() - startTimeRef.current) / 1000)
        }
      }, 100)
    } catch {
      speechIntentRef.current = "off"
      setStatus("idle")
    }
  }, [chunkThreshold, deviceId, handleBufferedChunk, mergeBufferedSamples, setupSpeechRecognition])

  const stop = useCallback(() => {
    void flushChunk()

    speechIntentRef.current = "off"
    recognitionRef.current?.stop()

    processorRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (audioCtxRef.current?.state !== "closed") {
      audioCtxRef.current?.close()
    }
    if (timerRef.current) clearInterval(timerRef.current)

    processorRef.current = null
    audioCtxRef.current = null
    streamRef.current = null
    setStream(null)
    setStatus("idle")
  }, [flushChunk])

  const pause = useCallback(() => {
    if (statusRef.current !== "recording") return
    speechIntentRef.current = "paused"
    recognitionRef.current?.stop()
    pausedElapsedRef.current += (Date.now() - startTimeRef.current) / 1000
    setStatus("paused")
  }, [])

  const resume = useCallback(() => {
    if (statusRef.current !== "paused") return
    speechIntentRef.current = "listen"
    try {
      recognitionRef.current?.start()
    } catch {
      // ignore
    }
    startTimeRef.current = Date.now()
    setStatus("recording")
  }, [])

  const cleanTranscript = useCallback(async () => {
    const text = [rawTranscriptRef.current, interimTranscriptRef.current]
      .filter(Boolean)
      .join(" ")
      .trim()
    if (!text) {
      setTranscriptionError("Nothing to clean yet.")
      setTranscriptionStatus("failed")
      return
    }

    setTranscriptionStatus("cleaning")
    setTranscriptionError(undefined)
    try {
      const cleaned = await requestTranscriptCleanup(text)
      setCleanedTranscript(cleaned)
      setTranscriptCleanedAt(new Date().toISOString())
      setTranscriptionStatus("cleaned")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTranscriptionError(message)
      setTranscriptionStatus("failed")
    }
  }, [])

  const clearChunks = useCallback(() => {
    speechIntentRef.current = "off"
    recognitionRef.current?.abort()
    recognitionRef.current = null

    for (const chunk of chunks) {
      URL.revokeObjectURL(chunk.url)
    }
    setChunks([])
    chunkSequenceRef.current = 0
    pendingUploadsRef.current = []
    uploadingRef.current = false
    setRecordingId(createRecordingId())

    setRawTranscript("")
    setInterimTranscript("")
    setCleanedTranscript("")
    setTranscriptionStatus("idle")
    setTranscriptionError(undefined)
    setTranscriptCleanedAt(undefined)
    rawTranscriptRef.current = ""
    interimTranscriptRef.current = ""
  }, [chunks])

  useEffect(() => {
    return () => {
      speechIntentRef.current = "off"
      recognitionRef.current?.abort()
      recognitionRef.current = null
      processorRef.current?.disconnect()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (audioCtxRef.current?.state !== "closed") {
        audioCtxRef.current?.close()
      }
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  return {
    status,
    start,
    stop,
    pause,
    resume,
    chunks,
    elapsed,
    stream,
    clearChunks,
    recordingId,
    reconcileRecording,
    rawTranscript,
    interimTranscript,
    cleanedTranscript,
    transcriptionStatus,
    transcriptionError,
    transcriptCleanedAt,
    cleanTranscript,
  }
}
