/** Minimal surface for browser SpeechRecognition (Chrome: webkitSpeechRecognition). */

export type SpeechRecognitionResultLike = {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: { transcript: string }
}

export type SpeechRecognitionResultListLike = {
  readonly length: number
  [index: number]: SpeechRecognitionResultLike
}

export type BrowserSpeechRecognitionResultEvent = {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

export type BrowserSpeechRecognitionErrorEvent = {
  error: string
}

export type BrowserSpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((ev: BrowserSpeechRecognitionResultEvent) => void) | null
  onerror: ((ev: BrowserSpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

export type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition

export function getBrowserSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null
  }
  const w = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}
