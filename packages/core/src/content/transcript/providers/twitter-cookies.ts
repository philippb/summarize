import { extractCookiesFromChrome } from './twitter-cookies-chrome.js'
import { extractCookiesFromFirefox } from './twitter-cookies-firefox.js'
import { extractCookiesFromSafari } from './twitter-cookies-safari.js'
import type { CookieExtractionResult, CookieSource } from './twitter-cookies-utils.js'
import { createEmptyCookies, normalizeValue } from './twitter-cookies-utils.js'

const DEFAULT_SOURCES: CookieSource[] = ['safari', 'chrome', 'firefox']

export async function resolveTwitterCookies(options: {
  authToken?: string
  ct0?: string
  cookieSource?: CookieSource | CookieSource[]
  chromeProfile?: string
  firefoxProfile?: string
}): Promise<CookieExtractionResult> {
  const warnings: string[] = []
  const cookies = createEmptyCookies()

  const cookieSource = options.cookieSource

  if (options.authToken) {
    cookies.authToken = options.authToken
    cookies.source = 'CLI argument'
  }
  if (options.ct0) {
    cookies.ct0 = options.ct0
    if (!cookies.source) cookies.source = 'CLI argument'
  }

  const envAuthKeys = ['AUTH_TOKEN', 'TWITTER_AUTH_TOKEN']
  const envCt0Keys = ['CT0', 'TWITTER_CT0']

  if (!cookies.authToken) {
    for (const key of envAuthKeys) {
      const value = normalizeValue(process.env[key])
      if (value) {
        cookies.authToken = value
        cookies.source = `env ${key}`
        break
      }
    }
  }

  if (!cookies.ct0) {
    for (const key of envCt0Keys) {
      const value = normalizeValue(process.env[key])
      if (value) {
        cookies.ct0 = value
        if (!cookies.source) cookies.source = `env ${key}`
        break
      }
    }
  }

  if (cookies.authToken && cookies.ct0) {
    cookies.cookieHeader = `auth_token=${cookies.authToken}; ct0=${cookies.ct0}`
    return { cookies, warnings }
  }

  const sourcesToTry: CookieSource[] = Array.isArray(cookieSource)
    ? cookieSource
    : cookieSource
      ? [cookieSource]
      : DEFAULT_SOURCES

  for (const source of sourcesToTry) {
    if (source === 'safari') {
      const safariResult = await extractCookiesFromSafari()
      warnings.push(...safariResult.warnings)
      if (safariResult.cookies.authToken && safariResult.cookies.ct0) {
        return { cookies: safariResult.cookies, warnings }
      }
      continue
    }

    if (source === 'chrome') {
      const chromeResult = await extractCookiesFromChrome(options.chromeProfile)
      warnings.push(...chromeResult.warnings)
      if (chromeResult.cookies.authToken && chromeResult.cookies.ct0) {
        return { cookies: chromeResult.cookies, warnings }
      }
      continue
    }

    if (source === 'firefox') {
      const firefoxResult = await extractCookiesFromFirefox(options.firefoxProfile)
      warnings.push(...firefoxResult.warnings)
      if (firefoxResult.cookies.authToken && firefoxResult.cookies.ct0) {
        return { cookies: firefoxResult.cookies, warnings }
      }
    }
  }

  if (!cookies.authToken) {
    warnings.push(
      'Missing auth_token - provide via AUTH_TOKEN env var, or login to x.com in Safari/Chrome/Firefox'
    )
  }
  if (!cookies.ct0) {
    warnings.push(
      'Missing ct0 - provide via CT0 env var, or login to x.com in Safari/Chrome/Firefox'
    )
  }

  if (cookies.authToken && cookies.ct0) {
    cookies.cookieHeader = `auth_token=${cookies.authToken}; ct0=${cookies.ct0}`
  }

  return { cookies, warnings }
}

export type {
  CookieExtractionResult,
  CookieSource,
  TwitterCookies,
} from './twitter-cookies-utils.js'
