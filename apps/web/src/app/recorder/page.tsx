"use client"

import { useCallback, useRef, useState } from "react"
import { Copy, Download, Mic, Pause, Play, Square, Trash2 } from "lucide-react"

import { Button } from "@my-better-t-app/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { useRecorder, type RecorderChunk } from "@/hooks/use-recorder"

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`
}

function formatDuration(seconds: number) {
  return `${seconds.toFixed(1)}s`
}

function ChunkRow({ chunk, index }: { chunk: RecorderChunk; index: number }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      el.currentTime = 0
      setPlaying(false)
    } else {
      el.play()
      setPlaying(true)
    }
  }

  const download = () => {
    const a = document.createElement("a")
    a.href = chunk.url
    a.download = `chunk-${index + 1}.wav`
    a.click()
  }

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <audio
          ref={audioRef}
          src={chunk.url}
          onEnded={() => setPlaying(false)}
          preload="none"
        />
        <span className="text-xs font-medium text-muted-foreground tabular-nums">
          #{index + 1}
        </span>
        <span className="text-xs text-muted-foreground">Seq {chunk.sequenceNo}</span>
        <span className="text-xs font-semibold uppercase tracking-wider">
          {chunk.status.replace(/_/g, " ")}
        </span>
        <span className="text-xs tabular-nums">{formatDuration(chunk.duration)}</span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon-xs" onClick={toggle}>
            {playing ? <Square className="size-3" /> : <Play className="size-3" />}
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={download}>
            <Download className="size-3" />
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <span>Chunk ID: {chunk.chunkId}</span>
        <span>Size: {chunk.sizeBytes.toLocaleString()} bytes</span>
        <span>OPFS: {chunk.localOpfsPath ?? "pending"}</span>
        <span>Uploaded: {chunk.uploadedAt ?? "-"}</span>
        <span>Acked: {chunk.ackedAt ?? "-"}</span>
        {chunk.error ? (
          <span className="text-destructive">Error: {chunk.error}</span>
        ) : (
          <span className="text-muted-foreground">No error</span>
        )}
      </div>
    </div>
  )
}

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>()
  const [isReconciling, setIsReconciling] = useState(false)
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null)
  const [copyHint, setCopyHint] = useState<string | null>(null)
  const {
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
  } = useRecorder({ chunkDuration: 5, deviceId })

  const handleReconcile = useCallback(async () => {
    setIsReconciling(true)
    setReconcileMessage(null)
    try {
      await reconcileRecording()
      setReconcileMessage("Reconciliation completed")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setReconcileMessage(`Reconcile error: ${message}`)
    } finally {
      setIsReconciling(false)
    }
  }, [reconcileRecording])

  const handleCleanTranscript = useCallback(async () => {
    await cleanTranscript()
  }, [cleanTranscript])

  const copyCombinedTranscript = useCallback(async () => {
    const text = [rawTranscript, interimTranscript].filter(Boolean).join(" ").trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopyHint("Copied raw + interim")
    } catch {
      setCopyHint("Copy failed")
    }
    setTimeout(() => setCopyHint(null), 2000)
  }, [interimTranscript, rawTranscript])

  const copyCleaned = useCallback(async () => {
    if (!cleanedTranscript) return
    try {
      await navigator.clipboard.writeText(cleanedTranscript)
      setCopyHint("Copied cleaned")
    } catch {
      setCopyHint("Copy failed")
    }
    setTimeout(() => setCopyHint(null), 2000)
  }, [cleanedTranscript])

  const isRecording = status === "recording"
  const isPaused = status === "paused"
  const isActive = isRecording || isPaused

  const handlePrimary = useCallback(() => {
    if (isActive) {
      stop()
    } else {
      start()
    }
  }, [isActive, stop, start])

  const isCleaning = transcriptionStatus === "cleaning"

  return (
    <div className="container mx-auto flex max-w-2xl flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>
            16 kHz / 16-bit PCM WAV — chunked every 5 s. Each chunk is saved to OPFS before upload,
            then POSTed to the API for MinIO + Postgres ack.
          </CardDescription>
          <div className="flex flex-col gap-1 border-t border-border/40 pt-3 text-xs">
            <span className="font-medium text-foreground">Recording ID</span>
            <span className="break-all font-mono text-muted-foreground">{recordingId}</span>
            <span className="text-muted-foreground">
              Recorder: <span className="font-mono text-foreground">{status}</span>
              {" · "}
              Speech:{" "}
              <span className="font-mono text-foreground">{transcriptionStatus}</span>
            </span>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={isRecording}
              processing={isPaused}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          <div className="flex items-center justify-center gap-3">
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting"}
            >
              {isActive ? (
                <>
                  <Square className="size-4" />
                  Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" />
                  {status === "requesting" ? "Requesting..." : "Record"}
                </>
              )}
            </Button>

            {isActive && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={isPaused ? resume : pause}
              >
                {isPaused ? (
                  <>
                    <Play className="size-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-4" />
                    Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="w-full">
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
          <CardDescription>
            Live text from the browser Web Speech API (not the WAV chunks). DeepSeek only formats
            this text after you stop — no audio is sent to DeepSeek.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {transcriptionStatus === "unsupported" && (
            <p className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100">
              This browser does not expose speech recognition. Recording and chunk upload still
              work; only live transcription is unavailable.
            </p>
          )}
          {transcriptionError && transcriptionStatus === "failed" && (
            <p className="text-sm text-destructive">{transcriptionError}</p>
          )}
          <div>
            <span className="text-xs font-medium text-muted-foreground">Raw (final)</span>
            <p className="mt-1 min-h-[3rem] whitespace-pre-wrap rounded-sm border border-border/50 bg-muted/20 p-2 text-sm">
              {rawTranscript || "—"}
            </p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Interim</span>
            <p className="mt-1 min-h-[2rem] whitespace-pre-wrap rounded-sm border border-dashed border-border/50 bg-muted/10 p-2 text-sm text-muted-foreground">
              {interimTranscript || "—"}
            </p>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Cleaned (DeepSeek)</span>
            <p className="mt-1 min-h-[3rem] whitespace-pre-wrap rounded-sm border border-border/50 bg-muted/20 p-2 text-sm">
              {cleanedTranscript || "—"}
            </p>
            {transcriptCleanedAt && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Cleaned at {transcriptCleanedAt}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isCleaning || isActive}
              onClick={handleCleanTranscript}
            >
              {isCleaning ? "Cleaning…" : "Clean transcript"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={copyCombinedTranscript}
              disabled={!rawTranscript && !interimTranscript}
            >
              <Copy className="size-3" />
              Copy raw + interim
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={copyCleaned}
              disabled={!cleanedTranscript}
            >
              <Copy className="size-3" />
              Copy cleaned
            </Button>
          </div>
          {copyHint && <p className="text-xs text-muted-foreground">{copyHint}</p>}
        </CardContent>
      </Card>

      {chunks.length > 0 && (
        <Card className="w-full">
          <CardHeader className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <CardTitle>Chunks</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={handleReconcile}
                disabled={isReconciling || chunks.length === 0}
              >
                {isReconciling ? "Reconciling..." : "Reconcile recording"}
              </Button>
            </div>
            <CardDescription>{chunks.length} recorded</CardDescription>
            <div className="flex flex-col gap-1 text-xs font-mono text-muted-foreground">
              {reconcileMessage && <span>{reconcileMessage}</span>}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {chunks.map((chunk, i) => (
              <ChunkRow key={chunk.chunkId} chunk={chunk} index={i} />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 gap-1.5 self-end text-destructive"
              onClick={clearChunks}
            >
              <Trash2 className="size-3" />
              Clear all
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
