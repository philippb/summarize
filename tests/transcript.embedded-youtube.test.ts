import { describe, expect, it } from 'vitest'
import { extractEmbeddedYouTubeUrlFromHtml } from '../src/content/link-preview/transcript/utils.js'

describe('extractEmbeddedYouTubeUrlFromHtml', () => {
  it('returns a watch URL for a lightweight embed page', () => {
    const html = `<!doctype html><html><body>
      <p>Episode page</p>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`

    expect(extractEmbeddedYouTubeUrlFromHtml(html)).toBe(
      'https://www.youtube.com/watch?v=abcdefghijk'
    )
  })

  it('skips embed detection when the page has lots of text', () => {
    const filler = 'lorem ipsum '.repeat(300)
    const html = `<!doctype html><html><body>
      <p>${filler}</p>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`

    expect(extractEmbeddedYouTubeUrlFromHtml(html)).toBeNull()
  })

  it('handles og:video embed URLs', () => {
    const html = `<!doctype html><html><head>
      <meta property="og:video" content="//www.youtube.com/embed/abcdefghijk" />
    </head><body><p>Short page</p></body></html>`

    expect(extractEmbeddedYouTubeUrlFromHtml(html)).toBe(
      'https://www.youtube.com/watch?v=abcdefghijk'
    )
  })
})
