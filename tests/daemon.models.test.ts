import { describe, expect, it, vi } from 'vitest'

import { buildModelPickerOptions } from '../src/daemon/models.js'

describe('daemon /v1/models', () => {
  it('includes local OpenAI-compatible models without OPENAI_API_KEY', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined()
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'llama3.1' }] }),
      } as Response
    }) as unknown as typeof fetch

    const result = await buildModelPickerOptions({
      env: {},
      envForRun: { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' },
      configForCli: null,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(result.localModelsSource).toEqual({
      kind: 'openai-compatible',
      baseUrlHost: '127.0.0.1:11434',
    })
    expect(result.options.some((o) => o.id === 'openai/llama3.1')).toBe(true)
  })

  it('does not probe local models for OpenRouter base URLs', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not fetch /models for OpenRouter')
    }) as unknown as typeof fetch

    const result = await buildModelPickerOptions({
      env: {},
      envForRun: { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENROUTER_API_KEY: 'k' },
      configForCli: null,
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(result.providers.openrouter).toBe(true)
    expect(result.localModelsSource).toBeNull()
    expect(result.options.some((o) => o.id === 'free')).toBe(true)
  })
})
