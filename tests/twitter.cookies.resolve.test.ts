import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safari: vi.fn(),
  chrome: vi.fn(),
  firefox: vi.fn(),
}))

vi.mock('../packages/core/src/content/transcript/providers/twitter-cookies-safari.js', () => ({
  extractCookiesFromSafari: mocks.safari,
}))

vi.mock('../packages/core/src/content/transcript/providers/twitter-cookies-chrome.js', () => ({
  extractCookiesFromChrome: mocks.chrome,
}))

vi.mock('../packages/core/src/content/transcript/providers/twitter-cookies-firefox.js', () => ({
  extractCookiesFromFirefox: mocks.firefox,
}))

const empty = () => ({ authToken: null, ct0: null, cookieHeader: null, source: null })

describe('twitter cookies resolver', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    mocks.safari.mockReset()
    mocks.chrome.mockReset()
    mocks.firefox.mockReset()
    process.env = { ...savedEnv }
    delete process.env.AUTH_TOKEN
    delete process.env.CT0
    delete process.env.TWITTER_AUTH_TOKEN
    delete process.env.TWITTER_CT0
  })

  it('uses explicit tokens without touching browsers', async () => {
    const mod = await import('../packages/core/src/content/transcript/providers/twitter-cookies.js')

    const res = await mod.resolveTwitterCookies({ authToken: 'auth', ct0: 'csrf' })
    expect(res.cookies.cookieHeader).toBe('auth_token=auth; ct0=csrf')
    expect(res.cookies.source).toBe('CLI argument')
    expect(mocks.safari).not.toHaveBeenCalled()
    expect(mocks.chrome).not.toHaveBeenCalled()
    expect(mocks.firefox).not.toHaveBeenCalled()
  })

  it('uses env vars without touching browsers', async () => {
    process.env.AUTH_TOKEN = 'auth'
    process.env.CT0 = 'csrf'
    const mod = await import('../packages/core/src/content/transcript/providers/twitter-cookies.js')

    const res = await mod.resolveTwitterCookies({})
    expect(res.cookies.cookieHeader).toBe('auth_token=auth; ct0=csrf')
    expect(res.cookies.source).toBe('env AUTH_TOKEN')
    expect(mocks.safari).not.toHaveBeenCalled()
    expect(mocks.chrome).not.toHaveBeenCalled()
    expect(mocks.firefox).not.toHaveBeenCalled()
  })

  it('returns the first browser with both cookies', async () => {
    mocks.safari.mockResolvedValue({
      cookies: { authToken: 'a', ct0: 'c', cookieHeader: 'auth_token=a; ct0=c', source: 'Safari' },
      warnings: [],
    })
    const mod = await import('../packages/core/src/content/transcript/providers/twitter-cookies.js')

    const res = await mod.resolveTwitterCookies({ cookieSource: ['safari', 'chrome', 'firefox'] })
    expect(res.cookies.source).toBe('Safari')
    expect(res.cookies.cookieHeader).toBe('auth_token=a; ct0=c')
    expect(mocks.safari).toHaveBeenCalledTimes(1)
    expect(mocks.chrome).not.toHaveBeenCalled()
  })

  it('falls back to the next browser when needed', async () => {
    mocks.safari.mockResolvedValue({
      cookies: { ...empty(), source: 'Safari' },
      warnings: ['nope'],
    })
    mocks.chrome.mockResolvedValue({
      cookies: { authToken: 'a', ct0: 'c', cookieHeader: 'auth_token=a; ct0=c', source: 'Chrome' },
      warnings: [],
    })
    const mod = await import('../packages/core/src/content/transcript/providers/twitter-cookies.js')

    const res = await mod.resolveTwitterCookies({ cookieSource: ['safari', 'chrome'] })
    expect(res.cookies.source).toBe('Chrome')
    expect(res.warnings).toContain('nope')
    expect(mocks.safari).toHaveBeenCalledTimes(1)
    expect(mocks.chrome).toHaveBeenCalledTimes(1)
  })

  it('returns warnings when no cookies are found', async () => {
    mocks.safari.mockResolvedValue({ cookies: empty(), warnings: [] })
    const mod = await import('../packages/core/src/content/transcript/providers/twitter-cookies.js')

    const res = await mod.resolveTwitterCookies({ cookieSource: ['safari'] })
    expect(res.cookies.cookieHeader).toBeNull()
    expect(res.warnings.join('\n')).toContain('Missing auth_token')
    expect(res.warnings.join('\n')).toContain('Missing ct0')
  })
})
