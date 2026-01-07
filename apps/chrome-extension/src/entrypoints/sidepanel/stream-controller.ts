import { parseSseEvent, type SseMetaData, type SseSlidesData } from '../../../../../src/shared/sse-events.js'
import { mergeStreamingChunk } from '../../../../../src/shared/streaming-merge.js'
import { parseSseStream, type SseMessage } from '../../lib/sse'
import type { PanelPhase, RunStart } from './types'

export type StreamController = {
  start: (run: RunStart) => Promise<void>
  abort: () => void
  isStreaming: () => boolean
}

export type StreamControllerOptions = {
  getToken: () => Promise<string>
  onStatus: (text: string) => void
  onPhaseChange: (phase: PanelPhase) => void
  onMeta: (meta: SseMetaData) => void
  onSlides?: ((slides: SseSlidesData) => void) | null
  onError?: ((error: unknown) => string) | null
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
  idleTimeoutMessage?: string
  // Summarize mode callbacks (optional for chat mode)
  onReset?: (() => void) | null
  onBaseTitle?: ((text: string) => void) | null
  onBaseSubtitle?: ((text: string) => void) | null
  onRememberUrl?: ((url: string) => void) | null
  onSummaryFromCache?: ((value: boolean | null) => void) | null
  onMetrics?: ((summary: string) => void) | null
  onRender?: ((markdown: string) => void) | null
  onSyncWithActiveTab?: (() => Promise<void>) | null
  // Chat mode callbacks (optional for summarize mode)
  onChunk?: ((accumulatedContent: string) => void) | null
  onDone?: (() => void) | null
  // Mode-specific options
  mode?: 'summarize' | 'chat'
  streamingStatusText?: string
}

export function createStreamController(options: StreamControllerOptions): StreamController {
  const {
    getToken,
    onStatus,
    onPhaseChange,
    onMeta,
    onSlides,
    onError,
    fetchImpl,
    onReset,
    onBaseTitle,
    onBaseSubtitle,
    onRememberUrl,
    onSummaryFromCache,
    onMetrics,
    onRender,
    onSyncWithActiveTab,
    onChunk,
    onDone,
    mode = 'summarize',
    streamingStatusText,
    idleTimeoutMs = 120_000,
    idleTimeoutMessage = 'No response from the daemon for a while. It may have stopped. Click “Try again”.',
  } = options
  let controller: AbortController | null = null
  let activeAbortState: { reason: 'manual' | 'timeout' | null } | null = null
  let markdown = ''
  let chatContent = ''
  let renderQueued = 0
  let streamedAnyNonWhitespace = false
  let rememberedUrl = false
  let streaming = false
  let hadError = false
  let sawDone = false

  const queueRender = () => {
    if (renderQueued || !onRender) return
    renderQueued = window.setTimeout(() => {
      renderQueued = 0
      onRender(markdown)
    }, 80)
  }

  const queueChunkUpdate = () => {
    if (renderQueued || !onChunk) return
    renderQueued = window.setTimeout(() => {
      renderQueued = 0
      onChunk(chatContent)
    }, 80)
  }

  const abort = () => {
    if (!controller) return
    if (activeAbortState) activeAbortState.reason = 'manual'
    controller.abort()
    controller = null
    activeAbortState = null
    if (streaming) {
      streaming = false
      onPhaseChange('idle')
    }
  }

  const start = async (run: RunStart) => {
    const token = (await getToken()).trim()
    if (!token) {
      onStatus('Setup required (missing token)')
      return
    }

    abort()
    const nextController = new AbortController()
    controller = nextController
    const abortState = { reason: null as 'manual' | 'timeout' | null }
    activeAbortState = abortState
    streaming = true
    hadError = false
    streamedAnyNonWhitespace = false
    rememberedUrl = false
    sawDone = false
    markdown = ''
    chatContent = ''
    onPhaseChange('connecting')
    onSummaryFromCache?.(null)
    onReset?.()

    onBaseTitle?.(run.title || run.url)
    onBaseSubtitle?.('')
    onStatus('Connecting…')

    try {
      const res = await (fetchImpl ?? fetch)(
        `http://127.0.0.1:8787/v1/summarize/${run.id}/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: nextController.signal,
        }
      )
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      if (!res.body) throw new Error('Missing stream body')

      onStatus(streamingStatusText ?? (mode === 'chat' ? '' : 'Summarizing…'))
      onPhaseChange('streaming')

      const iterator = parseSseStream(res.body)
      const useIdleTimeout = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
      const nextWithTimeout = async () => {
        if (!useIdleTimeout) return iterator.next()
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeoutPromise = new Promise<IteratorResult<SseMessage>>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(idleTimeoutMessage)
            error.name = 'IdleTimeoutError'
            reject(error)
          }, idleTimeoutMs)
        })
        try {
          return await Promise.race([iterator.next(), timeoutPromise])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }

      while (true) {
        const { value: msg, done } = await nextWithTimeout()
        if (done) break
        if (nextController.signal.aborted) return

        const event = parseSseEvent(msg)
        if (!event) continue

        if (event.event === 'chunk') {
          if (mode === 'chat') {
            chatContent += event.data.text
            queueChunkUpdate()
          } else {
            const merged = mergeStreamingChunk(markdown, event.data.text).next
            if (merged !== markdown) {
              markdown = merged
              queueRender()
            }
          }

          if (!streamedAnyNonWhitespace && event.data.text.trim().length > 0) {
            streamedAnyNonWhitespace = true
            if (!rememberedUrl && onRememberUrl) {
              rememberedUrl = true
              onRememberUrl(run.url)
            }
          }
        } else if (event.event === 'meta') {
          onMeta(event.data)
          if (typeof event.data.summaryFromCache === 'boolean') {
            onSummaryFromCache?.(event.data.summaryFromCache)
          }
        } else if (event.event === 'slides') {
          onSlides?.(event.data)
        } else if (event.event === 'status') {
          if (!streamedAnyNonWhitespace) onStatus(event.data.text)
        } else if (event.event === 'metrics') {
          onMetrics?.(event.data.summary)
        } else if (event.event === 'error') {
          throw new Error(event.data.message)
        } else if (event.event === 'done') {
          sawDone = true
          break
        }
      }

      if (nextController.signal.aborted) return
      if (!sawDone) {
        throw new Error('Stream ended unexpectedly. The daemon may have stopped.')
      }
      if (!streamedAnyNonWhitespace) {
        throw new Error('Model returned no output.')
      }

      onStatus('')
      onDone?.()
    } catch (err) {
      if (err instanceof Error && err.name === 'IdleTimeoutError') {
        abortState.reason = 'timeout'
        if (!nextController.signal.aborted) {
          nextController.abort()
        }
      }
      if (nextController.signal.aborted && abortState.reason !== 'timeout') return
      hadError = true
      const message = onError ? onError(err) : err instanceof Error ? err.message : String(err)
      onStatus(`Error: ${message}`)
      onPhaseChange('error')
      onDone?.()
    } finally {
      if (controller === nextController) {
        streaming = false
        if (!nextController.signal.aborted && !hadError) {
          onPhaseChange('idle')
        }
        activeAbortState = null
        await onSyncWithActiveTab?.()
      }
    }
  }

  return {
    start,
    abort,
    isStreaming: () => streaming,
  }
}
