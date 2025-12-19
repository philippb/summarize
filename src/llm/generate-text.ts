import type { ModelMessage } from 'ai'
import { parseGatewayStyleModelId } from './model-id.js'

export type LlmApiKeys = {
  xaiApiKey: string | null
  openaiApiKey: string | null
  googleApiKey: string | null
  anthropicApiKey: string | null
}

export type LlmTokenUsage = {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

function normalizeTokenUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as Record<string, unknown>

  const promptTokens =
    typeof usage.promptTokens === 'number' && Number.isFinite(usage.promptTokens)
      ? usage.promptTokens
      : typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
        ? usage.inputTokens
        : null
  const completionTokens =
    typeof usage.completionTokens === 'number' && Number.isFinite(usage.completionTokens)
      ? usage.completionTokens
      : typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
        ? usage.outputTokens
        : null
  const totalTokens =
    typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : null

  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

export async function generateTextWithModelId({
  modelId,
  apiKeys,
  system,
  prompt,
  maxOutputTokens,
  timeoutMs,
  temperature,
  fetchImpl,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: string | ModelMessage[]
  maxOutputTokens?: number
  timeoutMs: number
  temperature: number
  fetchImpl: typeof fetch
}): Promise<{
  text: string
  canonicalModelId: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic'
  usage: LlmTokenUsage | null
}> {
  const parsed = parseGatewayStyleModelId(modelId)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const { generateText } = await import('ai')

    if (parsed.provider === 'xai') {
      const apiKey = apiKeys.xaiApiKey
      if (!apiKey) throw new Error('Missing XAI_API_KEY for xai/... model')
      const { createXai } = await import('@ai-sdk/xai')
      const xai = createXai({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: xai(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        temperature,
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
      }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey) throw new Error('Missing GOOGLE_GENERATIVE_AI_API_KEY for google/... model')
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const google = createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: google(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        temperature,
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
      }
    }

    if (parsed.provider === 'anthropic') {
      const apiKey = apiKeys.anthropicApiKey
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const anthropic = createAnthropic({ apiKey, fetch: fetchImpl })
      const result = await generateText({
        model: anthropic(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        temperature,
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
      })
      return {
        text: result.text,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
      }
    }

    const apiKey = apiKeys.openaiApiKey
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY for openai/... model')
    const { createOpenAI } = await import('@ai-sdk/openai')
    const openai = createOpenAI({ apiKey, fetch: fetchImpl })
    const result = await generateText({
      model: openai(parsed.model),
      system,
      ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
      temperature,
      ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
      abortSignal: controller.signal,
    })
    return {
      text: result.text,
      canonicalModelId: parsed.canonical,
      provider: parsed.provider,
      usage: normalizeTokenUsage((result as unknown as { usage?: unknown }).usage),
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('LLM request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function streamTextWithModelId({
  modelId,
  apiKeys,
  system,
  prompt,
  maxOutputTokens,
  timeoutMs,
  temperature,
  fetchImpl,
}: {
  modelId: string
  apiKeys: LlmApiKeys
  system?: string
  prompt: string | ModelMessage[]
  maxOutputTokens?: number
  timeoutMs: number
  temperature: number
  fetchImpl: typeof fetch
}): Promise<{
  textStream: AsyncIterable<string>
  canonicalModelId: string
  provider: 'xai' | 'openai' | 'google' | 'anthropic'
  usage: Promise<LlmTokenUsage | null>
  lastError: () => unknown
}> {
  const parsed = parseGatewayStyleModelId(modelId)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const { streamText } = await import('ai')
    let lastError: unknown = null
    const onError = ({ error }: { error: unknown }) => {
      lastError = error
    }

    if (parsed.provider === 'xai') {
      const apiKey = apiKeys.xaiApiKey
      if (!apiKey) throw new Error('Missing XAI_API_KEY for xai/... model')
      const { createXai } = await import('@ai-sdk/xai')
      const xai = createXai({ apiKey, fetch: fetchImpl })
      const result = streamText({
        model: xai(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        temperature,
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
        onError,
      })
      return {
        textStream: result.textStream,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'google') {
      const apiKey = apiKeys.googleApiKey
      if (!apiKey) throw new Error('Missing GOOGLE_GENERATIVE_AI_API_KEY for google/... model')
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const google = createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })
      const result = streamText({
        model: google(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        temperature,
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
        onError,
      })
      return {
        textStream: result.textStream,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
        lastError: () => lastError,
      }
    }

    if (parsed.provider === 'anthropic') {
      const apiKey = apiKeys.anthropicApiKey
      if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY for anthropic/... model')
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const anthropic = createAnthropic({ apiKey, fetch: fetchImpl })
      const result = streamText({
        model: anthropic(parsed.model),
        system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        temperature,
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
        abortSignal: controller.signal,
        onError,
      })
      return {
        textStream: result.textStream,
        canonicalModelId: parsed.canonical,
        provider: parsed.provider,
        usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
        lastError: () => lastError,
      }
    }

    const apiKey = apiKeys.openaiApiKey
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY for openai/... model')
    const { createOpenAI } = await import('@ai-sdk/openai')
    const openai = createOpenAI({ apiKey, fetch: fetchImpl })
    const result = streamText({
      model: openai(parsed.model),
      system,
      ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
      temperature,
      ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
      abortSignal: controller.signal,
      onError,
    })
    return {
      textStream: result.textStream,
      canonicalModelId: parsed.canonical,
      provider: parsed.provider,
      usage: result.totalUsage.then((raw) => normalizeTokenUsage(raw)).catch(() => null),
      lastError: () => lastError,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('LLM request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
