import type { CacheState } from '../cache.js'
import { type ExtractedLinkContent, isYouTubeUrl } from '../content/index.js'
import type { RunMetricsReport } from '../costs.js'
import { buildFinishLineText, buildLengthPartsForFinishLine } from '../run/finish-line.js'
import { deriveExtractionUi } from '../run/flows/url/extract.js'
import { runUrlFlow } from '../run/flows/url/flow.js'
import { buildUrlPrompt, summarizeExtractedUrl } from '../run/flows/url/summary.js'

import { createDaemonUrlFlowContext } from './flow-context.js'
import { countWords, formatInputSummary } from './meta.js'
import { formatProgress } from './summarize-progress.js'

export type VisiblePageInput = {
  url: string
  title: string | null
  text: string
  truncated: boolean
}

export type UrlModeInput = {
  url: string
  title: string | null
  maxCharacters: number | null
}

export type StreamSink = {
  writeChunk: (text: string) => void
  onModelChosen: (modelId: string) => void
  writeStatus?: ((text: string) => void) | null
  writeMeta?: ((data: { inputSummary: string | null }) => void) | null
}

export type VisiblePageMetrics = {
  elapsedMs: number
  summary: string
  details: string | null
  summaryDetailed: string
  detailsDetailed: string | null
}

function buildDaemonMetrics({
  elapsedMs,
  summaryFromCache,
  label,
  modelLabel,
  report,
  costUsd,
  compactExtraParts,
  detailedExtraParts,
}: {
  elapsedMs: number
  summaryFromCache: boolean
  label: string | null
  modelLabel: string
  report: RunMetricsReport
  costUsd: number | null
  compactExtraParts: string[] | null
  detailedExtraParts: string[] | null
}): VisiblePageMetrics {
  const elapsedLabel = summaryFromCache ? 'Cached' : null
  const compact = buildFinishLineText({
    elapsedMs,
    elapsedLabel,
    label,
    model: modelLabel,
    report,
    costUsd,
    detailed: false,
    extraParts: compactExtraParts,
  })
  const extended = buildFinishLineText({
    elapsedMs,
    elapsedLabel,
    label,
    model: modelLabel,
    report,
    costUsd,
    detailed: true,
    extraParts: detailedExtraParts,
  })

  return {
    elapsedMs,
    summary: compact.line,
    details: compact.details,
    summaryDetailed: extended.line,
    detailsDetailed: extended.details,
  }
}

function guessSiteName(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname || null
  } catch {
    return null
  }
}

function buildInputSummaryForExtracted(extracted: ExtractedLinkContent): string | null {
  const isYouTube = extracted.siteName === 'YouTube' || isYouTubeUrl(extracted.url)

  const transcriptChars =
    typeof extracted.transcriptCharacters === 'number' && extracted.transcriptCharacters > 0
      ? extracted.transcriptCharacters
      : null
  const hasTranscript = transcriptChars != null

  const transcriptWords =
    hasTranscript && transcriptChars != null
      ? (extracted.transcriptWordCount ?? Math.max(0, Math.round(transcriptChars / 6)))
      : null

  const exactDurationSeconds =
    typeof extracted.mediaDurationSeconds === 'number' && extracted.mediaDurationSeconds > 0
      ? extracted.mediaDurationSeconds
      : null
  const estimatedDurationSeconds =
    transcriptWords != null && transcriptWords > 0
      ? Math.max(60, Math.max(1, Math.round(transcriptWords / 160)) * 60)
      : null

  const durationSeconds = hasTranscript ? (exactDurationSeconds ?? estimatedDurationSeconds) : null
  const isDurationApproximate =
    hasTranscript && durationSeconds != null && exactDurationSeconds == null

  const kindLabel = (() => {
    if (isYouTube) return 'YouTube'
    if (!hasTranscript) return null
    if (extracted.isVideoOnly || extracted.video) return 'video'
    return 'podcast'
  })()

  return formatInputSummary({
    kindLabel,
    durationSeconds,
    words: hasTranscript ? transcriptWords : extracted.wordCount,
    characters: hasTranscript ? transcriptChars : extracted.totalCharacters,
    isDurationApproximate,
  })
}

export async function streamSummaryForVisiblePage({
  env,
  fetchImpl,
  input,
  modelOverride,
  promptOverride,
  lengthRaw,
  languageRaw,
  sink,
  cache,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  input: VisiblePageInput
  modelOverride: string | null
  promptOverride: string | null
  lengthRaw: unknown
  languageRaw: unknown
  sink: StreamSink
  cache: CacheState
}): Promise<{ usedModel: string; metrics: VisiblePageMetrics }> {
  const startedAt = Date.now()
  let usedModel: string | null = null
  let summaryFromCache = false

  const writeStatus = typeof sink.writeStatus === 'function' ? sink.writeStatus : null

  const ctx = createDaemonUrlFlowContext({
    env,
    fetchImpl,
    cache,
    modelOverride,
    promptOverride,
    lengthRaw,
    languageRaw,
    maxExtractCharacters: null,
    hooks: {
      onModelChosen: (modelId) => {
        usedModel = modelId
        sink.onModelChosen(modelId)
      },
      onSummaryCached: (cached) => {
        summaryFromCache = cached
      },
    },
    runStartedAtMs: startedAt,
    stdoutSink: { writeChunk: sink.writeChunk },
  })

  const extracted: ExtractedLinkContent = {
    url: input.url,
    title: input.title,
    description: null,
    siteName: guessSiteName(input.url),
    content: input.text,
    truncated: input.truncated,
    totalCharacters: input.text.length,
    wordCount: countWords(input.text),
    transcriptCharacters: null,
    transcriptLines: null,
    transcriptWordCount: null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptMetadata: null,
    mediaDurationSeconds: null,
    video: null,
    isVideoOnly: false,
    diagnostics: {
      strategy: 'html',
      firecrawl: {
        attempted: false,
        used: false,
        cacheMode: cache.mode,
        cacheStatus: 'unknown',
      },
      markdown: {
        requested: false,
        used: false,
        provider: null,
      },
      transcript: {
        cacheMode: cache.mode,
        cacheStatus: 'unknown',
        textProvided: false,
        provider: null,
        attemptedProviders: [],
      },
    } satisfies ExtractedLinkContent['diagnostics'],
  }

  sink.writeMeta?.({
    inputSummary: formatInputSummary({
      kindLabel: null,
      durationSeconds: null,
      words: extracted.wordCount,
      characters: extracted.totalCharacters,
    }),
  })
  writeStatus?.('Summarizing…')

  const extractionUi = deriveExtractionUi(extracted)
  const prompt = buildUrlPrompt({
    extracted,
    outputLanguage: ctx.flags.outputLanguage,
    lengthArg: ctx.flags.lengthArg,
    promptOverride: ctx.flags.promptOverride ?? null,
    lengthInstruction: ctx.flags.lengthInstruction ?? null,
    languageInstruction: ctx.flags.languageInstruction ?? null,
  })

  await summarizeExtractedUrl({
    ctx,
    url: input.url,
    extracted,
    extractionUi,
    prompt,
    effectiveMarkdownMode: 'off',
    transcriptionCostLabel: null,
    onModelChosen: ctx.hooks.onModelChosen ?? null,
  })

  const report = await ctx.hooks.buildReport()
  const costUsd = await ctx.hooks.estimateCostUsd()
  const elapsedMs = Date.now() - startedAt

  const label = extracted.siteName ?? guessSiteName(extracted.url)
  const modelLabel = usedModel ?? ctx.model.requestedModelLabel
  return {
    usedModel: modelLabel,
    metrics: buildDaemonMetrics({
      elapsedMs,
      summaryFromCache,
      label,
      modelLabel,
      report,
      costUsd,
      compactExtraParts: null,
      detailedExtraParts: null,
    }),
  }
}

export async function streamSummaryForUrl({
  env,
  fetchImpl,
  input,
  modelOverride,
  promptOverride,
  lengthRaw,
  languageRaw,
  sink,
  cache,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  input: UrlModeInput
  modelOverride: string | null
  promptOverride: string | null
  lengthRaw: unknown
  languageRaw: unknown
  sink: StreamSink
  cache: CacheState
}): Promise<{ usedModel: string; metrics: VisiblePageMetrics }> {
  const startedAt = Date.now()
  let usedModel: string | null = null
  let summaryFromCache = false
  const extractedRef = { value: null as ExtractedLinkContent | null }

  const writeStatus = typeof sink.writeStatus === 'function' ? sink.writeStatus : null

  const ctx = createDaemonUrlFlowContext({
    env,
    fetchImpl,
    cache,
    modelOverride,
    promptOverride,
    lengthRaw,
    languageRaw,
    maxExtractCharacters:
      input.maxCharacters && input.maxCharacters > 0 ? input.maxCharacters : null,
    hooks: {
      onModelChosen: (modelId) => {
        usedModel = modelId
        sink.onModelChosen(modelId)
      },
      onExtracted: (content) => {
        extractedRef.value = content
        sink.writeMeta?.({ inputSummary: buildInputSummaryForExtracted(content) })
        writeStatus?.('Summarizing…')
      },
      onLinkPreviewProgress: (event) => {
        const msg = formatProgress(event)
        if (msg) writeStatus?.(msg)
      },
      onSummaryCached: (cached) => {
        summaryFromCache = cached
      },
    },
    runStartedAtMs: startedAt,
    stdoutSink: { writeChunk: sink.writeChunk },
  })

  writeStatus?.('Extracting…')
  await runUrlFlow({ ctx, url: input.url, isYoutubeUrl: isYouTubeUrl(input.url) })

  const extracted = extractedRef.value
  if (!extracted) {
    throw new Error('Internal error: missing extracted content')
  }

  const report = await ctx.hooks.buildReport()
  const costUsd = await ctx.hooks.estimateCostUsd()
  const elapsedMs = Date.now() - startedAt

  const label = extracted.siteName ?? guessSiteName(extracted.url)
  const modelLabel = usedModel ?? ctx.model.requestedModelLabel
  const compactExtraParts = buildLengthPartsForFinishLine(extracted, false)
  const detailedExtraParts = buildLengthPartsForFinishLine(extracted, true)

  return {
    usedModel: modelLabel,
    metrics: buildDaemonMetrics({
      elapsedMs,
      summaryFromCache,
      label,
      modelLabel,
      report,
      costUsd,
      compactExtraParts,
      detailedExtraParts,
    }),
  }
}
