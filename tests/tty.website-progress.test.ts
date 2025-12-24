import { describe, expect, it, vi } from 'vitest'

import type { LinkPreviewProgressEvent } from '../src/content/link-preview/deps.js'
import { ProgressKind } from '../src/content/link-preview/deps.js'
import { createWebsiteProgress } from '../src/tty/website-progress.js'

describe('tty/website-progress', () => {
  it('renders fetch progress with sane formatting and stops ticking after done', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const texts: string[] = []
    const progress = createWebsiteProgress({
      enabled: true,
      spinner: { setText: (text) => texts.push(text) },
    })
    expect(progress).not.toBeNull()

    progress!.onProgress({ kind: ProgressKind.FetchHtmlStart, url: 'https://example.com' })

    vi.setSystemTime(162_000)
    progress!.onProgress({
      kind: ProgressKind.FetchHtmlProgress,
      url: 'https://example.com',
      downloadedBytes: 136 * 1024,
      totalBytes: 15 * 1024,
    })

    const last = texts.at(-1) ?? ''
    expect(last).toContain('Fetching website (136 KB, 2m 42s')
    expect(last).toContain('B/s')
    expect(last).not.toContain('2m42s')
    expect(last).not.toContain('KB/')

    const beforeDoneCount = texts.length
    progress!.onProgress({
      kind: ProgressKind.FetchHtmlDone,
      url: 'https://example.com',
      downloadedBytes: 136 * 1024,
      totalBytes: 15 * 1024,
    })
    expect(texts.length).toBeGreaterThan(beforeDoneCount)

    const afterDoneCount = texts.length
    vi.advanceTimersByTime(5000)
    expect(texts.length).toBe(afterDoneCount)

    vi.useRealTimers()
  })

  it('switches to a transcript phase so long transcriptions do not look like stuck fetches', () => {
    const texts: string[] = []
    const progress = createWebsiteProgress({
      enabled: true,
      spinner: { setText: (text) => texts.push(text) },
    })
    expect(progress).not.toBeNull()

    const event: LinkPreviewProgressEvent = {
      kind: ProgressKind.TranscriptStart,
      url: 'https://example.com',
      service: 'podcast',
      hint: 'podcast',
    }
    progress!.onProgress(event)

    expect(texts.at(-1)).toBe('Transcribing (podcast)…')
  })

  it('renders audio download + whisper progress with sane formatting', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const texts: string[] = []
    const progress = createWebsiteProgress({
      enabled: true,
      spinner: { setText: (text) => texts.push(text) },
    })
    expect(progress).not.toBeNull()

    progress!.onProgress({
      kind: ProgressKind.TranscriptMediaDownloadStart,
      url: 'https://example.com',
      service: 'podcast',
      mediaUrl: 'https://cdn.example.com/audio.mp3',
      totalBytes: 15 * 1024,
    })

    vi.setSystemTime(162_000)
    progress!.onProgress({
      kind: ProgressKind.TranscriptMediaDownloadProgress,
      url: 'https://example.com',
      service: 'podcast',
      downloadedBytes: 136 * 1024,
      totalBytes: 15 * 1024,
    })

    const lastDownload = texts.at(-1) ?? ''
    expect(lastDownload).toContain('Downloading audio (136 KB, 2m 42s')
    expect(lastDownload).toContain('B/s')
    expect(lastDownload).not.toContain('2m42s')
    expect(lastDownload).not.toContain('KB/')

    progress!.onProgress({
      kind: ProgressKind.TranscriptMediaDownloadDone,
      url: 'https://example.com',
      service: 'podcast',
      downloadedBytes: 136 * 1024,
      totalBytes: 15 * 1024,
    })

    vi.setSystemTime(162_000)
    progress!.onProgress({
      kind: ProgressKind.TranscriptWhisperStart,
      url: 'https://example.com',
      service: 'podcast',
      providerHint: 'openai',
      totalDurationSeconds: 3600,
      parts: null,
    })

    vi.setSystemTime(287_000)
    progress!.onProgress({
      kind: ProgressKind.TranscriptWhisperProgress,
      url: 'https://example.com',
      service: 'podcast',
      processedDurationSeconds: 600,
      totalDurationSeconds: 3600,
      partIndex: 1,
      parts: 6,
    })

    const lastWhisper = texts.at(-1) ?? ''
    expect(lastWhisper).toContain('Transcribing (Whisper/OpenAI, 10m/1h')
    expect(lastWhisper).toContain('1/6')
    expect(lastWhisper).toContain('2m 5s')

    vi.useRealTimers()
  })

  it('renders provider hint variants and omits parts when index is missing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const texts: string[] = []
    const progress = createWebsiteProgress({
      enabled: true,
      spinner: { setText: (text) => texts.push(text) },
    })
    expect(progress).not.toBeNull()

    progress!.onProgress({
      kind: ProgressKind.TranscriptWhisperStart,
      url: 'https://example.com',
      service: 'podcast',
      providerHint: 'openai->fal',
      totalDurationSeconds: null,
      parts: 6,
    })
    expect(texts.at(-1)).toContain('Transcribing (Whisper/OpenAI→FAL')

    progress!.onProgress({
      kind: ProgressKind.TranscriptWhisperProgress,
      url: 'https://example.com',
      service: 'podcast',
      processedDurationSeconds: null,
      totalDurationSeconds: null,
      partIndex: null,
      parts: 6,
    })
    expect(texts.at(-1)).not.toContain('1/6')

    vi.useRealTimers()
  })

  it('renders total duration when processed duration is unavailable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    const texts: string[] = []
    const progress = createWebsiteProgress({
      enabled: true,
      spinner: { setText: (text) => texts.push(text) },
    })
    expect(progress).not.toBeNull()

    progress!.onProgress({
      kind: ProgressKind.TranscriptWhisperStart,
      url: 'https://example.com',
      service: 'podcast',
      providerHint: 'fal',
      totalDurationSeconds: 44,
      parts: null,
    })

    expect(texts.at(-1)).toContain('Transcribing (Whisper/FAL, 44s')

    vi.useRealTimers()
  })
})
