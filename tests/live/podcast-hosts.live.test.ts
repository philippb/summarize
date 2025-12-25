import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { runCli } from '../../src/run.js'

const LIVE = process.env.SUMMARIZE_LIVE_TEST === '1'

const collectStream = () => {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})

;(LIVE ? describe : describe.skip)('live podcast hosts', () => {
  const timeoutMs = 180_000

  const expectDescriptionOrTranscript = ({
    description,
    content,
    minDescriptionChars,
  }: {
    description: string
    content: string
    minDescriptionChars: number
  }) => {
    expect(description.length).toBeGreaterThan(minDescriptionChars)
    expect(content.trim().length).toBeGreaterThan(200)

    const looksLikeTranscript =
      /^transcript:/i.test(content.trim()) ||
      content.length >= Math.max(1200, description.length + 400) ||
      /\n{3,}/.test(content)

    if (looksLikeTranscript) {
      // Podcast links: prefer full transcript/content when available.
      expect(content.length).toBeGreaterThanOrEqual(1200)
      return
    }

    // Fallback: description-sized content when no transcript is available.
    expect(content).toContain(description.slice(0, Math.min(50, description.length)))
    expect(content.length).toBeLessThan(description.length + 120)
  }

  it(
    'podbean share prefers description-sized content',
    async () => {
      const out = collectStream()
      await runCli(
        [
          '--extract',
          '--json',
          '--timeout',
          '120s',
          'https://www.podbean.com/media/share/dir-6wa7k-29a23114',
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        }
      )

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string }
      }
      const description = payload.extracted?.description ?? ''
      const content = payload.extracted?.content ?? ''
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 80 })
    },
    timeoutMs
  )

  it(
    'amazon music episode prefers description-sized content (requires Firecrawl)',
    async () => {
      const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY?.trim() ?? ''
      if (!FIRECRAWL_API_KEY) {
        it.skip('requires FIRECRAWL_API_KEY', () => {})
        return
      }

      const out = collectStream()
      await runCli(
        [
          '--extract',
          '--json',
          '--timeout',
          '120s',
          'https://music.amazon.de/podcasts/61e4318e-659a-46b8-9380-c268b487dc68/episodes/07a8b875-a1d2-4d00-96ea-0bd986c2c7bd/die-j%C3%A4gerin-s2f2-nur-verlierer',
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        }
      )

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string }
      }
      const description = payload.extracted?.description ?? ''
      const content = payload.extracted?.content ?? ''
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 80 })
    },
    timeoutMs
  )

  it(
    'podchaser episode prefers description-sized content',
    async () => {
      const out = collectStream()
      await runCli(
        [
          '--extract',
          '--json',
          '--timeout',
          '120s',
          'https://www.podchaser.com/podcasts/aviation-weeks-check-6-podcast-26817/episodes/check-6-revisits-rtxs-pratt-wh-276449881',
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        }
      )

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string }
      }
      const description = payload.extracted?.description ?? ''
      const content = payload.extracted?.content ?? ''
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 120 })
    },
    timeoutMs
  )

  it(
    'spreaker episode prefers description-sized content',
    async () => {
      const out = collectStream()
      await runCli(
        [
          '--extract',
          '--json',
          '--timeout',
          '120s',
          'https://www.spreaker.com/episode/christmas-eve-by-the-campfire-gratitude-reflection-the-rv-life--69193832',
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        }
      )

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string }
      }
      const description = payload.extracted?.description ?? ''
      const content = payload.extracted?.content ?? ''
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 60 })
    },
    timeoutMs
  )

  it(
    'buzzsprout episode prefers description-sized content',
    async () => {
      const out = collectStream()
      await runCli(
        [
          '--extract',
          '--json',
          '--timeout',
          '120s',
          'https://www.buzzsprout.com/2449647/episodes/18377889-2025-in-review-lessons-learned-in-gratitude-anxiety-growth-confidence-self-worth-bravery-self-compassion-and-so-much-more',
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        }
      )

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string }
      }
      const description = payload.extracted?.description ?? ''
      const content = payload.extracted?.content ?? ''
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 80 })
    },
    timeoutMs
  )
})
