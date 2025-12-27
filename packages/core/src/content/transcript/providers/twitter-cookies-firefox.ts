import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CookieExtractionResult, TwitterCookies } from './twitter-cookies-utils.js'
import { createEmptyCookies, serializeCookieJar } from './twitter-cookies-utils.js'

function getFirefoxProfilesRoot(): string | null {
  const home = process.env.HOME || ''
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')
  }
  if (process.platform === 'linux') {
    return join(home, '.mozilla', 'firefox')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) return null
    return join(appData, 'Mozilla', 'Firefox', 'Profiles')
  }
  return null
}

function pickFirefoxProfile(profilesRoot: string, profile?: string): string | null {
  if (profile) {
    const candidate = join(profilesRoot, profile, 'cookies.sqlite')
    return existsSync(candidate) ? candidate : null
  }

  const entries = readdirSync(profilesRoot, { withFileTypes: true })
  const defaultRelease = entries.find(
    (entry) => entry.isDirectory() && entry.name.includes('default-release')
  )
  const targetDir = defaultRelease?.name ?? entries.find((entry) => entry.isDirectory())?.name
  if (!targetDir) return null

  const candidate = join(profilesRoot, targetDir, 'cookies.sqlite')
  return existsSync(candidate) ? candidate : null
}

function getFirefoxCookiesPath(profile?: string): string | null {
  const profilesRoot = getFirefoxProfilesRoot()
  if (!profilesRoot || !existsSync(profilesRoot)) return null
  return pickFirefoxProfile(profilesRoot, profile)
}

export async function extractCookiesFromFirefox(profile?: string): Promise<CookieExtractionResult> {
  const warnings: string[] = []
  const cookies: TwitterCookies = createEmptyCookies()

  const cookiesPath = getFirefoxCookiesPath(profile)
  if (!cookiesPath) {
    warnings.push('Firefox cookies database not found.')
    return { cookies, warnings }
  }

  let tempDir: string | null = null

  try {
    tempDir = mkdtempSync(join(tmpdir(), 'twitter-cookies-'))
    const tempDbPath = join(tempDir, 'cookies.sqlite')
    copyFileSync(cookiesPath, tempDbPath)

    const jar: Record<string, string> = {}
    const query =
      "SELECT name, value FROM moz_cookies WHERE host IN ('.x.com', '.twitter.com', 'x.com', 'twitter.com');"

    const result = execSync(`sqlite3 -separator '|' "${tempDbPath}" "${query}"`, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).trim()

    if (result) {
      for (const line of result.split('\n')) {
        const [name, value] = line.split('|')
        if (!name || !value) continue
        jar[name] = value
        if (name === 'auth_token' && !cookies.authToken) {
          cookies.authToken = value
        } else if (name === 'ct0' && !cookies.ct0) {
          cookies.ct0 = value
        }
      }
    }

    if (Object.keys(jar).length > 0) {
      cookies.cookieHeader = serializeCookieJar(jar)
    }

    if (cookies.authToken || cookies.ct0) {
      cookies.source = profile ? `Firefox profile "${profile}"` : 'Firefox default profile'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(`Failed to read Firefox cookies: ${message}`)
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }

  if (!cookies.authToken && !cookies.ct0) {
    warnings.push(
      'No Twitter cookies found in Firefox. Make sure you are logged into x.com in Firefox and the profile exists.'
    )
  }

  return { cookies, warnings }
}
