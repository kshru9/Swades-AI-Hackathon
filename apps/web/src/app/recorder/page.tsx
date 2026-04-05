"use client"

import { useCallback, useRef, useState } from "react"
import { Download, Mic, Pause, Play, Square, Trash2 } from "lucide-react"

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

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>16 kHz / 16-bit PCM WAV — chunked every 5 s</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* Waveform */}
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

          {/* Timer */}
          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            {/* Record / Stop */}
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

            {/* Pause / Resume */}
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

      {/* Chunks */}
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
                {isReconciling ? "Reconciling..." : "Reconcile Recording"}
              </Button>
            </div>
            <CardDescription>{chunks.length} recorded</CardDescription>
            <div className="flex flex-col gap-1 text-xs font-mono text-muted-foreground">
              <span>Recording ID: {recordingId}</span>
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
