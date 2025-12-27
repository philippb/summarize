import { execFile } from 'node:child_process'
import { Writable } from 'node:stream'

import type { OutputLanguage } from '../language.js'
import { parseGatewayStyleModelId } from '../llm/model-id.js'
import { buildAutoModelAttempts } from '../model-auto.js'
import type { FixedModelSpec } from '../model-spec.js'
import { parseCliUserModelId } from '../run/env.js'
import { runModelAttempts } from '../run/model-attempts.js'
import { resolveConfigState } from '../run/run-config.js'
import { resolveEnvState } from '../run/run-env.js'
import { createRunMetrics } from '../run/run-metrics.js'
import { resolveModelSelection } from '../run/run-models.js'
import { resolveDesiredOutputTokens } from '../run/run-output.js'
import { createSummaryEngine } from '../run/summary-engine.js'
import type { ModelAttempt } from '../run/types.js'

import type { StreamSink } from './summarize.js'

export type DaemonRunContext = {
  envForRun: Record<string, string | undefined>
  outputLanguage: OutputLanguage
  desiredOutputTokens: number | null
  metrics: ReturnType<typeof createRunMetrics>
  summaryEngine: ReturnType<typeof createSummaryEngine>
  requestedModelLabel: string | null
  isNamedModelSelection: boolean
  isFallbackModel: boolean
  fixedModelSpec: FixedModelSpec | null
  configForModelSelection: ReturnType<typeof resolveModelSelection>['configForModelSelection']
  envForAuto: Record<string, string | undefined>
  cliAvailability: ReturnType<typeof resolveEnvState>['cliAvailability']
  zaiApiKey: string | null
  zaiBaseUrl: string
  apifyApiToken: string | null
  ytDlpPath: string | null
  falApiKey: string | null
  openaiTranscriptionKey: string | null
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

export function createDaemonRunContext({
  env,
  fetchImpl,
  modelOverride,
  sink,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  modelOverride: string | null
  sink: StreamSink
}): DaemonRunContext {
  const envForRun = env

  const {
    config,
    configPath,
    outputLanguage,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
  } = resolveConfigState({
    envForRun,
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
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
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

  return {
    envForRun,
    outputLanguage,
    desiredOutputTokens,
    metrics,
    summaryEngine,
    requestedModelLabel,
    isNamedModelSelection,
    isFallbackModel,
    fixedModelSpec,
    configForModelSelection,
    envForAuto,
    cliAvailability,
    zaiApiKey,
    zaiBaseUrl,
    apifyApiToken: apifyToken,
    ytDlpPath,
    falApiKey,
    openaiTranscriptionKey,
  }
}

async function buildModelAttemptsForPrompt({
  ctx,
  promptTokens,
  kind,
  requiresVideoUnderstanding,
}: {
  ctx: DaemonRunContext
  promptTokens: number | null
  kind: Parameters<typeof buildAutoModelAttempts>[0]['kind']
  requiresVideoUnderstanding: boolean
}): Promise<ModelAttempt[]> {
  if (ctx.isFallbackModel) {
    const catalog = await ctx.metrics.getLiteLlmCatalog()
    const all = buildAutoModelAttempts({
      kind,
      promptTokens,
      desiredOutputTokens: ctx.desiredOutputTokens,
      requiresVideoUnderstanding,
      env: ctx.envForAuto,
      config: ctx.configForModelSelection,
      catalog,
      openrouterProvidersFromEnv: null,
      cliAvailability: ctx.cliAvailability,
    })
    return all.map((attempt) => {
      if (attempt.transport !== 'cli')
        return ctx.summaryEngine.applyZaiOverrides(attempt as ModelAttempt)
      const parsed = parseCliUserModelId(attempt.userModelId)
      return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
    })
  }

  if (!ctx.fixedModelSpec) throw new Error('Internal error: missing fixed model spec')
  if (ctx.fixedModelSpec.transport === 'cli') {
    return [
      {
        transport: 'cli',
        userModelId: ctx.fixedModelSpec.userModelId,
        llmModelId: null,
        cliProvider: ctx.fixedModelSpec.cliProvider,
        cliModel: ctx.fixedModelSpec.cliModel,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: ctx.fixedModelSpec.requiredEnv,
      },
    ]
  }

  const openaiOverrides =
    ctx.fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
      ? {
          openaiApiKeyOverride: ctx.zaiApiKey,
          openaiBaseUrlOverride: ctx.zaiBaseUrl,
          forceChatCompletions: true,
        }
      : {}

  return [
    {
      transport: ctx.fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
      userModelId: ctx.fixedModelSpec.userModelId,
      llmModelId: ctx.fixedModelSpec.llmModelId,
      openrouterProviders: ctx.fixedModelSpec.openrouterProviders,
      forceOpenRouter: ctx.fixedModelSpec.forceOpenRouter,
      requiredEnv: ctx.fixedModelSpec.requiredEnv,
      ...openaiOverrides,
    } as ModelAttempt,
  ]
}

function pickCanonicalUsedModel({
  usedAttempt,
  requestedModelLabel,
}: {
  usedAttempt: ModelAttempt
  requestedModelLabel: string | null
}): string {
  return usedAttempt.transport === 'cli'
    ? usedAttempt.userModelId
    : usedAttempt.llmModelId
      ? parseGatewayStyleModelId(usedAttempt.llmModelId).canonical
      : (requestedModelLabel ?? 'unknown')
}

export async function runPrompt({
  ctx,
  prompt,
  promptTokens,
  kind,
  requiresVideoUnderstanding,
  sink,
}: {
  ctx: DaemonRunContext
  prompt: string
  promptTokens: number | null
  kind: Parameters<typeof buildAutoModelAttempts>[0]['kind']
  requiresVideoUnderstanding: boolean
  sink: StreamSink
}): Promise<{ usedModel: string }> {
  const attempts = await buildModelAttemptsForPrompt({
    ctx,
    promptTokens,
    kind,
    requiresVideoUnderstanding,
  })

  const { result, usedAttempt, missingRequiredEnvs, lastError } = await runModelAttempts({
    attempts,
    isFallbackModel: ctx.isFallbackModel,
    isNamedModelSelection: ctx.isNamedModelSelection,
    envHasKeyFor: ctx.summaryEngine.envHasKeyFor,
    formatMissingModelError: ctx.summaryEngine.formatMissingModelError,
    runAttempt: async (attempt) => {
      return ctx.summaryEngine.runSummaryAttempt({
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

  return {
    usedModel: pickCanonicalUsedModel({
      usedAttempt,
      requestedModelLabel: ctx.requestedModelLabel,
    }),
  }
}
