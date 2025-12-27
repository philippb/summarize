import { execFile } from 'node:child_process'
import { Writable } from 'node:stream'

import type { CacheState } from '../cache.js'
import type { ExtractedLinkContent, LinkPreviewProgressEvent } from '../content/index.js'
import type { ExecFileFn } from '../markitdown.js'
import type { FixedModelSpec } from '../model-spec.js'
import type { AssetSummaryContext, SummarizeAssetArgs } from '../run/flows/asset/summary.js'
import { summarizeAsset as summarizeAssetFlow } from '../run/flows/asset/summary.js'
import type { UrlFlowContext } from '../run/flows/url/types.js'
import { resolveConfigState } from '../run/run-config.js'
import { resolveEnvState } from '../run/run-env.js'
import { createRunMetrics } from '../run/run-metrics.js'
import { resolveModelSelection } from '../run/run-models.js'
import { resolveDesiredOutputTokens } from '../run/run-output.js'
import { createSummaryEngine } from '../run/summary-engine.js'

import { resolveDaemonOutputLanguage, resolveDaemonSummaryLength } from './request-settings.js'

type TextSink = {
  writeChunk: (text: string) => void
}

function createWritableFromTextSink(sink: TextSink): NodeJS.WritableStream {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
      if (text) sink.writeChunk(text)
      callback()
    },
  })
  ;(stream as unknown as { isTTY?: boolean }).isTTY = false
  return stream
}

export type DaemonUrlFlowContextArgs = {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  cache: CacheState
  modelOverride: string | null
  promptOverride: string | null
  lengthRaw: unknown
  languageRaw: unknown
  maxExtractCharacters: number | null
  hooks?: {
    onModelChosen?: ((modelId: string) => void) | null
    onExtracted?: ((extracted: ExtractedLinkContent) => void) | null
    onLinkPreviewProgress?: ((event: LinkPreviewProgressEvent) => void) | null
    onSummaryCached?: ((cached: boolean) => void) | null
  } | null
  runStartedAtMs: number
  stdoutSink: TextSink
}

export function createDaemonUrlFlowContext(args: DaemonUrlFlowContextArgs): UrlFlowContext {
  const {
    env,
    fetchImpl,
    cache,
    modelOverride,
    promptOverride,
    lengthRaw,
    languageRaw,
    maxExtractCharacters,
    hooks,
    runStartedAtMs,
    stdoutSink,
  } = args

  const envForRun = env

  const languageExplicitlySet = typeof languageRaw === 'string' && Boolean(languageRaw.trim())

  const {
    config,
    configPath,
    outputLanguage: outputLanguageFromConfig,
    openaiWhisperUsdPerMinute,
    videoMode,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    configModelLabel,
  } = resolveConfigState({
    envForRun,
    programOpts: { videoMode: 'auto' },
    languageExplicitlySet,
    videoModeExplicitlySet: false,
    cliFlagPresent: false,
    cliProviderArg: null,
  })

  const {
    apiKey,
    openrouterApiKey,
    openrouterConfigured,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    cliAvailability,
    envForAuto,
    apifyToken,
    ytDlpPath,
    falApiKey,
  } = resolveEnvState({ env: envForRun, envForRun, configForCli })

  const {
    requestedModel,
    requestedModelInput,
    requestedModelLabel,
    isNamedModelSelection,
    wantsFreeNamedModel,
    configForModelSelection,
    isFallbackModel,
  } = resolveModelSelection({
    config,
    configForCli,
    configPath,
    envForRun,
    explicitModelArg: modelOverride?.trim() ? modelOverride.trim() : null,
  })

  const fixedModelSpec: FixedModelSpec | null =
    requestedModel.kind === 'fixed' ? requestedModel : null

  const { lengthArg } = resolveDaemonSummaryLength(lengthRaw)
  const desiredOutputTokens = resolveDesiredOutputTokens({ lengthArg, maxOutputTokensArg: null })

  const metrics = createRunMetrics({ env: envForRun, fetchImpl, maxOutputTokensArg: null })

  const stdout = createWritableFromTextSink(stdoutSink)
  const stderr = process.stderr

  const summaryEngine = createSummaryEngine({
    env: envForRun,
    envForRun,
    stdout,
    stderr,
    execFileImpl: execFile as unknown as ExecFileFn,
    timeoutMs: 120_000,
    retries: 1,
    streamingEnabled: true,
    plain: true,
    verbose: false,
    verboseColor: false,
    openaiUseChatCompletions,
    cliConfigForRun: cliConfigForRun ?? null,
    cliAvailability,
    trackedFetch: metrics.trackedFetch,
    resolveMaxOutputTokensForCall: metrics.resolveMaxOutputTokensForCall,
    resolveMaxInputTokensForCall: metrics.resolveMaxInputTokensForCall,
    llmCalls: metrics.llmCalls,
    clearProgressForStdout: () => {},
    apiKeys: {
      xaiApiKey,
      openaiApiKey: apiKey,
      googleApiKey,
      anthropicApiKey,
      openrouterApiKey,
    },
    keyFlags: {
      googleConfigured,
      anthropicConfigured,
      openrouterConfigured,
    },
    zai: { apiKey: zaiApiKey, baseUrl: zaiBaseUrl },
  })

  const outputLanguage = resolveDaemonOutputLanguage({
    raw: languageRaw,
    fallback: outputLanguageFromConfig,
  })

  const lengthInstruction =
    promptOverride && lengthArg.kind === 'chars'
      ? `Output is ${lengthArg.maxCharacters.toLocaleString()} characters.`
      : null
  const languageExplicit =
    typeof languageRaw === 'string' &&
    languageRaw.trim().length > 0 &&
    languageRaw.trim().toLowerCase() !== 'auto'
  const languageInstruction =
    promptOverride && languageExplicit && outputLanguage.kind === 'fixed'
      ? `Output should be ${outputLanguage.label}.`
      : null

  const assetSummaryContext: AssetSummaryContext = {
    env: envForRun,
    envForRun,
    stdout,
    stderr,
    execFileImpl: execFile as unknown as ExecFileFn,
    timeoutMs: 120_000,
    preprocessMode: 'off',
    format: 'text',
    lengthArg,
    outputLanguage,
    videoMode,
    fixedModelSpec,
    promptOverride,
    lengthInstruction,
    languageInstruction,
    isFallbackModel,
    desiredOutputTokens,
    envForAuto,
    configForModelSelection,
    cliAvailability,
    requestedModel,
    requestedModelInput,
    requestedModelLabel,
    wantsFreeNamedModel,
    isNamedModelSelection,
    maxOutputTokensArg: null,
    json: false,
    metricsEnabled: false,
    metricsDetailed: false,
    shouldComputeReport: false,
    runStartedAtMs,
    verbose: false,
    verboseColor: false,
    streamingEnabled: true,
    plain: true,
    summaryEngine,
    trackedFetch: metrics.trackedFetch,
    writeViaFooter: () => {},
    clearProgressForStdout: () => {},
    getLiteLlmCatalog: metrics.getLiteLlmCatalog,
    buildReport: metrics.buildReport,
    estimateCostUsd: metrics.estimateCostUsd,
    llmCalls: metrics.llmCalls,
    cache,
    apiStatus: {
      xaiApiKey,
      apiKey,
      openrouterApiKey,
      apifyToken,
      firecrawlConfigured,
      googleConfigured,
      anthropicConfigured,
      zaiApiKey,
      zaiBaseUrl,
    },
  }

  const ctx: UrlFlowContext = {
    io: {
      env: envForRun,
      envForRun,
      stdout,
      stderr,
      execFileImpl: execFile as unknown as ExecFileFn,
      fetch: metrics.trackedFetch,
    },
    flags: {
      timeoutMs: 120_000,
      maxExtractCharacters,
      retries: 1,
      format: 'text',
      markdownMode: 'readability',
      preprocessMode: 'off',
      youtubeMode: 'auto',
      firecrawlMode: 'off',
      videoMode,
      outputLanguage,
      lengthArg,
      promptOverride,
      lengthInstruction,
      languageInstruction,
      maxOutputTokensArg: null,
      json: false,
      extractMode: false,
      metricsEnabled: false,
      metricsDetailed: false,
      shouldComputeReport: false,
      runStartedAtMs,
      verbose: false,
      verboseColor: false,
      progressEnabled: false,
      streamingEnabled: true,
      plain: true,
      configPath,
      configModelLabel,
    },
    model: {
      requestedModel,
      requestedModelInput,
      requestedModelLabel,
      fixedModelSpec,
      isFallbackModel,
      isNamedModelSelection,
      wantsFreeNamedModel,
      desiredOutputTokens,
      configForModelSelection,
      envForAuto,
      cliAvailability,
      openaiUseChatCompletions,
      openaiWhisperUsdPerMinute,
      apiStatus: {
        xaiApiKey,
        apiKey,
        openrouterApiKey,
        openrouterConfigured,
        googleApiKey,
        googleConfigured,
        anthropicApiKey,
        anthropicConfigured,
        zaiApiKey,
        zaiBaseUrl,
        firecrawlConfigured,
        firecrawlApiKey,
        apifyToken,
        ytDlpPath,
        falApiKey,
        openaiTranscriptionKey,
      },
      summaryEngine,
      getLiteLlmCatalog: metrics.getLiteLlmCatalog,
      llmCalls: metrics.llmCalls,
    },
    cache,
    hooks: {
      onModelChosen: hooks?.onModelChosen ?? null,
      onExtracted: hooks?.onExtracted ?? null,
      onLinkPreviewProgress: hooks?.onLinkPreviewProgress ?? null,
      onSummaryCached: hooks?.onSummaryCached ?? null,
      setTranscriptionCost: metrics.setTranscriptionCost,
      summarizeAsset: (assetArgs: SummarizeAssetArgs) =>
        summarizeAssetFlow(assetSummaryContext, assetArgs),
      writeViaFooter: () => {},
      clearProgressForStdout: () => {},
      setClearProgressBeforeStdout: () => {},
      clearProgressIfCurrent: () => {},
      buildReport: metrics.buildReport,
      estimateCostUsd: metrics.estimateCostUsd,
    },
  }

  return ctx
}
