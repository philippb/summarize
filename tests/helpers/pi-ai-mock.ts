type UsageOverrides = Partial<{
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}>

export function makeAssistantMessage({
  text = 'OK',
  provider = 'openai',
  model = 'gpt-5.2',
  api = 'openai-responses',
  usage,
  stopReason = 'stop',
}: {
  text?: string
  provider?: string
  model?: string
  api?: string
  usage?: UsageOverrides
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
}) {
  const input = usage?.input ?? 1
  const output = usage?.output ?? 1
  const cacheRead = usage?.cacheRead ?? 0
  const cacheWrite = usage?.cacheWrite ?? 0
  const totalTokens = usage?.totalTokens ?? input + output + cacheRead + cacheWrite

  return {
    role: 'assistant' as const,
    api: api as any,
    provider,
    model,
    stopReason,
    timestamp: Date.now(),
    content: [{ type: 'text' as const, text }],
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

export function makeTextDeltaStream(
  deltas: string[],
  finalMessage: ReturnType<typeof makeAssistantMessage>,
  {
    error,
  }: {
    error?: unknown
  } = {}
) {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        yield {
          type: 'text_delta' as const,
          contentIndex: 0,
          delta,
          partial: finalMessage,
        }
      }
      if (error) {
        yield { type: 'error' as const, reason: 'error' as const, error: error as any }
        return
      }
      yield { type: 'done' as const, reason: 'stop' as const, message: finalMessage as any }
    },
    async result() {
      if (error) throw error
      return finalMessage as any
    },
  }

  return stream
}
