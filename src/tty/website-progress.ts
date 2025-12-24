import type { LinkPreviewProgressEvent } from '../content/link-preview/deps.js'

import {
  formatBytes,
  formatBytesPerSecond,
  formatDurationSecondsSmart,
  formatElapsedMs,
} from './format.js'

export function createWebsiteProgress({
  enabled,
  spinner,
}: {
  enabled: boolean
  spinner: { setText: (text: string) => void }
}): {
  stop: () => void
  onProgress: (event: LinkPreviewProgressEvent) => void
} | null {
  if (!enabled) return null

  const state: {
    phase:
      | 'fetching'
      | 'firecrawl'
      | 'bird'
      | 'nitter'
      | 'transcript'
      | 'transcript-download'
      | 'transcript-whisper'
      | 'idle'
    htmlDownloadedBytes: number
    htmlTotalBytes: number | null
    fetchStartedAtMs: number | null
    transcriptDownloadStartedAtMs: number | null
    transcriptDownloadedBytes: number
    transcriptTotalBytes: number | null
    transcriptWhisperStartedAtMs: number | null
    transcriptWhisperProviderHint: 'openai' | 'fal' | 'openai->fal' | 'unknown' | null
    transcriptWhisperProcessedSeconds: number | null
    transcriptWhisperTotalSeconds: number | null
    transcriptWhisperPartIndex: number | null
    transcriptWhisperParts: number | null
    lastSpinnerUpdateAtMs: number
  } = {
    phase: 'idle',
    htmlDownloadedBytes: 0,
    htmlTotalBytes: null,
    fetchStartedAtMs: null,
    transcriptDownloadStartedAtMs: null,
    transcriptDownloadedBytes: 0,
    transcriptTotalBytes: null,
    transcriptWhisperStartedAtMs: null,
    transcriptWhisperProviderHint: null,
    transcriptWhisperProcessedSeconds: null,
    transcriptWhisperTotalSeconds: null,
    transcriptWhisperPartIndex: null,
    transcriptWhisperParts: null,
    lastSpinnerUpdateAtMs: 0,
  }

  let ticker: ReturnType<typeof setInterval> | null = null

  const updateSpinner = (text: string, options?: { force?: boolean }) => {
    const now = Date.now()
    if (!options?.force && now - state.lastSpinnerUpdateAtMs < 100) return
    state.lastSpinnerUpdateAtMs = now
    spinner.setText(text)
  }

  const formatFirecrawlReason = (reason: string) => {
    const lower = reason.toLowerCase()
    if (lower.includes('forced')) return 'forced'
    if (lower.includes('html fetch failed')) return 'fallback: HTML fetch failed'
    if (lower.includes('blocked') || lower.includes('thin')) return 'fallback: blocked/thin HTML'
    return reason
  }

  const renderFetchLine = () => {
    const downloaded = formatBytes(state.htmlDownloadedBytes)
    const total =
      typeof state.htmlTotalBytes === 'number' &&
      state.htmlTotalBytes > 0 &&
      state.htmlDownloadedBytes <= state.htmlTotalBytes
        ? `/${formatBytes(state.htmlTotalBytes)}`
        : ''
    const elapsedMs =
      typeof state.fetchStartedAtMs === 'number' ? Date.now() - state.fetchStartedAtMs : 0
    const elapsed = formatElapsedMs(elapsedMs)
    if (state.htmlDownloadedBytes === 0 && !state.htmlTotalBytes) {
      return `Fetching website (connecting, ${elapsed})…`
    }
    const rate =
      elapsedMs > 0 && state.htmlDownloadedBytes > 0
        ? `, ${formatBytesPerSecond(state.htmlDownloadedBytes / (elapsedMs / 1000))}`
        : ''
    return `Fetching website (${downloaded}${total}, ${elapsed}${rate})…`
  }

  const renderTranscriptDownloadLine = () => {
    const downloaded = formatBytes(state.transcriptDownloadedBytes)
    const total =
      typeof state.transcriptTotalBytes === 'number' &&
      state.transcriptTotalBytes > 0 &&
      state.transcriptDownloadedBytes <= state.transcriptTotalBytes
        ? `/${formatBytes(state.transcriptTotalBytes)}`
        : ''
    const elapsedMs =
      typeof state.transcriptDownloadStartedAtMs === 'number'
        ? Date.now() - state.transcriptDownloadStartedAtMs
        : 0
    const elapsed = formatElapsedMs(elapsedMs)
    if (state.transcriptDownloadedBytes === 0 && !state.transcriptTotalBytes) {
      return `Downloading audio (connecting, ${elapsed})…`
    }
    const rate =
      elapsedMs > 0 && state.transcriptDownloadedBytes > 0
        ? `, ${formatBytesPerSecond(state.transcriptDownloadedBytes / (elapsedMs / 1000))}`
        : ''
    return `Downloading audio (${downloaded}${total}, ${elapsed}${rate})…`
  }

  const formatProviderHint = (
    hint: 'openai' | 'fal' | 'openai->fal' | 'unknown' | null
  ): string => {
    if (!hint) return 'Whisper'
    if (hint === 'openai') return 'Whisper/OpenAI'
    if (hint === 'fal') return 'Whisper/FAL'
    if (hint === 'openai->fal') return 'Whisper/OpenAI→FAL'
    return 'Whisper'
  }

  const renderTranscriptWhisperLine = () => {
    const base = 'Transcribing'
    const provider = formatProviderHint(state.transcriptWhisperProviderHint)
    const elapsedMs =
      typeof state.transcriptWhisperStartedAtMs === 'number'
        ? Date.now() - state.transcriptWhisperStartedAtMs
        : 0
    const elapsed = formatElapsedMs(elapsedMs)

    const parts =
      typeof state.transcriptWhisperPartIndex === 'number' &&
      typeof state.transcriptWhisperParts === 'number' &&
      state.transcriptWhisperPartIndex > 0 &&
      state.transcriptWhisperParts > 0
        ? `, ${state.transcriptWhisperPartIndex}/${state.transcriptWhisperParts}`
        : ''

    const duration =
      typeof state.transcriptWhisperProcessedSeconds === 'number' &&
      typeof state.transcriptWhisperTotalSeconds === 'number' &&
      state.transcriptWhisperTotalSeconds > 0
        ? `, ${formatDurationSecondsSmart(state.transcriptWhisperProcessedSeconds)}/${formatDurationSecondsSmart(
            state.transcriptWhisperTotalSeconds
          )}`
        : typeof state.transcriptWhisperTotalSeconds === 'number' &&
            state.transcriptWhisperTotalSeconds > 0
          ? `, ${formatDurationSecondsSmart(state.transcriptWhisperTotalSeconds)}`
          : ''

    return `${base} (${provider}${duration}${parts}, ${elapsed})…`
  }

  const startTicker = () => {
    if (ticker) return
    ticker = setInterval(() => {
      if (state.phase === 'fetching') {
        updateSpinner(renderFetchLine())
        return
      }
      if (state.phase === 'transcript-download') {
        updateSpinner(renderTranscriptDownloadLine())
        return
      }
      if (state.phase === 'transcript-whisper') {
        updateSpinner(renderTranscriptWhisperLine())
      }
    }, 1000)
  }

  const stopTicker = () => {
    if (!ticker) return
    clearInterval(ticker)
    ticker = null
  }

  // Tricky UX: the HTML fetch is often fast, but the next step can be slow (e.g. Whisper
  // transcription for podcast URLs). Stop the "Fetching website" ticker once the fetch is done so
  // elapsed time doesn’t keep increasing and look like a stuck download.
  const freezeFetchLine = () => {
    stopTicker()
    updateSpinner(renderFetchLine(), { force: true })
  }

  return {
    stop: stopTicker,
    onProgress: (event: LinkPreviewProgressEvent) => {
      if (event.kind === 'fetch-html-start') {
        state.phase = 'fetching'
        state.htmlDownloadedBytes = 0
        state.htmlTotalBytes = null
        state.fetchStartedAtMs = Date.now()
        startTicker()
        updateSpinner('Fetching website (connecting)…')
        return
      }

      if (event.kind === 'fetch-html-progress') {
        state.phase = 'fetching'
        state.htmlDownloadedBytes = event.downloadedBytes
        state.htmlTotalBytes = event.totalBytes
        updateSpinner(renderFetchLine())
        return
      }

      if (event.kind === 'fetch-html-done') {
        state.phase = 'idle'
        state.htmlDownloadedBytes = event.downloadedBytes
        state.htmlTotalBytes = event.totalBytes
        freezeFetchLine()
        return
      }

      if (event.kind === 'transcript-media-download-start') {
        state.phase = 'transcript-download'
        state.transcriptDownloadedBytes = 0
        state.transcriptTotalBytes = event.totalBytes
        state.transcriptDownloadStartedAtMs = Date.now()
        startTicker()
        updateSpinner('Downloading audio (connecting)…', { force: true })
        return
      }

      if (event.kind === 'transcript-media-download-progress') {
        state.phase = 'transcript-download'
        state.transcriptDownloadedBytes = event.downloadedBytes
        state.transcriptTotalBytes = event.totalBytes
        updateSpinner(renderTranscriptDownloadLine())
        return
      }

      if (event.kind === 'transcript-media-download-done') {
        state.phase = 'idle'
        state.transcriptDownloadedBytes = event.downloadedBytes
        state.transcriptTotalBytes = event.totalBytes
        stopTicker()
        updateSpinner(renderTranscriptDownloadLine(), { force: true })
        return
      }

      if (event.kind === 'transcript-whisper-start') {
        state.phase = 'transcript-whisper'
        state.transcriptWhisperStartedAtMs = Date.now()
        state.transcriptWhisperProviderHint = event.providerHint
        state.transcriptWhisperProcessedSeconds = null
        state.transcriptWhisperTotalSeconds = event.totalDurationSeconds
        state.transcriptWhisperPartIndex = null
        state.transcriptWhisperParts = event.parts
        startTicker()
        updateSpinner(renderTranscriptWhisperLine(), { force: true })
        return
      }

      if (event.kind === 'transcript-whisper-progress') {
        state.phase = 'transcript-whisper'
        state.transcriptWhisperProcessedSeconds = event.processedDurationSeconds
        state.transcriptWhisperTotalSeconds = event.totalDurationSeconds
        state.transcriptWhisperPartIndex = event.partIndex
        state.transcriptWhisperParts = event.parts
        updateSpinner(renderTranscriptWhisperLine())
        return
      }

      if (event.kind === 'bird-start') {
        state.phase = 'bird'
        stopTicker()
        updateSpinner('Bird: reading tweet…', { force: true })
        return
      }

      if (event.kind === 'bird-done') {
        state.phase = 'bird'
        stopTicker()
        if (event.ok && typeof event.textBytes === 'number') {
          updateSpinner(`Bird: got ${formatBytes(event.textBytes)}…`, { force: true })
          return
        }
        updateSpinner('Bird: failed; fallback…', { force: true })
        return
      }

      if (event.kind === 'nitter-start') {
        state.phase = 'nitter'
        stopTicker()
        updateSpinner('Nitter: fetching…', { force: true })
        return
      }

      if (event.kind === 'nitter-done') {
        state.phase = 'nitter'
        stopTicker()
        if (event.ok && typeof event.textBytes === 'number') {
          updateSpinner(`Nitter: got ${formatBytes(event.textBytes)}…`, { force: true })
          return
        }
        updateSpinner('Nitter: failed; fallback…', { force: true })
        return
      }

      if (event.kind === 'firecrawl-start') {
        state.phase = 'firecrawl'
        stopTicker()
        const reason = event.reason ? formatFirecrawlReason(event.reason) : ''
        const suffix = reason ? ` (${reason})` : ''
        updateSpinner(`Firecrawl: scraping${suffix}…`, { force: true })
        return
      }

      if (event.kind === 'firecrawl-done') {
        state.phase = 'firecrawl'
        stopTicker()
        if (event.ok && typeof event.markdownBytes === 'number') {
          updateSpinner(`Firecrawl: got ${formatBytes(event.markdownBytes)}…`, { force: true })
          return
        }
        updateSpinner('Firecrawl: no content; fallback…', { force: true })
        return
      }

      if (event.kind === 'transcript-start') {
        state.phase = 'transcript'
        stopTicker()
        const hint = event.hint ? ` (${event.hint})` : ''
        updateSpinner(`Transcribing${hint}…`, { force: true })
        return
      }

      if (event.kind === 'transcript-done') {
        state.phase = 'transcript'
        stopTicker()
        updateSpinner(event.ok ? 'Transcribed…' : 'Transcript failed; fallback…', { force: true })
      }
    },
  }
}
