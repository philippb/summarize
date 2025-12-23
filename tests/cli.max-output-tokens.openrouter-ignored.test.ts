import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({ text: 'OK' }))

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(({ apiKey }: { apiKey: string }) => {
    const createSeeableModel = (modelId: string) => ({ provider: 'openai', modelId, apiKey })
    return Object.assign(createSeeableModel, {
      chat: (modelId: string) => ({ provider: 'openai-chat', modelId, apiKey }),
    })
  }),
}))

const collectStdout = () => {
  let text = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stdout, getText: () => text }
}

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

describe('--max-output-tokens (OpenRouter)', () => {
  it('does not send maxOutputTokens to OpenRouter calls (avoids empty reasoning-only responses)', async () => {
    generateTextMock.mockReset().mockResolvedValue({ text: 'OK' })
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
      [
        '--model',
        'openrouter/openai/gpt-5-mini',
        '--max-output-tokens',
        '1234',
        '--timeout',
        '2s',
        'https://example.com',
      ],
      {
        env: { OPENROUTER_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: silentStderr,
      }
    )

    const args = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.hasOwn(args, 'maxOutputTokens')).toBe(false)
  })
})
