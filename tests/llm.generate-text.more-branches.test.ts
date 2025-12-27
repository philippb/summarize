import { describe, expect, it, vi } from 'vitest'

import { generateTextWithModelId, streamTextWithModelId } from '../src/llm/generate-text.js'
import { makeAssistantMessage, makeTextDeltaStream } from './helpers/pi-ai-mock.js'

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

describe('llm/generate-text extra branches', () => {
  it('streamTextWithModelId resolves usage=null when stream.result rejects', async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(['o', 'k'], makeAssistantMessage({ text: 'ok' }), {
        error: new Error('no usage'),
      })
    )

    const result = await streamTextWithModelId({
      modelId: 'openai/gpt-5.2',
      apiKeys: {
        openaiApiKey: 'k',
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: null,
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    })

    const chunks: string[] = []
    for await (const chunk of result.textStream) chunks.push(chunk)
    expect(chunks.join('')).toBe('ok')
    await expect(result.usage).resolves.toBeNull()
  })

  it('streamTextWithModelId normalizes anthropic access errors via error events', async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(['o', 'k'], makeAssistantMessage({ text: 'ok', provider: 'anthropic' }), {
        error: Object.assign(new Error('model: claude-3-5-sonnet-latest'), {
          statusCode: 403,
          responseBody: JSON.stringify({
            type: 'error',
            error: { type: 'permission_error', message: 'model: claude-3-5-sonnet-latest' },
          }),
        }),
      })
    )

    const result = await streamTextWithModelId({
      modelId: 'anthropic/claude-3-5-sonnet-latest',
      apiKeys: {
        openaiApiKey: null,
        xaiApiKey: null,
        googleApiKey: null,
        anthropicApiKey: 'k',
        openrouterApiKey: null,
      },
      prompt: 'hi',
      timeoutMs: 2000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      maxOutputTokens: 10,
    })

    for await (const _chunk of result.textStream) {
      // Drain stream to observe error event and store lastError.
    }
    const err = result.lastError()
    expect(err instanceof Error ? err.message : String(err)).toMatch(
      /Anthropic API rejected model/i
    )
  })

  it('generateTextWithModelId retries on timeout-like errors', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      let calls = 0
      mocks.completeSimple.mockImplementation(async () => {
        calls += 1
        if (calls === 1) throw new Error('timed out')
        return makeAssistantMessage({ text: 'OK' })
      })

      const onRetry = vi.fn()
      const promise = generateTextWithModelId({
        modelId: 'openai/gpt-5.2',
        apiKeys: {
          openaiApiKey: 'k',
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
        retries: 1,
        onRetry,
      })

      await vi.runOnlyPendingTimersAsync()
      const result = await promise
      expect(result.text).toBe('OK')
      expect(onRetry).toHaveBeenCalled()
      expect(calls).toBe(2)
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('throws missing key errors for openai/... models', async () => {
    mocks.completeSimple.mockReset()
    await expect(
      generateTextWithModelId({
        modelId: 'openai/gpt-5.2',
        apiKeys: {
          openaiApiKey: null,
          xaiApiKey: null,
          googleApiKey: null,
          anthropicApiKey: null,
          openrouterApiKey: null,
        },
        prompt: 'hi',
        timeoutMs: 2000,
        fetchImpl: globalThis.fetch.bind(globalThis),
        maxOutputTokens: 10,
      })
    ).rejects.toThrow(/Missing OPENAI_API_KEY/i)
  })
})
