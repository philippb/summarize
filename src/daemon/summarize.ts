import { execFile } from 'node:child_process'
import { Writable } from 'node:stream'

import { countTokens } from 'gpt-tokenizer'

import { parseGatewayStyleModelId } from '../llm/model-id.js'
import { buildAutoModelAttempts } from '../model-auto.js'
import type { FixedModelSpec } from '../model-spec.js'
import { buildLinkSummaryPrompt } from '../prompts/index.js'
import { parseCliUserModelId } from '../run/env.js'
import { buildFinishLineText } from '../run/finish-line.js'
import { runModelAttempts } from '../run/model-attempts.js'
import { resolveConfigState } from '../run/run-config.js'
import { resolveEnvState } from '../run/run-env.js'
import { createRunMetrics } from '../run/run-metrics.js'
import { resolveModelSelection } from '../run/run-models.js'
import { resolveDesiredOutputTokens } from '../run/run-output.js'
import { createSummaryEngine } from '../run/summary-engine.js'
import type { ModelAttempt } from '../run/types.js'

export type VisiblePageInput = {
  url: string
  title: string | null
  text: string
  truncated: boolean
}

export type StreamSink = {
  writeChunk: (text: string) => void
  onModelChosen: (modelId: string) => void
}

export type VisiblePageMetrics = {
  elapsedMs: number
  summary: string
  details: string | null
  summaryDetailed: string
  detailsDetailed: string | null
}

function guessSiteName(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname || null
  } catch {
    return null
  }
}

function createWritableFromSink(sink: StreamSink): NodeJS.WritableStream {
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

export async function streamSummaryForVisiblePage({
  env,
  fetchImpl,
  input,
  modelOverride,
  sink,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  input: VisiblePageInput
  modelOverride: string | null
  sink: StreamSink
}): Promise<{ usedModel: string; metrics: VisiblePageMetrics }> {
  const envForRun = env
  const startedAt = Date.now()

  const {
    config,
    configPath,
    outputLanguage,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
  } = resolveConfigState({
    envForRun,
    // Minimal CLI defaults expected by config helpers.
    // Some parsers (e.g. parseVideoMode) assume strings and will crash on undefined.
    programOpts: { videoMode: 'auto' },
    languageExplicitlySet: false,
    videoModeExplicitlySet: false,
    cliFlagPresent: false,
    cliProviderArg: null,
  })

  const {
    apiKey,
    openrouterApiKey,
    openrouterConfigured,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    googleConfigured,
    anthropicConfigured,
    cliAvailability,
    envForAuto,
  } = resolveEnvState({ env: envForRun, envForRun, configForCli })

  const {
    requestedModel,
    requestedModelLabel,
    isNamedModelSelection,
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

  const lengthArg = { kind: 'preset', preset: 'xl' } as const
  const desiredOutputTokens = resolveDesiredOutputTokens({ lengthArg, maxOutputTokensArg: null })

  const metrics = createRunMetrics({ env: envForRun, fetchImpl, maxOutputTokensArg: null })
  const llmCalls = metrics.llmCalls

  const stdout = createWritableFromSink(sink)
  const stderr = createWritableFromSink({ writeChunk: () => {}, onModelChosen: () => {} })

  const summaryEngine = createSummaryEngine({
    env: envForRun,
    envForRun,
    stdout,
    stderr,
    execFileImpl: execFile,
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
    llmCalls,
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

  const prompt = buildLinkSummaryPrompt({
    url: input.url,
    title: input.title,
    siteName: guessSiteName(input.url),
    description: null,
    content: input.text,
    truncated: input.truncated,
    hasTranscript: false,
    summaryLength: lengthArg.preset,
    outputLanguage,
    shares: [],
  })
  const promptTokens = countTokens(prompt)

  const attempts: ModelAttempt[] = await (async () => {
    if (isFallbackModel) {
      const catalog = await metrics.getLiteLlmCatalog()
      const all = buildAutoModelAttempts({
        kind: 'website',
        promptTokens,
        desiredOutputTokens,
        requiresVideoUnderstanding: false,
        env: envForAuto,
        config: configForModelSelection,
        catalog,
        openrouterProvidersFromEnv: null,
        cliAvailability,
      })
      return all.map((attempt) => {
        if (attempt.transport !== 'cli')
          return summaryEngine.applyZaiOverrides(attempt as ModelAttempt)
        const parsed = parseCliUserModelId(attempt.userModelId)
        return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
      })
    }

    if (!fixedModelSpec) throw new Error('Internal error: missing fixed model spec')
    if (fixedModelSpec.transport === 'cli') {
      return [
        {
          transport: 'cli',
          userModelId: fixedModelSpec.userModelId,
          llmModelId: null,
          cliProvider: fixedModelSpec.cliProvider,
          cliModel: fixedModelSpec.cliModel,
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: fixedModelSpec.requiredEnv,
        },
      ]
    }

    const openaiOverrides =
      fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
        ? {
            openaiApiKeyOverride: zaiApiKey,
            openaiBaseUrlOverride: zaiBaseUrl,
            forceChatCompletions: true,
          }
        : {}

    return [
      {
        transport: fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
        userModelId: fixedModelSpec.userModelId,
        llmModelId: fixedModelSpec.llmModelId,
        openrouterProviders: fixedModelSpec.openrouterProviders,
        forceOpenRouter: fixedModelSpec.forceOpenRouter,
        requiredEnv: fixedModelSpec.requiredEnv,
        ...openaiOverrides,
      } as ModelAttempt,
    ]
  })()

  const { result, usedAttempt, missingRequiredEnvs, lastError } = await runModelAttempts({
    attempts,
    isFallbackModel,
    isNamedModelSelection,
    envHasKeyFor: summaryEngine.envHasKeyFor,
    formatMissingModelError: summaryEngine.formatMissingModelError,
    runAttempt: async (attempt) => {
      return summaryEngine.runSummaryAttempt({
        attempt,
        prompt,
        allowStreaming: true,
        onModelChosen: (modelId) => sink.onModelChosen(modelId),
      })
    },
  })

  if (!result || !usedAttempt) {
    const missing = [...missingRequiredEnvs].join(', ')
    const msg =
      missing.length > 0
        ? `Missing required env vars for auto selection: ${missing}`
        : lastError instanceof Error
          ? lastError.message
          : 'Summary failed'
    throw new Error(msg)
  }

  const canonicalUsedModel =
    usedAttempt.transport === 'cli'
      ? usedAttempt.userModelId
      : usedAttempt.llmModelId
        ? parseGatewayStyleModelId(usedAttempt.llmModelId).canonical
        : requestedModelLabel

  const report = await metrics.buildReport()
  const costUsd = await metrics.estimateCostUsd()
  const elapsedMs = Date.now() - startedAt

  const label = guessSiteName(input.url)
  const compact = buildFinishLineText({
    elapsedMs,
    label,
    model: canonicalUsedModel,
    report,
    costUsd,
    detailed: false,
    extraParts: null,
  })
  const extended = buildFinishLineText({
    elapsedMs,
    label,
    model: canonicalUsedModel,
    report,
    costUsd,
    detailed: true,
    extraParts: null,
  })

  return {
    usedModel: canonicalUsedModel,
    metrics: {
      elapsedMs,
      summary: compact.line,
      details: compact.details,
      summaryDetailed: extended.line,
      detailsDetailed: extended.details,
    },
  }
}
