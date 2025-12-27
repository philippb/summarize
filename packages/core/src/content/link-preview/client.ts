import type { TranscriptCache } from '../cache/types.js'
import { fetchLinkContent } from './content/index.js'
import type { ExtractedLinkContent, FetchLinkContentOptions } from './content/types.js'
import type {
  ConvertHtmlToMarkdown,
  LinkPreviewDeps,
  LinkPreviewProgressEvent,
  ResolveTwitterCookies,
  ScrapeWithFirecrawl,
} from './deps.js'

/** Public client used by external consumers to fetch link content. */
export interface LinkPreviewClient {
  fetchLinkContent(url: string, options?: FetchLinkContentOptions): Promise<ExtractedLinkContent>
}

/** Public options for wiring dependencies into the link preview client. */
export interface LinkPreviewClientOptions {
  fetch?: typeof fetch
  scrapeWithFirecrawl?: ScrapeWithFirecrawl | null
  apifyApiToken?: string | null
  ytDlpPath?: string | null
  falApiKey?: string | null
  openaiApiKey?: string | null
  convertHtmlToMarkdown?: ConvertHtmlToMarkdown | null
  transcriptCache?: TranscriptCache | null
  readTweetWithBird?: LinkPreviewDeps['readTweetWithBird']
  resolveTwitterCookies?: ResolveTwitterCookies | null
  onProgress?: ((event: LinkPreviewProgressEvent) => void) | null
}

/** Public factory for a link preview client with injectable dependencies. */
export function createLinkPreviewClient(options: LinkPreviewClientOptions = {}): LinkPreviewClient {
  const fetchImpl: typeof fetch =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const scrape: ScrapeWithFirecrawl | null = options.scrapeWithFirecrawl ?? null
  const apifyApiToken = typeof options.apifyApiToken === 'string' ? options.apifyApiToken : null
  const ytDlpPath = typeof options.ytDlpPath === 'string' ? options.ytDlpPath : null
  const falApiKey = typeof options.falApiKey === 'string' ? options.falApiKey : null
  const openaiApiKey = typeof options.openaiApiKey === 'string' ? options.openaiApiKey : null
  const convertHtmlToMarkdown: ConvertHtmlToMarkdown | null = options.convertHtmlToMarkdown ?? null
  const transcriptCache: TranscriptCache | null = options.transcriptCache ?? null
  const readTweetWithBird =
    typeof options.readTweetWithBird === 'function' ? options.readTweetWithBird : null
  const resolveTwitterCookies =
    typeof options.resolveTwitterCookies === 'function' ? options.resolveTwitterCookies : null
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  return {
    fetchLinkContent: (url: string, contentOptions?: FetchLinkContentOptions) =>
      fetchLinkContent(url, contentOptions, {
        fetch: fetchImpl,
        scrapeWithFirecrawl: scrape,
        apifyApiToken,
        ytDlpPath,
        falApiKey,
        openaiApiKey,
        convertHtmlToMarkdown,
        transcriptCache,
        readTweetWithBird,
        resolveTwitterCookies,
        onProgress,
      }),
  }
}
