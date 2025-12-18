import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

function collectStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

function createTextStream(chunks: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const streamTextMock = vi.fn(() => {
  return {
    textStream: createTextStream(['Hello', ' world']),
    totalUsage: Promise.resolve({
      promptTokens: 123_456,
      completionTokens: 7_890,
      totalTokens: 131_346,
    }),
  }
})

vi.mock('ai', () => ({
  streamText: streamTextMock,
}))

const createOpenAIMock = vi.fn(() => {
  return (_modelId: string) => ({})
})

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}))

const createXaiMock = vi.fn(() => {
  return (_modelId: string) => ({})
})

vi.mock('@ai-sdk/xai', () => ({
  createXai: createXaiMock,
}))

describe('cli finish line + cost formatting', () => {
  it('streams text to stdout and prints cost line with cents only', async () => {
    streamTextMock.mockReset().mockImplementation(() => {
      return {
        textStream: createTextStream(['Hello', ' world']),
        totalUsage: Promise.resolve({
          promptTokens: 123_456,
          completionTokens: 7_890,
          totalTokens: 131_346,
        }),
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'summarize-finish-line-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    // LiteLLM cache: gpt-5.2 input=$1.75/1M, output=$14/1M
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gpt-5.2': { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    // ensure LiteLLM network fetch is never attempted
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const stdout = collectStream()
    ;(stdout.stream as unknown as { isTTY?: boolean; columns?: number }).isTTY = true
    ;(stdout.stream as unknown as { columns?: number }).columns = 80
    const stderr = collectStream()

    await runCli(
      [
        '--model',
        'openai/gpt-5.2',
        '--timeout',
        '2s',
        '--stream',
        'auto',
        '--render',
        'plain',
        '--cost',
        'https://example.com',
      ],
      {
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toBe('Hello world\n')
    const err = stderr.getText()
    expect(err).toContain('Finished in')
    expect(err).toContain('cost=$0.33')
    expect(err).toContain('promptTokens=123456')
    expect(err).toContain('completionTokens=7890')
    expect(err).toContain('totalTokens=131346')
    expect(err).toMatch(/cost=\$[0-9]+\.[0-9]{2}\b/)
    expect(err).toContain('tok(i/o/t)=')
    expect(err).not.toContain('firecrawl=')
    expect(err).not.toContain('apify=')
    expect(err).not.toContain('strategy=')
    expect(err).not.toContain('chunks=')
    // ensure we never print >2 decimals
    expect(err).not.toMatch(/\$[0-9]+\.[0-9]{3,}/)

    globalFetchSpy.mockRestore()
  })

  it('prints <$0.01 instead of $0.00 for non-zero costs', async () => {
    streamTextMock.mockReset().mockImplementation(() => {
      return {
        textStream: createTextStream(['Hi']),
        totalUsage: Promise.resolve({
          promptTokens: 10,
          completionTokens: 10,
          totalTokens: 20,
        }),
      }
    })

    const root = mkdtempSync(join(tmpdir(), 'summarize-finish-line-small-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    // LiteLLM cache: key without provider prefix to exercise prefix-stripped resolution for xai/...
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'grok-4-fast-non-reasoning': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000001,
        },
      }),
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

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const stdout = collectStream()
    ;(stdout.stream as unknown as { isTTY?: boolean; columns?: number }).isTTY = true
    ;(stdout.stream as unknown as { columns?: number }).columns = 80
    const stderr = collectStream()

    await runCli(
      [
        '--model',
        'xai/grok-4-fast-non-reasoning',
        '--timeout',
        '2s',
        '--stream',
        'auto',
        '--render',
        'plain',
        '--cost',
        'https://example.com',
      ],
      {
        env: { HOME: root, XAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    const err = stderr.getText()
    expect(err).toContain('cost=<$0.01')
    expect(err).not.toContain('cost=$0.00')
    expect(err).toContain('tok(i/o/t)=10/10/20')
    expect(err).not.toContain('firecrawl=')
    expect(err).not.toContain('apify=')
    expect(err).not.toContain('strategy=')
    expect(err).not.toContain('chunks=')

    globalFetchSpy.mockRestore()
  })
})
