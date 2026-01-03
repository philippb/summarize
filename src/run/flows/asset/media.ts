/**
 * Media file transcription handler for local audio files.
 * Phase 2: Transcript provider integration
 * Phase 2.2: Local file path handling for transcript caching
 */

import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLinkPreviewClient, type ExtractedLinkContent } from '../../../content/index.js'
import { createFirecrawlScraper } from '../../../firecrawl.js'
import { resolveTwitterCookies } from '../../cookies/twitter.js'
import { hasBirdCli } from '../../env.js'
import { readTweetWithBird } from '../../bird.js'
import type { AssetAttachment } from '../../attachments.js'
import { writeVerbose } from '../../logging.js'
import type { AssetSummaryContext, SummarizeAssetArgs } from './summary.js'

/**
 * Get file modification time for cache invalidation support.
 * Returns null if the path is not a local file or file doesn't exist.
 */
function getFileModificationTime(filePath: string): number | null {
  // Only support absolute local file paths
  if (!isAbsolute(filePath)) {
    return null
  }
  try {
    const stats = statSync(filePath)
    return stats.mtimeMs ?? null
  } catch {
    // File doesn't exist or can't be accessed
    return null
  }
}

/**
 * Handler for local audio files.
 *
 * Phase 2 Implementation:
 * 1. Validates transcription provider availability
 * 2. Creates LinkPreviewClient with necessary dependencies
 * 3. Calls client.fetchLinkContent to trigger transcription
 * 4. Converts transcript text to AssetAttachment
 * 5. Calls summarizeAsset with the transcript
 *
 * Phase 2.2 Enhancement:
 * - Captures file modification time for cache invalidation
 * - Passes fileMtime to transcript cache for local file support
 */
export async function summarizeMediaFile(
  ctx: AssetSummaryContext,
  args: SummarizeAssetArgs
): Promise<void> {
  // Get file modification time for cache invalidation
  const fileMtime = getFileModificationTime(args.sourceLabel)

  // Check if basic transcription setup is available
  const openaiKey = ctx.env.OPENAI_API_KEY
  const falKey = ctx.env.FAL_KEY
  const ytDlpPath = ctx.env.YT_DLP_PATH
  const hasLocalWhisper = ctx.env.SUMMARIZE_WHISPER_CPP_BINARY

  const hasAnyTranscriptionProvider = openaiKey || falKey || hasLocalWhisper

  if (!hasAnyTranscriptionProvider) {
    throw new Error(
      'Audio file transcription requires one of the following:\n\n' +
        '1. OpenAI Whisper:\n' +
        '   Set OPENAI_API_KEY=sk-...\n\n' +
        '2. FAL Whisper:\n' +
        '   Set FAL_KEY=...\n\n' +
        '3. Local whisper.cpp (recommended, free):\n' +
        '   brew install ggerganov/ggerganov/whisper-cpp\n' +
        '   Set SUMMARIZE_WHISPER_CPP_BINARY=/path/to/whisper-cli\n\n' +
        'See: https://github.com/openai/whisper for setup details'
    )
  }

  const absolutePath = resolvePath(args.sourceLabel)

  // Create Firecrawl scraper if configured
  const firecrawlScraper =
    ctx.apiStatus.firecrawlConfigured && ctx.env.FIRECRAWL_API_KEY
      ? createFirecrawlScraper({
          apiKey: ctx.env.FIRECRAWL_API_KEY,
          fetchImpl: ctx.trackedFetch,
        })
      : null

  // Create reader for bird tweets (for completeness, not used for audio)
  const readTweetWithBirdClient = hasBirdCli(ctx.env)
    ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
        readTweetWithBird({ url, timeoutMs, env: ctx.env })
    : null

  // Create link preview client for transcript resolution
  const client = createLinkPreviewClient({
    apifyApiToken: ctx.apiStatus.apifyToken,
    ytDlpPath: ytDlpPath,
    falApiKey: falKey,
    openaiApiKey: openaiKey,
    scrapeWithFirecrawl: firecrawlScraper,
    convertHtmlToMarkdown: null, // Not needed for audio
    readTweetWithBird: readTweetWithBirdClient,
    resolveTwitterCookies: async (_args) => {
      const res = await resolveTwitterCookies({ env: ctx.env })
      return {
        cookiesFromBrowser: res.cookies.cookiesFromBrowser,
        source: res.cookies.source,
        warnings: res.warnings,
      }
    },
    fetch: ctx.trackedFetch,
    transcriptCache:
      ctx.cache.mode === 'default' ? (ctx.cache.store?.transcriptCache ?? null) : null,
    onProgress: (_event) => {
      // Could update progress here if needed
      // For now, silent transcription
    },
  })

  try {
    // Convert local file path to file:// URL for transcript resolution
    // This is required because the generic transcript provider passes the URL to yt-dlp,
    // which needs a proper file:// URL to handle local files
    const fileUrl = pathToFileURL(absolutePath).href

    // Fetch the link content (will trigger transcription for media)
    // Using file:// URL ensures the provider chain can handle local files properly
    const extracted: ExtractedLinkContent = await client.fetchLinkContent(fileUrl, {
      cacheMode: 'default',
      youtubeTranscript: 'auto', // Not used for local files, but set for completeness
      mediaTranscript: 'prefer', // Prefer transcription for audio files
      transcriptTimestamps: false,
      fileMtime, // Include file modification time for cache invalidation
    })

    // Check if we got a transcript
    if (!extracted.content || extracted.content.trim().length === 0) {
      throw new Error(
        'Failed to transcribe audio file. ' +
          'Check that:\n' +
          '  - Audio format is supported (MP3, WAV, M4A, OGG, FLAC)\n' +
          '  - Transcription provider is configured\n' +
          '  - File is readable\n' +
          '  - Audio is not corrupted'
      )
    }

    // Create a text-based attachment from the transcript
    const filename = args.sourceLabel.split('/').pop() ?? 'audio'
    const transcriptAttachment: AssetAttachment = {
      mediaType: 'text/plain',
      filename: `${filename}.transcript.txt`,
      kind: 'file',
      bytes: new TextEncoder().encode(extracted.content),
    }

    writeVerbose(
      ctx.stdout,
      false,
      `transcription done audio file: ${extracted.diagnostics?.transcript?.provider ?? 'unknown'}`,
      false
    )

    // Call the standard asset summarization with the transcript
    const { summarizeAsset } = await import('./summary.js')
    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: `${args.sourceLabel} (transcript)`,
      attachment: transcriptAttachment,
      onModelChosen: args.onModelChosen,
    })
  } catch (error) {
    // Re-throw with better context for transcription errors
    if (error instanceof Error && error.message.includes('transcribe')) {
      throw error
    }
    throw new Error(
      `Transcription failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
