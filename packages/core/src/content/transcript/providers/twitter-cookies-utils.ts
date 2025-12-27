export interface TwitterCookies {
  authToken: string | null
  ct0: string | null
  cookieHeader: string | null
  source: string | null
}

export interface CookieExtractionResult {
  cookies: TwitterCookies
  warnings: string[]
}

export type CookieSource = 'safari' | 'chrome' | 'firefox'

export function normalizeValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

export function serializeCookieJar(jar: Record<string, string>): string {
  const entries = Object.entries(jar)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  return entries.map(([name, value]) => `${name}=${value}`).join('; ')
}

export function createEmptyCookies(): TwitterCookies {
  return {
    authToken: null,
    ct0: null,
    cookieHeader: null,
    source: null,
  }
}
