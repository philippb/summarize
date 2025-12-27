import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createCacheStore } from '../src/cache.js'
import { streamSummaryForVisiblePage } from '../src/daemon/summarize.js'
import { makeAssistantMessage, makeTextDeltaStream } from './helpers/pi-ai-mock.js'

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

vi.mock('@mariozechner/pi-ai', () => ({
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

describe('daemon summary cache', () => {
  it('reuses cached summary for visible page requests', async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ['### Overview\n- Cached summary.\n'],
        makeAssistantMessage({
          text: '### Overview\n- Cached summary.\n',
          usage: { input: 1, output: 1, totalTokens: 2 },
        })
      )
    )
    mocks.streamSimple.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-daemon-cache-'))
    const summarizeDir = join(root, '.summarize')
    const cacheDir = join(summarizeDir, 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({ 'gpt-5.2': { max_input_tokens: 999_999 } }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const cachePath = join(summarizeDir, 'cache.sqlite')
    const store = await createCacheStore({ path: cachePath, maxBytes: 1024 * 1024 })
    const cacheState = {
      mode: 'default' as const,
      store,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      maxBytes: 1024 * 1024,
      path: cachePath,
    }

    const runOnce = async () => {
      let out = ''
      const sink = {
        writeChunk: (text: string) => {
          out += text
        },
        onModelChosen: () => {},
      }

      const result = await streamSummaryForVisiblePage({
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetchImpl: globalThis.fetch.bind(globalThis),
        input: {
          url: 'https://example.com/article',
          title: 'Hello',
          text: 'Content',
          truncated: false,
        },
        modelOverride: 'openai/gpt-5.2',
        promptOverride: null,
        lengthRaw: 'xl',
        languageRaw: 'auto',
        sink,
        cache: cacheState,
      })

      return { out, metrics: result.metrics }
    }

    const first = await runOnce()
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1)

    const second = await runOnce()
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1)
    expect(second.out).toBe(first.out)
    expect(second.metrics.summary.split(' · ')[0]).toBe('Cached')

    store.close()
    globalFetchSpy.mockRestore()
  })
})
