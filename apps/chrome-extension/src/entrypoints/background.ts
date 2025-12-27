import { defineBackground } from 'wxt/utils/define-background'

import { loadSettings, patchSettings } from '../lib/settings'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize' }
  | { type: 'panel:ping' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setModel'; value: string }
  | { type: 'panel:openOptions' }

type RunStart = {
  id: string
  url: string
  title: string | null
  model: string
  reason: string
}

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { url: string | null; title: string | null }
  settings: { autoSummarize: boolean; model: string; tokenPresent: boolean }
  status: string
}

type ExtractRequest = { type: 'extract'; maxChars: number }
type ExtractResponse =
  | { ok: true; url: string; title: string | null; text: string; truncated: boolean }
  | { ok: false; error: string }

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
  let panelPort: chrome.runtime.Port | null = null
  let panelOpen = false
  let lastSummarizedUrl: string | null = null
  let inflightUrl: string | null = null
  let runController: AbortController | null = null
  let lastNavAt = 0

  const send = (msg: BgToPanel) => panelPort?.postMessage(msg)
  const sendStatus = (status: string) => send({ type: 'ui:status', status })

  const emitState = async (status: string) => {
    const settings = await loadSettings()
    const tab = await getActiveTab()
    const health = await daemonHealth()
    const authed = settings.token.trim() ? await daemonPing(settings.token.trim()) : { ok: false }
    const state: UiState = {
      panelOpen,
      daemon: { ok: health.ok, authed: authed.ok, error: health.error ?? authed.error },
      tab: { url: tab?.url ?? null, title: tab?.title ?? null },
      settings: {
        autoSummarize: settings.autoSummarize,
        model: settings.model,
        tokenPresent: Boolean(settings.token.trim()),
      },
      status,
    }
    send({ type: 'ui:state', state })
  }

  const summarizeActiveTab = async (reason: string) => {
    if (!panelOpen) return

    const settings = await loadSettings()
    if (reason !== 'manual' && !settings.autoSummarize) return
    if (!settings.token.trim()) {
      await emitState('Setup required (missing token)')
      return
    }

    const tab = await getActiveTab()
    if (!tab?.id || !canSummarizeUrl(tab.url)) return

    runController?.abort()
    runController = new AbortController()
    sendStatus(`Extracting… (${reason})`)

    const extractedAttempt = await extractFromTab(tab.id, settings.maxChars)
    if (!extractedAttempt.ok) {
      send({ type: 'run:error', message: extractedAttempt.error })
      sendStatus(`Error: ${extractedAttempt.error}`)
      return
    }
    const extracted = extractedAttempt.data

    if (
      settings.autoSummarize &&
      (lastSummarizedUrl === extracted.url || inflightUrl === extracted.url) &&
      reason !== 'manual'
    ) {
      sendStatus('')
      return
    }

    sendStatus('Requesting daemon…')
    inflightUrl = extracted.url
    let id: string
    try {
      const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: extracted.url,
          title: extracted.title,
          text: extracted.text,
          truncated: extracted.truncated,
          model: settings.model,
        }),
        signal: runController.signal,
      })
      const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
      if (!res.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${res.status} ${res.statusText}`)
      }
      id = json.id
    } catch (err) {
      if (runController.signal.aborted) return
      const message = friendlyFetchError(err, 'Daemon request failed')
      send({ type: 'run:error', message })
      sendStatus(`Error: ${message}`)
      inflightUrl = null
      return
    }

    send({
      type: 'run:start',
      run: { id, url: extracted.url, title: extracted.title, model: settings.model, reason },
    })
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel') return
    panelPort = port
    panelOpen = true

    port.onDisconnect.addListener(() => {
      if (panelPort === port) panelPort = null
      panelOpen = false
      runController?.abort()
      runController = null
      inflightUrl = null
    })

    port.onMessage.addListener((msg: PanelToBg) => {
      switch (msg.type) {
        case 'panel:ready':
          void emitState('')
          void summarizeActiveTab('panel-open')
          return
        case 'panel:summarize':
          void summarizeActiveTab('manual')
          return
        case 'panel:ping':
          return
        case 'panel:rememberUrl':
          lastSummarizedUrl = msg.url
          inflightUrl = null
          return
        case 'panel:setAuto':
          void (async () => {
            await patchSettings({ autoSummarize: msg.value })
            void emitState('')
            if (msg.value) void summarizeActiveTab('auto-enabled')
          })()
          return
        case 'panel:setModel':
          void (async () => {
            await patchSettings({ model: msg.value })
            void emitState('')
          })()
          return
        case 'panel:openOptions':
          void chrome.runtime.openOptionsPage()
          return
      }
    })
  })

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
    if (changeInfo.status === 'complete') {
      void emitState('')
      void summarizeActiveTab('tab-updated')
    }
  })

  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
})
