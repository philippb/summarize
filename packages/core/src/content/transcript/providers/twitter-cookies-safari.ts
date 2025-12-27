import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CookieExtractionResult, TwitterCookies } from './twitter-cookies-utils.js'
import { createEmptyCookies, normalizeValue, serializeCookieJar } from './twitter-cookies-utils.js'

const SAFARI_COOKIE_DOMAINS = ['x.com', 'twitter.com']
const SAFARI_PAGE_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00])

function getSafariCookiesPath(): string | null {
  if (process.platform !== 'darwin') return null
  const home = process.env.HOME || ''
  const candidates = [
    join(home, 'Library', 'Cookies', 'Cookies.binarycookies'),
    join(
      home,
      'Library',
      'Containers',
      'com.apple.Safari',
      'Data',
      'Library',
      'Cookies',
      'Cookies.binarycookies'
    ),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function matchesSafariDomain(domain: string | null): boolean {
  if (!domain) return false
  const normalized = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase()
  return SAFARI_COOKIE_DOMAINS.some(
    (target) => normalized === target || normalized.endsWith(`.${target}`)
  )
}

function readSafariCString(buffer: Buffer, start: number, end: number): string | null {
  if (start < 0 || start >= end) return null
  let cursor = start
  while (cursor < end && buffer[cursor] !== 0) cursor += 1
  if (cursor >= end) return null
  return buffer.toString('utf8', start, cursor)
}

function parseSafariCookieRecord(
  page: Buffer,
  offset: number,
  jar: Record<string, string>,
  cookies: TwitterCookies
): void {
  if (offset < 0 || offset + 4 > page.length) return
  const recordSize = page.readUInt32LE(offset)
  const recordEnd = offset + recordSize
  if (recordSize <= 0 || recordEnd > page.length) return

  const headerStart = offset + 4
  const headerSize = 4 + 4 + 4 + 4 + 4 + 4 + 4
  if (headerStart + headerSize > recordEnd) return

  const domainOffset = page.readUInt32LE(headerStart + 12)
  const nameOffset = page.readUInt32LE(headerStart + 16)
  const valueOffset = page.readUInt32LE(headerStart + 24)

  const domain = readSafariCString(page, offset + domainOffset, recordEnd)
  const name = readSafariCString(page, offset + nameOffset, recordEnd)
  const value = readSafariCString(page, offset + valueOffset, recordEnd)

  if (!name || !value || !matchesSafariDomain(domain)) return

  const normalizedValue = normalizeValue(value)
  if (!normalizedValue) return

  jar[name] = normalizedValue

  if (name === 'auth_token' && !cookies.authToken) {
    cookies.authToken = normalizedValue
  } else if (name === 'ct0' && !cookies.ct0) {
    cookies.ct0 = normalizedValue
  }
}

function parseSafariCookiePage(
  page: Buffer,
  jar: Record<string, string>,
  cookies: TwitterCookies
): void {
  if (page.length < 12) return
  if (!page.subarray(0, 4).equals(SAFARI_PAGE_SIGNATURE)) return
  const cookieCount = page.readUInt32LE(4)
  if (!cookieCount) return

  const offsets: number[] = []
  let cursor = 8
  for (let i = 0; i < cookieCount; i += 1) {
    if (cursor + 4 > page.length) return
    offsets.push(page.readUInt32LE(cursor))
    cursor += 4
  }

  for (const offset of offsets) {
    parseSafariCookieRecord(page, offset, jar, cookies)
  }
}

function parseSafariCookies(
  data: Buffer,
  jar: Record<string, string>,
  cookies: TwitterCookies
): void {
  if (data.length < 8) return
  if (data.subarray(0, 4).toString('utf8') !== 'cook') return
  const pageCount = data.readUInt32BE(4)
  let cursor = 8
  const pageSizes: number[] = []
  for (let i = 0; i < pageCount; i += 1) {
    if (cursor + 4 > data.length) return
    pageSizes.push(data.readUInt32BE(cursor))
    cursor += 4
  }

  for (const pageSize of pageSizes) {
    if (cursor + pageSize > data.length) return
    const page = data.subarray(cursor, cursor + pageSize)
    parseSafariCookiePage(page, jar, cookies)
    cursor += pageSize
  }
}

export async function extractCookiesFromSafari(): Promise<CookieExtractionResult> {
  const warnings: string[] = []
  const cookies = createEmptyCookies()

  const cookiesPath = getSafariCookiesPath()
  if (!cookiesPath) {
    warnings.push('Safari cookies database not found.')
    return { cookies, warnings }
  }

  let tempDir: string | null = null

  try {
    const jar: Record<string, string> = {}
    tempDir = mkdtempSync(join(tmpdir(), 'twitter-cookies-'))
    const tempCookiesPath = join(tempDir, 'Cookies.binarycookies')
    copyFileSync(cookiesPath, tempCookiesPath)
    const data = readFileSync(tempCookiesPath)
    parseSafariCookies(data, jar, cookies)
    if (Object.keys(jar).length > 0) {
      cookies.cookieHeader = serializeCookieJar(jar)
    }

    if (cookies.authToken || cookies.ct0) {
      cookies.source = 'Safari'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(`Failed to read Safari cookies: ${message}`)
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
      'No Twitter cookies found in Safari. Make sure you are logged into x.com in Safari.'
    )
  }

  return { cookies, warnings }
}
