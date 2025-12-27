import { Readability } from '@mozilla/readability'
import { defineContentScript } from 'wxt/utils/define-content-script'

type ExtractRequest = { type: 'extract'; maxChars: number }
type ExtractResponse =
  | { ok: true; url: string; title: string | null; text: string; truncated: boolean }
  | { ok: false; error: string }

function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const sliced = text.slice(0, Math.max(0, maxChars - 24))
  return { text: `${sliced}\n\n[TRUNCATED]`, truncated: true }
}

function extract(maxChars: number): ExtractResponse {
  try {
    const url = location.href
    const title = document.title || null
    const cloned = document.cloneNode(true) as Document
    const reader = new Readability(cloned, { keepClasses: false })
    const parsed = reader.parse()
    const raw = parsed?.textContent?.trim() || document.body?.innerText?.trim() || ''
    if (!raw) return { ok: false, error: 'No readable text found.' }
    const clamped = clampText(raw, maxChars)
    return {
      ok: true,
      url,
      title: parsed?.title?.trim() || title,
      text: clamped.text,
      truncated: clamped.truncated,
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
