import { type LinkPreviewProgressEvent, ProgressKind } from '@steipete/summarize-core/content'

export function formatProgress(event: LinkPreviewProgressEvent): string | null {
  switch (event.kind) {
    case ProgressKind.FetchHtmlStart:
      return 'Fetching…'
    case ProgressKind.FirecrawlStart:
      return `Firecrawl… (${event.reason})`
    case ProgressKind.FirecrawlDone:
      return event.ok ? 'Firecrawl: done' : 'Firecrawl: failed'
    case ProgressKind.TranscriptStart:
      return event.hint?.trim() ? event.hint.trim() : 'Transcript…'
    case ProgressKind.TranscriptMediaDownloadStart:
      return `${event.service}: downloading audio…`
    case ProgressKind.TranscriptMediaDownloadProgress:
      return `${event.service}: downloading audio…`
    case ProgressKind.TranscriptWhisperStart:
      return `${event.service}: transcribing…`
    case ProgressKind.TranscriptWhisperProgress:
      return `${event.service}: transcribing…`
    case ProgressKind.TranscriptDone:
      return event.ok
        ? `${event.service}: transcript ready`
        : `${event.service}: transcript unavailable`
    case ProgressKind.BirdStart:
      return 'X: extracting tweet (bird)…'
    case ProgressKind.BirdDone:
      return event.ok ? 'X: extracted tweet' : 'X: extract failed'
    case ProgressKind.NitterStart:
      return 'X: extracting tweet (nitter)…'
    case ProgressKind.NitterDone:
      return event.ok ? 'X: extracted tweet' : 'X: extract failed'
    default:
      return null
  }
}
