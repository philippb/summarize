import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}))

vi.mock('node:fs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return Object.assign({}, fs, {
    existsSync: vi.fn(() => false),
    copyFileSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/test-dir'),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => Buffer.alloc(0)),
    rmSync: vi.fn(),
  })
})

const itIfDarwin = process.platform === 'darwin' ? it : it.skip

function buildSafariCookieRecord(input: {
  domain: string
  name: string
  value: string
  path?: string
}): Buffer {
  const domain = Buffer.from(input.domain, 'utf8')
  const name = Buffer.from(input.name, 'utf8')
  const path = Buffer.from(input.path ?? '/', 'utf8')
  const value = Buffer.from(input.value, 'utf8')

  const headerSize = 56
  const domainOffset = headerSize
  const nameOffset = domainOffset + domain.length + 1
  const pathOffset = nameOffset + name.length + 1
  const valueOffset = pathOffset + path.length + 1
  const recordSize = valueOffset + value.length + 1

  const record = Buffer.alloc(recordSize)
  record.writeUInt32LE(recordSize, 0)
  record.writeUInt32LE(0, 4)
  record.writeUInt32LE(0, 8)
  record.writeUInt32LE(0, 12)
  record.writeUInt32LE(domainOffset, 16)
  record.writeUInt32LE(nameOffset, 20)
  record.writeUInt32LE(pathOffset, 24)
  record.writeUInt32LE(valueOffset, 28)

  domain.copy(record, domainOffset)
  record[domainOffset + domain.length] = 0
  name.copy(record, nameOffset)
  record[nameOffset + name.length] = 0
  path.copy(record, pathOffset)
  record[pathOffset + path.length] = 0
  value.copy(record, valueOffset)
  record[valueOffset + value.length] = 0

  return record
}

function buildSafariCookiesFile(records: Buffer[]): Buffer {
  const cookieCount = records.length
  const headerSize = 4 + 4 + 4 * cookieCount + 4
  const offsets: number[] = []
  let cursor = headerSize
  for (const record of records) {
    offsets.push(cursor)
    cursor += record.length
  }

  const pageSize = cursor
  const page = Buffer.alloc(pageSize)
  page.writeUInt32BE(0x00000100, 0)
  page.writeUInt32LE(cookieCount, 4)
  offsets.forEach((offset, index) => {
    page.writeUInt32LE(offset, 8 + index * 4)
  })
  page.writeUInt32LE(0, 8 + cookieCount * 4)
  offsets.forEach((offset, index) => {
    records[index].copy(page, offset)
  })

  const header = Buffer.alloc(12)
  header.write('cook', 0, 'ascii')
  header.writeUInt32BE(1, 4)
  header.writeUInt32BE(pageSize, 8)

  return Buffer.concat([header, page])
}

describe('twitter cookie extraction', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    process.env.AUTH_TOKEN = undefined
    process.env.TWITTER_AUTH_TOKEN = undefined
    process.env.CT0 = undefined
    process.env.TWITTER_CT0 = undefined
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  itIfDarwin('extracts cookies from Safari binarycookies', async () => {
    const fs = await import('node:fs')
    ;(fs.existsSync as unknown as vi.Mock).mockImplementation((path: string) =>
      path.toLowerCase().endsWith('cookies.binarycookies')
    )
    ;(fs.readFileSync as unknown as vi.Mock).mockReturnValue(
      buildSafariCookiesFile([
        buildSafariCookieRecord({ domain: '.x.com', name: 'auth_token', value: 'safari_auth' }),
        buildSafariCookieRecord({ domain: '.x.com', name: 'ct0', value: 'safari_ct0' }),
      ])
    )

    const { extractCookiesFromSafari } = await import(
      '../packages/core/src/content/transcript/providers/twitter-cookies-safari.js'
    )
    const result = await extractCookiesFromSafari()
    expect(result.cookies.authToken).toBe('safari_auth')
    expect(result.cookies.ct0).toBe('safari_ct0')
    expect(result.cookies.cookieHeader).toContain('auth_token=safari_auth')
    expect(result.cookies.cookieHeader).toContain('ct0=safari_ct0')
    expect(result.cookies.source).toBe('Safari')
  })

  it('extracts cookies from Chrome sqlite output', async () => {
    const fs = await import('node:fs')
    const { execSync } = await import('node:child_process')
    ;(fs.existsSync as unknown as vi.Mock).mockReturnValue(true)
    ;(execSync as unknown as vi.Mock).mockReturnValue(
      [
        `auth_token|${Buffer.from('auth').toString('hex')}`,
        `ct0|${Buffer.from('ct0token').toString('hex')}`,
      ].join('\n')
    )

    const { extractCookiesFromChrome } = await import(
      '../packages/core/src/content/transcript/providers/twitter-cookies-chrome.js'
    )
    const result = await extractCookiesFromChrome()
    expect(result.cookies.authToken).toBe('auth')
    expect(result.cookies.ct0).toBe('ct0token')
    expect(result.cookies.cookieHeader).toContain('auth_token=auth')
    expect(result.cookies.source).toBe('Chrome default profile')
  })

  it('extracts cookies from Firefox sqlite output', async () => {
    const fs = await import('node:fs')
    const { execSync } = await import('node:child_process')
    ;(fs.existsSync as unknown as vi.Mock).mockReturnValue(true)
    ;(fs.readdirSync as unknown as vi.Mock).mockReturnValue([
      { name: 'abc.default-release', isDirectory: () => true },
    ])
    ;(execSync as unknown as vi.Mock).mockReturnValue('auth_token|auth\nct0|ct0')

    const { extractCookiesFromFirefox } = await import(
      '../packages/core/src/content/transcript/providers/twitter-cookies-firefox.js'
    )
    const result = await extractCookiesFromFirefox('abc.default-release')
    expect(result.cookies.authToken).toBe('auth')
    expect(result.cookies.ct0).toBe('ct0')
    expect(result.cookies.cookieHeader).toContain('auth_token=auth')
    expect(result.cookies.source).toContain('Firefox')
  })

  it('resolves cookies from env vars', async () => {
    process.env.AUTH_TOKEN = 'env_auth'
    process.env.CT0 = 'env_ct0'
    const { resolveTwitterCookies } = await import(
      '../packages/core/src/content/transcript/providers/twitter-cookies.js'
    )
    const result = await resolveTwitterCookies({})
    expect(result.cookies.authToken).toBe('env_auth')
    expect(result.cookies.ct0).toBe('env_ct0')
    expect(result.cookies.cookieHeader).toBe('auth_token=env_auth; ct0=env_ct0')
    expect(result.cookies.source).toBe('env AUTH_TOKEN')
  })
})
