import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'
import { makeAssistantMessage } from './helpers/pi-ai-mock.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error('no model')
  }),
}))

mocks.completeSimple.mockImplementation(async (model: any, _context: any, options: any) =>
  makeAssistantMessage({
    provider: model.provider,
    model: model.id,
    api: model.api,
    text: 'OK',
    usage: { input: 1, output: 1, totalTokens: 2 },
    ...(options?.signal?.aborted ? { stopReason: 'aborted' } : {}),
  })
)

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

function collectStdout() {
  let text = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stdout, getText: () => text }
}

describe('cli LLM provider selection (direct keys)', () => {
  it('uses OpenAI when --model is openai/...', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(['--model', 'openai/gpt-5.2', '--timeout', '2s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
    })

    expect(out.getText().trim()).toBe('OK')
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string }
    expect(model.provider).toBe('openai')
  })

  it('uses Z.AI when --model is zai/...', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(['--model', 'zai/glm-4.7', '--timeout', '2s', 'https://example.com'], {
      env: { Z_AI_API_KEY: 'zai-test', OPENAI_API_KEY: 'openai-test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
    })

    expect(out.getText().trim()).toBe('OK')
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string; baseUrl?: string }
    const options = mocks.completeSimple.mock.calls[0]?.[2] as { apiKey?: string }
    expect(model.provider).toBe('zai')
    expect(options.apiKey).toBe('zai-test')
    expect(model.baseUrl).toBe('https://api.z.ai/api/paas/v4')
  })

  it('uses Google when --model is google/...', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(['--model', 'google/gemini-2.0-flash', '--timeout', '2s', 'https://example.com'], {
      env: { GOOGLE_GENERATIVE_AI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
    })

    expect(out.getText().trim()).toBe('OK')
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string }
    expect(model.provider).toBe('google')
  })

  it('uses xAI when --model is xai/...', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(
      ['--model', 'xai/grok-4-fast-non-reasoning', '--timeout', '2s', 'https://example.com'],
      {
        env: { XAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb()
          },
        }),
      }
    )

    expect(out.getText().trim()).toBe('OK')
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string }
    expect(model.provider).toBe('xai')
  })

  it('uses Anthropic when --model is anthropic/...', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const out = collectStdout()
    await runCli(
      ['--model', 'anthropic/claude-sonnet-4-5', '--timeout', '2s', 'https://example.com'],
      {
        env: { ANTHROPIC_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb()
          },
        }),
      }
    )

    expect(out.getText().trim()).toBe('OK')
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string }
    expect(model.provider).toBe('anthropic')
  })
})
