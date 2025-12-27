import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

mocks.completeSimple.mockImplementation(async (model: any) =>
  makeAssistantMessage({ text: 'OK', provider: model.provider, model: model.id, api: model.api })
)

vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}))

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

function captureStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

describe('cli config precedence', () => {
  it('uses config file model when --model and SUMMARIZE_MODEL are absent', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const tempRoot = mkdtempSync(join(tmpdir(), 'summarize-cli-config-'))
    const configPath = join(tempRoot, '.summarize', 'config.json')
    mkdirSync(join(tempRoot, '.summarize'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ model: { id: 'openai/gpt-5.2' } }), 'utf8')

    await runCli(['--timeout', '2s', 'https://example.com'], {
      env: { HOME: tempRoot, OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: noopStream(),
      stderr: noopStream(),
    })

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1)
  })

  it('uses config file model preset when --model and SUMMARIZE_MODEL are absent', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const tempRoot = mkdtempSync(join(tmpdir(), 'summarize-cli-config-'))
    const configPath = join(tempRoot, '.summarize', 'config.json')
    mkdirSync(join(tempRoot, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: 'mypreset',
        models: {
          mypreset: {
            mode: 'auto',
            rules: [{ candidates: ['openai/gpt-5.2'] }],
          },
        },
      }),
      'utf8'
    )

    const stdout = captureStream()

    await runCli(
      ['--timeout', '2s', '--extract', '--format', 'text', '--json', 'https://example.com'],
      {
        env: { HOME: tempRoot },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: noopStream(),
      }
    )

    const parsed = JSON.parse(stdout.getText()) as { input: { model: string } }
    expect(parsed.input.model).toBe('mypreset')

    // --extract means no LLM calls; ensure we didn't try to init a provider.
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0)
  })

  it('prefers SUMMARIZE_MODEL over config file', async () => {
    mocks.completeSimple.mockClear()

    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const tempRoot = mkdtempSync(join(tmpdir(), 'summarize-cli-config-'))
    const configPath = join(tempRoot, '.summarize', 'config.json')
    mkdirSync(join(tempRoot, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({ model: { id: 'xai/grok-4-fast-non-reasoning' } }),
      'utf8'
    )

    const stdout = captureStream()

    await runCli(
      ['--timeout', '2s', '--extract', '--format', 'text', '--json', 'https://example.com'],
      {
        env: { HOME: tempRoot, SUMMARIZE_MODEL: 'openai/gpt-5.2' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: noopStream(),
      }
    )

    const parsed = JSON.parse(stdout.getText()) as { input: { model: string } }
    expect(parsed.input.model).toBe('openai/gpt-5.2')

    // --extract means no LLM calls; ensure we didn't try to init a provider.
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0)
  })
})
