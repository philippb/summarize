import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isFfmpegAvailable,
  isWhisperCppReady,
  MAX_OPENAI_UPLOAD_BYTES,
  probeMediaDurationSecondsWithFfprobe,
  transcribeMediaFileWithWhisper,
  transcribeMediaWithWhisper,
} from '../../../../transcription/whisper.js'
import type { ProviderContext, ProviderFetchOptions, ProviderResult } from '../types.js'

const FEED_HINT_URL_PATTERN = /rss|feed|podcast|\.xml($|[?#])/i
const PODCAST_PLATFORM_HOST_PATTERN =
  /open\.spotify\.com|spotify\.com|podcasts\.apple\.com|overcast\.fm|pca\.st|pod\.link|castbox\.fm|player\.fm/i
const TRANSCRIPTION_TIMEOUT_MS = 600_000
const MAX_REMOTE_MEDIA_BYTES = 512 * 1024 * 1024
const BLOCKED_HTML_HINT_PATTERN =
  /access denied|attention required|captcha|recaptcha|cloudflare|forbidden|verify you are human/i
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'
const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup'

type JsonRecord = Record<string, unknown>

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getJsonPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isJsonRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function getJsonString(value: unknown, path: readonly string[]): string | null {
  const found = getJsonPath(value, path)
  return typeof found === 'string' ? found : null
}

function getJsonNumber(value: unknown, path: readonly string[]): number | null {
  const found = getJsonPath(value, path)
  return typeof found === 'number' && Number.isFinite(found) ? found : null
}

function getJsonArray(value: unknown, path: readonly string[]): unknown[] {
  const found = getJsonPath(value, path)
  return Array.isArray(found) ? found : []
}

function asRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is JsonRecord => isJsonRecord(v))
}

function getRecordString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

export const canHandle = ({ url, html }: ProviderContext): boolean => {
  if (typeof html === 'string' && looksLikeRssOrAtomFeed(html)) return true
  if (PODCAST_PLATFORM_HOST_PATTERN.test(url)) return true
  return FEED_HINT_URL_PATTERN.test(url)
}

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: ProviderResult['attemptedProviders'] = []
  const notes: string[] = []

  const hasTranscriptionKeys = Boolean(options.openaiApiKey || options.falApiKey)
  const hasLocalWhisper = await isWhisperCppReady()
  if (!hasTranscriptionKeys && !hasLocalWhisper) {
    return {
      text: null,
      source: null,
      attemptedProviders,
      metadata: { provider: 'podcast', reason: 'missing_transcription_keys' },
      notes: 'Missing transcription provider (install whisper-cpp or set OPENAI_API_KEY/FAL_KEY)',
    }
  }

  const spotifyEpisodeId = extractSpotifyEpisodeId(context.url)
  if (spotifyEpisodeId) {
    attemptedProviders.push('whisper')
    try {
      // Spotify episode pages frequently trigger bot protection (captcha/recaptcha) and the
      // episode audio itself is sometimes DRM-protected. So we:
      // - fetch the lightweight embed page for stable metadata (__NEXT_DATA__),
      // - first try the embed-provided audio URL (works for many episodes),
      // - then fall back to resolving the publisher RSS feed via Apple’s iTunes directory.
      const embedUrl = `https://open.spotify.com/embed/episode/${spotifyEpisodeId}`
      const { html: embedHtml, via } = await fetchSpotifyEmbedHtml({
        embedUrl,
        episodeId: spotifyEpisodeId,
        fetchImpl: options.fetch,
        scrapeWithFirecrawl: options.scrapeWithFirecrawl ?? null,
      })

      const embedData = extractSpotifyEmbedData(embedHtml)
      if (!embedData) {
        throw new Error('Spotify embed data not found (missing __NEXT_DATA__)')
      }
      const showTitle = embedData.showTitle
      const episodeTitle = embedData.episodeTitle
      const embedAudioUrl = embedData.audioUrl
      const embedDurationSeconds = embedData.durationSeconds

      if (embedAudioUrl) {
        const result = await transcribeMediaUrl({
          fetchImpl: options.fetch,
          url: embedAudioUrl,
          filenameHint: 'episode.mp4',
          durationSecondsHint: embedDurationSeconds,
          openaiApiKey: options.openaiApiKey,
          falApiKey: options.falApiKey,
          notes,
          progress: {
            url: context.url,
            service: 'podcast',
            onProgress: options.onProgress ?? null,
          },
        })
        if (result.text) {
          notes.push(
            via === 'firecrawl'
              ? 'Resolved Spotify embed audio via Firecrawl'
              : 'Resolved Spotify embed audio'
          )
          return {
            text: result.text,
            source: 'whisper',
            attemptedProviders,
            notes: notes.length > 0 ? notes.join('; ') : null,
            metadata: {
              provider: 'podcast',
              kind: 'spotify_embed_audio',
              episodeId: spotifyEpisodeId,
              showTitle,
              episodeTitle,
              audioUrl: embedAudioUrl,
              durationSeconds: embedDurationSeconds,
              drmFormat: embedData.drmFormat,
              transcriptionProvider: result.provider,
            },
          }
        }
        notes.push(
          `Spotify embed audio transcription failed; falling back to iTunes RSS: ${result.error?.message ?? 'unknown error'}`
        )
      }

      const feedUrl = await resolvePodcastFeedUrlFromItunesSearch(options.fetch, showTitle)
      if (!feedUrl) {
        throw new Error(
          `Spotify episode audio appears DRM-protected; could not resolve RSS feed via iTunes Search API for show "${showTitle}"`
        )
      }

      const feedResponse = await options.fetch(feedUrl, {
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      })
      if (!feedResponse.ok) {
        throw new Error(`Podcast feed fetch failed (${feedResponse.status})`)
      }
      const feedXml = await feedResponse.text()
      const match = extractEnclosureForEpisode(feedXml, episodeTitle)
      if (!match) {
        throw new Error(`Episode enclosure not found in RSS feed for "${episodeTitle}"`)
      }
      const enclosureUrl = decodeXmlEntities(match.enclosureUrl)
      const durationSeconds = match.durationSeconds

      notes.push(
        via === 'firecrawl'
          ? 'Resolved Spotify episode via Firecrawl embed + iTunes RSS'
          : 'Resolved Spotify episode via iTunes RSS'
      )
      const result = await transcribeMediaUrl({
        fetchImpl: options.fetch,
        url: enclosureUrl,
        filenameHint: 'episode.mp3',
        durationSecondsHint: durationSeconds,
        openaiApiKey: options.openaiApiKey,
        falApiKey: options.falApiKey,
        notes,
        progress: { url: context.url, service: 'podcast', onProgress: options.onProgress ?? null },
      })
      if (result.text) {
        return {
          text: result.text,
          source: 'whisper',
          attemptedProviders,
          notes: notes.length > 0 ? notes.join('; ') : null,
          metadata: {
            provider: 'podcast',
            kind: 'spotify_itunes_rss_enclosure',
            episodeId: spotifyEpisodeId,
            showTitle,
            episodeTitle,
            feedUrl,
            enclosureUrl,
            durationSeconds,
            transcriptionProvider: result.provider,
          },
        }
      }
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: result.error?.message ?? null,
        metadata: {
          provider: 'podcast',
          kind: 'spotify_itunes_rss_enclosure',
          episodeId: spotifyEpisodeId,
          showTitle,
          episodeTitle,
          feedUrl,
          enclosureUrl,
          durationSeconds,
        },
      }
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `Spotify episode fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          provider: 'podcast',
          kind: 'spotify_itunes_rss_enclosure',
          episodeId: spotifyEpisodeId,
        },
      }
    }
  }

  // Prefer embedded Apple Podcasts JSON when we have HTML (tests + legacy behavior).
  // Only hit the iTunes lookup API when we don't have HTML (Apple Podcasts short-circuit).
  const appleIds = typeof context.html !== 'string' ? extractApplePodcastIds(context.url) : null
  if (appleIds) {
    attemptedProviders.push('whisper')
    try {
      const episode = await resolveApplePodcastEpisodeFromItunesLookup({
        fetchImpl: options.fetch,
        showId: appleIds.showId,
        episodeId: appleIds.episodeId,
      })
      if (!episode) {
        throw new Error('iTunes lookup did not return an episodeUrl')
      }

      const result = await transcribeMediaUrl({
        fetchImpl: options.fetch,
        url: episode.episodeUrl,
        filenameHint: episode.fileExtension ? `episode.${episode.fileExtension}` : 'episode.mp3',
        durationSecondsHint: episode.durationSeconds,
        openaiApiKey: options.openaiApiKey,
        falApiKey: options.falApiKey,
        notes,
        progress: { url: context.url, service: 'podcast', onProgress: options.onProgress ?? null },
      })

      if (result.text) {
        notes.push('Resolved Apple Podcasts episode via iTunes lookup')
        return {
          text: result.text,
          source: 'whisper',
          attemptedProviders,
          notes: notes.length > 0 ? notes.join('; ') : null,
          metadata: {
            provider: 'podcast',
            kind: 'apple_itunes_episode',
            showId: appleIds.showId,
            episodeId: appleIds.episodeId,
            episodeUrl: episode.episodeUrl,
            feedUrl: episode.feedUrl,
            durationSeconds: episode.durationSeconds,
            transcriptionProvider: result.provider,
          },
        }
      }

      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: result.error?.message ?? null,
        metadata: {
          provider: 'podcast',
          kind: 'apple_itunes_episode',
          showId: appleIds.showId,
          episodeId: appleIds.episodeId,
          episodeUrl: episode.episodeUrl,
          feedUrl: episode.feedUrl,
          durationSeconds: episode.durationSeconds,
          transcriptionProvider: result.provider,
        },
      }
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `Apple Podcasts iTunes lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { provider: 'podcast', kind: 'apple_itunes_episode', showId: appleIds.showId },
      }
    }
  }

  const appleStreamUrl =
    typeof context.html === 'string' ? extractEmbeddedJsonUrl(context.html, 'streamUrl') : null
  if (appleStreamUrl) {
    attemptedProviders.push('whisper')
    const result = await transcribeMediaUrl({
      fetchImpl: options.fetch,
      url: appleStreamUrl,
      filenameHint: 'episode.mp3',
      durationSecondsHint: null,
      openaiApiKey: options.openaiApiKey,
      falApiKey: options.falApiKey,
      notes,
      progress: { url: context.url, service: 'podcast', onProgress: options.onProgress ?? null },
    })
    if (result.text) {
      return {
        text: result.text,
        source: 'whisper',
        attemptedProviders,
        notes: notes.length > 0 ? notes.join('; ') : null,
        metadata: {
          provider: 'podcast',
          kind: 'apple_stream_url',
          streamUrl: appleStreamUrl,
          transcriptionProvider: result.provider,
        },
      }
    }
    return {
      text: null,
      source: null,
      attemptedProviders,
      notes: result.error?.message ?? null,
      metadata: { provider: 'podcast', kind: 'apple_stream_url', streamUrl: appleStreamUrl },
    }
  }

  const appleFeedUrl =
    typeof context.html === 'string' ? extractEmbeddedJsonUrl(context.html, 'feedUrl') : null
  if (appleFeedUrl) {
    attemptedProviders.push('whisper')
    try {
      const feedResponse = await options.fetch(appleFeedUrl, {
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      })
      if (!feedResponse.ok) {
        throw new Error(`Feed fetch failed (${feedResponse.status})`)
      }
      const xml = await feedResponse.text()
      const enclosure = extractEnclosureFromFeed(xml)
      if (enclosure) {
        const resolvedUrl = decodeXmlEntities(enclosure.enclosureUrl)
        const durationSeconds = enclosure.durationSeconds
        const result = await transcribeMediaUrl({
          fetchImpl: options.fetch,
          url: resolvedUrl,
          filenameHint: 'episode.mp3',
          durationSecondsHint: durationSeconds,
          openaiApiKey: options.openaiApiKey,
          falApiKey: options.falApiKey,
          notes,
          progress: {
            url: context.url,
            service: 'podcast',
            onProgress: options.onProgress ?? null,
          },
        })
        if (result.text) {
          return {
            text: result.text,
            source: 'whisper',
            attemptedProviders,
            notes: notes.length > 0 ? notes.join('; ') : null,
            metadata: {
              provider: 'podcast',
              kind: 'apple_feed_url',
              feedUrl: appleFeedUrl,
              enclosureUrl: resolvedUrl,
              durationSeconds,
              transcriptionProvider: result.provider,
            },
          }
        }
        return {
          text: null,
          source: null,
          attemptedProviders,
          notes: result.error?.message ?? null,
          metadata: {
            provider: 'podcast',
            kind: 'apple_feed_url',
            feedUrl: appleFeedUrl,
            durationSeconds,
          },
        }
      }
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `Podcast feed fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { provider: 'podcast', kind: 'apple_feed_url', feedUrl: appleFeedUrl },
      }
    }
  }

  const feedEnclosureUrl =
    typeof context.html === 'string' ? extractEnclosureFromFeed(context.html) : null
  if (feedEnclosureUrl) {
    attemptedProviders.push('whisper')
    const resolvedUrl = decodeXmlEntities(feedEnclosureUrl.enclosureUrl)
    const durationSeconds = feedEnclosureUrl.durationSeconds
    try {
      const transcript = await transcribeMediaUrl({
        fetchImpl: options.fetch,
        url: resolvedUrl,
        filenameHint: 'episode.mp3',
        durationSecondsHint: durationSeconds,
        openaiApiKey: options.openaiApiKey,
        falApiKey: options.falApiKey,
        notes,
        progress: { url: context.url, service: 'podcast', onProgress: options.onProgress ?? null },
      })
      if (transcript.text) {
        return {
          text: transcript.text,
          source: 'whisper',
          attemptedProviders,
          notes: notes.length > 0 ? notes.join('; ') : null,
          metadata: {
            provider: 'podcast',
            kind: 'rss_enclosure',
            enclosureUrl: resolvedUrl,
            durationSeconds,
            transcriptionProvider: transcript.provider,
          },
        }
      }
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: transcript.error?.message ?? null,
        metadata: {
          provider: 'podcast',
          kind: 'rss_enclosure',
          enclosureUrl: resolvedUrl,
          durationSeconds,
          transcriptionProvider: transcript.provider,
        },
      }
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `Podcast enclosure download failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { provider: 'podcast', kind: 'rss_enclosure', enclosureUrl: resolvedUrl },
      }
    }
  }

  const ogAudioUrl = typeof context.html === 'string' ? extractOgAudioUrl(context.html) : null
  if (ogAudioUrl) {
    attemptedProviders.push('whisper')
    const result = await transcribeMediaUrl({
      fetchImpl: options.fetch,
      url: ogAudioUrl,
      filenameHint: 'audio.mp3',
      durationSecondsHint: null,
      openaiApiKey: options.openaiApiKey,
      falApiKey: options.falApiKey,
      notes,
      progress: { url: context.url, service: 'podcast', onProgress: options.onProgress ?? null },
    })
    if (result.text) {
      notes.push('Used og:audio media (may be a preview clip, not the full episode)')
      return {
        text: result.text,
        source: 'whisper',
        attemptedProviders,
        notes: notes.length > 0 ? notes.join('; ') : null,
        metadata: {
          provider: 'podcast',
          kind: 'og_audio',
          ogAudioUrl,
          transcriptionProvider: result.provider,
        },
      }
    }
    return {
      text: null,
      source: null,
      attemptedProviders,
      notes: result.error?.message ?? null,
      metadata: { provider: 'podcast', kind: 'og_audio', ogAudioUrl },
    }
  }

  if (options.ytDlpPath) {
    attemptedProviders.push('yt-dlp')
    try {
      const mod = await import('./youtube/yt-dlp.js')
      const result = await mod.fetchTranscriptWithYtDlp({
        ytDlpPath: options.ytDlpPath,
        openaiApiKey: options.openaiApiKey,
        falApiKey: options.falApiKey,
        url: context.url,
      })
      if (result.notes.length > 0) notes.push(...result.notes)
      return {
        text: result.text,
        source: result.text ? 'yt-dlp' : null,
        attemptedProviders,
        notes: notes.length > 0 ? notes.join('; ') : null,
        metadata: { provider: 'podcast', kind: 'yt_dlp', transcriptionProvider: result.provider },
      }
    } catch (error) {
      return {
        text: null,
        source: null,
        attemptedProviders,
        notes: `yt-dlp transcription failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { provider: 'podcast', kind: 'yt_dlp' },
      }
    }
  }

  return {
    text: null,
    source: null,
    attemptedProviders,
    metadata: { provider: 'podcast', reason: 'no_enclosure_and_no_yt_dlp' },
  }
}

function looksLikeRssOrAtomFeed(xml: string): boolean {
  const head = xml.slice(0, 4096).trimStart().toLowerCase()
  if (head.startsWith('<rss') || head.includes('<rss')) return true
  if (head.startsWith('<?xml') && (head.includes('<rss') || head.includes('<feed'))) return true
  if (head.startsWith('<feed') || head.includes('<feed')) return true
  return false
}

function extractEnclosureFromFeed(
  xml: string
): { enclosureUrl: string; durationSeconds: number | null } | null {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  for (const item of items) {
    const enclosureUrl = extractEnclosureUrlFromItem(item)
    if (!enclosureUrl) continue
    return { enclosureUrl, durationSeconds: extractItemDurationSeconds(item) }
  }

  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i)
  if (enclosureMatch?.[2]) {
    return { enclosureUrl: enclosureMatch[2], durationSeconds: extractItemDurationSeconds(xml) }
  }

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i
  )
  if (atomMatch?.[3]) {
    return { enclosureUrl: atomMatch[3], durationSeconds: extractItemDurationSeconds(xml) }
  }

  return null
}

function extractEnclosureUrlFromItem(xml: string): string | null {
  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i)
  if (enclosureMatch?.[2]) return enclosureMatch[2]

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i
  )
  if (atomMatch?.[3]) return atomMatch[3]

  return null
}

function extractEmbeddedJsonUrl(html: string, field: string): string | null {
  const pattern = new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`, 'i')
  const match = html.match(pattern)
  if (!match?.[1]) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

function extractOgAudioUrl(html: string): string | null {
  const match = html.match(/<meta\s+property=['"]og:audio['"]\s+content=['"]([^'"]+)['"][^>]*>/i)
  if (!match?.[1]) return null
  const candidate = match[1].trim()
  if (!candidate) return null
  if (!/^https?:\/\//i.test(candidate)) return null
  return candidate
}

function extractSpotifyEpisodeId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!host.endsWith('spotify.com')) return null

    const parts = parsed.pathname.split('/').filter(Boolean)
    const idx = parts.indexOf('episode')
    const id = idx >= 0 ? parts[idx + 1] : null
    return id && /^[A-Za-z0-9]+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function extractSpotifyEmbedData(html: string): {
  showTitle: string
  episodeTitle: string
  durationSeconds: number | null
  drmFormat: string | null
  audioUrl: string | null
} | null {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!match?.[1]) return null
  try {
    const json = JSON.parse(match[1]) as unknown
    const showTitle = (
      getJsonString(json, ['props', 'pageProps', 'state', 'data', 'entity', 'subtitle']) ?? ''
    ).trim()
    const episodeTitle = (
      getJsonString(json, ['props', 'pageProps', 'state', 'data', 'entity', 'title']) ?? ''
    ).trim()
    const durationMs = getJsonNumber(json, [
      'props',
      'pageProps',
      'state',
      'data',
      'entity',
      'duration',
    ])
    const drmFormat =
      getJsonString(json, [
        'props',
        'pageProps',
        'state',
        'data',
        'defaultAudioFileObject',
        'format',
      ]) ?? null
    const audioUrl = pickSpotifyEmbedAudioUrl(
      getJsonPath(json, ['props', 'pageProps', 'state', 'data', 'defaultAudioFileObject', 'url'])
    )
    if (!showTitle || !episodeTitle) return null
    return {
      showTitle,
      episodeTitle,
      durationSeconds:
        typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs / 1000 : null,
      drmFormat,
      audioUrl,
    }
  } catch {
    return null
  }
}

function pickSpotifyEmbedAudioUrl(raw: unknown): string | null {
  const urls: string[] = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []
  const normalized = urls.map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u))
  if (normalized.length === 0) return null
  const scdn = normalized.find((u) => /scdn\.co/i.test(u))
  return scdn ?? normalized[0] ?? null
}

function extractApplePodcastIds(url: string): { showId: string; episodeId: string | null } | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'podcasts.apple.com') return null
    const showId = parsed.pathname.match(/\/id(\d+)(?:\/|$)/)?.[1] ?? null
    if (!showId) return null
    const episodeIdRaw = parsed.searchParams.get('i')
    const episodeId = episodeIdRaw && /^\d+$/.test(episodeIdRaw) ? episodeIdRaw : null
    return { showId, episodeId }
  } catch {
    return null
  }
}

async function resolveApplePodcastEpisodeFromItunesLookup({
  fetchImpl,
  showId,
  episodeId,
}: {
  fetchImpl: typeof fetch
  showId: string
  episodeId: string | null
}): Promise<{
  episodeUrl: string
  feedUrl: string | null
  fileExtension: string | null
  durationSeconds: number | null
} | null> {
  const query = new URLSearchParams({
    id: showId,
    entity: 'podcastEpisode',
    limit: '200',
  })
  const res = await fetchImpl(`${ITUNES_LOOKUP_URL}?${query.toString()}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return null
  const payload = (await res.json()) as unknown
  const results = asRecordArray(getJsonArray(payload, ['results']))

  const show = results.find(
    (r) => getRecordString(r, 'wrapperType') === 'track' && getRecordString(r, 'kind') === 'podcast'
  )
  const feedUrl =
    typeof show?.feedUrl === 'string' && show.feedUrl.trim() ? show.feedUrl.trim() : null

  const episodes = results.filter((r) => getRecordString(r, 'wrapperType') === 'podcastEpisode')
  if (episodes.length === 0) return null

  const chosen = (() => {
    if (episodeId) {
      const match = episodes.find((r) => String(r.trackId ?? '') === episodeId)
      if (match) return match
    }
    // No i=... in URL: pick the newest episode by release date.
    const sorted = [...episodes].sort((a, b) => {
      const aDate = Date.parse(String(a.releaseDate ?? ''))
      const bDate = Date.parse(String(b.releaseDate ?? ''))
      if (!Number.isFinite(aDate) && !Number.isFinite(bDate)) return 0
      if (!Number.isFinite(aDate)) return 1
      if (!Number.isFinite(bDate)) return -1
      return bDate - aDate
    })
    return sorted[0]
  })()

  const episodeUrlRaw =
    typeof chosen.episodeUrl === 'string'
      ? chosen.episodeUrl.trim()
      : typeof chosen.previewUrl === 'string'
        ? chosen.previewUrl.trim()
        : ''
  if (!episodeUrlRaw || !/^https?:\/\//i.test(episodeUrlRaw)) return null

  const fileExtension =
    typeof chosen.episodeFileExtension === 'string' && chosen.episodeFileExtension.trim()
      ? chosen.episodeFileExtension.trim().replace(/^\./, '')
      : null
  const durationSeconds =
    typeof chosen.trackTimeMillis === 'number' && Number.isFinite(chosen.trackTimeMillis)
      ? chosen.trackTimeMillis / 1000
      : null

  return { episodeUrl: episodeUrlRaw, feedUrl, fileExtension, durationSeconds }
}

async function resolvePodcastFeedUrlFromItunesSearch(
  fetchImpl: typeof fetch,
  showTitle: string
): Promise<string | null> {
  const query = new URLSearchParams({
    term: showTitle,
    media: 'podcast',
    entity: 'podcast',
    limit: '10',
  })
  const res = await fetchImpl(`${ITUNES_SEARCH_URL}?${query.toString()}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    return null
  }
  const payload = (await res.json()) as unknown
  const results = asRecordArray(getJsonArray(payload, ['results']))
  if (results.length === 0) return null

  const normalizedTarget = normalizeLooseTitle(showTitle)
  const exact = results.find(
    (r) => normalizeLooseTitle(String(r.collectionName ?? '')) === normalizedTarget
  )
  const best = exact ?? results[0]
  const feedUrl = typeof best?.feedUrl === 'string' ? best.feedUrl.trim() : ''
  return feedUrl && /^https?:\/\//i.test(feedUrl) ? feedUrl : null
}

function normalizeLooseTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/\p{Diacritic}+/gu, '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
}

function extractEnclosureForEpisode(
  feedXml: string,
  episodeTitle: string
): { enclosureUrl: string; durationSeconds: number | null } | null {
  const normalizedTarget = normalizeLooseTitle(episodeTitle)
  const items = feedXml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
  for (const item of items) {
    const title = extractItemTitle(item)
    if (!title) continue
    if (normalizeLooseTitle(title) !== normalizedTarget) continue
    const enclosureUrl = extractEnclosureUrlFromItem(item)
    if (!enclosureUrl) continue
    return { enclosureUrl, durationSeconds: extractItemDurationSeconds(item) }
  }
  return null
}

function extractItemTitle(itemXml: string): string | null {
  const match = itemXml.match(/<title>([\s\S]*?)<\/title>/i)
  if (!match?.[1]) return null
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, '')
    .replaceAll(/\]\]>/g, '')
    .trim()
  return raw.length > 0 ? raw : null
}

async function fetchSpotifyEmbedHtml({
  embedUrl,
  episodeId,
  fetchImpl,
  scrapeWithFirecrawl,
}: {
  embedUrl: string
  episodeId: string
  fetchImpl: typeof fetch
  scrapeWithFirecrawl:
    | ((
        url: string,
        options?: { cacheMode?: 'default' | 'bypass'; timeoutMs?: number }
      ) => Promise<{ html?: string | null; markdown: string } | null>)
    | null
}): Promise<{ html: string; via: 'fetch' | 'firecrawl' }> {
  try {
    // Try plain fetch first: fast, cheap, and often works with a realistic UA + referer.
    const embedResponse = await fetchImpl(embedUrl, {
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        referer: `https://open.spotify.com/episode/${episodeId}`,
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    })
    if (!embedResponse.ok) {
      throw new Error(`Spotify embed fetch failed (${embedResponse.status})`)
    }
    const embedHtml = await embedResponse.text()
    if (!looksLikeBlockedHtml(embedHtml)) {
      return { html: embedHtml, via: 'fetch' }
    }
    throw new Error('Spotify embed HTML looked blocked (captcha)')
  } catch (error) {
    if (!scrapeWithFirecrawl) {
      throw error
    }

    // Firecrawl is optional and only used as a fallback when Spotify blocks direct fetches.
    const payload = await scrapeWithFirecrawl(embedUrl, {
      cacheMode: 'bypass',
      timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
    })
    const text = (payload?.html ?? payload?.markdown ?? '').trim()
    if (!text) {
      throw new Error(
        `Spotify embed fetch failed and Firecrawl returned empty content (${
          error instanceof Error ? error.message : String(error)
        })`
      )
    }
    if (looksLikeBlockedHtml(text)) {
      throw new Error('Spotify embed blocked even via Firecrawl (captcha)')
    }
    return { html: text, via: 'firecrawl' }
  }
}

function looksLikeBlockedHtml(html: string): boolean {
  const head = html.slice(0, 20000).toLowerCase()
  // Spotify embed pages include `__NEXT_DATA__` even when the rest of the HTML is minimal; treat that
  // as a strong "not blocked" signal to avoid unnecessary Firecrawl fallbacks.
  if (head.includes('__next_data__')) return false
  return BLOCKED_HTML_HINT_PATTERN.test(head)
}

function extractItemDurationSeconds(itemXml: string): number | null {
  const match = itemXml.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/i)
  if (!match?.[1]) return null
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, '')
    .replaceAll(/\]\]>/g, '')
    .trim()
  if (!raw) return null

  // common forms: "HH:MM:SS", "MM:SS", "SS"
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null
  }

  const parts = raw
    .split(':')
    .map((value) => value.trim())
    .filter(Boolean)
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((value) => Number(value))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  const seconds = (() => {
    if (nums.length === 3) {
      const [hours, minutes, secondsRaw] = nums
      if (hours === undefined || minutes === undefined || secondsRaw === undefined) return null
      return Math.round(hours * 3600 + minutes * 60 + secondsRaw)
    }
    const [minutes, secondsRaw] = nums
    if (minutes === undefined || secondsRaw === undefined) return null
    return Math.round(minutes * 60 + secondsRaw)
  })()
  if (seconds === null) return null
  return seconds > 0 ? seconds : null
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll(/&amp;/gi, '&')
    .replaceAll(/&#38;/g, '&')
    .replaceAll(/&lt;/gi, '<')
    .replaceAll(/&gt;/gi, '>')
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&apos;/gi, "'")
}

async function transcribeMediaUrl({
  fetchImpl,
  url,
  filenameHint,
  durationSecondsHint,
  openaiApiKey,
  falApiKey,
  notes,
  progress,
}: {
  fetchImpl: typeof fetch
  url: string
  filenameHint: string
  durationSecondsHint: number | null
  openaiApiKey: string | null
  falApiKey: string | null
  notes: string[]
  progress: {
    url: string
    service: 'podcast'
    onProgress: ProviderFetchOptions['onProgress'] | null
  } | null
}): Promise<{ text: string | null; provider: string | null; error: Error | null }> {
  const canChunk = await isFfmpegAvailable()
  const providerHint: 'cpp' | 'openai' | 'fal' | 'openai->fal' | 'unknown' =
    (await isWhisperCppReady())
      ? 'cpp'
      : openaiApiKey && falApiKey
        ? 'openai->fal'
        : openaiApiKey
          ? 'openai'
          : falApiKey
            ? 'fal'
            : 'unknown'

  const head = await probeRemoteMedia(fetchImpl, url)
  if (head.contentLength !== null && head.contentLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(
      `Remote media too large (${formatBytes(head.contentLength)}). Limit is ${formatBytes(MAX_REMOTE_MEDIA_BYTES)}.`
    )
  }

  const mediaType = head.mediaType ?? 'application/octet-stream'
  const filename = head.filename ?? filenameHint
  const totalBytes = head.contentLength

  progress?.onProgress?.({
    kind: 'transcript-media-download-start',
    url: progress.url,
    service: progress.service,
    mediaUrl: url,
    totalBytes,
  })

  const modelId =
    providerHint === 'cpp'
      ? 'whisper.cpp'
      : openaiApiKey && falApiKey
        ? 'whisper-1->fal-ai/wizper'
        : openaiApiKey
          ? 'whisper-1'
          : falApiKey
            ? 'fal-ai/wizper'
            : null
  if (!canChunk) {
    const bytes = await downloadCappedBytes(fetchImpl, url, MAX_OPENAI_UPLOAD_BYTES, {
      totalBytes,
      onProgress: (downloadedBytes) =>
        progress?.onProgress?.({
          kind: 'transcript-media-download-progress',
          url: progress.url,
          service: progress.service,
          downloadedBytes,
          totalBytes,
        }),
    })
    progress?.onProgress?.({
      kind: 'transcript-media-download-done',
      url: progress.url,
      service: progress.service,
      downloadedBytes: bytes.byteLength,
      totalBytes,
    })
    progress?.onProgress?.({
      kind: 'transcript-whisper-start',
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: durationSecondsHint,
      parts: null,
    })
    notes.push(`Transcribed first ${formatBytes(bytes.byteLength)} only (ffmpeg not available)`)
    const transcript = await transcribeMediaWithWhisper({
      bytes,
      mediaType,
      filename,
      openaiApiKey,
      falApiKey,
      onProgress: null,
    })
    if (transcript.notes.length > 0) notes.push(...transcript.notes)
    return { text: transcript.text, provider: transcript.provider, error: transcript.error }
  }

  if (head.contentLength !== null && head.contentLength <= MAX_OPENAI_UPLOAD_BYTES) {
    const bytes = await downloadCappedBytes(fetchImpl, url, MAX_OPENAI_UPLOAD_BYTES, {
      totalBytes,
      onProgress: (downloadedBytes) =>
        progress?.onProgress?.({
          kind: 'transcript-media-download-progress',
          url: progress.url,
          service: progress.service,
          downloadedBytes,
          totalBytes,
        }),
    })
    progress?.onProgress?.({
      kind: 'transcript-media-download-done',
      url: progress.url,
      service: progress.service,
      downloadedBytes: bytes.byteLength,
      totalBytes,
    })
    progress?.onProgress?.({
      kind: 'transcript-whisper-start',
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: durationSecondsHint,
      parts: null,
    })
    const transcript = await transcribeMediaWithWhisper({
      bytes,
      mediaType,
      filename,
      openaiApiKey,
      falApiKey,
      onProgress: null,
    })
    if (transcript.notes.length > 0) notes.push(...transcript.notes)
    return { text: transcript.text, provider: transcript.provider, error: transcript.error }
  }

  const tmpFile = join(tmpdir(), `summarize-podcast-${randomUUID()}.bin`)
  try {
    const downloadedBytes = await downloadToFile(fetchImpl, url, tmpFile, {
      totalBytes,
      onProgress: (nextDownloadedBytes) =>
        progress?.onProgress?.({
          kind: 'transcript-media-download-progress',
          url: progress.url,
          service: progress.service,
          downloadedBytes: nextDownloadedBytes,
          totalBytes,
        }),
    })
    progress?.onProgress?.({
      kind: 'transcript-media-download-done',
      url: progress.url,
      service: progress.service,
      downloadedBytes,
      totalBytes,
    })

    const probedDurationSeconds =
      durationSecondsHint ?? (await probeMediaDurationSecondsWithFfprobe(tmpFile))
    progress?.onProgress?.({
      kind: 'transcript-whisper-start',
      url: progress.url,
      service: progress.service,
      providerHint,
      modelId,
      totalDurationSeconds: probedDurationSeconds,
      parts: null,
    })
    const transcript = await transcribeMediaFileWithWhisper({
      filePath: tmpFile,
      mediaType,
      filename,
      openaiApiKey,
      falApiKey,
      totalDurationSeconds: probedDurationSeconds,
      onProgress: (event) => {
        progress?.onProgress?.({
          kind: 'transcript-whisper-progress',
          url: progress.url,
          service: progress.service,
          processedDurationSeconds: event.processedDurationSeconds,
          totalDurationSeconds: event.totalDurationSeconds,
          partIndex: event.partIndex,
          parts: event.parts,
        })
      },
    })
    if (transcript.notes.length > 0) notes.push(...transcript.notes)
    return { text: transcript.text, provider: transcript.provider, error: transcript.error }
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
}

async function probeRemoteMedia(
  fetchImpl: typeof fetch,
  url: string
): Promise<{ contentLength: number | null; mediaType: string | null; filename: string | null }> {
  try {
    const res = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error('head failed')
    const contentLength = parseContentLength(res.headers.get('content-length'))
    const mediaType = normalizeHeaderType(res.headers.get('content-type'))
    const filename = filenameFromUrl(url)
    return { contentLength, mediaType, filename }
  } catch {
    return { contentLength: null, mediaType: null, filename: filenameFromUrl(url) }
  }
}

async function downloadCappedBytes(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  options?: { totalBytes: number | null; onProgress?: ((downloadedBytes: number) => void) | null }
): Promise<Uint8Array> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`)
  }
  const body = res.body
  if (!body) {
    const arrayBuffer = await res.arrayBuffer()
    return new Uint8Array(arrayBuffer.slice(0, maxBytes))
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let lastReported = 0
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      const remaining = maxBytes - total
      const next = value.byteLength > remaining ? value.slice(0, remaining) : value
      chunks.push(next)
      total += next.byteLength
      if (total - lastReported >= 64 * 1024) {
        lastReported = total
        options?.onProgress?.(total)
      }
      if (total >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  options?.onProgress?.(total)

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function downloadToFile(
  fetchImpl: typeof fetch,
  url: string,
  filePath: string,
  options?: { totalBytes: number | null; onProgress?: ((downloadedBytes: number) => void) | null }
): Promise<number> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`)
  }
  const body = res.body
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    await fs.writeFile(filePath, bytes)
    options?.onProgress?.(bytes.byteLength)
    return bytes.byteLength
  }

  const handle = await fs.open(filePath, 'w')
  let downloadedBytes = 0
  let lastReported = 0
  try {
    const reader = body.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        await handle.write(value)
        downloadedBytes += value.byteLength
        if (downloadedBytes - lastReported >= 128 * 1024) {
          lastReported = downloadedBytes
          options?.onProgress?.(downloadedBytes)
        }
      }
      options?.onProgress?.(downloadedBytes)
    } finally {
      await reader.cancel().catch(() => {})
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return downloadedBytes
}

function normalizeHeaderType(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.split(';')[0]?.trim().toLowerCase() ?? null
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

function filenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const base = parsed.pathname.split('/').pop() ?? ''
    return base.trim().length > 0 ? base : null
  } catch {
    return null
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  const decimals = value >= 10 || idx === 0 ? 0 : 1
  return `${value.toFixed(decimals)}${units[idx]}`
}

// Test-only exports (not part of the public API; may change without notice).
export const __test__ = {
  probeRemoteMedia,
  downloadCappedBytes,
  downloadToFile,
  normalizeHeaderType,
  parseContentLength,
  filenameFromUrl,
  looksLikeBlockedHtml,
  extractItemDurationSeconds,
  extractEnclosureForEpisode,
  resolvePodcastFeedUrlFromItunesSearch,
  formatBytes,
}
