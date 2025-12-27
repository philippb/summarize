import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveTwitterCookies } from '../src/run/cookies/twitter.js'

function makeTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'summarize-twitter-cookies-'))
}

function touch(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, 'x')
}

describe('twitter cookies resolver (CLI)', () => {
  it('returns cookies-from-browser when chrome store exists', async () => {
    const home = makeTempHome()
    touch(
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies')
    )

    const res = await resolveTwitterCookies({ env: {}, platform: 'darwin', homeDir: home })
    expect(res.cookies.cookiesFromBrowser).toBe('chrome')
    expect(res.cookies.source).toBe('Chrome')
    expect(res.warnings).toHaveLength(0)
  })

  it('uses cookie source order and profile from env', async () => {
    const home = makeTempHome()
    touch(
      path.join(
        home,
        'Library',
        'Application Support',
        'Firefox',
        'Profiles',
        'default-release',
        'cookies.sqlite'
      )
    )

    const res = await resolveTwitterCookies({
      env: {
        TWITTER_COOKIE_SOURCE: 'firefox, chrome',
        TWITTER_FIREFOX_PROFILE: 'default-release',
      },
      platform: 'darwin',
      homeDir: home,
    })
    expect(res.cookies.cookiesFromBrowser).toBe('firefox:default-release')
    expect(res.cookies.source).toBe('Firefox (default-release)')
    expect(res.warnings).toHaveLength(0)
  })

  it('skips missing sources and returns the first available store', async () => {
    const home = makeTempHome()
    touch(
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies')
    )

    const res = await resolveTwitterCookies({
      env: {},
      cookieSource: ['safari', 'chrome'],
      platform: 'darwin',
      homeDir: home,
    })
    expect(res.cookies.cookiesFromBrowser).toBe('chrome')
    expect(res.cookies.source).toBe('Chrome')
  })

  it('returns explicit source with warning when store is missing', async () => {
    const home = makeTempHome()

    const res = await resolveTwitterCookies({
      env: { TWITTER_COOKIE_SOURCE: 'safari' },
      platform: 'darwin',
      homeDir: home,
    })
    expect(res.cookies.cookiesFromBrowser).toBe('safari')
    expect(res.cookies.source).toBe('Safari')
    expect(res.warnings.join('\n')).toContain('No cookie store found')
  })

  it('returns null when no cookie stores are found', async () => {
    const home = makeTempHome()

    const res = await resolveTwitterCookies({ env: {}, platform: 'darwin', homeDir: home })
    expect(res.cookies.cookiesFromBrowser).toBeNull()
    expect(res.warnings.join('\n')).toContain('No browser cookies found')
  })

  it('warns about unknown cookie source tokens', async () => {
    const home = makeTempHome()
    touch(
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies')
    )

    const res = await resolveTwitterCookies({
      env: { TWITTER_COOKIE_SOURCE: 'chrome, foo' },
      platform: 'darwin',
      homeDir: home,
    })
    expect(res.warnings.join('\n')).toContain('Unknown cookie source "foo"')
    expect(res.cookies.cookiesFromBrowser).toBe('chrome')
  })
})
