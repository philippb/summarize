import { describe, expect, it, vi } from 'vitest'

const generateTextWithModelIdMock = vi.fn(async () => ({
  text: '# Hello',
  canonicalModelId: 'openai/gpt-5.2',
  provider: 'openai',
}))

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: generateTextWithModelIdMock,
}))

describe('HTML→Markdown converter', async () => {
  const { createHtmlToMarkdownConverter } = await import('../src/llm/html-to-markdown.js')

  it('passes system + prompt to generateTextWithModelId', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createHtmlToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      openrouterApiKey: null,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const result = await converter({
      url: 'https://example.com',
      title: 'Example',
      siteName: 'Example',
      html: '<html><body><h1>Hello</h1></body></html>',
      timeoutMs: 2000,
    })

    expect(result).toBe('# Hello')
    expect(generateTextWithModelIdMock).toHaveBeenCalledTimes(1)
    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as {
      prompt: { system?: string; userText: string }
      modelId: string
    }
    expect(args.modelId).toBe('openai/gpt-5.2')
    expect(args.prompt.system).toContain('You convert HTML')
    expect(args.prompt.userText).toContain('URL: https://example.com')
    expect(args.prompt.userText).toContain('<h1>Hello</h1>')
  })

  it('truncates very large HTML inputs', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createHtmlToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      openrouterApiKey: null,
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const html = `<html><body>${'A'.repeat(200_005)}MARKER</body></html>`
    await converter({
      url: 'https://example.com',
      title: null,
      siteName: null,
      html,
      timeoutMs: 2000,
    })

    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as {
      prompt: { userText: string }
    }
    expect(args.prompt.userText).not.toContain('MARKER')
  })

  it('does not forward OpenRouter provider options to generateTextWithModelId', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createHtmlToMarkdownConverter({
      modelId: 'openai/openai/gpt-oss-20b',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: null,
      openrouterApiKey: 'test',
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    await converter({
      url: 'https://example.com',
      title: 'Example',
      siteName: 'Example',
      html: '<html><body><h1>Hello</h1></body></html>',
      timeoutMs: 2000,
    })

    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as {
      openrouter?: unknown
    }
    expect(args.openrouter).toBeUndefined()
  })
})
