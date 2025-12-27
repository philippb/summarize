import MarkdownIt from 'markdown-it'

import { loadSettings, patchSettings } from '../../lib/settings'
import { generateToken } from '../../lib/token'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize' }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setModel'; value: string }
  | { type: 'panel:openOptions' }

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { url: string | null; title: string | null }
  settings: { autoSummarize: boolean; model: string; tokenPresent: boolean }
  status: string
}

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'summary:reset' }
  | { type: 'summary:chunk'; text: string }
  | { type: 'summary:meta'; model: string }
  | { type: 'summary:done' }
  | { type: 'summary:error'; message: string }

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const subtitleEl = byId<HTMLDivElement>('subtitle')
const setupEl = byId<HTMLDivElement>('setup')
const statusEl = byId<HTMLDivElement>('status')
const renderEl = byId<HTMLElement>('render')

const summarizeBtn = byId<HTMLButtonElement>('summarize')
const settingsBtn = byId<HTMLButtonElement>('settings')
const autoEl = byId<HTMLInputElement>('auto')
const modelEl = byId<HTMLInputElement>('model')
const fontEl = byId<HTMLSelectElement>('font')
const sizeEl = byId<HTMLInputElement>('size')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

let markdown = ''
let renderQueued = 0
let currentState: UiState | null = null

function setStatus(text: string) {
  statusEl.textContent = text
  const isError = text.toLowerCase().startsWith('error:') || text.toLowerCase().includes(' error')
  statusEl.classList.toggle('error', isError)
}

window.addEventListener('error', (event) => {
  const message =
    event.error instanceof Error ? event.error.stack || event.error.message : event.message
  setStatus(`Error: ${message}`)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
  setStatus(`Error: ${message}`)
})

function queueRender() {
  if (renderQueued) return
  renderQueued = window.setTimeout(() => {
    renderQueued = 0
    try {
      renderEl.innerHTML = md.render(markdown)
    } catch (err) {
      const message = err instanceof Error ? err.stack || err.message : String(err)
      setStatus(`Error: ${message}`)
      return
    }
    for (const a of Array.from(renderEl.querySelectorAll('a'))) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }, 80)
}

function applyTypography(fontFamily: string, fontSize: number) {
  document.documentElement.style.setProperty('--font-body', fontFamily)
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
}

async function ensureToken(): Promise<string> {
  const settings = await loadSettings()
  if (settings.token.trim()) return settings.token.trim()
  const token = generateToken()
  await patchSettings({ token })
  return token
}

function renderSetup(token: string) {
  setupEl.classList.remove('hidden')
  const cmd = `summarize daemon install --token ${token}`
  setupEl.innerHTML = `
    <h2>Setup</h2>
    <p>Install the local daemon (LaunchAgent) so the side panel can stream summaries.</p>
    <code>${cmd}</code>
    <div class="row">
      <button id="copy" type="button">Copy Install Command</button>
      <button id="regen" type="button">Regenerate Token</button>
    </div>
  `
  const copyBtn = setupEl.querySelector<HTMLButtonElement>('#copy')
  const regenBtn = setupEl.querySelector<HTMLButtonElement>('#regen')
  copyBtn?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText(cmd)
      setStatus('Copied')
      setTimeout(() => setStatus(currentState?.status ?? ''), 800)
    })()
  })
  regenBtn?.addEventListener('click', () => {
    void (async () => {
      const token2 = generateToken()
      await patchSettings({ token: token2 })
      renderSetup(token2)
    })()
  })
}

function maybeShowSetup(state: UiState) {
  if (!state.settings.tokenPresent) {
    void (async () => {
      const token = await ensureToken()
      renderSetup(token)
    })()
    return
  }
  if (!state.daemon.ok || !state.daemon.authed) {
    setupEl.classList.remove('hidden')
    const token = (async () => (await loadSettings()).token.trim())()
    void token.then((t) => {
      const cmd = `summarize daemon install --token ${t}`
      setupEl.innerHTML = `
        <h2>Daemon not reachable</h2>
        <p>${state.daemon.error ?? 'Check that the LaunchAgent is installed.'}</p>
        <p>Try:</p>
        <code>${cmd}</code>
        <div class="row">
          <button id="copy" type="button">Copy Install Command</button>
          <button id="status" type="button">Copy Status Command</button>
        </div>
      `
      setupEl.querySelector<HTMLButtonElement>('#copy')?.addEventListener('click', () => {
        void (async () => {
          await navigator.clipboard.writeText(cmd)
        })()
      })
      setupEl.querySelector<HTMLButtonElement>('#status')?.addEventListener('click', () => {
        void (async () => {
          await navigator.clipboard.writeText('summarize daemon status')
        })()
      })
    })
    return
  }
  setupEl.classList.add('hidden')
}

function updateControls(state: UiState) {
  autoEl.checked = state.settings.autoSummarize
  modelEl.value = state.settings.model
  subtitleEl.textContent = state.tab.title || state.tab.url || ''
  setStatus(state.status)
  maybeShowSetup(state)
}

const port = chrome.runtime.connect({ name: 'panel' })
port.onMessage.addListener((msg: BgToPanel) => {
  switch (msg.type) {
    case 'ui:state':
      currentState = msg.state
      updateControls(msg.state)
      return
    case 'summary:reset':
      markdown = ''
      renderEl.innerHTML = ''
      return
    case 'summary:chunk':
      markdown += msg.text
      queueRender()
      return
    case 'summary:meta':
      subtitleEl.textContent = `${currentState?.tab.title || 'Current tab'} · ${msg.model}`
      return
    case 'summary:done':
      return
    case 'summary:error':
      setStatus(`Error: ${msg.message}`)
      return
  }
})

function send(message: PanelToBg) {
  port.postMessage(message)
}

summarizeBtn.addEventListener('click', () => send({ type: 'panel:summarize' }))
settingsBtn.addEventListener('click', () => send({ type: 'panel:openOptions' }))

autoEl.addEventListener('change', () => send({ type: 'panel:setAuto', value: autoEl.checked }))
modelEl.addEventListener('change', () =>
  send({ type: 'panel:setModel', value: modelEl.value.trim() || 'auto' })
)

fontEl.addEventListener('change', () => {
  void (async () => {
    const next = await patchSettings({ fontFamily: fontEl.value })
    applyTypography(next.fontFamily, next.fontSize)
  })()
})

sizeEl.addEventListener('input', () => {
  void (async () => {
    const next = await patchSettings({ fontSize: Number(sizeEl.value) })
    applyTypography(next.fontFamily, next.fontSize)
  })()
})

void (async () => {
  const s = await loadSettings()
  fontEl.value = s.fontFamily
  sizeEl.value = String(s.fontSize)
  modelEl.value = s.model
  autoEl.checked = s.autoSummarize
  applyTypography(s.fontFamily, s.fontSize)
  send({ type: 'panel:ready' })
})()
