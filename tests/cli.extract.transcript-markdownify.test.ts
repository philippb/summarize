import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const mocks = vi.hoisted(() => ({
  generateTextWithModelId: vi.fn(async () => ({
    text: '# How to Speak\n\nHello everyone. Today we talk about speaking.',
    canonicalModelId: 'openai/gpt-5-mini',
    provider: 'openai',
    usage: null,
  })),
}))

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: mocks.generateTextWithModelId,
}))

const jsonResponse = (payload: unknown, status = 200) =>
  Response.json(payload, { status, headers: { 'Content-Type': 'application/json' } })

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('cli --extract --format md --markdown-mode llm (transcript markdownify)', () => {
  it('converts YouTube transcript to markdown via LLM when --markdown-mode llm is specified', async () => {
    mocks.generateTextWithModelId.mockClear()
    const youtubeHtml =
      '<!doctype html><html><head><title>How to Speak</title><meta name="description" content="MIT lecture" />' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1});</script>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions"}]}},"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body><main><p>Fallback</p></main></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '')

      // YouTube page fetch
      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResponse(youtubeHtml))
      }

      // YouTube transcript API
      if (url.includes('youtubei/v1/get_transcript')) {
        return Promise.resolve(
          jsonResponse({
            actions: [
              {
                updateEngagementPanelAction: {
                  content: {
                    transcriptRenderer: {
                      content: {
                        transcriptSearchPanelRenderer: {
                          body: {
                            transcriptSegmentListRenderer: {
                              initialSegments: [
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'SPEAKER: Hello everyone.' }] },
                                  },
                                },
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: {
                                      runs: [{ text: 'Um, today we talk about speaking.' }],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          })
        )
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const stdoutChunks: string[] = []
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutChunks.push(chunk.toString())
        callback()
      },
    })

    const stderrChunks: string[] = []
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(chunk.toString())
        callback()
      },
    })

    await runCli(
      [
        '--extract',
        '--format',
        'md',
        '--markdown-mode',
        'llm',
        '--timeout',
        '10s',
        'https://www.youtube.com/watch?v=abcdefghijk',
      ],
      {
        env: { OPENROUTER_API_KEY: 'test-key' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    const output = stdoutChunks.join('')
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(1)
    const generateArgs = (mocks.generateTextWithModelId.mock.calls[0]?.[0] ?? {}) as {
      prompt?: { system?: string; userText?: string }
    }
    expect(generateArgs.prompt?.system).toContain('convert raw transcripts')
    expect(generateArgs.prompt?.userText).toContain('SPEAKER: Hello everyone')
    // Should contain the LLM-formatted markdown, not raw transcript
    expect(output).toContain('# How to Speak')
    expect(output).toContain('Hello everyone')
    // Should NOT contain the raw "SPEAKER:" prefix or "Um,"
    expect(output).not.toContain('SPEAKER:')
  })

  it('outputs raw transcript when --markdown-mode is not llm (default behavior)', async () => {
    mocks.generateTextWithModelId.mockClear()
    const youtubeHtml =
      '<!doctype html><html><head><title>Test Video</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1});</script>' +
      '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions"}]}},"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
      '</head><body><main><p>Fallback</p></main></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '')

      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResponse(youtubeHtml))
      }

      if (url.includes('youtubei/v1/get_transcript')) {
        return Promise.resolve(
          jsonResponse({
            actions: [
              {
                updateEngagementPanelAction: {
                  content: {
                    transcriptRenderer: {
                      content: {
                        transcriptSearchPanelRenderer: {
                          body: {
                            transcriptSegmentListRenderer: {
                              initialSegments: [
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'Raw transcript line one' }] },
                                  },
                                },
                                {
                                  transcriptSegmentRenderer: {
                                    snippet: { runs: [{ text: 'Raw transcript line two' }] },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            ],
          })
        )
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const stdoutChunks: string[] = []
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutChunks.push(chunk.toString())
        callback()
      },
    })

    await runCli(['--extract', '--timeout', '10s', 'https://www.youtube.com/watch?v=abcdefghijk'], {
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: new Writable({ write: (_c, _e, cb) => cb() }),
    })

    const output = stdoutChunks.join('')
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(0)
    // Should contain raw transcript
    expect(output).toContain('Raw transcript line one')
    expect(output).toContain('Raw transcript line two')
  })

  it('requires API key when --markdown-mode llm is specified', async () => {
    const youtubeHtml =
      '<!doctype html><html><head><title>Test</title>' +
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}}});</script>' +
      '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST"}};</script>' +
      '</head><body></body></html>'

    const fetchMock = vi.fn<[RequestInfo | URL], Promise<Response>>((input) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '')
      if (url.includes('youtube.com/watch')) {
        return Promise.resolve(htmlResponse(youtubeHtml))
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${url}`))
    })

    const noopStream = () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      })

    // Should throw an error about missing API key
    await expect(
      runCli(
        [
          '--extract',
          '--format',
          'md',
          '--markdown-mode',
          'llm',
          'https://www.youtube.com/watch?v=test',
        ],
        {
          env: {}, // No API keys
          fetch: fetchMock as unknown as typeof fetch,
          stdout: noopStream(),
          stderr: noopStream(),
        }
      )
    ).rejects.toThrow(/GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY/)
  })
})
