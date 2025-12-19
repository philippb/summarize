import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const generateTextMock = vi.fn(async () => ({
  text: 'OK',
  usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
}))
const streamTextMock = vi.fn(() => {
  const error = new Error(
    'models/gemini-3-flash-preview is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.'
  ) as Error & { url?: string; statusCode?: number; responseBody?: string }
  error.url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse'
  error.statusCode = 404
  error.responseBody = JSON.stringify({
    error: {
      code: 404,
      status: 'NOT_FOUND',
      message:
        'models/gemini-3-flash-preview is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.',
    },
  })
  throw error
})

vi.mock('ai', () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

const createGoogleMock = vi.fn(({ apiKey }: { apiKey: string }) => {
  void apiKey
  return (_modelId: string) => ({})
})

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: createGoogleMock,
}))

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

describe('cli google streaming fallback', () => {
  it('falls back to non-streaming when streamGenerateContent is rejected at runtime', async () => {
    generateTextMock.mockClear()
    streamTextMock.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-google-stream-fallback-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gemini-3-flash-preview': {
          input_cost_per_token: 0.0000002,
          output_cost_per_token: 0.0000008,
        },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')) {
        expect(init?.method ?? 'GET').toBe('GET')
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-3-flash-preview',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const stdout = collectStream()
    ;(stdout.stream as unknown as { isTTY?: boolean }).isTTY = true
    const stderr = collectStream()

    await runCli(
      ['--model', 'google/gemini-3-flash-preview', '--timeout', '2s', '--stream', 'on', pdfPath],
      {
        env: { HOME: root, GOOGLE_GENERATIVE_AI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(generateTextMock).toHaveBeenCalledTimes(1)
    expect(streamTextMock).toHaveBeenCalledTimes(1)
  })

  it('still streams when ListModels omits streamGenerateContent', async () => {
    generateTextMock.mockClear()
    streamTextMock.mockClear()

    streamTextMock.mockImplementationOnce(() => ({
      textStream: {
        async *[Symbol.asyncIterator]() {
          yield 'STREAMED'
        },
      },
      totalUsage: Promise.resolve({ promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
    }))

    const root = mkdtempSync(join(tmpdir(), 'summarize-google-stream-ok-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'gemini-3-flash-preview': {
          input_cost_per_token: 0.0000002,
          output_cost_per_token: 0.0000008,
        },
      }),
      'utf8'
    )
    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.meta.json'),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      'utf8'
    )

    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?key=')) {
        expect(init?.method ?? 'GET').toBe('GET')
        return new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-3-flash-preview',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const stdout = collectStream()
    ;(stdout.stream as unknown as { isTTY?: boolean }).isTTY = true
    const stderr = collectStream()

    await runCli(
      ['--model', 'google/gemini-3-flash-preview', '--timeout', '2s', '--stream', 'on', pdfPath],
      {
        env: { HOME: root, GOOGLE_GENERATIVE_AI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('STREAMED')
    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(generateTextMock).toHaveBeenCalledTimes(0)
  })
})
