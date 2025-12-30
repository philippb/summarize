import MarkdownIt from 'markdown-it'

import { parseSseEvent } from '../../../../../src/shared/sse-events.js'
import { readPresetOrCustomValue } from '../../lib/combo'
import { buildIdleSubtitle } from '../../lib/header'
import { buildMetricsParts, buildMetricsTokens } from '../../lib/metrics'
import { defaultSettings, loadSettings, patchSettings } from '../../lib/settings'
import { parseSseStream } from '../../lib/sse'
import { applyTheme } from '../../lib/theme'
import { generateToken } from '../../lib/token'
import { mountCheckbox } from '../../ui/zag-checkbox'
import { ChatController } from './chat-controller'
import { type ChatHistoryLimits, compactChatHistory } from './chat-state'
import { createHeaderController } from './header-controller'
import { mountSidepanelLengthPicker, mountSidepanelPickers, mountSummarizeControl } from './pickers'
import { createStreamController } from './stream-controller'
import type { ChatMessage, PanelPhase, PanelState, RunStart, UiState } from './types'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize'; refresh?: boolean; inputMode?: 'page' | 'video' }
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

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const subtitleEl = byId<HTMLDivElement>('subtitle')
const titleEl = byId<HTMLDivElement>('title')
const headerEl = document.querySelector('header') as HTMLElement
if (!headerEl) throw new Error('Missing <header>')
const progressFillEl = byId<HTMLDivElement>('progressFill')
const drawerEl = byId<HTMLElement>('drawer')
const setupEl = byId<HTMLDivElement>('setup')
const errorEl = byId<HTMLDivElement>('error')
const errorMessageEl = byId<HTMLParagraphElement>('errorMessage')
const errorRetryBtn = byId<HTMLButtonElement>('errorRetry')
const renderEl = byId<HTMLElement>('render')
const mainEl = document.querySelector('main') as HTMLElement
if (!mainEl) throw new Error('Missing <main>')
const metricsEl = byId<HTMLDivElement>('metrics')
const metricsHomeEl = byId<HTMLDivElement>('metricsHome')
const chatMetricsSlotEl = byId<HTMLDivElement>('chatMetricsSlot')
const chatDockEl = byId<HTMLDivElement>('chatDock')

const summarizeControlRoot = byId<HTMLElement>('summarizeControlRoot')
const drawerToggleBtn = byId<HTMLButtonElement>('drawerToggle')
const refreshBtn = byId<HTMLButtonElement>('refresh')
const advancedBtn = byId<HTMLButtonElement>('advanced')
const autoToggleRoot = byId<HTMLDivElement>('autoToggle')
const lengthRoot = byId<HTMLDivElement>('lengthRoot')
const pickersRoot = byId<HTMLDivElement>('pickersRoot')
const sizeEl = byId<HTMLInputElement>('size')
const advancedSettingsEl = byId<HTMLDetailsElement>('advancedSettings')
const modelPresetEl = byId<HTMLSelectElement>('modelPreset')
const modelCustomEl = byId<HTMLInputElement>('modelCustom')
const modelRefreshBtn = byId<HTMLButtonElement>('modelRefresh')
const modelStatusEl = byId<HTMLDivElement>('modelStatus')

const chatContainerEl = byId<HTMLElement>('chatContainer')
const chatMessagesEl = byId<HTMLDivElement>('chatMessages')
const chatInputEl = byId<HTMLTextAreaElement>('chatInput')
const chatSendBtn = byId<HTMLButtonElement>('chatSend')
const chatContextStatusEl = byId<HTMLDivElement>('chatContextStatus')
const chatJumpBtn = byId<HTMLButtonElement>('chatJump')
const chatQueueEl = byId<HTMLDivElement>('chatQueue')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

const panelState: PanelState = {
  ui: null,
  currentSource: null,
  lastMeta: { inputSummary: null, model: null, modelLabel: null },
  summaryMarkdown: null,
  summaryFromCache: null,
  phase: 'idle',
  error: null,
  chatStreaming: false,
}
let drawerAnimation: Animation | null = null
let autoValue = false
let chatEnabledValue = defaultSettings.chatEnabled
let autoKickTimer = 0

const MAX_CHAT_MESSAGES = 1000
const MAX_CHAT_CHARACTERS = 160_000
const MAX_CHAT_QUEUE = 10
const chatLimits: ChatHistoryLimits = {
  maxMessages: MAX_CHAT_MESSAGES,
  maxChars: MAX_CHAT_CHARACTERS,
}
type ChatQueueItem = {
  id: string
  text: string
  createdAt: number
}
let chatQueue: ChatQueueItem[] = []
const chatHistoryCache = new Map<number, ChatMessage[]>()
let chatHistoryLoadId = 0
let activeTabId: number | null = null
let activeTabUrl: string | null = null
let lastStreamError: string | null = null
let lastChatError: string | null = null
let lastAction: 'summarize' | 'chat' | null = null
let inputMode: 'page' | 'video' = 'page'
let mediaAvailable = false

const chatController = new ChatController({
  messagesEl: chatMessagesEl,
  inputEl: chatInputEl,
  sendBtn: chatSendBtn,
  contextEl: chatContextStatusEl,
  markdown: md,
  limits: chatLimits,
  scrollToBottom: () => scrollToBottom(),
  onNewContent: () => updateAutoScrollLock(),
})

const summarizeControl = mountSummarizeControl(summarizeControlRoot, {
  value: inputMode,
  mediaAvailable: false,
  videoLabel: 'Video',
  onValueChange: (value) => {
    inputMode = value
  },
  onSummarize: () => sendSummarize(),
})

function normalizeQueueText(input: string) {
  return input.replace(/\s+/g, ' ').trim()
}

function renderChatQueue() {
  if (chatQueue.length === 0) {
    chatQueueEl.classList.add('isHidden')
    chatQueueEl.replaceChildren()
    return
  }
  chatQueueEl.classList.remove('isHidden')
  chatQueueEl.replaceChildren()

  for (const item of chatQueue) {
    const row = document.createElement('div')
    row.className = 'chatQueueItem'
    row.dataset.id = item.id

    const text = document.createElement('div')
    text.className = 'chatQueueText'
    text.textContent = item.text
    text.title = item.text

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'chatQueueRemove'
    remove.textContent = 'x'
    remove.setAttribute('aria-label', 'Remove queued message')
    remove.addEventListener('click', () => removeQueuedMessage(item.id))

    row.append(text, remove)
    chatQueueEl.append(row)
  }
}

function enqueueChatMessage(input: string): boolean {
  const text = normalizeQueueText(input)
  if (!text) return false
  if (chatQueue.length >= MAX_CHAT_QUEUE) {
    headerController.setStatus(`Queue full (${MAX_CHAT_QUEUE}). Remove one to add more.`)
    return false
  }
  chatQueue.push({ id: crypto.randomUUID(), text, createdAt: Date.now() })
  renderChatQueue()
  return true
}

function removeQueuedMessage(id: string) {
  chatQueue = chatQueue.filter((item) => item.id !== id)
  renderChatQueue()
}

function clearQueuedMessages() {
  if (chatQueue.length === 0) return
  chatQueue = []
  renderChatQueue()
}

const isStreaming = () => panelState.phase === 'connecting' || panelState.phase === 'streaming'

const showError = (message: string) => {
  errorMessageEl.textContent = message
  errorEl.classList.remove('hidden')
}

const clearError = () => {
  errorMessageEl.textContent = ''
  errorEl.classList.add('hidden')
}

const setPhase = (phase: PanelPhase, opts?: { error?: string | null }) => {
  panelState.phase = phase
  panelState.error = phase === 'error' ? (opts?.error ?? panelState.error) : null
  if (phase === 'error') {
    showError(panelState.error ?? 'Something went wrong.')
  } else {
    clearError()
  }
  if (phase !== 'connecting' && phase !== 'streaming') {
    headerController.stopProgress()
  }
}

const headerController = createHeaderController({
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  getState: () => ({
    phase: panelState.phase,
    summaryFromCache: panelState.summaryFromCache,
  }),
})

headerController.updateHeaderOffset()
window.addEventListener('resize', headerController.updateHeaderOffset)

let autoScrollLocked = true

const isNearBottom = () => {
  const distance = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight
  return distance < 32
}

const updateAutoScrollLock = () => {
  autoScrollLocked = isNearBottom()
  chatJumpBtn.classList.toggle('isVisible', !autoScrollLocked)
}

const scrollToBottom = (force = false) => {
  if (force) autoScrollLocked = true
  if (!force && !autoScrollLocked) return
  mainEl.scrollTop = mainEl.scrollHeight
  chatJumpBtn.classList.remove('isVisible')
}

mainEl.addEventListener('scroll', updateAutoScrollLock, { passive: true })
updateAutoScrollLock()

chatJumpBtn.addEventListener('click', () => {
  scrollToBottom(true)
  chatInputEl.focus()
})

const updateChatDockHeight = () => {
  const height = chatDockEl.getBoundingClientRect().height
  document.documentElement.style.setProperty('--chat-dock-height', `${height}px`)
}

updateChatDockHeight()
const chatDockObserver = new ResizeObserver(() => updateChatDockHeight())
chatDockObserver.observe(chatDockEl)

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

function canSyncTabUrl(url: string | null | undefined): url is string {
  if (!url) return false
  if (url.startsWith('chrome://')) return false
  if (url.startsWith('chrome-extension://')) return false
  if (url.startsWith('edge://')) return false
  if (url.startsWith('about:')) return false
  return true
}

async function syncWithActiveTab() {
  if (!panelState.currentSource) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url || !canSyncTabUrl(tab.url)) return
    if (!urlsMatch(tab.url, panelState.currentSource.url)) {
      panelState.currentSource = null
      setPhase('idle')
      resetSummaryView()
      headerController.setBaseTitle(tab.title || tab.url || 'Summarize')
      headerController.setBaseSubtitle('')
      return
    }
    if (tab.title && tab.title !== panelState.currentSource.title) {
      panelState.currentSource = { ...panelState.currentSource, title: tab.title }
      headerController.setBaseTitle(tab.title)
    }
  } catch {
    // ignore
  }
}

function resetSummaryView() {
  renderEl.innerHTML = ''
  clearMetricsForMode('summary')
  panelState.summaryMarkdown = null
  panelState.summaryFromCache = null
  resetChatState()
}

window.addEventListener('error', (event) => {
  const message =
    event.error instanceof Error ? event.error.stack || event.error.message : event.message
  headerController.setStatus(`Error: ${message}`)
  setPhase('error', { error: message })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
  headerController.setStatus(`Error: ${message}`)
  setPhase('error', { error: message })
})

function renderMarkdown(markdown: string) {
  panelState.summaryMarkdown = markdown
  try {
    renderEl.innerHTML = md.render(markdown)
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err)
    headerController.setStatus(`Error: ${message}`)
    return
  }
  for (const a of Array.from(renderEl.querySelectorAll('a'))) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  }
}

function getLineHeightPx(el: HTMLElement, styles?: CSSStyleDeclaration): number {
  const resolved = styles ?? getComputedStyle(el)
  const lineHeightRaw = resolved.lineHeight
  const fontSize = Number.parseFloat(resolved.fontSize) || 0
  if (lineHeightRaw === 'normal') return fontSize * 1.2
  const parsed = Number.parseFloat(lineHeightRaw)
  return Number.isFinite(parsed) ? parsed : 0
}

function elementWrapsToMultipleLines(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false
  const styles = getComputedStyle(el)
  const lineHeight = getLineHeightPx(el, styles)
  if (!lineHeight) return false

  const paddingTop = Number.parseFloat(styles.paddingTop) || 0
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0
  const borderTop = Number.parseFloat(styles.borderTopWidth) || 0
  const borderBottom = Number.parseFloat(styles.borderBottomWidth) || 0
  const totalHeight = el.getBoundingClientRect().height
  const contentHeight = Math.max(
    0,
    totalHeight - paddingTop - paddingBottom - borderTop - borderBottom
  )

  return contentHeight > lineHeight * 1.4
}

type MetricsMode = 'summary' | 'chat'

type MetricsState = {
  summary: string | null
  inputSummary: string | null
  sourceUrl: string | null
}

type MetricsRenderState = {
  summary: string | null
  inputSummary: string | null
  sourceUrl: string | null
  shortened: boolean
  rafId: number | null
  observer: ResizeObserver | null
}

const metricsRenderState: MetricsRenderState = {
  summary: null,
  inputSummary: null,
  sourceUrl: null,
  shortened: false,
  rafId: null,
  observer: null,
}

const metricsByMode: Record<MetricsMode, MetricsState> = {
  summary: { summary: null, inputSummary: null, sourceUrl: null },
  chat: { summary: null, inputSummary: null, sourceUrl: null },
}

let activeMetricsMode: MetricsMode = 'summary'

let metricsMeasureEl: HTMLDivElement | null = null

function ensureMetricsMeasureEl(): HTMLDivElement {
  if (metricsMeasureEl) return metricsMeasureEl
  const el = document.createElement('div')
  el.style.position = 'absolute'
  el.style.visibility = 'hidden'
  el.style.pointerEvents = 'none'
  el.style.left = '-99999px'
  el.style.top = '0'
  el.style.padding = '0'
  el.style.border = '0'
  el.style.margin = '0'
  el.style.whiteSpace = 'normal'
  el.style.boxSizing = 'content-box'
  document.body.append(el)
  metricsMeasureEl = el
  return el
}

function syncMetricsMeasureStyles() {
  if (!metricsMeasureEl) return
  const styles = getComputedStyle(metricsEl)
  metricsMeasureEl.style.fontFamily = styles.fontFamily
  metricsMeasureEl.style.fontSize = styles.fontSize
  metricsMeasureEl.style.fontWeight = styles.fontWeight
  metricsMeasureEl.style.fontStyle = styles.fontStyle
  metricsMeasureEl.style.fontVariant = styles.fontVariant
  metricsMeasureEl.style.lineHeight = styles.lineHeight
  metricsMeasureEl.style.letterSpacing = styles.letterSpacing
  metricsMeasureEl.style.wordSpacing = styles.wordSpacing
  metricsMeasureEl.style.textTransform = styles.textTransform
  metricsMeasureEl.style.textIndent = styles.textIndent
  metricsMeasureEl.style.wordBreak = styles.wordBreak
  metricsMeasureEl.style.whiteSpace = styles.whiteSpace
  metricsMeasureEl.style.width = `${metricsEl.clientWidth}px`
}

function ensureMetricsObserver() {
  if (metricsRenderState.observer) return
  metricsRenderState.observer = new ResizeObserver(() => {
    scheduleMetricsFitCheck()
  })
  metricsRenderState.observer.observe(metricsEl)
}

function scheduleMetricsFitCheck() {
  if (!metricsRenderState.summary) return
  if (metricsRenderState.rafId != null) return
  metricsRenderState.rafId = window.requestAnimationFrame(() => {
    metricsRenderState.rafId = null
    if (!metricsRenderState.summary) return
    const parts = buildMetricsParts({
      summary: metricsRenderState.summary,
      inputSummary: metricsRenderState.inputSummary,
    })
    if (parts.length === 0) return
    const fullText = parts.join(' · ')
    if (!/\bopenrouter\//i.test(fullText)) return
    if (metricsEl.clientWidth <= 0) return
    const measureEl = ensureMetricsMeasureEl()
    syncMetricsMeasureStyles()
    measureEl.textContent = fullText
    const shouldShorten = elementWrapsToMultipleLines(measureEl)
    if (shouldShorten === metricsRenderState.shortened) return
    metricsRenderState.shortened = shouldShorten
    renderMetricsSummary(metricsRenderState.summary, {
      shortenOpenRouter: shouldShorten,
      inputSummary: metricsRenderState.inputSummary,
      sourceUrl: metricsRenderState.sourceUrl,
    })
  })
}

function renderMetricsSummary(
  summary: string,
  options?: { shortenOpenRouter?: boolean; inputSummary?: string | null; sourceUrl?: string | null }
) {
  metricsEl.replaceChildren()
  const tokens = buildMetricsTokens({
    summary,
    inputSummary: options?.inputSummary ?? panelState.lastMeta.inputSummary,
    sourceUrl: options?.sourceUrl ?? panelState.currentSource?.url ?? null,
    shortenOpenRouter: options?.shortenOpenRouter ?? false,
  })

  tokens.forEach((token, index) => {
    if (index) metricsEl.append(document.createTextNode(' · '))
    if (token.kind === 'link') {
      const link = document.createElement('a')
      link.href = token.href
      link.textContent = token.text
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      metricsEl.append(link)
      return
    }
    if (token.kind === 'media') {
      if (token.before) metricsEl.append(document.createTextNode(token.before))
      const link = document.createElement('a')
      link.href = token.href
      link.textContent = token.label
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      metricsEl.append(link)
      if (token.after) metricsEl.append(document.createTextNode(token.after))
      return
    }
    metricsEl.append(document.createTextNode(token.text))
  })
}

function moveMetricsTo(mode: MetricsMode) {
  const target = mode === 'chat' ? chatMetricsSlotEl : metricsHomeEl
  if (metricsEl.parentElement !== target) {
    target.append(metricsEl)
  }
  activeMetricsMode = mode
}

function renderMetricsMode(mode: MetricsMode) {
  const state = metricsByMode[mode]
  metricsRenderState.summary = state.summary
  metricsRenderState.inputSummary = state.inputSummary
  metricsRenderState.sourceUrl = state.sourceUrl
  metricsRenderState.shortened = false

  if (mode === 'chat') {
    chatMetricsSlotEl.classList.toggle('isVisible', Boolean(state.summary))
  } else {
    chatMetricsSlotEl.classList.remove('isVisible')
  }

  metricsEl.removeAttribute('title')
  metricsEl.removeAttribute('data-details')

  if (!state.summary) {
    metricsEl.textContent = ''
    metricsEl.classList.add('hidden')
    return
  }

  renderMetricsSummary(state.summary, {
    inputSummary: state.inputSummary,
    sourceUrl: state.sourceUrl,
  })
  metricsEl.classList.remove('hidden')
  ensureMetricsObserver()
  scheduleMetricsFitCheck()
}

function setMetricsForMode(
  mode: MetricsMode,
  summary: string | null,
  inputSummary: string | null,
  sourceUrl: string | null
) {
  metricsByMode[mode] = { summary, inputSummary, sourceUrl }
  if (activeMetricsMode === mode) {
    renderMetricsMode(mode)
  }
}

function clearMetricsForMode(mode: MetricsMode) {
  setMetricsForMode(mode, null, null, null)
}

function setActiveMetricsMode(mode: MetricsMode) {
  moveMetricsTo(mode)
  renderMetricsMode(mode)
}

function applyTypography(fontFamily: string, fontSize: number) {
  document.documentElement.style.setProperty('--font-body', fontFamily)
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
}

let pickerSettings = {
  scheme: defaultSettings.colorScheme,
  mode: defaultSettings.colorMode,
  fontFamily: defaultSettings.fontFamily,
  length: defaultSettings.length,
}

const pickerHandlers = {
  onSchemeChange: (value) => {
    void (async () => {
      const next = await patchSettings({ colorScheme: value })
      pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode }
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode })
    })()
  },
  onModeChange: (value) => {
    void (async () => {
      const next = await patchSettings({ colorMode: value })
      pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode }
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode })
    })()
  },
  onFontChange: (value) => {
    void (async () => {
      const next = await patchSettings({ fontFamily: value })
      pickerSettings = { ...pickerSettings, fontFamily: next.fontFamily }
      applyTypography(next.fontFamily, next.fontSize)
    })()
  },
  onLengthChange: (value) => {
    pickerSettings = { ...pickerSettings, length: value }
    send({ type: 'panel:setLength', value })
  },
}

const pickers = mountSidepanelPickers(pickersRoot, {
  scheme: pickerSettings.scheme,
  mode: pickerSettings.mode,
  fontFamily: pickerSettings.fontFamily,
  onSchemeChange: pickerHandlers.onSchemeChange,
  onModeChange: pickerHandlers.onModeChange,
  onFontChange: pickerHandlers.onFontChange,
})

const lengthPicker = mountSidepanelLengthPicker(lengthRoot, {
  length: pickerSettings.length,
  onLengthChange: pickerHandlers.onLengthChange,
})

const autoToggle = mountCheckbox(autoToggleRoot, {
  id: 'sidepanel-auto',
  label: 'Auto summarize',
  checked: autoValue,
  onCheckedChange: (checked) => {
    autoValue = checked
    send({ type: 'panel:setAuto', value: checked })
  },
})

function applyChatEnabled() {
  chatContainerEl.toggleAttribute('hidden', !chatEnabledValue)
  chatDockEl.toggleAttribute('hidden', !chatEnabledValue)
  if (!chatEnabledValue) {
    chatJumpBtn.classList.remove('isVisible')
  }
  if (!chatEnabledValue) {
    clearMetricsForMode('chat')
    resetChatState()
    clearQueuedMessages()
  } else {
    renderEl.classList.remove('hidden')
  }
}

function getChatHistoryKey(tabId: number) {
  return `chat:tab:${tabId}`
}

async function clearChatHistoryForTab(tabId: number | null) {
  if (!tabId) return
  chatHistoryCache.delete(tabId)
  const store = chrome.storage?.session
  if (!store) return
  try {
    await store.remove(getChatHistoryKey(tabId))
  } catch {
    // ignore
  }
}

async function clearChatHistoryForActiveTab() {
  await clearChatHistoryForTab(activeTabId)
}

async function loadChatHistory(tabId: number): Promise<ChatMessage[] | null> {
  const cached = chatHistoryCache.get(tabId)
  if (cached) return cached
  const store = chrome.storage?.session
  if (!store) return null
  try {
    const key = getChatHistoryKey(tabId)
    const res = await store.get(key)
    const raw = res?.[key]
    if (!Array.isArray(raw)) return null
    const parsed = raw.filter((msg) => msg && typeof msg === 'object') as ChatMessage[]
    if (!parsed.length) return null
    chatHistoryCache.set(tabId, parsed)
    return parsed
  } catch {
    return null
  }
}

async function persistChatHistory() {
  if (!chatEnabledValue) return
  const tabId = activeTabId
  if (!tabId) return
  const compacted = compactChatHistory(chatController.getMessages(), chatLimits)
  if (compacted.length !== chatController.getMessages().length) {
    chatController.setMessages(compacted, { scroll: false })
  }
  chatHistoryCache.set(tabId, compacted)
  const store = chrome.storage?.session
  if (!store) return
  try {
    await store.set({ [getChatHistoryKey(tabId)]: compacted })
  } catch {
    // ignore
  }
}

async function restoreChatHistory() {
  const tabId = activeTabId
  if (!tabId) return
  chatHistoryLoadId += 1
  const loadId = chatHistoryLoadId
  const history = await loadChatHistory(tabId)
  if (loadId !== chatHistoryLoadId || !history?.length) return
  const compacted = compactChatHistory(history, chatLimits)
  chatController.setMessages(compacted, { scroll: false })
}

type PlatformKind = 'mac' | 'windows' | 'linux' | 'other'

function resolvePlatformKind(): PlatformKind {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const raw = (nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? '')
    .toLowerCase()
    .trim()

  if (raw.includes('mac')) return 'mac'
  if (raw.includes('win')) return 'windows'
  if (raw.includes('linux') || raw.includes('cros') || raw.includes('chrome os')) return 'linux'
  return 'other'
}

const platformKind = resolvePlatformKind()

function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase() === 'failed to fetch') {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\`, maybe \`summarize daemon restart\`, and check ~/.summarize/logs/daemon.err.log)`
  }
  return `${context}: ${message}`
}

function setModelStatus(text: string, state: 'idle' | 'running' | 'error' | 'ok' = 'idle') {
  modelStatusEl.textContent = text
  if (state === 'idle') {
    modelStatusEl.removeAttribute('data-state')
  } else {
    modelStatusEl.setAttribute('data-state', state)
  }
}

function setDefaultModelPresets() {
  modelPresetEl.innerHTML = ''
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = 'Auto'
  modelPresetEl.append(auto)
  const custom = document.createElement('option')
  custom.value = 'custom'
  custom.textContent = 'Custom…'
  modelPresetEl.append(custom)
}

function setModelPlaceholderFromDiscovery(discovery: {
  providers?: unknown
  localModelsSource?: unknown
}) {
  const hints: string[] = ['auto']
  const providers = discovery.providers
  if (providers && typeof providers === 'object') {
    const p = providers as Record<string, unknown>
    if (p.openrouter === true) hints.push('free')
    if (p.openai === true) hints.push('openai/…')
    if (p.anthropic === true) hints.push('anthropic/…')
    if (p.google === true) hints.push('google/…')
    if (p.xai === true) hints.push('xai/…')
    if (p.zai === true) hints.push('zai/…')
  }
  if (discovery.localModelsSource && typeof discovery.localModelsSource === 'object') {
    hints.push('local: openai/<id>')
  }
  modelCustomEl.placeholder = hints.join(' / ')
}

function readCurrentModelValue(): string {
  return readPresetOrCustomValue({
    presetValue: modelPresetEl.value,
    customValue: modelCustomEl.value,
    defaultValue: defaultSettings.model,
  })
}

function setModelValue(value: string) {
  const next = value.trim() || defaultSettings.model
  const optionValues = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
  if (optionValues.has(next) && next !== 'custom') {
    modelPresetEl.value = next
    modelCustomEl.hidden = true
    return
  }
  modelPresetEl.value = 'custom'
  modelCustomEl.hidden = false
  modelCustomEl.value = next
}

function captureModelSelection() {
  return {
    presetValue: modelPresetEl.value,
    customValue: modelCustomEl.value,
  }
}

function restoreModelSelection(selection: { presetValue: string; customValue: string }) {
  if (selection.presetValue === 'custom') {
    modelPresetEl.value = 'custom'
    modelCustomEl.hidden = false
    modelCustomEl.value = selection.customValue
    return
  }
  const optionValues = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
  if (optionValues.has(selection.presetValue) && selection.presetValue !== 'custom') {
    modelPresetEl.value = selection.presetValue
    modelCustomEl.hidden = true
    return
  }
  setModelValue(selection.presetValue)
}

async function refreshModelPresets(token: string) {
  const selection = captureModelSelection()
  const trimmed = token.trim()
  if (!trimmed) {
    setDefaultModelPresets()
    setModelPlaceholderFromDiscovery({})
    restoreModelSelection(selection)
    return
  }
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
    })
    if (!res.ok) {
      setDefaultModelPresets()
      restoreModelSelection(selection)
      return
    }
    const json = (await res.json()) as unknown
    if (!json || typeof json !== 'object') return
    const obj = json as Record<string, unknown>
    if (obj.ok !== true) return

    setModelPlaceholderFromDiscovery({
      providers: obj.providers,
      localModelsSource: obj.localModelsSource,
    })

    const optionsRaw = obj.options
    if (!Array.isArray(optionsRaw)) return

    const options = optionsRaw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as { id?: unknown; label?: unknown }
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        const label = typeof record.label === 'string' ? record.label.trim() : ''
        if (!id) return null
        return { id, label }
      })
      .filter((x): x is { id: string; label: string } => x !== null)

    if (options.length === 0) {
      setDefaultModelPresets()
      restoreModelSelection(selection)
      return
    }

    setDefaultModelPresets()
    const seen = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
    for (const opt of options) {
      if (seen.has(opt.id)) continue
      seen.add(opt.id)
      const el = document.createElement('option')
      el.value = opt.id
      el.textContent = opt.label ? `${opt.id} — ${opt.label}` : opt.id
      modelPresetEl.append(el)
    }
    restoreModelSelection(selection)
  } catch {
    // ignore
  }
}

let modelRefreshAt = 0
const refreshModelsIfStale = () => {
  const now = Date.now()
  if (now - modelRefreshAt < 1500) return
  modelRefreshAt = now
  void (async () => {
    const token = (await loadSettings()).token
    await refreshModelPresets(token)
  })()
}

let refreshFreeRunning = false

async function runRefreshFree() {
  if (refreshFreeRunning) return
  const token = (await loadSettings()).token.trim()
  if (!token) {
    setModelStatus('Setup required (missing token).', 'error')
    return
  }
  refreshFreeRunning = true
  modelRefreshBtn.disabled = true
  setModelStatus('Starting scan…', 'running')

  try {
    const res = await fetch('http://127.0.0.1:8787/v1/refresh-free', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
    if (!res.ok || !json.ok || !json.id) {
      throw new Error(json.error || `${res.status} ${res.statusText}`)
    }

    const streamRes = await fetch(`http://127.0.0.1:8787/v1/refresh-free/${json.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`)
    if (!streamRes.body) throw new Error('Missing stream body')

    for await (const raw of parseSseStream(streamRes.body)) {
      const event = parseSseEvent(raw)
      if (!event) continue
      if (event.event === 'status') {
        const text = event.data.text.trim()
        if (text) setModelStatus(text, 'running')
      } else if (event.event === 'error') {
        throw new Error(event.data.message)
      } else if (event.event === 'done') {
        break
      }
    }

    setModelStatus('Free models updated.', 'ok')
    await refreshModelPresets(token)
  } catch (err) {
    setModelStatus(friendlyFetchError(err, 'Refresh free failed'), 'error')
  } finally {
    refreshFreeRunning = false
    modelRefreshBtn.disabled = false
  }
}

const streamController = createStreamController({
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    renderEl.innerHTML = ''
    clearMetricsForMode('summary')
    panelState.summaryMarkdown = null
    panelState.summaryFromCache = null
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
    lastStreamError = null
    resetChatState()
  },
  onStatus: (text) => headerController.setStatus(text),
  onBaseTitle: (text) => headerController.setBaseTitle(text),
  onBaseSubtitle: (text) => headerController.setBaseSubtitle(text),
  onPhaseChange: (phase) => {
    if (phase === 'error') {
      setPhase('error', { error: lastStreamError ?? panelState.error })
    } else {
      setPhase(phase)
    }
  },
  onRememberUrl: (url) => send({ type: 'panel:rememberUrl', url }),
  onMeta: (data) => {
    panelState.lastMeta = {
      model: typeof data.model === 'string' ? data.model : panelState.lastMeta.model,
      modelLabel:
        typeof data.modelLabel === 'string' ? data.modelLabel : panelState.lastMeta.modelLabel,
      inputSummary:
        typeof data.inputSummary === 'string'
          ? data.inputSummary
          : panelState.lastMeta.inputSummary,
    }
    headerController.setBaseSubtitle(
      buildIdleSubtitle({
        inputSummary: panelState.lastMeta.inputSummary,
        modelLabel: panelState.lastMeta.modelLabel,
        model: panelState.lastMeta.model,
      })
    )
  },
  onSummaryFromCache: (value) => {
    panelState.summaryFromCache = value
    if (value === true) {
      headerController.stopProgress()
    } else if (value === false && isStreaming()) {
      headerController.armProgress()
    }
  },
  onMetrics: (summary) => {
    setMetricsForMode(
      'summary',
      summary,
      panelState.lastMeta.inputSummary,
      panelState.currentSource?.url ?? null
    )
    setActiveMetricsMode('summary')
  },
  onRender: renderMarkdown,
  onSyncWithActiveTab: syncWithActiveTab,
  onError: (err) => {
    const message = friendlyFetchError(err, 'Stream failed')
    lastStreamError = message
    return message
  },
})

const chatStreamController = createStreamController({
  mode: 'chat',
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    clearMetricsForMode('chat')
    lastChatError = null
  },
  onStatus: (text) => headerController.setStatus(text),
  onPhaseChange: (phase) => {
    if (phase === 'error') {
      finishStreamingMessage()
      setPhase('error', { error: lastChatError ?? 'Chat failed.' })
    }
  },
  onMeta: () => {},
  onMetrics: (summary) => {
    setMetricsForMode('chat', summary, null, panelState.currentSource?.url ?? null)
  },
  onChunk: (content) => {
    updateStreamingMessage(content)
  },
  onDone: () => {
    finishStreamingMessage()
  },
  onError: (err) => {
    const message = friendlyFetchError(err, 'Chat stream failed')
    lastChatError = message
    return message
  },
})

async function ensureToken(): Promise<string> {
  const settings = await loadSettings()
  if (settings.token.trim()) return settings.token.trim()
  const token = generateToken()
  await patchSettings({ token })
  return token
}

function installStepsHtml({
  token,
  headline,
  message,
  showTroubleshooting,
}: {
  token: string
  headline: string
  message?: string
  showTroubleshooting?: boolean
}) {
  const npmCmd = 'npm i -g @steipete/summarize'
  const brewCmd = 'brew install steipete/tap/summarize'
  const daemonCmd = `summarize daemon install --token ${token}`
  const isMac = platformKind === 'mac'
  const isLinux = platformKind === 'linux'
  const isWindows = platformKind === 'windows'
  const isSupported = isMac || isLinux || isWindows
  const daemonLabel = isMac
    ? 'LaunchAgent'
    : isLinux
      ? 'systemd user service'
      : isWindows
        ? 'Scheduled Task'
        : 'daemon'

  const installToggle = isMac
    ? `
      <div class="setup__toggle" role="tablist" aria-label="Install method">
        <button class="setup__pill" type="button" data-install="npm" role="tab" aria-selected="false">NPM</button>
        <button class="setup__pill" type="button" data-install="brew" role="tab" aria-selected="false">Homebrew</button>
      </div>
    `
    : ''

  const installIntro = `
    <div class="setup__section">
      <div class="setup__headerRow">
        <p class="setup__title" data-install-title><strong>1) Install summarize</strong></p>
        ${installToggle}
      </div>
      <div class="setup__codeRow">
        <code data-install-code>${isMac ? brewCmd : npmCmd}</code>
        <button class="ghost icon setup__copy" type="button" data-copy="install" aria-label="Copy install command">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
          </svg>
        </button>
      </div>
      <p class="setup__hint" data-install-hint>${
        isMac
          ? 'Homebrew installs the daemon-ready binary (macOS arm64).'
          : 'Homebrew tap is macOS-only.'
      }</p>
    </div>
  `

  const daemonIntro = isSupported
    ? `
      <div class="setup__section">
        <p class="setup__title"><strong>2) Register the daemon (${daemonLabel})</strong></p>
        <div class="setup__codeRow">
          <code data-daemon-code>${daemonCmd}</code>
          <button class="ghost icon setup__copy" type="button" data-copy="daemon" aria-label="Copy daemon command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
      </div>
    `
    : `
      <div class="setup__section">
        <p class="setup__title"><strong>2) Daemon auto-start</strong></p>
        <p class="setup__hint">Not supported on this OS yet.</p>
      </div>
    `

  const troubleshooting =
    showTroubleshooting && isSupported
      ? `
      <div class="setup__section">
        <p class="setup__title"><strong>Troubleshooting</strong></p>
        <div class="setup__codeRow">
          <code>summarize daemon status</code>
          <button class="ghost icon setup__copy" type="button" data-copy="status" aria-label="Copy status command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">Shows daemon health, version, and token auth status.</p>
        <div class="setup__codeRow">
          <code>summarize daemon restart</code>
          <button class="ghost icon setup__copy" type="button" data-copy="restart" aria-label="Copy restart command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">Restarts the daemon if it’s stuck or not responding.</p>
      </div>
    `
      : ''

  return `
    <h2>${headline}</h2>
    ${message ? `<p>${message}</p>` : ''}
    ${installIntro}
    ${daemonIntro}
    <div class="setup__section setup__actions">
      <button id="regen" type="button" class="ghost">Regenerate Token</button>
    </div>
    ${troubleshooting}
  `
}

function wireSetupButtons({
  token,
  showTroubleshooting,
}: {
  token: string
  showTroubleshooting?: boolean
}) {
  const npmCmd = 'npm i -g @steipete/summarize'
  const brewCmd = 'brew install steipete/tap/summarize'
  const daemonCmd = `summarize daemon install --token ${token}`
  const isMac = platformKind === 'mac'
  const installMethodKey = 'summarize.installMethod'
  type InstallMethod = 'npm' | 'brew'
  const resolveInstallMethod = (): InstallMethod => {
    if (!isMac) return 'npm'
    try {
      const stored = localStorage.getItem(installMethodKey)
      if (stored === 'npm' || stored === 'brew') return stored
    } catch {
      // ignore
    }
    return 'brew'
  }
  const persistInstallMethod = (method: InstallMethod) => {
    if (!isMac) return
    try {
      localStorage.setItem(installMethodKey, method)
    } catch {
      // ignore
    }
  }

  const flashCopied = () => {
    headerController.setStatus('Copied')
    setTimeout(() => headerController.setStatus(panelState.ui?.status ?? ''), 800)
  }

  const installTitleEl = setupEl.querySelector<HTMLElement>('[data-install-title]')
  const installCodeEl = setupEl.querySelector<HTMLElement>('[data-install-code]')
  const installHintEl = setupEl.querySelector<HTMLElement>('[data-install-hint]')
  const installButtons = Array.from(setupEl.querySelectorAll<HTMLButtonElement>('[data-install]'))

  const applyInstallMethod = (method: InstallMethod) => {
    const label = method === 'brew' ? 'Homebrew' : 'NPM'
    if (installTitleEl) {
      installTitleEl.innerHTML = `<strong>1) Install summarize (${label})</strong>`
    }
    if (installCodeEl) {
      installCodeEl.textContent = method === 'brew' ? brewCmd : npmCmd
    }
    if (installHintEl) {
      if (!isMac) {
        installHintEl.textContent = 'Homebrew tap is macOS-only.'
      } else if (method === 'brew') {
        installHintEl.textContent = 'Homebrew installs the daemon-ready binary (macOS arm64).'
      } else {
        installHintEl.textContent = 'NPM installs the CLI (requires Node.js).'
      }
    }
    for (const button of installButtons) {
      const isActive = button.dataset.install === method
      button.classList.toggle('isActive', isActive)
      button.setAttribute('aria-selected', isActive ? 'true' : 'false')
    }
    persistInstallMethod(method)
  }

  const currentInstallMethod = resolveInstallMethod()
  applyInstallMethod(currentInstallMethod)

  for (const button of installButtons) {
    button.addEventListener('click', () => {
      const method = button.dataset.install === 'brew' ? 'brew' : 'npm'
      applyInstallMethod(method)
    })
  }

  setupEl.querySelectorAll<HTMLButtonElement>('[data-copy]')?.forEach((button) => {
    button.addEventListener('click', () => {
      void (async () => {
        const copyType = button.dataset.copy
        const installMethod = resolveInstallMethod()
        const payload =
          copyType === 'install'
            ? installMethod === 'brew'
              ? brewCmd
              : npmCmd
            : copyType === 'daemon'
              ? daemonCmd
              : copyType === 'status'
                ? 'summarize daemon status'
                : copyType === 'restart'
                  ? 'summarize daemon restart'
                  : ''
        if (!payload) return
        await navigator.clipboard.writeText(payload)
        flashCopied()
      })()
    })
  })

  setupEl.querySelector<HTMLButtonElement>('#regen')?.addEventListener('click', () => {
    void (async () => {
      const token2 = generateToken()
      await patchSettings({ token: token2 })
      renderSetup(token2)
    })()
  })

  if (!showTroubleshooting) return
}

function renderSetup(token: string) {
  setupEl.classList.remove('hidden')
  setupEl.innerHTML = installStepsHtml({
    token,
    headline: 'Setup',
    message: 'Install summarize, then register the daemon so the side panel can stream summaries.',
  })
  wireSetupButtons({ token })
}

function maybeShowSetup(state: UiState): boolean {
  if (!state.settings.tokenPresent) {
    void (async () => {
      const token = await ensureToken()
      renderSetup(token)
    })()
    return true
  }
  if (!state.daemon.ok || !state.daemon.authed) {
    setupEl.classList.remove('hidden')
    const token = (async () => (await loadSettings()).token.trim())()
    void token.then((t) => {
      setupEl.innerHTML = `
        ${installStepsHtml({
          token: t,
          headline: 'Daemon not reachable',
          message: state.daemon.error ?? 'Check that the LaunchAgent is installed.',
          showTroubleshooting: true,
        })}
      `
      wireSetupButtons({ token: t, showTroubleshooting: true })
    })
    return true
  }
  setupEl.classList.add('hidden')
  return false
}

function updateControls(state: UiState) {
  const nextTabId = state.tab.id ?? null
  const nextTabUrl = state.tab.url ?? null
  const tabChanged = nextTabId !== activeTabId
  const urlChanged =
    !tabChanged && nextTabUrl && activeTabUrl && !urlsMatch(nextTabUrl, activeTabUrl)

  if (tabChanged || urlChanged) {
    const previousTabId = activeTabId
    activeTabId = nextTabId
    activeTabUrl = nextTabUrl
    resetChatState()
    inputMode = 'page'
    if (!tabChanged && urlChanged) {
      void clearChatHistoryForTab(previousTabId)
    }
  }

  autoValue = state.settings.autoSummarize
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      send({ type: 'panel:setAuto', value: checked })
    },
  })
  chatEnabledValue = state.settings.chatEnabled
  applyChatEnabled()
  if (chatEnabledValue && activeTabId && chatController.getMessages().length === 0) {
    void restoreChatHistory()
  }
  if (pickerSettings.length !== state.settings.length) {
    pickerSettings = { ...pickerSettings, length: state.settings.length }
    lengthPicker.update({
      length: pickerSettings.length,
      onLengthChange: pickerHandlers.onLengthChange,
    })
  }
  if (readCurrentModelValue() !== state.settings.model) {
    setModelValue(state.settings.model)
  }
  modelRefreshBtn.disabled = !state.settings.tokenPresent || refreshFreeRunning
  if (panelState.currentSource) {
    if (state.tab.url && !urlsMatch(state.tab.url, panelState.currentSource.url)) {
      panelState.currentSource = null
      streamController.abort()
      resetSummaryView()
    } else if (state.tab.title && state.tab.title !== panelState.currentSource.title) {
      panelState.currentSource = { ...panelState.currentSource, title: state.tab.title }
      headerController.setBaseTitle(state.tab.title)
    }
  }
  if (!panelState.currentSource) {
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
    headerController.setBaseTitle(state.tab.title || state.tab.url || 'Summarize')
    headerController.setBaseSubtitle('')
  }
  if (!isStreaming() || state.status.trim().length > 0) {
    headerController.setStatus(state.status)
  }
  const nextMediaAvailable = Boolean(state.media && (state.media.hasVideo || state.media.hasAudio))
  const nextVideoLabel = state.media?.hasAudio && !state.media.hasVideo ? 'Audio' : 'Video'
  if (!nextMediaAvailable) {
    inputMode = 'page'
  }
  mediaAvailable = nextMediaAvailable
  summarizeControl.update({
    value: inputMode,
    mediaAvailable,
    videoLabel: nextVideoLabel,
    pageWords: state.stats.pageWords,
    videoDurationSeconds: state.stats.videoDurationSeconds,
    onValueChange: (value) => {
      inputMode = value
    },
    onSummarize: () => sendSummarize(),
  })
  const showingSetup = maybeShowSetup(state)
  if (showingSetup && panelState.phase !== 'setup') {
    setPhase('setup')
  } else if (!showingSetup && panelState.phase === 'setup') {
    setPhase('idle')
  }
}

function handleBgMessage(msg: BgToPanel) {
  switch (msg.type) {
    case 'ui:state':
      panelState.ui = msg.state
      updateControls(msg.state)
      return
    case 'ui:status':
      if (!isStreaming() || msg.status.trim().length > 0) {
        headerController.setStatus(msg.status)
      }
      return
    case 'run:error':
      headerController.setStatus(`Error: ${msg.message}`)
      setPhase('error', { error: msg.message })
      if (panelState.chatStreaming) {
        finishStreamingMessage()
      }
      return
    case 'run:start':
      lastAction = 'summarize'
      window.clearTimeout(autoKickTimer)
      if (panelState.chatStreaming) {
        chatStreamController.abort()
      }
      void clearChatHistoryForActiveTab()
      resetChatState()
      setActiveMetricsMode('summary')
      panelState.currentSource = { url: msg.run.url, title: msg.run.title }
      panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
      void streamController.start(msg.run)
      return
    case 'chat:start':
      lastAction = 'chat'
      if (!chatEnabledValue) return
      void chatStreamController.start({
        id: msg.payload.id,
        url: msg.payload.url,
        title: panelState.currentSource?.title || null,
        reason: 'chat',
      })
      return
  }
}

function scheduleAutoKick() {
  if (!autoValue) return
  window.clearTimeout(autoKickTimer)
  autoKickTimer = window.setTimeout(() => {
    if (!autoValue) return
    if (panelState.phase !== 'idle') return
    if (panelState.summaryMarkdown) return
    sendSummarize()
  }, 350)
}

function send(message: PanelToBg) {
  if (message.type === 'panel:summarize') {
    lastAction = 'summarize'
  } else if (message.type === 'panel:chat') {
    lastAction = 'chat'
  }
  void chrome.runtime.sendMessage(message).catch(() => {
    // ignore (panel/background race while reloading)
  })
}

function sendSummarize(opts?: { refresh?: boolean }) {
  send({
    type: 'panel:summarize',
    refresh: Boolean(opts?.refresh),
    inputMode: inputMode,
  })
}

function toggleDrawer(force?: boolean, opts?: { animate?: boolean }) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  const animate = opts?.animate !== false && !reducedMotion

  const isOpen = !drawerEl.classList.contains('hidden')
  const next = typeof force === 'boolean' ? force : !isOpen

  drawerToggleBtn.classList.toggle('isActive', next)
  drawerToggleBtn.setAttribute('aria-expanded', next ? 'true' : 'false')
  drawerEl.setAttribute('aria-hidden', next ? 'false' : 'true')

  if (next === isOpen) return

  const cleanup = () => {
    drawerEl.style.removeProperty('height')
    drawerEl.style.removeProperty('opacity')
    drawerEl.style.removeProperty('transform')
    drawerEl.style.removeProperty('overflow')
  }

  drawerAnimation?.cancel()
  drawerAnimation = null
  cleanup()

  if (!animate) {
    drawerEl.classList.toggle('hidden', !next)
    return
  }

  if (next) {
    drawerEl.classList.remove('hidden')
    const targetHeight = drawerEl.scrollHeight
    drawerEl.style.height = '0px'
    drawerEl.style.opacity = '0'
    drawerEl.style.transform = 'translateY(-6px)'
    drawerEl.style.overflow = 'hidden'

    drawerAnimation = drawerEl.animate(
      [
        { height: '0px', opacity: 0, transform: 'translateY(-6px)' },
        { height: `${targetHeight}px`, opacity: 1, transform: 'translateY(0px)' },
      ],
      { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    )
    drawerAnimation.onfinish = () => {
      drawerAnimation = null
      cleanup()
    }
    drawerAnimation.oncancel = () => {
      drawerAnimation = null
    }
    return
  }

  const currentHeight = drawerEl.getBoundingClientRect().height
  drawerEl.style.height = `${currentHeight}px`
  drawerEl.style.opacity = '1'
  drawerEl.style.transform = 'translateY(0px)'
  drawerEl.style.overflow = 'hidden'

  drawerAnimation = drawerEl.animate(
    [
      { height: `${currentHeight}px`, opacity: 1, transform: 'translateY(0px)' },
      { height: '0px', opacity: 0, transform: 'translateY(-6px)' },
    ],
    { duration: 180, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  )
  drawerAnimation.onfinish = () => {
    drawerAnimation = null
    drawerEl.classList.add('hidden')
    cleanup()
  }
  drawerAnimation.oncancel = () => {
    drawerAnimation = null
  }
}

function resetChatState() {
  if (panelState.chatStreaming) {
    chatStreamController.abort()
  }
  panelState.chatStreaming = false
  chatController.reset()
  clearQueuedMessages()
  chatJumpBtn.classList.remove('isVisible')
}

function updateStreamingMessage(content: string) {
  chatController.updateStreamingMessage(content)
}

function finishStreamingMessage() {
  panelState.chatStreaming = false
  chatSendBtn.disabled = false
  chatInputEl.focus()
  chatController.finishStreamingMessage()
  void persistChatHistory()
  maybeSendQueuedChat()
}

function startChatMessage(text: string) {
  const input = text.trim()
  if (!input || !chatEnabledValue) return

  clearError()

  chatController.addMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content: input,
    timestamp: Date.now(),
  })

  chatController.addMessage({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
  })

  panelState.chatStreaming = true
  scrollToBottom(true)
  lastAction = 'chat'

  send({
    type: 'panel:chat',
    messages: chatController.buildRequestMessages(),
    summary: panelState.summaryMarkdown,
  })
}

function maybeSendQueuedChat() {
  if (panelState.chatStreaming || !chatEnabledValue) return
  if (chatQueue.length === 0) {
    renderChatQueue()
    return
  }
  const next = chatQueue.shift()
  renderChatQueue()
  if (next) startChatMessage(next.text)
}

function retryChat() {
  if (!chatEnabledValue || panelState.chatStreaming) return
  const messages = chatController.getMessages()
  const hasUser = messages.some((msg) => msg.role === 'user' && msg.content.trim().length > 0)
  if (!hasUser) return

  clearError()
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content.trim().length > 0) {
    chatController.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    })
  } else {
    chatController.updateStreamingMessage('')
  }

  panelState.chatStreaming = true
  scrollToBottom(true)

  send({
    type: 'panel:chat',
    messages: chatController.buildRequestMessages(),
    summary: panelState.summaryMarkdown,
  })
}

function retryLastAction() {
  if (lastAction === 'chat') {
    retryChat()
    return
  }
  sendSummarize({ refresh: true })
}

function sendChatMessage() {
  if (!chatEnabledValue) return
  const rawInput = chatInputEl.value
  const input = rawInput.trim()
  if (!input) return

  chatInputEl.value = ''
  chatInputEl.style.height = 'auto'

  if (panelState.chatStreaming || chatQueue.length > 0) {
    const queued = enqueueChatMessage(input)
    if (!queued) {
      chatInputEl.value = rawInput
      chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`
    } else if (!panelState.chatStreaming) {
      maybeSendQueuedChat()
    }
    return
  }

  startChatMessage(input)
}

refreshBtn.addEventListener('click', () => sendSummarize({ refresh: true }))
errorRetryBtn.addEventListener('click', () => retryLastAction())
drawerToggleBtn.addEventListener('click', () => toggleDrawer())
advancedBtn.addEventListener('click', () => send({ type: 'panel:openOptions' }))

chatSendBtn.addEventListener('click', sendChatMessage)
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendChatMessage()
  }
})
chatInputEl.addEventListener('input', () => {
  chatInputEl.style.height = 'auto'
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`
})

sizeEl.addEventListener('input', () => {
  void (async () => {
    const next = await patchSettings({ fontSize: Number(sizeEl.value) })
    applyTypography(next.fontFamily, next.fontSize)
  })()
})

modelPresetEl.addEventListener('change', () => {
  modelCustomEl.hidden = modelPresetEl.value !== 'custom'
  if (!modelCustomEl.hidden) modelCustomEl.focus()
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() })
  })()
})

modelCustomEl.addEventListener('change', () => {
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() })
  })()
})

modelCustomEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  modelCustomEl.blur()
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() })
  })()
})

modelPresetEl.addEventListener('focus', refreshModelsIfStale)
modelPresetEl.addEventListener('pointerdown', refreshModelsIfStale)
modelCustomEl.addEventListener('focus', refreshModelsIfStale)
modelCustomEl.addEventListener('pointerdown', refreshModelsIfStale)
advancedSettingsEl.addEventListener('toggle', () => {
  if (advancedSettingsEl.open) refreshModelsIfStale()
})
modelRefreshBtn.addEventListener('click', () => {
  void runRefreshFree()
})

void (async () => {
  const s = await loadSettings()
  sizeEl.value = String(s.fontSize)
  autoValue = s.autoSummarize
  chatEnabledValue = s.chatEnabled
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      send({ type: 'panel:setAuto', value: checked })
    },
  })
  applyChatEnabled()
  pickerSettings = {
    scheme: s.colorScheme,
    mode: s.colorMode,
    fontFamily: s.fontFamily,
    length: s.length,
  }
  pickers.update({
    scheme: pickerSettings.scheme,
    mode: pickerSettings.mode,
    fontFamily: pickerSettings.fontFamily,
    onSchemeChange: pickerHandlers.onSchemeChange,
    onModeChange: pickerHandlers.onModeChange,
    onFontChange: pickerHandlers.onFontChange,
  })
  lengthPicker.update({
    length: pickerSettings.length,
    onLengthChange: pickerHandlers.onLengthChange,
  })
  setDefaultModelPresets()
  setModelValue(s.model)
  setModelPlaceholderFromDiscovery({})
  modelCustomEl.hidden = modelPresetEl.value !== 'custom'
  modelRefreshBtn.disabled = !s.token.trim()
  applyTypography(s.fontFamily, s.fontSize)
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode })
  toggleDrawer(false, { animate: false })
  chrome.runtime.onMessage.addListener((msg: BgToPanel) => {
    handleBgMessage(msg)
  })
  send({ type: 'panel:ready' })
  scheduleAutoKick()
})()

setInterval(() => {
  send({ type: 'panel:ping' })
}, 25_000)

let lastVisibility = document.visibilityState
let panelMarkedOpen = document.visibilityState === 'visible'

function markPanelOpen() {
  if (panelMarkedOpen) return
  panelMarkedOpen = true
  send({ type: 'panel:ready' })
  scheduleAutoKick()
  void syncWithActiveTab()
}

function markPanelClosed() {
  if (!panelMarkedOpen) return
  panelMarkedOpen = false
  window.clearTimeout(autoKickTimer)
  send({ type: 'panel:closed' })
}

document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible'
  const wasVisible = lastVisibility === 'visible'
  if (visible && !wasVisible) {
    markPanelOpen()
  } else if (!visible && wasVisible) {
    markPanelClosed()
  }
  lastVisibility = document.visibilityState
})

window.addEventListener('focus', () => {
  if (document.visibilityState !== 'visible') return
  markPanelOpen()
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.shiftKey) return
  const target = event.target as HTMLElement | null
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return
  }
  event.preventDefault()
  sendSummarize({ refresh: true })
})

window.addEventListener('beforeunload', () => {
  send({ type: 'panel:closed' })
})
