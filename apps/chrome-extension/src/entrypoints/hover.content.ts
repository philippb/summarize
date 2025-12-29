import { defineContentScript } from 'wxt/utils/define-content-script'

import { loadSettings, type Settings } from '../lib/settings'
import { parseSseStream } from '../lib/sse'
import { parseSseEvent } from '../../../../src/shared/sse-events.js'
import { mergeStreamingChunk } from '../../../../src/shared/streaming-merge.js'

type HoverCacheEntry = {
  summary: string
  updatedAt: number
}

const HOVER_DELAY_MS = 420
const CACHE_TTL_MS = 12 * 60 * 1000
const TOOLTIP_ID = '__summarize_hover_tooltip__'
const STYLE_ID = '__summarize_hover_tooltip_style__'

function isValidUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw)
}

function resolveUrl(anchor: HTMLAnchorElement): string | null {
  const raw = anchor.getAttribute('href')?.trim() ?? ''
  if (!raw) return null
  if (raw.startsWith('#')) return null
  if (raw.startsWith('javascript:')) return null
  if (raw.startsWith('mailto:')) return null
  if (raw.startsWith('tel:')) return null
  try {
    const url = new URL(raw, location.href)
    if (!isValidUrl(url.href)) return null
    return url.href
  } catch {
    return null
  }
}

function clampText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 2147483647;
      max-width: min(420px, 92vw);
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(18, 18, 18, 0.96);
      color: #f4f4f4;
      font: 12.5px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.2);
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px) scale(0.98);
      transition: opacity 120ms ease, transform 120ms ease;
    }

    #${TOOLTIP_ID}[data-visible="true"] {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    #${TOOLTIP_ID} .summary {
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    #${TOOLTIP_ID} .status {
      opacity: 0.7;
      font-style: italic;
    }
  `
  document.documentElement.append(style)
}

type Tooltip = {
  el: HTMLDivElement
  textEl: HTMLDivElement
}

function ensureTooltip(): Tooltip {
  ensureStyle()
  let el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (!el) {
    el = document.createElement('div')
    el.id = TOOLTIP_ID
    el.setAttribute('role', 'tooltip')
    const textEl = document.createElement('div')
    textEl.className = 'summary'
    el.append(textEl)
    document.documentElement.append(el)
    return { el, textEl }
  }
  const textEl = el.querySelector('.summary') as HTMLDivElement | null
  if (!textEl) {
    const nextText = document.createElement('div')
    nextText.className = 'summary'
    el.append(nextText)
    return { el, textEl: nextText }
  }
  return { el, textEl }
}

function positionTooltip(anchor: HTMLElement, tooltip: Tooltip) {
  const rect = anchor.getBoundingClientRect()
  const tooltipRect = tooltip.el.getBoundingClientRect()
  const margin = 10
  let top = rect.bottom + margin
  const fitsBelow = top + tooltipRect.height + margin <= window.innerHeight
  if (!fitsBelow) {
    top = rect.top - tooltipRect.height - margin
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin))

  let left = rect.left + rect.width / 2 - tooltipRect.width / 2
  left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin))

  tooltip.el.style.top = `${Math.round(top)}px`
  tooltip.el.style.left = `${Math.round(left)}px`
}

function showTooltip(anchor: HTMLElement, text: string, { status = false } = {}) {
  const tooltip = ensureTooltip()
  tooltip.textEl.textContent = text
  tooltip.textEl.classList.toggle('status', status)
  tooltip.el.dataset.visible = 'true'
  requestAnimationFrame(() => positionTooltip(anchor, tooltip))
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (!el) return
  delete el.dataset.visible
}

function isAnchorTarget(eventTarget: EventTarget | null): HTMLAnchorElement | null {
  if (!(eventTarget instanceof Element)) return null
  return eventTarget.closest('a[href]')
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_hover_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    let settings: Settings | null = null
    let settingsLoaded = false
    const refreshSettings = async () => {
      settings = await loadSettings()
      settingsLoaded = true
    }
    void refreshSettings()
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (!changes.settings) return
      void refreshSettings()
    })

    const cache = new Map<string, HoverCacheEntry>()
    let hoverTimer: number | null = null
    let activeAnchor: HTMLAnchorElement | null = null
    let activeUrl = ''
    let abortController: AbortController | null = null
    let renderQueued = 0
    let cachedScrollHandler = 0

    const clearHoverTimer = () => {
      if (hoverTimer == null) return
      window.clearTimeout(hoverTimer)
      hoverTimer = null
    }

    const abortActive = () => {
      if (abortController) {
        abortController.abort()
        abortController = null
      }
    }

    const clearActive = () => {
      clearHoverTimer()
      abortActive()
      activeAnchor = null
      activeUrl = ''
      hideTooltip()
    }

    const scheduleReposition = () => {
      if (!activeAnchor) return
      if (renderQueued) return
      renderQueued = window.requestAnimationFrame(() => {
        renderQueued = 0
        if (!activeAnchor) return
        const tooltip = ensureTooltip()
        positionTooltip(activeAnchor, tooltip)
      })
    }

    const ensureScrollHandler = () => {
      if (cachedScrollHandler) return
      cachedScrollHandler = 1
      window.addEventListener('scroll', scheduleReposition, { passive: true })
      window.addEventListener('resize', scheduleReposition)
    }

    const scheduleHover = (anchor: HTMLAnchorElement) => {
      clearHoverTimer()
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null
        void handleHover(anchor)
      }, HOVER_DELAY_MS)
    }

    const handleHover = async (anchor: HTMLAnchorElement) => {
      if (!settingsLoaded) await refreshSettings()
      if (!settings?.hoverSummaries) return
      const url = resolveUrl(anchor)
      if (!url) return
      if (!settings.token.trim()) return

      activeAnchor = anchor
      activeUrl = url
      ensureScrollHandler()

      const cached = cache.get(url)
      if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
        showTooltip(anchor, cached.summary)
        return
      }

      showTooltip(anchor, 'Summarizing...', { status: true })

      abortActive()
      const controller = new AbortController()
      abortController = controller
      const token = settings.token.trim()
      const model = settings.model
      const language = settings.language

      try {
        const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url,
            title: anchor.textContent?.trim() || null,
            text: '',
            truncated: false,
            model,
            length: 'short',
            language,
            prompt: 'Summarize the linked page concisely. Best effort to keep it short.',
            mode: 'url',
            maxCharacters: settings.maxChars,
          }),
          signal: controller.signal,
        })

        const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
        if (!res.ok || !json?.ok || !json.id) {
          throw new Error(json?.error || `${res.status} ${res.statusText}`)
        }

        const streamRes = await fetch(
          `http://127.0.0.1:8787/v1/summarize/${json.id}/events`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          }
        )
        if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`)
        if (!streamRes.body) throw new Error('Missing stream body')

        let summary = ''
        for await (const msg of parseSseStream(streamRes.body)) {
          if (controller.signal.aborted) return
          if (!activeAnchor || activeUrl !== url) return
          const event = parseSseEvent(msg)
          if (!event) continue
          if (event.event === 'chunk') {
            const merged = mergeStreamingChunk(summary, event.data.text)
            summary = merged.next
            const cleaned = clampText(summary)
            if (cleaned) {
              showTooltip(anchor, cleaned)
            }
          } else if (event.event === 'error') {
            throw new Error(event.data.message)
          } else if (event.event === 'done') {
            break
          }
        }

        const finalText = clampText(summary)
        if (finalText) {
          cache.set(url, { summary: finalText, updatedAt: Date.now() })
          showTooltip(anchor, finalText)
        } else {
          showTooltip(anchor, 'No summary returned.', { status: true })
        }
      } catch (error) {
        if (!controller.signal.aborted && activeAnchor && activeUrl === url) {
          const message = error instanceof Error ? error.message : 'Summary failed'
          showTooltip(anchor, message, { status: true })
        }
      }
    }

    document.addEventListener('pointerover', (event) => {
      if (!(event instanceof PointerEvent)) return
      const anchor = isAnchorTarget(event.target)
      if (!anchor) return
      if (activeAnchor === anchor) return
      clearActive()
      scheduleHover(anchor)
    })

    document.addEventListener('pointerout', (event) => {
      if (!(event instanceof PointerEvent)) return
      if (!activeAnchor) return
      if (event.relatedTarget && activeAnchor.contains(event.relatedTarget as Node)) return
      clearActive()
    })

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') clearActive()
    })
  },
})
