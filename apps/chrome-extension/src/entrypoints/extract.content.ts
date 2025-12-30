import { Readability } from '@mozilla/readability'
import { defineContentScript } from 'wxt/utils/define-content-script'

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

function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const sliced = text.slice(0, Math.max(0, maxChars - 24))
  return { text: `${sliced}\n\n[TRUNCATED]`, truncated: true }
}

function parseClockDuration(value: string): number | null {
  const parts = value
    .trim()
    .split(':')
    .map((part) => Number.parseInt(part.trim(), 10))
  if (parts.some((part) => !Number.isFinite(part))) return null
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    return minutes * 60 + seconds
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return hours * 3600 + minutes * 60 + seconds
  }
  return null
}

function parseIsoDuration(value: string): number | null {
  const match = value.trim().match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i)
  if (!match) return null
  const hours = Number.parseInt(match[1] ?? '0', 10)
  const minutes = Number.parseInt(match[2] ?? '0', 10)
  const seconds = Number.parseInt(match[3] ?? '0', 10)
  if (![hours, minutes, seconds].every((part) => Number.isFinite(part))) return null
  const total = hours * 3600 + minutes * 60 + seconds
  return total > 0 ? total : null
}

function resolveMediaDurationSeconds(): number | null {
  const metaDuration = document
    .querySelector('meta[itemprop="duration"]')
    ?.getAttribute('content')
  if (metaDuration) {
    const parsed = parseIsoDuration(metaDuration)
    if (parsed) return parsed
  }

  const uiDuration = document.querySelector('.ytp-time-duration')?.textContent?.trim()
  if (uiDuration) {
    const parsed = parseClockDuration(uiDuration)
    if (parsed) return parsed
  }

  const media = document.querySelector('video')
  if (media && typeof (media as HTMLVideoElement).duration === 'number') {
    const duration = (media as HTMLVideoElement).duration
    if (Number.isFinite(duration) && duration > 0) {
      return Math.round(duration)
    }
  }

  return null
}

function extract(maxChars: number): ExtractResponse {
  try {
    const url = location.href
    const title = document.title || null
    const mediaDurationSeconds = resolveMediaDurationSeconds()
    const cloned = document.cloneNode(true) as Document
    const reader = new Readability(cloned, { keepClasses: false })
    const parsed = reader.parse()
    const raw = parsed?.textContent?.trim() || document.body?.innerText?.trim() || ''
    if (!raw) {
      if (mediaDurationSeconds) {
        return { ok: true, url, title, text: '', truncated: false, mediaDurationSeconds }
      }
      return { ok: false, error: 'No readable text found.' }
    }
    const clamped = clampText(raw, maxChars)
    return {
      ok: true,
      url,
      title: parsed?.title?.trim() || title,
      text: clamped.text,
      truncated: clamped.truncated,
      mediaDurationSeconds,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Extraction failed' }
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_extract_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    chrome.runtime.onMessage.addListener(
      (message: ExtractRequest, _sender, sendResponse: (response: ExtractResponse) => void) => {
        if (message?.type !== 'extract') return
        sendResponse(extract(message.maxChars))
        return true
      }
    )
  },
})
