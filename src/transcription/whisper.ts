import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createFalClient } from '@fal-ai/client'

const TRANSCRIPTION_TIMEOUT_MS = 600_000
const MAX_ERROR_DETAIL_CHARS = 200
export const MAX_OPENAI_UPLOAD_BYTES = 24 * 1024 * 1024
const DEFAULT_SEGMENT_SECONDS = 600

export type TranscriptionProvider = 'openai' | 'fal'

export type WhisperTranscriptionResult = {
  text: string | null
  provider: TranscriptionProvider | null
  error: Error | null
  notes: string[]
}

export type WhisperProgressEvent = {
  /** 1-based segment index (only when chunked via ffmpeg). */
  partIndex: number | null
  /** Total number of segments (only when chunked via ffmpeg). */
  parts: number | null
  /** Best-effort processed duration of the source media. */
  processedDurationSeconds: number | null
  /** Best-effort total duration of the source media. */
  totalDurationSeconds: number | null
}

export async function transcribeMediaWithWhisper({
  bytes,
  mediaType,
  filename,
  openaiApiKey,
  falApiKey,
}: {
  bytes: Uint8Array
  mediaType: string
  filename: string | null
  openaiApiKey: string | null
  falApiKey: string | null
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []

  if (!openaiApiKey && !falApiKey) {
    return {
      text: null,
      provider: null,
      error: new Error('OPENAI_API_KEY or FAL_KEY is required for Whisper transcription'),
      notes,
    }
  }

  if (openaiApiKey && bytes.byteLength > MAX_OPENAI_UPLOAD_BYTES) {
    const canChunk = await isFfmpegAvailable()
    if (canChunk) {
      const tempFile = join(tmpdir(), `summarize-whisper-${randomUUID()}`)
      try {
        await fs.writeFile(tempFile, bytes)
        const chunked = await transcribeMediaFileWithWhisper({
          filePath: tempFile,
          mediaType,
          filename,
          openaiApiKey,
          falApiKey,
          segmentSeconds: DEFAULT_SEGMENT_SECONDS,
        })
        return chunked
      } finally {
        await fs.unlink(tempFile).catch(() => {})
      }
    }

    notes.push(
      `Media too large for Whisper upload (${formatBytes(bytes.byteLength)}); transcribing first ${formatBytes(MAX_OPENAI_UPLOAD_BYTES)} only (install ffmpeg for full transcription)`
    )
    bytes = bytes.slice(0, MAX_OPENAI_UPLOAD_BYTES)
  }

  let openaiError: Error | null = null
  if (openaiApiKey) {
    try {
      const text = await transcribeWithOpenAi(bytes, mediaType, filename, openaiApiKey)
      if (text) {
        return { text, provider: 'openai', error: null, notes }
      }
      openaiError = new Error('OpenAI transcription returned empty text')
    } catch (error) {
      openaiError = wrapError('OpenAI transcription failed', error)
    }
  }

  if (openaiApiKey && openaiError && shouldRetryOpenAiViaFfmpeg(openaiError)) {
    const canTranscode = await isFfmpegAvailable()
    if (canTranscode) {
      try {
        // Some providers hand out containers/codecs Whisper rejects. Transcoding to a small mono MP3
        // is the most reliable cross-format fallback (and also reduces upload size).
        notes.push('OpenAI could not decode media; transcoding via ffmpeg and retrying')
        const mp3Bytes = await transcodeBytesToMp3(bytes)
        const retried = await transcribeWithOpenAi(mp3Bytes, 'audio/mpeg', 'audio.mp3', openaiApiKey)
        if (retried) {
          return { text: retried, provider: 'openai', error: null, notes }
        }
        openaiError = new Error('OpenAI transcription returned empty text after ffmpeg transcode')
        bytes = mp3Bytes
        mediaType = 'audio/mpeg'
        filename = 'audio.mp3'
      } catch (error) {
        notes.push(
          `ffmpeg transcode failed; cannot retry OpenAI decode error: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    } else {
      notes.push('OpenAI could not decode media; install ffmpeg to enable transcoding retry')
    }
  }

  const canUseFal = Boolean(falApiKey) && mediaType.toLowerCase().startsWith('audio/')
  if (openaiError && canUseFal) {
    notes.push(`OpenAI transcription failed; falling back to FAL: ${openaiError.message}`)
  }
  if (falApiKey && !canUseFal) {
    notes.push(`Skipping FAL transcription: unsupported mediaType ${mediaType}`)
  }

  if (falApiKey && canUseFal) {
    try {
      const text = await transcribeWithFal(bytes, mediaType, falApiKey)
      if (text) {
        return { text, provider: 'fal', error: null, notes }
      }
      return {
        text: null,
        provider: 'fal',
        error: new Error('FAL transcription returned empty text'),
        notes,
      }
    } catch (error) {
      return {
        text: null,
        provider: 'fal',
        error: wrapError('FAL transcription failed', error),
        notes,
      }
    }
  }

  return {
    text: null,
    provider: openaiApiKey ? 'openai' : null,
    error: openaiError ?? new Error('No transcription providers available'),
    notes,
  }
}

function shouldRetryOpenAiViaFfmpeg(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return (
    msg.includes('unrecognized file format') ||
    msg.includes('could not be decoded') ||
    msg.includes('format is not supported')
  )
}

async function transcodeBytesToMp3(bytes: Uint8Array): Promise<Uint8Array> {
  const inputPath = join(tmpdir(), `summarize-whisper-input-${randomUUID()}.bin`)
  const outputPath = join(tmpdir(), `summarize-whisper-output-${randomUUID()}.mp3`)
  try {
    await fs.writeFile(inputPath, bytes)
    await runFfmpegTranscodeToMp3({ inputPath, outputPath })
    return new Uint8Array(await fs.readFile(outputPath))
  } finally {
    await fs.unlink(inputPath).catch(() => {})
    await fs.unlink(outputPath).catch(() => {})
  }
}

export async function transcribeMediaFileWithWhisper({
  filePath,
  mediaType,
  filename,
  openaiApiKey,
  falApiKey,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  totalDurationSeconds = null,
  onProgress = null,
}: {
  filePath: string
  mediaType: string
  filename: string | null
  openaiApiKey: string | null
  falApiKey: string | null
  segmentSeconds?: number
  totalDurationSeconds?: number | null
  onProgress?: ((event: WhisperProgressEvent) => void) | null
}): Promise<WhisperTranscriptionResult> {
  const notes: string[] = []

  if (!openaiApiKey && !falApiKey) {
    return {
      text: null,
      provider: null,
      error: new Error('OPENAI_API_KEY or FAL_KEY is required for Whisper transcription'),
      notes,
    }
  }

  const stat = await fs.stat(filePath)
  if (openaiApiKey && stat.size > MAX_OPENAI_UPLOAD_BYTES) {
    const canChunk = await isFfmpegAvailable()
    if (!canChunk) {
      notes.push(
        `Media too large for Whisper upload (${formatBytes(stat.size)}); install ffmpeg to enable chunked transcription`
      )
      const head = await readFirstBytes(filePath, MAX_OPENAI_UPLOAD_BYTES)
      const partial = await transcribeMediaWithWhisper({
        bytes: head,
        mediaType,
        filename,
        openaiApiKey,
        falApiKey,
      })
      if (partial.notes.length > 0) notes.push(...partial.notes)
      return { ...partial, notes }
    }

    const dir = await fs.mkdtemp(join(tmpdir(), 'summarize-whisper-segments-'))
    try {
      const pattern = join(dir, 'part-%03d.mp3')
      await runFfmpegSegment({
        inputPath: filePath,
        outputPattern: pattern,
        segmentSeconds,
      })
      const files = (await fs.readdir(dir))
        .filter((name) => name.startsWith('part-') && name.endsWith('.mp3'))
        .sort((a, b) => a.localeCompare(b))
      if (files.length === 0) {
        return {
          text: null,
          provider: null,
          error: new Error('ffmpeg produced no audio segments'),
          notes,
        }
      }

      notes.push(`ffmpeg chunked media into ${files.length} parts (${segmentSeconds}s each)`)
      onProgress?.({
        partIndex: null,
        parts: files.length,
        processedDurationSeconds: null,
        totalDurationSeconds,
      })

      const parts: string[] = []
      let usedProvider: TranscriptionProvider | null = null
      for (const [index, name] of files.entries()) {
        const segmentPath = join(dir, name)
        const segmentBytes = new Uint8Array(await fs.readFile(segmentPath))
        const result = await transcribeMediaWithWhisper({
          bytes: segmentBytes,
          mediaType: 'audio/mpeg',
          filename: name,
          openaiApiKey,
          falApiKey,
        })
        if (!usedProvider && result.provider) usedProvider = result.provider
        if (result.error && !result.text) {
          return { text: null, provider: usedProvider, error: result.error, notes }
        }
        if (result.text) parts.push(result.text)

        // Coarse but useful: update based on part boundaries. Duration is best-effort (RSS hints or
        // ffprobe); the per-part time is stable enough to make the spinner feel alive.
        const processedSeconds = Math.max(0, (index + 1) * segmentSeconds)
        onProgress?.({
          partIndex: index + 1,
          parts: files.length,
          processedDurationSeconds:
            typeof totalDurationSeconds === 'number' && totalDurationSeconds > 0
              ? Math.min(processedSeconds, totalDurationSeconds)
              : null,
          totalDurationSeconds,
        })
      }

      return { text: parts.join('\n\n'), provider: usedProvider, error: null, notes }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const bytes = new Uint8Array(await fs.readFile(filePath))
  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds,
  })
  const result = await transcribeMediaWithWhisper({
    bytes,
    mediaType,
    filename,
    openaiApiKey,
    falApiKey,
  })
  if (result.notes.length > 0) notes.push(...result.notes)
  return { ...result, notes }
}

export async function probeMediaDurationSecondsWithFfprobe(filePath: string): Promise<number | null> {
  // ffprobe is part of the ffmpeg suite. We keep this optional (best-effort) so environments
  // without ffmpeg still work; it only powers nicer progress output.
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (stdout.length > 2048) return
      stdout += chunk
    })
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const trimmed = stdout.trim()
      const parsed = Number(trimmed)
      resolve(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
    })
  })
}

async function transcribeWithOpenAi(
  bytes: Uint8Array,
  mediaType: string,
  filename: string | null,
  apiKey: string
): Promise<string | null> {
  const form = new FormData()
  const providedName = filename?.trim() ? filename.trim() : 'media'
  // Whisper sometimes relies on the filename extension for format detection; ensure a reasonable one.
  const safeName = ensureWhisperFilenameExtension(providedName, mediaType)
  form.append('file', new Blob([toArrayBuffer(bytes)], { type: mediaType }), safeName)
  form.append('model', 'whisper-1')

  const response = await globalThis.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    const suffix = detail ? `: ${detail}` : ''
    throw new Error(`OpenAI transcription failed (${response.status})${suffix}`)
  }

  const payload = (await response.json()) as { text?: unknown }
  if (typeof payload?.text !== 'string') return null
  const trimmed = payload.text.trim()
  return trimmed.length > 0 ? trimmed : null
}

function ensureWhisperFilenameExtension(name: string, mediaType: string): string {
  const trimmed = name.trim()
  const base = trimmed.length > 0 ? trimmed : 'media'
  const hasExtension = (() => {
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return false
    if (dot === base.length - 1) return false
    return true
  })()
  if (hasExtension) return base

  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? ''
  const ext =
    type === 'audio/mpeg' || type === 'audio/mp3' || type === 'audio/mpga'
      ? 'mp3'
      : type === 'video/mp4' || type === 'audio/mp4' || type === 'application/mp4'
        ? 'mp4'
        : type === 'audio/x-wav' || type === 'audio/wav'
          ? 'wav'
          : type === 'audio/flac'
            ? 'flac'
            : type === 'audio/webm' || type === 'video/webm'
              ? 'webm'
              : type === 'audio/ogg' || type === 'audio/oga' || type === 'application/ogg'
                ? 'ogg'
                : 'mp3'

  return `${base}.${ext}`
}

async function transcribeWithFal(
  bytes: Uint8Array,
  mediaType: string,
  apiKey: string
): Promise<string | null> {
  const fal = createFalClient({ credentials: apiKey })
  const blob = new Blob([toArrayBuffer(bytes)], { type: mediaType })
  const audioUrl = await fal.storage.upload(blob)

  const result = await Promise.race([
    fal.subscribe('fal-ai/wizper', {
      input: { audio_url: audioUrl, language: 'en' },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('FAL transcription timeout')), TRANSCRIPTION_TIMEOUT_MS)
    ),
  ])

  return extractText(result)
}

function extractText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const data = 'data' in result ? (result as { data: unknown }).data : result
  if (typeof data !== 'object' || data === null) return null
  if ('text' in data && typeof (data as { text: unknown }).text === 'string') {
    const text = (data as { text: string }).text.trim()
    return text.length > 0 ? text : null
  }
  if ('chunks' in data && Array.isArray((data as { chunks: unknown }).chunks)) {
    const chunks = (data as { chunks: unknown[] }).chunks
    const lines: string[] = []
    for (const chunk of chunks) {
      if (typeof chunk === 'object' && chunk !== null && 'text' in chunk) {
        const text = (chunk as { text: unknown }).text
        if (typeof text === 'string' && text.trim()) {
          lines.push(text.trim())
        }
      }
    }
    return lines.length > 0 ? lines.join(' ') : null
  }
  return null
}

async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const text = await response.text()
    const trimmed = text.trim()
    if (!trimmed) return null
    return trimmed.length > MAX_ERROR_DETAIL_CHARS
      ? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
      : trimmed
  } catch {
    return null
  }
}

function wrapError(prefix: string, error: unknown): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`, { cause: error })
  }
  return new Error(`${prefix}: ${String(error)}`)
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buffer = view.buffer as ArrayBuffer
  return buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
}

export async function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
}

async function runFfmpegSegment({
  inputPath,
  outputPattern,
  segmentSeconds,
}: {
  inputPath: string
  outputPattern: string
  segmentSeconds: number
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-f',
      'segment',
      '-segment_time',
      String(segmentSeconds),
      '-reset_timestamps',
      '1',
      outputPattern,
    ]
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      if (stderr.length > 8192) return
      stderr += chunk
    })
    proc.on('error', (error) => reject(error))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim()
      reject(new Error(`ffmpeg failed (${code ?? 'unknown'}): ${detail || 'unknown error'}`))
    })
  })
}

async function runFfmpegTranscodeToMp3({
  inputPath,
  outputPath,
}: {
  inputPath: string
  outputPath: string
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '64k',
      outputPath,
    ]
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      if (stderr.length > 8192) return
      stderr += chunk
    })
    proc.on('error', (error) => reject(error))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim()
      reject(new Error(`ffmpeg transcode failed (${code ?? 'unknown'}): ${detail || 'unknown error'}`))
    })
  })
}

async function readFirstBytes(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const read = await handle.read(buffer, 0, maxBytes, 0)
    return new Uint8Array(buffer.slice(0, read.bytesRead))
  } finally {
    await handle.close().catch(() => {})
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  const decimals = value >= 10 || idx === 0 ? 0 : 1
  return `${value.toFixed(decimals)}${units[idx]}`
}
