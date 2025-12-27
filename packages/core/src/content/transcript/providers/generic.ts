import { isWhisperCppReady } from '../../../transcription/whisper.js'
import { isTwitterStatusUrl } from '../../link-preview/content/twitter-utils.js'
import { normalizeTranscriptText } from '../normalize.js'
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from '../types.js'

export const canHandle = (): boolean => true

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult['attemptedProviders'] = []
  const notes: string[] = []

  if (!isTwitterStatusUrl(context.url)) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', reason: 'not_implemented' },
    }
  }

  if (!options.ytDlpPath) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', kind: 'twitter', reason: 'missing_yt_dlp' },
      notes: 'yt-dlp is not configured (set YT_DLP_PATH or ensure yt-dlp is on PATH)',
    }
  }

  const hasTranscriptionKeys = Boolean(options.openaiApiKey || options.falApiKey)
  const hasLocalWhisper = await isWhisperCppReady()
  if (!hasTranscriptionKeys && !hasLocalWhisper) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'generic', kind: 'twitter', reason: 'missing_transcription_keys' },
      notes: 'Missing transcription provider (install whisper-cpp or set OPENAI_API_KEY/FAL_KEY)',
    }
  }

  attemptedProviders.push('yt-dlp')

  const resolved = options.resolveTwitterCookies
    ? await options.resolveTwitterCookies({ url: context.url })
    : null
  if (resolved?.warnings?.length) notes.push(...resolved.warnings)

  const extraArgs: string[] = []
  if (resolved?.cookiesFromBrowser) {
    extraArgs.push('--cookies-from-browser', resolved.cookiesFromBrowser)
    if (resolved.source) notes.push(`Using X cookies from ${resolved.source}`)
  }

  const mod = await import('./youtube/yt-dlp.js')
  const ytdlpResult = await mod.fetchTranscriptWithYtDlp({
    ytDlpPath: options.ytDlpPath,
    openaiApiKey: options.openaiApiKey,
    falApiKey: options.falApiKey,
    url: context.url,
    onProgress: options.onProgress ?? null,
    service: 'generic',
    extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
  })
  if (ytdlpResult.notes.length > 0) {
    notes.push(...ytdlpResult.notes)
  }

  if (ytdlpResult.text) {
    return {
      text: normalizeTranscriptText(ytdlpResult.text),
      source: 'yt-dlp',
      attemptedProviders,
      metadata: {
        provider: 'generic',
        kind: 'twitter',
        transcriptionProvider: ytdlpResult.provider,
        cookieSource: resolved?.source ?? null,
      },
      notes: notes.length > 0 ? notes.join('; ') : null,
    }
  }

  if (ytdlpResult.error) {
    notes.push(`yt-dlp transcription failed: ${ytdlpResult.error.message}`)
  }

  return {
    text: null,
    source: null,
    attemptedProviders,
    metadata: {
      provider: 'generic',
      kind: 'twitter',
      reason: ytdlpResult.error ? 'yt_dlp_failed' : 'no_transcript',
      transcriptionProvider: ytdlpResult.provider,
    },
    notes: notes.length > 0 ? notes.join('; ') : null,
  }
}
