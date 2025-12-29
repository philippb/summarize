import { describe, expect, it } from 'vitest'

import { generateTextWithModelId } from '../../src/llm/generate-text.js'

const LIVE = process.env.SUMMARIZE_LIVE_TEST === '1'

function shouldSoftSkipLiveError(message: string): boolean {
  return /(model.*not found|does not exist|permission|access|unauthorized|forbidden|404|not_found|model_not_found)/i.test(
    message
  )
}

;(LIVE ? describe : describe.skip)('live model smoke', () => {
  const timeoutMs = 120_000

  const apiKeys = {
    xaiApiKey: process.env.XAI_API_KEY ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    googleApiKey:
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  }

  it(
    'OpenAI (gpt-5.2) returns text',
    async () => {
      if (!apiKeys.openaiApiKey) {
        it.skip('requires OPENAI_API_KEY', () => {})
        return
      }
      try {
        const result = await generateTextWithModelId({
          modelId: 'openai/gpt-5.2',
          apiKeys,
          prompt: { userText: 'Say exactly: ok' },
          maxOutputTokens: 32,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
        expect(result.text.trim().length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldSoftSkipLiveError(message)) return
        throw error
      }
    },
    timeoutMs
  )

  it(
    'Anthropic (opus 4.x) returns text',
    async () => {
      if (!apiKeys.anthropicApiKey) {
        it.skip('requires ANTHROPIC_API_KEY', () => {})
        return
      }
      try {
        const result = await generateTextWithModelId({
          modelId: 'anthropic/claude-opus-4-1',
          apiKeys,
          prompt: { userText: 'Say exactly: ok' },
          maxOutputTokens: 32,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
        expect(result.text.trim().length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldSoftSkipLiveError(message)) return
        throw error
      }
    },
    timeoutMs
  )

  it(
    'xAI (grok 4.1 fast) returns text',
    async () => {
      if (!apiKeys.xaiApiKey) {
        it.skip('requires XAI_API_KEY', () => {})
        return
      }
      try {
        const result = await generateTextWithModelId({
          modelId: 'xai/grok-4-1-fast',
          apiKeys,
          prompt: { userText: 'Say exactly: ok' },
          maxOutputTokens: 32,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
        expect(result.text.trim().length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldSoftSkipLiveError(message)) return
        throw error
      }
    },
    timeoutMs
  )

  it(
    'Google (Gemini 3 Flash) returns text',
    async () => {
      if (!apiKeys.googleApiKey) {
        it.skip('requires GEMINI_API_KEY', () => {})
        return
      }
      try {
        const result = await generateTextWithModelId({
          modelId: 'google/gemini-3-flash-preview',
          apiKeys,
          prompt: { userText: 'Say exactly: ok' },
          maxOutputTokens: 32,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
        })
        expect(result.text.trim().length).toBeGreaterThan(0)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (shouldSoftSkipLiveError(message)) return
        throw error
      }
    },
    timeoutMs
  )
})
