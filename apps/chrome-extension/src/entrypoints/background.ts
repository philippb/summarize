import { shouldPreferUrlMode } from '@steipete/summarize-core/content/url'
import { defineBackground } from 'wxt/utils/define-background'
import { parseSseEvent } from '../../../../src/shared/sse-events.js'
import { buildChatPageContent } from '../lib/chat-context'
import { buildDaemonRequestBody } from '../lib/daemon-payload'
import { createDaemonRecovery, isDaemonUnreachableError } from '../lib/daemon-recovery'
import { loadSettings, patchSettings } from '../lib/settings'
import { parseSseStream } from '../lib/sse'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize'; refresh?: boolean }
  | {
      type: 'panel:chat'
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
      summary?: string | null
    }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setLength'; value: string }
  | { type: 'panel:openOptions' }

type RunStart = {
  id: string
  url: string
  title: string | null
  model: string
  reason: string
}

type ChatStartPayload = {
  id: string
  url: string
}

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }
  | { type: 'chat:start'; payload: ChatStartPayload }

type HoverToBg =
  | { type: 'hover:summarize'; requestId: string; url: string; title: string | null }
  | { type: 'hover:abort'; requestId: string }

type BgToHover =
  | { type: 'hover:chunk'; requestId: string; url: string; text: string }
  | { type: 'hover:done'; requestId: string; url: string }
  | { type: 'hover:error'; requestId: string; url: string; message: string }

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { id: number | null; url: string | null; title: string | null }
  settings: {
    autoSummarize: boolean
    hoverSummaries: boolean
    chatEnabled: boolean
    model: string
    length: string
    tokenPresent: boolean
  }
  status: string
}

type ExtractRequest = { type: 'extract'; maxChars: number }
type ExtractResponse =
  | {
      ok: true
      url: string
      title: string | null
      text: string
      truncated: boolean
      mediaDurationSeconds?: number | null
    }
  | { ok: false; error: string }

const optionsWindowSize = { width: 940, height: 680 }
const optionsWindowMin = { width: 820, height: 560 }
const optionsWindowMargin = 20
const MIN_CHAT_CHARS = 100
const CHAT_FULL_TRANSCRIPT_MAX_CHARS = Number.MAX_SAFE_INTEGER

function resolveOptionsUrl(): string {
  const page = chrome.runtime.getManifest().options_ui?.page ?? 'options.html'
  return chrome.runtime.getURL(page)
}

async function openOptionsWindow() {
  const url = resolveOptionsUrl()
  try {
    if (chrome.windows?.create) {
      const current = await chrome.windows.getCurrent()
      const maxWidth = current.width
        ? Math.max(optionsWindowMin.width, current.width - optionsWindowMargin)
        : null
      const maxHeight = current.height
        ? Math.max(optionsWindowMin.height, current.height - optionsWindowMargin)
        : null
      const width = maxWidth ? Math.min(optionsWindowSize.width, maxWidth) : optionsWindowSize.width
      const height = maxHeight
        ? Math.min(optionsWindowSize.height, maxHeight)
        : optionsWindowSize.height
      await chrome.windows.create({ url, type: 'popup', width, height })
      return
    }
  } catch {
    // ignore and fall back
  }
  void chrome.runtime.openOptionsPage()
}

function canSummarizeUrl(url: string | undefined): url is string {
  if (!url) return false
  if (url.startsWith('chrome://')) return false
  if (url.startsWith('chrome-extension://')) return false
  if (url.startsWith('edge://')) return false
  if (url.startsWith('about:')) return false
  return true
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

async function daemonHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('http://127.0.0.1:8787/health')
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'health failed'
    if (message.toLowerCase() === 'failed to fetch') {
      return {
        ok: false,
        error:
          'Failed to fetch (daemon unreachable or blocked by Chrome; try `summarize daemon status` and check ~/.summarize/logs/daemon.err.log)',
      }
    }
    return { ok: false, error: message }
  }
}

async function daemonPing(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/ping', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ping failed'
    if (message.toLowerCase() === 'failed to fetch') {
      return {
        ok: false,
        error:
          'Failed to fetch (daemon unreachable or blocked by Chrome; try `summarize daemon status`)',
      }
    }
    return { ok: false, error: message }
  }
}

function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase() === 'failed to fetch') {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\` and check ~/.summarize/logs/daemon.err.log)`
  }
  return `${context}: ${message}`
}

function normalizeUrl(value: string) {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function urlsMatch(a: string, b: string) {
  const left = normalizeUrl(a)
  const right = normalizeUrl(b)
  if (left === right) return true
  const boundaryMatch = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter)) return false
    if (longer.length === shorter.length) return true
    const next = longer[shorter.length]
    return next === '/' || next === '?' || next === '&'
  }
  return boundaryMatch(left, right) || boundaryMatch(right, left)
}

async function extractFromTab(
  tabId: number,
  maxChars: number
): Promise<{ ok: true; data: ExtractResponse & { ok: true } } | { ok: false; error: string }> {
  const req = { type: 'extract', maxChars } satisfies ExtractRequest

  const tryInject = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/extract.js'],
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error:
          message.toLowerCase().includes('cannot access') ||
          message.toLowerCase().includes('denied')
            ? `Chrome blocked content access (${message}). Check extension “Site access” → “On all sites” (or allow this domain), then reload the tab.`
            : `Failed to inject content script (${message}). Check extension “Site access”, then reload the tab.`,
      }
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, req)) as ExtractResponse
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, data: res }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noReceiver =
        message.includes('Receiving end does not exist') ||
        message.includes('Could not establish connection')
      if (noReceiver) {
        const injected = await tryInject()
        if (!injected.ok) return injected
        await new Promise((r) => setTimeout(r, 120))
        continue
      }

      if (attempt === 2) {
        return {
          ok: false,
          error: noReceiver
            ? 'Content script not ready. Check extension “Site access” → “On all sites”, then reload the tab.'
            : message,
        }
      }
      await new Promise((r) => setTimeout(r, 350))
    }
  }

  return { ok: false, error: 'Content script not ready' }
}

export default defineBackground(() => {
  let panelOpen = false
  let panelLastPingAt = 0
  let lastSummarizedUrl: string | null = null
  let inflightUrl: string | null = null
  let runController: AbortController | null = null
  let lastNavAt = 0
  const daemonRecovery = createDaemonRecovery()
  type CachedExtract = {
    url: string
    title: string | null
    text: string
    source: 'page' | 'url'
    truncated: boolean
    totalCharacters: number
    wordCount: number | null
    transcriptSource: string | null
    transcriptionProvider: string | null
    transcriptCharacters: number | null
    transcriptWordCount: number | null
    transcriptLines: number | null
    mediaDurationSeconds: number | null
    diagnostics?: {
      strategy: string
      markdown?: { used?: boolean; provider?: string | null } | null
      firecrawl?: { used?: boolean } | null
      transcript?: {
        provider?: string | null
        cacheStatus?: string | null
        attemptedProviders?: string[] | null
      } | null
    } | null
  }
  const cachedExtracts = new Map<number, CachedExtract>()
  const hoverControllersByTabId = new Map<
    number,
    { requestId: string; controller: AbortController }
  >()

  const isPanelOpen = () => {
    if (!panelOpen) return false
    if (panelLastPingAt === 0) return true
    return Date.now() - panelLastPingAt < 45_000
  }

  const getCachedExtract = (tabId: number, url?: string | null) => {
    const cached = cachedExtracts.get(tabId) ?? null
    if (!cached) return null
    if (url && cached.url !== url) {
      cachedExtracts.delete(tabId)
      return null
    }
    return cached
  }

  const ensureChatExtract = async (
    tab: chrome.tabs.Tab,
    settings: Awaited<ReturnType<typeof loadSettings>>
  ) => {
    if (!tab.id || !tab.url) {
      throw new Error('Cannot chat on this page')
    }

    const preferUrl = shouldPreferUrlMode(tab.url)
    const cached = getCachedExtract(tab.id, tab.url)
    if (cached && (!preferUrl || cached.source === 'url')) return cached

    if (!preferUrl) {
      const extractedAttempt = await extractFromTab(tab.id, CHAT_FULL_TRANSCRIPT_MAX_CHARS)
      if (extractedAttempt.ok) {
        const extracted = extractedAttempt.data
        const text = extracted.text.trim()
        if (text.length >= MIN_CHAT_CHARS) {
          const wordCount = text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0
          const next = {
            url: extracted.url,
            title: extracted.title ?? tab.title?.trim() ?? null,
            text: extracted.text,
            source: 'page' as const,
            truncated: extracted.truncated,
            totalCharacters: extracted.text.length,
            wordCount,
            transcriptSource: null,
            transcriptionProvider: null,
            transcriptCharacters: null,
            transcriptWordCount: null,
            transcriptLines: null,
            mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
            diagnostics: null,
          }
          cachedExtracts.set(tab.id, next)
          return next
        }
      } else if (
        extractedAttempt.error.toLowerCase().includes('chrome blocked') ||
        extractedAttempt.error.toLowerCase().includes('failed to inject')
      ) {
        throw new Error(extractedAttempt.error)
      }
    }

    sendStatus('Extracting page content…')
    const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: tab.url,
        mode: 'url',
        extractOnly: true,
        maxCharacters: null,
      }),
    })
    const json = (await res.json()) as {
      ok: boolean
      extracted?: {
        content: string
        title: string | null
        url: string
        wordCount: number
        totalCharacters: number
        truncated: boolean
        transcriptSource: string | null
        transcriptCharacters?: number | null
        transcriptWordCount?: number | null
        transcriptLines?: number | null
        transcriptionProvider?: string | null
        mediaDurationSeconds?: number | null
        diagnostics?: {
          strategy: string
          markdown?: { used?: boolean; provider?: string | null } | null
          firecrawl?: { used?: boolean } | null
          transcript?: {
            provider?: string | null
            cacheStatus?: string | null
            attemptedProviders?: string[] | null
          } | null
        }
      }
      error?: string
    }
    if (!res.ok || !json.ok || !json.extracted) {
      throw new Error(json.error || `${res.status} ${res.statusText}`)
    }

    const next = {
      url: json.extracted.url,
      title: json.extracted.title,
      text: json.extracted.content,
      source: 'url' as const,
      truncated: json.extracted.truncated,
      totalCharacters: json.extracted.totalCharacters,
      wordCount: json.extracted.wordCount,
      transcriptSource: json.extracted.transcriptSource ?? null,
      transcriptionProvider: json.extracted.transcriptionProvider ?? null,
      transcriptCharacters: json.extracted.transcriptCharacters ?? null,
      transcriptWordCount: json.extracted.transcriptWordCount ?? null,
      transcriptLines: json.extracted.transcriptLines ?? null,
      mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
      diagnostics: json.extracted.diagnostics ?? null,
    }
    if (!next.mediaDurationSeconds) {
      const fallback = await extractFromTab(tab.id, CHAT_FULL_TRANSCRIPT_MAX_CHARS)
      if (fallback.ok) {
        const duration = fallback.data.mediaDurationSeconds
        if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
          next.mediaDurationSeconds = duration
        }
      }
    }
    cachedExtracts.set(tab.id, next)
    return next
  }

  const send = async (msg: BgToPanel) => {
    if (!isPanelOpen()) return
    try {
      await chrome.runtime.sendMessage(msg)
    } catch {
      // ignore (panel closed / reloading)
    }
  }
  const sendStatus = (status: string) => void send({ type: 'ui:status', status })

  const sendHover = async (tabId: number, msg: BgToHover) => {
    try {
      await chrome.tabs.sendMessage(tabId, msg)
    } catch {
      // ignore (tab closed / navigated / no content script)
    }
  }

  const emitState = async (status: string, opts?: { checkRecovery?: boolean }) => {
    const settings = await loadSettings()
    const tab = await getActiveTab()
    const health = await daemonHealth()
    const authed = settings.token.trim() ? await daemonPing(settings.token.trim()) : { ok: false }
    const daemonReady = health.ok && authed.ok
    const pendingUrl = daemonRecovery.getPendingUrl()
    const currentUrlMatches = Boolean(pendingUrl && tab?.url && urlsMatch(tab.url, pendingUrl))
    const isIdle = !runController && !inflightUrl
    let shouldRecover = false
    if (opts?.checkRecovery) {
      shouldRecover = daemonRecovery.maybeRecover({
        isReady: daemonReady,
        currentUrlMatches,
        isIdle,
      })
    } else {
      daemonRecovery.updateStatus(daemonReady)
    }
    const state: UiState = {
      panelOpen: isPanelOpen(),
      daemon: { ok: health.ok, authed: authed.ok, error: health.error ?? authed.error },
      tab: { id: tab?.id ?? null, url: tab?.url ?? null, title: tab?.title ?? null },
      settings: {
        autoSummarize: settings.autoSummarize,
        hoverSummaries: settings.hoverSummaries,
        chatEnabled: settings.chatEnabled,
        model: settings.model,
        length: settings.length,
        tokenPresent: Boolean(settings.token.trim()),
      },
      status,
    }
    void send({ type: 'ui:state', state })

    if (shouldRecover) {
      void summarizeActiveTab('daemon-recovered')
      return
    }

    if (pendingUrl && tab?.url && !currentUrlMatches) {
      daemonRecovery.clearPending()
    }
  }

  const summarizeActiveTab = async (reason: string, opts?: { refresh?: boolean }) => {
    if (!isPanelOpen()) return

    const settings = await loadSettings()
    const isManual = reason === 'manual' || reason === 'refresh' || reason === 'length-change'
    if (!isManual && !settings.autoSummarize) return
    if (!settings.token.trim()) {
      await emitState('Setup required (missing token)')
      return
    }

    if (reason === 'spa-nav' || reason === 'tab-url-change') {
      await new Promise((resolve) => setTimeout(resolve, 220))
    }

    const tab = await getActiveTab()
    if (!tab?.id || !canSummarizeUrl(tab.url)) return

    runController?.abort()
    const controller = new AbortController()
    runController = controller

    sendStatus(`Extracting… (${reason})`)
    const extractedAttempt = await extractFromTab(tab.id, settings.maxChars)
    let extracted = extractedAttempt.ok
      ? extractedAttempt.data
      : {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: '',
          truncated: false,
        }

    if (tab.url && extracted.url && !urlsMatch(tab.url, extracted.url)) {
      await new Promise((resolve) => setTimeout(resolve, 180))
      const retry = await extractFromTab(tab.id, settings.maxChars)
      if (retry.ok) {
        extracted = retry.data
      }
    }

    const extractedMatchesTab = tab.url && extracted.url ? urlsMatch(tab.url, extracted.url) : true
    const resolvedExtracted =
      tab.url && !extractedMatchesTab
        ? {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: '',
            truncated: false,
          }
        : extracted

    if (!extracted) return

    if (
      settings.autoSummarize &&
      ((lastSummarizedUrl && urlsMatch(lastSummarizedUrl, resolvedExtracted.url)) ||
        (inflightUrl && urlsMatch(inflightUrl, resolvedExtracted.url))) &&
      !isManual
    ) {
      sendStatus('')
      return
    }

    const resolvedTitle = tab.title?.trim() || resolvedExtracted.title || null
    const resolvedPayload = { ...resolvedExtracted, title: resolvedTitle }
    const wordCount =
      resolvedPayload.text.length > 0 ? resolvedPayload.text.split(/\s+/).filter(Boolean).length : 0

    cachedExtracts.set(tab.id, {
      url: resolvedPayload.url,
      title: resolvedTitle,
      text: resolvedPayload.text,
      source: 'page',
      truncated: resolvedPayload.truncated,
      totalCharacters: resolvedPayload.text.length,
      wordCount,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptCharacters: null,
      transcriptWordCount: null,
      transcriptLines: null,
      mediaDurationSeconds: resolvedPayload.mediaDurationSeconds ?? null,
      diagnostics: null,
    })

    sendStatus('Connecting…')
    inflightUrl = resolvedPayload.url
    let id: string
    try {
      const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          buildDaemonRequestBody({
            extracted: resolvedPayload,
            settings,
            noCache: Boolean(opts?.refresh),
          })
        ),
        signal: controller.signal,
      })
      const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
      if (!res.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${res.status} ${res.statusText}`)
      }
      id = json.id
    } catch (err) {
      if (controller.signal.aborted) return
      const message = friendlyFetchError(err, 'Daemon request failed')
      void send({ type: 'run:error', message })
      sendStatus(`Error: ${message}`)
      inflightUrl = null
      if (!isManual && isDaemonUnreachableError(err)) {
        daemonRecovery.recordFailure(resolvedPayload.url)
      }
      return
    }

    void send({
      type: 'run:start',
      run: { id, url: resolvedPayload.url, title: resolvedTitle, model: settings.model, reason },
    })
  }

  const abortHoverForTab = (tabId: number, requestId?: string) => {
    const existing = hoverControllersByTabId.get(tabId)
    if (!existing) return
    if (requestId && existing.requestId !== requestId) return
    existing.controller.abort()
    hoverControllersByTabId.delete(tabId)
  }

  const runHoverSummarize = async (tabId: number, msg: HoverToBg & { type: 'hover:summarize' }) => {
    abortHoverForTab(tabId)

    // Keep localhost daemon calls out of content-script/page context to avoid Chrome’s “Local network access”
    // prompt per-origin. Background SW owns `fetch("http://127.0.0.1:8787/...")` for hover summaries.
    const controller = new AbortController()
    hoverControllersByTabId.set(tabId, { requestId: msg.requestId, controller })

    const isStillActive = () => {
      const current = hoverControllersByTabId.get(tabId)
      return Boolean(current && current.requestId === msg.requestId && !controller.signal.aborted)
    }

    const settings = await loadSettings()
    const logHover = (event: string, detail?: Record<string, unknown>) => {
      if (!settings.extendedLogging) return
      const payload = detail ? { event, ...detail } : { event }
      console.debug('[summarize][hover:bg]', payload)
    }
    const token = settings.token.trim()
    if (!token) {
      await sendHover(tabId, {
        type: 'hover:error',
        requestId: msg.requestId,
        url: msg.url,
        message: 'Setup required (missing token)',
      })
      return
    }

    try {
      logHover('start', { tabId, requestId: msg.requestId, url: msg.url })
      const base = buildDaemonRequestBody({
        extracted: { url: msg.url, title: msg.title, text: '', truncated: false },
        settings,
      })
      const body = {
        ...base,
        length: 'short',
        prompt: settings.hoverPrompt,
        mode: 'url',
        timeout: '30s',
      }

      const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
      if (!res.ok || !json?.ok || !json.id) {
        throw new Error(json?.error || `${res.status} ${res.statusText}`)
      }

      if (!isStillActive()) return
      logHover('stream-start', { tabId, requestId: msg.requestId, url: msg.url, runId: json.id })

      const streamRes = await fetch(`http://127.0.0.1:8787/v1/summarize/${json.id}/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`)
      if (!streamRes.body) throw new Error('Missing stream body')

      for await (const raw of parseSseStream(streamRes.body)) {
        if (!isStillActive()) return
        const event = parseSseEvent(raw)
        if (!event) continue

        if (event.event === 'chunk') {
          await sendHover(tabId, {
            type: 'hover:chunk',
            requestId: msg.requestId,
            url: msg.url,
            text: event.data.text,
          })
        } else if (event.event === 'error') {
          throw new Error(event.data.message)
        } else if (event.event === 'done') {
          break
        }
      }

      if (!isStillActive()) return
      logHover('done', { tabId, requestId: msg.requestId, url: msg.url })
      await sendHover(tabId, { type: 'hover:done', requestId: msg.requestId, url: msg.url })
    } catch (err) {
      if (!isStillActive()) return
      logHover('error', {
        tabId,
        requestId: msg.requestId,
        url: msg.url,
        message: err instanceof Error ? err.message : String(err),
      })
      await sendHover(tabId, {
        type: 'hover:error',
        requestId: msg.requestId,
        url: msg.url,
        message: friendlyFetchError(err, 'Hover summarize failed'),
      })
    } finally {
      abortHoverForTab(tabId, msg.requestId)
    }
  }

  chrome.runtime.onMessage.addListener(
    (raw: PanelToBg | HoverToBg, sender, sendResponse): boolean | undefined => {
      if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
        return
      }

      const type = (raw as { type: string }).type
      if (type.startsWith('panel:')) {
        const msg = raw as PanelToBg
        panelOpen = true
        if (type === 'panel:ping') panelLastPingAt = Date.now()

        switch (type) {
          case 'panel:ready':
            panelLastPingAt = Date.now()
            lastSummarizedUrl = null
            inflightUrl = null
            runController?.abort()
            runController = null
            daemonRecovery.clearPending()
            void emitState('')
            void summarizeActiveTab('panel-open')
            break
          case 'panel:closed':
            panelOpen = false
            panelLastPingAt = 0
            runController?.abort()
            runController = null
            lastSummarizedUrl = null
            inflightUrl = null
            cachedExtracts.clear()
            daemonRecovery.clearPending()
            break
          case 'panel:summarize':
            void summarizeActiveTab((msg as { refresh?: boolean }).refresh ? 'refresh' : 'manual', {
              refresh: Boolean((msg as { refresh?: boolean }).refresh),
            })
            break
          case 'panel:chat':
            void (async () => {
              const settings = await loadSettings()
              if (!settings.chatEnabled) {
                void send({ type: 'run:error', message: 'Chat is disabled in settings' })
                return
              }
              if (!settings.token.trim()) {
                void send({ type: 'run:error', message: 'Setup required (missing token)' })
                return
              }

              const tab = await getActiveTab()
              if (!tab?.id || !canSummarizeUrl(tab.url)) {
                void send({ type: 'run:error', message: 'Cannot chat on this page' })
                return
              }

              let cachedExtract: CachedExtract
              try {
                cachedExtract = await ensureChatExtract(tab, settings)
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                void send({ type: 'run:error', message })
                sendStatus(`Error: ${message}`)
                return
              }

              const chatPayload = msg as {
                messages: Array<{ role: 'user' | 'assistant'; content: string }>
                summary?: string | null
              }
              const chatMessages = chatPayload.messages
              const summaryText =
                typeof chatPayload.summary === 'string' ? chatPayload.summary.trim() : ''
              const pageContent = buildChatPageContent({
                transcript: cachedExtract.text,
                summary: summaryText,
                summaryCap: settings.maxChars,
                metadata: {
                  url: cachedExtract.url,
                  title: cachedExtract.title,
                  source: cachedExtract.source,
                  extractionStrategy:
                    cachedExtract.source === 'page'
                      ? 'readability (content script)'
                      : (cachedExtract.diagnostics?.strategy ?? null),
                  markdownProvider: cachedExtract.diagnostics?.markdown?.used
                    ? (cachedExtract.diagnostics?.markdown?.provider ?? 'unknown')
                    : null,
                  firecrawlUsed: cachedExtract.diagnostics?.firecrawl?.used ?? null,
                  transcriptSource: cachedExtract.transcriptSource,
                  transcriptionProvider: cachedExtract.transcriptionProvider,
                  transcriptCache: cachedExtract.diagnostics?.transcript?.cacheStatus ?? null,
                  attemptedTranscriptProviders:
                    cachedExtract.diagnostics?.transcript?.attemptedProviders ?? null,
                  mediaDurationSeconds: cachedExtract.mediaDurationSeconds,
                  totalCharacters: cachedExtract.totalCharacters,
                  wordCount: cachedExtract.wordCount,
                  transcriptCharacters: cachedExtract.transcriptCharacters,
                  transcriptWordCount: cachedExtract.transcriptWordCount,
                  transcriptLines: cachedExtract.transcriptLines,
                  truncated: cachedExtract.truncated,
                },
              })

              sendStatus('Sending to AI…')

              try {
                const res = await fetch('http://127.0.0.1:8787/v1/chat', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${settings.token.trim()}`,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify({
                    url: cachedExtract.url,
                    title: cachedExtract.title,
                    pageContent,
                    messages: chatMessages,
                    model: settings.model,
                  }),
                })
                const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
                if (!res.ok || !json.ok || !json.id) {
                  throw new Error(json.error || `${res.status} ${res.statusText}`)
                }

                void send({
                  type: 'chat:start',
                  payload: { id: json.id, url: cachedExtract.url },
                })
                sendStatus('')
              } catch (err) {
                const message = friendlyFetchError(err, 'Chat request failed')
                void send({ type: 'run:error', message })
                sendStatus(`Error: ${message}`)
              }
            })()
            break
          case 'panel:ping':
            void emitState('', { checkRecovery: true })
            break
          case 'panel:rememberUrl':
            lastSummarizedUrl = (msg as { url: string }).url
            inflightUrl = null
            break
          case 'panel:setAuto':
            void (async () => {
              await patchSettings({ autoSummarize: (msg as { value: boolean }).value })
              void emitState('')
              if ((msg as { value: boolean }).value) void summarizeActiveTab('auto-enabled')
            })()
            break
          case 'panel:setLength':
            void (async () => {
              const next = (msg as { value: string }).value
              const current = await loadSettings()
              if (current.length === next) return
              await patchSettings({ length: next })
              void emitState('')
              void summarizeActiveTab('length-change')
            })()
            break
          case 'panel:openOptions':
            void openOptionsWindow()
            break
        }

        try {
          sendResponse({ ok: true })
        } catch {
          // ignore
        }
        // keep SW alive for async branches
        return true
      }

      if (type === 'hover:summarize') {
        const tabId = sender.tab?.id
        if (!tabId) {
          try {
            sendResponse({ ok: false, error: 'Missing sender tab' })
          } catch {
            // ignore
          }
          return
        }

        const msg = raw as HoverToBg & { type: 'hover:summarize' }
        void runHoverSummarize(tabId, msg)
        try {
          sendResponse({ ok: true })
        } catch {
          // ignore
        }
        return
      }

      if (type === 'hover:abort') {
        const tabId = sender.tab?.id
        if (!tabId) return
        abortHoverForTab(tabId, (raw as HoverToBg & { type: 'hover:abort' }).requestId)
        return
      }
    }
  )

  chrome.webNavigation.onHistoryStateUpdated.addListener(() => {
    const now = Date.now()
    if (now - lastNavAt < 700) return
    lastNavAt = now
    void emitState('')
    void summarizeActiveTab('spa-nav')
  })

  chrome.tabs.onActivated.addListener(() => {
    void emitState('')
    void summarizeActiveTab('tab-activated')
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (typeof changeInfo.title === 'string' || typeof changeInfo.url === 'string') {
      void emitState('')
    }
    if (typeof changeInfo.url === 'string') {
      void summarizeActiveTab('tab-url-change')
    }
    if (changeInfo.status === 'complete') {
      void emitState('')
      void summarizeActiveTab('tab-updated')
    }
  })

  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
})
