import type { Message } from '@mariozechner/pi-ai'
import { streamTextWithContext } from '../llm/generate-text.js'
import { buildAutoModelAttempts } from '../model-auto.js'

type ChatSession = {
  id: string
  lastMeta: {
    model: string | null
    modelLabel: string | null
    inputSummary: string | null
    summaryFromCache: boolean | null
  }
}

type ChatRequest = {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  session: ChatSession
  pageUrl: string
  pageTitle: string | null
  pageContent: string
  messages: Message[]
  modelOverride: string | null
  pushToSession: (event: { event: string } & Record<string, unknown>) => void
  emitMeta: (patch: { model?: string | null }) => void
}

function normalizeMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    timestamp: message.timestamp ?? Date.now(),
  }))
}

export async function streamChatResponse({
  env,
  fetchImpl,
  session,
  pageUrl,
  pageTitle,
  pageContent,
  messages,
  modelOverride,
  pushToSession,
  emitMeta,
}: ChatRequest): Promise<void> {
  void session
  void pageUrl
  void pageTitle
  void pageContent

  const apiKeys = {
    xaiApiKey: env.XAI_API_KEY ?? null,
    openaiApiKey: env.OPENAI_API_KEY ?? null,
    googleApiKey: env.GEMINI_API_KEY ?? null,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    openrouterApiKey: env.OPENROUTER_API_KEY ?? null,
  }

  let modelId = modelOverride ?? ''
  let forceOpenRouter = false
  let displayModel = modelOverride

  if (modelOverride) {
    if (modelOverride.toLowerCase().startsWith('openrouter/')) {
      if (!apiKeys.openrouterApiKey) {
        throw new Error('Missing OPENROUTER_API_KEY')
      }
      modelId = modelOverride.replace(/^openrouter\//i, 'openai/')
      forceOpenRouter = true
    } else {
      modelId = modelOverride
    }
  } else {
    const attempts = buildAutoModelAttempts({
      kind: 'text',
      promptTokens: null,
      desiredOutputTokens: null,
      requiresVideoUnderstanding: false,
      env,
      config: null,
      catalog: null,
      openrouterProvidersFromEnv: null,
    })
    const attempt = attempts[0]
    if (!attempt) {
      throw new Error('No model available for chat')
    }
    modelId = attempt.llmModelId ?? attempt.userModelId
    forceOpenRouter = attempt.forceOpenRouter
    displayModel = attempt.userModelId
  }

  emitMeta({ model: displayModel ?? null })

  const context = {
    systemPrompt: undefined,
    messages: normalizeMessages(messages),
  }

  const { textStream } = await streamTextWithContext({
    modelId,
    apiKeys,
    context,
    timeoutMs: 30_000,
    fetchImpl,
    forceOpenRouter,
  })

  for await (const _chunk of textStream) {
    // Streaming handled by caller; no-op for tests.
  }

  pushToSession({ event: 'metrics' })
}
