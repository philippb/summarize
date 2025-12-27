import { countTokens } from 'gpt-tokenizer'
import { render as renderMarkdownAnsi } from 'markdansi'
import {
  buildLanguageKey,
  buildLengthKey,
  buildPromptHash,
  buildSummaryCacheKey,
  hashString,
  normalizeContentForHash,
} from '../../../cache.js'
import type { ExtractedLinkContent } from '../../../content/index.js'
import { formatOutputLanguageForJson } from '../../../language.js'
import { parseGatewayStyleModelId } from '../../../llm/model-id.js'
import { buildAutoModelAttempts } from '../../../model-auto.js'
import { buildLinkSummaryPrompt } from '../../../prompts/index.js'
import { parseCliUserModelId } from '../../env.js'
import {
  buildExtractFinishLabel,
  buildLengthPartsForFinishLine,
  writeFinishLine,
} from '../../finish-line.js'
import { writeVerbose } from '../../logging.js'
import { prepareMarkdownForTerminal } from '../../markdown.js'
import { runModelAttempts } from '../../model-attempts.js'
import { buildOpenRouterNoAllowedProvidersMessage } from '../../openrouter.js'
import { isRichTty, markdownRenderWidth, supportsColor } from '../../terminal.js'
import type { ModelAttempt } from '../../types.js'
import type { UrlExtractionUi } from './extract.js'
import type { UrlFlowContext } from './types.js'

export function buildUrlPrompt({
  extracted,
  outputLanguage,
  lengthArg,
  promptOverride,
  lengthInstruction,
  languageInstruction,
}: {
  extracted: ExtractedLinkContent
  outputLanguage: UrlFlowContext['flags']['outputLanguage']
  lengthArg: UrlFlowContext['flags']['lengthArg']
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
}): string {
  const isYouTube = extracted.siteName === 'YouTube'
  return buildLinkSummaryPrompt({
    url: extracted.url,
    title: extracted.title,
    siteName: extracted.siteName,
    description: extracted.description,
    content: extracted.content,
    truncated: extracted.truncated,
    hasTranscript:
      isYouTube ||
      (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable'),
    summaryLength:
      lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
    outputLanguage,
    shares: [],
    promptOverride: promptOverride ?? null,
    lengthInstruction: lengthInstruction ?? null,
    languageInstruction: languageInstruction ?? null,
  })
}

const buildFinishExtras = ({
  extracted,
  metricsDetailed,
  transcriptionCostLabel,
}: {
  extracted: ExtractedLinkContent
  metricsDetailed: boolean
  transcriptionCostLabel: string | null
}) => {
  const parts = [
    ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
    ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
  ]
  return parts.length > 0 ? parts : null
}

const pickModelForFinishLine = (
  llmCalls: UrlFlowContext['model']['llmCalls'],
  fallback: string | null
) => {
  const findLastModel = (purpose: (typeof llmCalls)[number]['purpose']): string | null => {
    for (let i = llmCalls.length - 1; i >= 0; i -= 1) {
      const call = llmCalls[i]
      if (call && call.purpose === purpose) return call.model
    }
    return null
  }

  return (
    findLastModel('summary') ??
    findLastModel('markdown') ??
    (llmCalls.length > 0 ? (llmCalls[llmCalls.length - 1]?.model ?? null) : null) ??
    fallback
  )
}

const buildModelMetaFromAttempt = (attempt: ModelAttempt) => {
  if (attempt.transport === 'cli') {
    return { provider: 'cli' as const, canonical: attempt.userModelId }
  }
  const parsed = parseGatewayStyleModelId(attempt.llmModelId ?? attempt.userModelId)
  const canonical = attempt.userModelId.toLowerCase().startsWith('openrouter/')
    ? attempt.userModelId
    : parsed.canonical
  return { provider: parsed.provider, canonical }
}

export async function outputExtractedUrl({
  ctx,
  url,
  extracted,
  extractionUi,
  prompt,
  effectiveMarkdownMode,
  transcriptionCostLabel,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
}) {
  const { io, flags, model, hooks } = ctx

  hooks.clearProgressForStdout()
  const finishLabel = buildExtractFinishLabel({
    extracted: { diagnostics: extracted.diagnostics },
    format: flags.format,
    markdownMode: effectiveMarkdownMode,
    hasMarkdownLlmCall: model.llmCalls.some((call) => call.purpose === 'markdown'),
  })
  const finishModel = pickModelForFinishLine(model.llmCalls, null)

  if (flags.json) {
    const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: flags.timeoutMs,
        youtube: flags.youtubeMode,
        firecrawl: flags.firecrawlMode,
        format: flags.format,
        markdown: effectiveMarkdownMode,
        length:
          flags.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: flags.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: flags.lengthArg.maxCharacters },
        maxOutputTokens: flags.maxOutputTokensArg,
        model: model.requestedModelLabel,
        language: formatOutputLanguageForJson(flags.outputLanguage),
      },
      env: {
        hasXaiKey: Boolean(model.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(model.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(model.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(model.apiStatus.apifyToken),
        hasFirecrawlKey: model.apiStatus.firecrawlConfigured,
        hasGoogleKey: model.apiStatus.googleConfigured,
        hasAnthropicKey: model.apiStatus.anthropicConfigured,
      },
      extracted,
      prompt,
      llm: null,
      metrics: flags.metricsEnabled ? finishReport : null,
      summary: null,
    }
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (flags.metricsEnabled && finishReport) {
      const costUsd = await hooks.estimateCostUsd()
      writeFinishLine({
        stderr: io.stderr,
        elapsedMs: Date.now() - flags.runStartedAtMs,
        label: finishLabel,
        model: finishModel,
        report: finishReport,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: flags.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: flags.verboseColor,
      })
    }
    return
  }

  const renderedExtract =
    flags.format === 'markdown' && !flags.plain && isRichTty(io.stdout)
      ? renderMarkdownAnsi(prepareMarkdownForTerminal(extracted.content), {
          width: markdownRenderWidth(io.stdout, io.env),
          wrap: true,
          color: supportsColor(io.stdout, io.envForRun),
          hyperlinks: true,
        })
      : extracted.content

  if (flags.format === 'markdown' && !flags.plain && isRichTty(io.stdout)) {
    io.stdout.write(`\n${renderedExtract.replace(/^\n+/, '')}`)
  } else {
    io.stdout.write(renderedExtract)
  }
  if (!renderedExtract.endsWith('\n')) {
    io.stdout.write('\n')
  }
  hooks.writeViaFooter(extractionUi.footerParts)
  const report = flags.shouldComputeReport ? await hooks.buildReport() : null
  if (flags.metricsEnabled && report) {
    const costUsd = await hooks.estimateCostUsd()
    writeFinishLine({
      stderr: io.stderr,
      elapsedMs: Date.now() - flags.runStartedAtMs,
      label: finishLabel,
      model: finishModel,
      report,
      costUsd,
      detailed: flags.metricsDetailed,
      extraParts: buildFinishExtras({
        extracted,
        metricsDetailed: flags.metricsDetailed,
        transcriptionCostLabel,
      }),
      color: flags.verboseColor,
    })
  }
}

export async function summarizeExtractedUrl({
  ctx,
  url,
  extracted,
  extractionUi,
  prompt,
  effectiveMarkdownMode,
  transcriptionCostLabel,
  onModelChosen,
}: {
  ctx: UrlFlowContext
  url: string
  extracted: ExtractedLinkContent
  extractionUi: UrlExtractionUi
  prompt: string
  effectiveMarkdownMode: 'off' | 'auto' | 'llm' | 'readability'
  transcriptionCostLabel: string | null
  onModelChosen?: ((modelId: string) => void) | null
}) {
  const { io, flags, model, cache: cacheState, hooks } = ctx

  const promptTokens = countTokens(prompt)
  const kindForAuto = extracted.siteName === 'YouTube' ? ('youtube' as const) : ('website' as const)

  const attempts: ModelAttempt[] = await (async () => {
    if (model.isFallbackModel) {
      const catalog = await model.getLiteLlmCatalog()
      const list = buildAutoModelAttempts({
        kind: kindForAuto,
        promptTokens,
        desiredOutputTokens: model.desiredOutputTokens,
        requiresVideoUnderstanding: false,
        env: model.envForAuto,
        config: model.configForModelSelection,
        catalog,
        openrouterProvidersFromEnv: null,
        cliAvailability: model.cliAvailability,
      })
      if (flags.verbose) {
        for (const attempt of list.slice(0, 8)) {
          writeVerbose(
            io.stderr,
            flags.verbose,
            `auto candidate ${attempt.debug}`,
            flags.verboseColor
          )
        }
      }
      return list.map((attempt) => {
        if (attempt.transport !== 'cli')
          return model.summaryEngine.applyZaiOverrides(attempt as ModelAttempt)
        const parsed = parseCliUserModelId(attempt.userModelId)
        return { ...attempt, cliProvider: parsed.provider, cliModel: parsed.model }
      })
    }
    /* v8 ignore next */
    if (!model.fixedModelSpec) {
      throw new Error('Internal error: missing fixed model spec')
    }
    if (model.fixedModelSpec.transport === 'cli') {
      return [
        {
          transport: 'cli',
          userModelId: model.fixedModelSpec.userModelId,
          llmModelId: null,
          cliProvider: model.fixedModelSpec.cliProvider,
          cliModel: model.fixedModelSpec.cliModel,
          openrouterProviders: null,
          forceOpenRouter: false,
          requiredEnv: model.fixedModelSpec.requiredEnv,
        },
      ]
    }
    const openaiOverrides =
      model.fixedModelSpec.requiredEnv === 'Z_AI_API_KEY'
        ? {
            openaiApiKeyOverride: model.apiStatus.zaiApiKey,
            openaiBaseUrlOverride: model.apiStatus.zaiBaseUrl,
            forceChatCompletions: true,
          }
        : {}
    return [
      {
        transport: model.fixedModelSpec.transport === 'openrouter' ? 'openrouter' : 'native',
        userModelId: model.fixedModelSpec.userModelId,
        llmModelId: model.fixedModelSpec.llmModelId,
        openrouterProviders: model.fixedModelSpec.openrouterProviders,
        forceOpenRouter: model.fixedModelSpec.forceOpenRouter,
        requiredEnv: model.fixedModelSpec.requiredEnv,
        ...openaiOverrides,
      },
    ]
  })()

  const cacheStore = cacheState.mode === 'default' ? cacheState.store : null
  const contentHash = cacheStore ? hashString(normalizeContentForHash(extracted.content)) : null
  const promptHash = cacheStore ? buildPromptHash(prompt) : null
  const lengthKey = buildLengthKey(flags.lengthArg)
  const languageKey = buildLanguageKey(flags.outputLanguage)

  let summaryResult: Awaited<ReturnType<typeof model.summaryEngine.runSummaryAttempt>> | null = null
  let usedAttempt: ModelAttempt | null = null
  let summaryFromCache = false
  let cacheChecked = false

  if (cacheStore && contentHash && promptHash) {
    cacheChecked = true
    for (const attempt of attempts) {
      if (!model.summaryEngine.envHasKeyFor(attempt.requiredEnv)) continue
      const key = buildSummaryCacheKey({
        contentHash,
        promptHash,
        model: attempt.userModelId,
        lengthKey,
        languageKey,
      })
      const cached = cacheStore.getText('summary', key)
      if (!cached) continue
      writeVerbose(io.stderr, flags.verbose, 'cache hit summary', flags.verboseColor)
      onModelChosen?.(attempt.userModelId)
      summaryResult = {
        summary: cached,
        summaryAlreadyPrinted: false,
        modelMeta: buildModelMetaFromAttempt(attempt),
        maxOutputTokensForCall: null,
      }
      usedAttempt = attempt
      summaryFromCache = true
      break
    }
  }
  if (cacheChecked && !summaryFromCache) {
    writeVerbose(io.stderr, flags.verbose, 'cache miss summary', flags.verboseColor)
  }
  ctx.hooks.onSummaryCached?.(summaryFromCache)

  let lastError: unknown = null
  let missingRequiredEnvs = new Set<ModelAttempt['requiredEnv']>()
  let sawOpenRouterNoAllowedProviders = false

  if (!summaryResult || !usedAttempt) {
    const attemptOutcome = await runModelAttempts({
      attempts,
      isFallbackModel: model.isFallbackModel,
      isNamedModelSelection: model.isNamedModelSelection,
      envHasKeyFor: model.summaryEngine.envHasKeyFor,
      formatMissingModelError: model.summaryEngine.formatMissingModelError,
      onAutoSkip: (attempt) => {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `auto skip ${attempt.userModelId}: missing ${attempt.requiredEnv}`,
          flags.verboseColor
        )
      },
      onAutoFailure: (attempt, error) => {
        writeVerbose(
          io.stderr,
          flags.verbose,
          `auto failed ${attempt.userModelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          flags.verboseColor
        )
      },
      onFixedModelError: (_attempt, error) => {
        throw error
      },
      runAttempt: (attempt) =>
        model.summaryEngine.runSummaryAttempt({
          attempt,
          prompt,
          allowStreaming: flags.streamingEnabled,
          onModelChosen: onModelChosen ?? null,
        }),
    })
    summaryResult = attemptOutcome.result
    usedAttempt = attemptOutcome.usedAttempt
    lastError = attemptOutcome.lastError
    missingRequiredEnvs = attemptOutcome.missingRequiredEnvs
    sawOpenRouterNoAllowedProviders = attemptOutcome.sawOpenRouterNoAllowedProviders
  }

  if (!summaryResult || !usedAttempt) {
    // Auto mode: surface raw extracted content when no model can run.
    const withFreeTip = (message: string) => {
      if (!model.isNamedModelSelection || !model.wantsFreeNamedModel) return message
      return (
        `${message}\n` +
        `Tip: run "summarize refresh-free" to refresh the free model candidates (writes ~/.summarize/config.json).`
      )
    }

    if (model.isNamedModelSelection) {
      if (lastError === null && missingRequiredEnvs.size > 0) {
        throw new Error(
          withFreeTip(
            `Missing ${Array.from(missingRequiredEnvs).sort().join(', ')} for --model ${model.requestedModelInput}.`
          )
        )
      }
      if (lastError instanceof Error) {
        if (sawOpenRouterNoAllowedProviders) {
          const message = await buildOpenRouterNoAllowedProvidersMessage({
            attempts,
            fetchImpl: io.fetch,
            timeoutMs: flags.timeoutMs,
          })
          throw new Error(withFreeTip(message), { cause: lastError })
        }
        throw new Error(withFreeTip(lastError.message), { cause: lastError })
      }
      throw new Error(withFreeTip(`No model available for --model ${model.requestedModelInput}`))
    }
    hooks.clearProgressForStdout()
    if (flags.json) {
      const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null
      const finishModel = pickModelForFinishLine(model.llmCalls, null)
      const payload = {
        input: {
          kind: 'url' as const,
          url,
          timeoutMs: flags.timeoutMs,
          youtube: flags.youtubeMode,
          firecrawl: flags.firecrawlMode,
          format: flags.format,
          markdown: effectiveMarkdownMode,
          length:
            flags.lengthArg.kind === 'preset'
              ? { kind: 'preset' as const, preset: flags.lengthArg.preset }
              : { kind: 'chars' as const, maxCharacters: flags.lengthArg.maxCharacters },
          maxOutputTokens: flags.maxOutputTokensArg,
          model: model.requestedModelLabel,
          language: formatOutputLanguageForJson(flags.outputLanguage),
        },
        env: {
          hasXaiKey: Boolean(model.apiStatus.xaiApiKey),
          hasOpenAIKey: Boolean(model.apiStatus.apiKey),
          hasOpenRouterKey: Boolean(model.apiStatus.openrouterApiKey),
          hasApifyToken: Boolean(model.apiStatus.apifyToken),
          hasFirecrawlKey: model.apiStatus.firecrawlConfigured,
          hasGoogleKey: model.apiStatus.googleConfigured,
          hasAnthropicKey: model.apiStatus.anthropicConfigured,
        },
        extracted,
        prompt,
        llm: null,
        metrics: flags.metricsEnabled ? finishReport : null,
        summary: extracted.content,
      }
      io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      if (flags.metricsEnabled && finishReport) {
        const costUsd = await hooks.estimateCostUsd()
        writeFinishLine({
          stderr: io.stderr,
          elapsedMs: Date.now() - flags.runStartedAtMs,
          label: extractionUi.finishSourceLabel,
          model: finishModel,
          report: finishReport,
          costUsd,
          detailed: flags.metricsDetailed,
          extraParts: buildFinishExtras({
            extracted,
            metricsDetailed: flags.metricsDetailed,
            transcriptionCostLabel,
          }),
          color: flags.verboseColor,
        })
      }
      return
    }
    io.stdout.write(`${extracted.content}\n`)
    if (extractionUi.footerParts.length > 0) {
      hooks.writeViaFooter([...extractionUi.footerParts, 'no model'])
    }
    if (lastError instanceof Error && flags.verbose) {
      writeVerbose(
        io.stderr,
        flags.verbose,
        `auto failed all models: ${lastError.message}`,
        flags.verboseColor
      )
    }
    return
  }

  if (!summaryFromCache && cacheStore && contentHash && promptHash) {
    const key = buildSummaryCacheKey({
      contentHash,
      promptHash,
      model: usedAttempt.userModelId,
      lengthKey,
      languageKey,
    })
    cacheStore.setText('summary', key, summaryResult.summary, cacheState.ttlMs)
    writeVerbose(io.stderr, flags.verbose, 'cache write summary', flags.verboseColor)
  }

  const { summary, summaryAlreadyPrinted, modelMeta, maxOutputTokensForCall } = summaryResult

  if (flags.json) {
    const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null
    const payload = {
      input: {
        kind: 'url' as const,
        url,
        timeoutMs: flags.timeoutMs,
        youtube: flags.youtubeMode,
        firecrawl: flags.firecrawlMode,
        format: flags.format,
        markdown: effectiveMarkdownMode,
        length:
          flags.lengthArg.kind === 'preset'
            ? { kind: 'preset' as const, preset: flags.lengthArg.preset }
            : { kind: 'chars' as const, maxCharacters: flags.lengthArg.maxCharacters },
        maxOutputTokens: flags.maxOutputTokensArg,
        model: model.requestedModelLabel,
        language: formatOutputLanguageForJson(flags.outputLanguage),
      },
      env: {
        hasXaiKey: Boolean(model.apiStatus.xaiApiKey),
        hasOpenAIKey: Boolean(model.apiStatus.apiKey),
        hasOpenRouterKey: Boolean(model.apiStatus.openrouterApiKey),
        hasApifyToken: Boolean(model.apiStatus.apifyToken),
        hasFirecrawlKey: model.apiStatus.firecrawlConfigured,
        hasGoogleKey: model.apiStatus.googleConfigured,
        hasAnthropicKey: model.apiStatus.anthropicConfigured,
      },
      extracted,
      prompt,
      llm: {
        provider: modelMeta.provider,
        model: usedAttempt.userModelId,
        maxCompletionTokens: maxOutputTokensForCall,
        strategy: 'single' as const,
      },
      metrics: flags.metricsEnabled ? finishReport : null,
      summary,
    }
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    if (flags.metricsEnabled && finishReport) {
      const costUsd = await hooks.estimateCostUsd()
      writeFinishLine({
        stderr: io.stderr,
        elapsedMs: Date.now() - flags.runStartedAtMs,
        elapsedLabel: summaryFromCache ? 'Cached' : null,
        label: extractionUi.finishSourceLabel,
        model: usedAttempt.userModelId,
        report: finishReport,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: buildFinishExtras({
          extracted,
          metricsDetailed: flags.metricsDetailed,
          transcriptionCostLabel,
        }),
        color: flags.verboseColor,
      })
    }
    return
  }

  if (!summaryAlreadyPrinted) {
    hooks.clearProgressForStdout()
    const rendered =
      !flags.plain && isRichTty(io.stdout)
        ? renderMarkdownAnsi(prepareMarkdownForTerminal(summary), {
            width: markdownRenderWidth(io.stdout, io.env),
            wrap: true,
            color: supportsColor(io.stdout, io.envForRun),
            hyperlinks: true,
          })
        : summary

    if (!flags.plain && isRichTty(io.stdout)) {
      io.stdout.write(`\n${rendered.replace(/^\n+/, '')}`)
    } else {
      if (isRichTty(io.stdout)) io.stdout.write('\n')
      io.stdout.write(rendered.replace(/^\n+/, ''))
    }
    if (!rendered.endsWith('\n')) {
      io.stdout.write('\n')
    }
  }

  const report = flags.shouldComputeReport ? await hooks.buildReport() : null
  if (flags.metricsEnabled && report) {
    const costUsd = await hooks.estimateCostUsd()
    writeFinishLine({
      stderr: io.stderr,
      elapsedMs: Date.now() - flags.runStartedAtMs,
      elapsedLabel: summaryFromCache ? 'Cached' : null,
      label: extractionUi.finishSourceLabel,
      model: modelMeta.canonical,
      report,
      costUsd,
      detailed: flags.metricsDetailed,
      extraParts: buildFinishExtras({
        extracted,
        metricsDetailed: flags.metricsDetailed,
        transcriptionCostLabel,
      }),
      color: flags.verboseColor,
    })
  }
}
