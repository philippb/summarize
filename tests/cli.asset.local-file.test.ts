import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

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
    textStream: createTextStream(['OK']),
    totalUsage: Promise.resolve({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
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

describe('cli asset inputs (local file)', () => {
  it('attaches a local PDF to the model with a detected media type', async () => {
    streamTextMock.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

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

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      [
        '--model',
        'openai/gpt-5.2',
        '--timeout',
        '2s',
        '--stream',
        'on',
        '--render',
        'plain',
        pdfPath,
      ],
      {
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(streamTextMock).toHaveBeenCalledTimes(1)
    const call = streamTextMock.mock.calls[0]?.[0] as { messages?: unknown }
    expect(Array.isArray(call.messages)).toBe(true)
    const messages = call.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]?.role).toBe('user')
    expect(Array.isArray(messages[0]?.content)).toBe(true)
    const parts = messages[0].content as Array<Record<string, unknown>>
    const filePart = parts.find((p) => p.type === 'file') ?? parts.find((p) => p.type === 'image')
    expect(filePart).toBeTruthy()
    expect(filePart?.mediaType).toBe('application/pdf')

    globalFetchSpy.mockRestore()
  })

  it('inlines text files into the prompt instead of attaching a file part', async () => {
    streamTextMock.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-txt-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

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

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'test.txt')
    writeFileSync(txtPath, 'Hello from text file.\nSecond line.\n', 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      [
        '--model',
        'openai/gpt-5.2',
        '--timeout',
        '2s',
        '--stream',
        'on',
        '--render',
        'plain',
        txtPath,
      ],
      {
        env: { HOME: root, OPENAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(streamTextMock).toHaveBeenCalledTimes(1)

    const call = streamTextMock.mock.calls[0]?.[0] as { prompt?: unknown; messages?: unknown }
    expect(typeof call.prompt).toBe('string')
    expect(String(call.prompt)).toContain('Hello from text file.')
    expect(call.messages).toBeUndefined()

    globalFetchSpy.mockRestore()
  })

  it('allows xAI models to summarize local text files (inlined prompt)', async () => {
    streamTextMock.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-local-txt-xai-'))
    const cacheDir = join(root, '.summarize', 'cache')
    mkdirSync(cacheDir, { recursive: true })

    writeFileSync(
      join(cacheDir, 'litellm-model_prices_and_context_window.json'),
      JSON.stringify({
        'grok-4-fast-non-reasoning': {
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

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected LiteLLM catalog fetch')
    })

    const txtPath = join(root, 'test.txt')
    writeFileSync(txtPath, 'Hello from xAI text file.\nSecond line.\n', 'utf8')

    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(
      [
        '--model',
        'xai/grok-4-fast-non-reasoning',
        '--timeout',
        '2s',
        '--stream',
        'on',
        '--render',
        'plain',
        txtPath,
      ],
      {
        env: { HOME: root, XAI_API_KEY: 'test' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
    )

    expect(stdout.getText()).toContain('OK')
    expect(streamTextMock).toHaveBeenCalledTimes(1)

    const call = streamTextMock.mock.calls[0]?.[0] as { prompt?: unknown; messages?: unknown }
    expect(typeof call.prompt).toBe('string')
    expect(String(call.prompt)).toContain('Hello from xAI text file.')
    expect(call.messages).toBeUndefined()

    globalFetchSpy.mockRestore()
  })
})
