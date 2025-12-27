import { mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'

import type { TranscriptCache } from './content/index.js'

export type CacheKind = 'extract' | 'summary' | 'transcript'

export type CacheConfig = {
  enabled?: boolean
  maxMb?: number
  ttlDays?: number
  path?: string
}

export const CACHE_FORMAT_VERSION = 1
export const DEFAULT_CACHE_MAX_MB = 512
export const DEFAULT_CACHE_TTL_DAYS = 30

type SqliteStatement = {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => { changes?: number } | unknown
}

type SqliteDatabase = {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close?: () => void
}

type CacheRow = {
  value: string
  expires_at: number | null
  size_bytes: number
}

export type CacheStore = {
  getText: (kind: CacheKind, key: string) => string | null
  getJson: <T>(kind: CacheKind, key: string) => T | null
  setText: (kind: CacheKind, key: string, value: string, ttlMs: number | null) => void
  setJson: (kind: CacheKind, key: string, value: unknown, ttlMs: number | null) => void
  clear: () => void
  close: () => void
  transcriptCache: TranscriptCache
}

export type CacheState = {
  mode: 'default' | 'bypass'
  store: CacheStore | null
  ttlMs: number
  maxBytes: number
  path: string | null
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
let warningFilterInstalled = false

const installSqliteWarningFilter = () => {
  if (warningFilterInstalled) return
  warningFilterInstalled = true
  process.on('warning', (warning) => {
    if (
      warning?.name === 'ExperimentalWarning' &&
      typeof warning.message === 'string' &&
      warning.message.toLowerCase().includes('sqlite')
    ) {
      return
    }
    // Preserve non-sqlite warnings.
    // eslint-disable-next-line no-console
    console.warn(warning)
  })
}

async function openSqlite(path: string): Promise<SqliteDatabase> {
  if (isBun) {
    const mod = (await import('bun:sqlite')) as { Database: new (path: string) => SqliteDatabase }
    return new mod.Database(path)
  }
  installSqliteWarningFilter()
  const mod = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (path: string) => SqliteDatabase
  }
  return new mod.DatabaseSync(path)
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true })
}

function resolveHomeDir(env: Record<string, string | undefined>): string | null {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim()
  return home || null
}

export function resolveCachePath({
  env,
  cachePath,
}: {
  env: Record<string, string | undefined>
  cachePath: string | null
}): string | null {
  const home = resolveHomeDir(env)
  const raw = cachePath?.trim()
  if (raw && raw.length > 0) {
    if (raw.startsWith('~')) {
      if (!home) return null
      const expanded = raw === '~' ? home : join(home, raw.slice(2))
      return resolvePath(expanded)
    }
    return isAbsolute(raw) ? raw : home ? resolvePath(join(home, raw)) : null
  }
  if (!home) return null
  return join(home, '.summarize', 'cache.sqlite')
}

export async function createCacheStore({
  path,
  maxBytes,
}: {
  path: string
  maxBytes: number
}): Promise<CacheStore> {
  ensureDir(dirname(path))
  const db = await openSqlite(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec('PRAGMA auto_vacuum=INCREMENTAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (kind, key)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_accessed ON cache_entries(last_accessed_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at)')

  const stmtGet = db.prepare(
    'SELECT value, expires_at, size_bytes FROM cache_entries WHERE kind = ? AND key = ?'
  )
  const stmtTouch = db.prepare(
    'UPDATE cache_entries SET last_accessed_at = ? WHERE kind = ? AND key = ?'
  )
  const stmtDelete = db.prepare('DELETE FROM cache_entries WHERE kind = ? AND key = ?')
  const stmtDeleteExpired = db.prepare(
    'DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?'
  )
  const stmtUpsert = db.prepare(`
    INSERT INTO cache_entries (
      kind, key, value, size_bytes, created_at, last_accessed_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET
      value = excluded.value,
      size_bytes = excluded.size_bytes,
      created_at = excluded.created_at,
      last_accessed_at = excluded.last_accessed_at,
      expires_at = excluded.expires_at
  `)
  const stmtTotalSize = db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM cache_entries'
  )
  const stmtOldest = db.prepare(
    'SELECT kind, key, size_bytes FROM cache_entries ORDER BY last_accessed_at ASC LIMIT ?'
  )
  const stmtClear = db.prepare('DELETE FROM cache_entries')

  const sweepExpired = (now: number) => {
    stmtDeleteExpired.run(now)
  }

  const enforceSize = () => {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return
    const row = stmtTotalSize.get() as { total?: number | null } | undefined
    let total = typeof row?.total === 'number' ? row.total : 0
    if (total <= maxBytes) return
    const batchSize = 50
    while (total > maxBytes) {
      const rows = stmtOldest.all(batchSize) as Array<{
        kind: string
        key: string
        size_bytes: number
      }>
      if (rows.length === 0) break
      for (const row of rows) {
        if (total <= maxBytes) break
        stmtDelete.run(row.kind, row.key)
        total -= row.size_bytes ?? 0
      }
      if (total <= maxBytes) break
    }
    db.exec('PRAGMA incremental_vacuum')
  }

  const readEntry = (kind: CacheKind, key: string, now: number): CacheRow | null => {
    const row = stmtGet.get(kind, key) as CacheRow | undefined
    if (!row) return null
    const expiresAt = row.expires_at
    if (typeof expiresAt === 'number' && expiresAt <= now) {
      stmtDelete.run(kind, key)
      return { ...row, expires_at: expiresAt }
    }
    stmtTouch.run(now, kind, key)
    return row
  }

  const getText = (kind: CacheKind, key: string): string | null => {
    const now = Date.now()
    const row = readEntry(kind, key, now)
    if (!row) return null
    const expiresAt = row.expires_at
    if (typeof expiresAt === 'number' && expiresAt <= now) return null
    return row.value
  }

  const getJson = <T,>(kind: CacheKind, key: string): T | null => {
    const text = getText(kind, key)
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  const setText = (kind: CacheKind, key: string, value: string, ttlMs: number | null) => {
    const now = Date.now()
    sweepExpired(now)
    const expiresAt = typeof ttlMs === 'number' ? now + ttlMs : null
    const sizeBytes = Buffer.byteLength(value, 'utf8')
    stmtUpsert.run(kind, key, value, sizeBytes, now, now, expiresAt)
    enforceSize()
  }

  const setJson = (kind: CacheKind, key: string, value: unknown, ttlMs: number | null) => {
    setText(kind, key, JSON.stringify(value), ttlMs)
  }

  const clear = () => {
    stmtClear.run()
    db.exec('PRAGMA incremental_vacuum')
  }

  const close = () => {
    db.close?.()
  }

  const transcriptCache: TranscriptCache = {
    get: async ({ url }) => {
      const now = Date.now()
      const key = hashString(url)
      const row = readEntry('transcript', key, now)
      if (!row) return null
      const expired = typeof row.expires_at === 'number' && row.expires_at <= now
      let payload: { content?: string | null; source?: string | null; metadata?: unknown } | null =
        null
      try {
        payload = JSON.parse(row.value) as {
          content?: string | null
          source?: string | null
          metadata?: unknown
        }
      } catch {
        payload = null
      }
      return {
        content: payload?.content ?? null,
        source: payload?.source ?? null,
        expired,
        metadata: (payload?.metadata as Record<string, unknown> | null | undefined) ?? null,
      }
    },
    set: async ({ url, content, source, ttlMs, metadata, service, resourceKey }) => {
      const key = hashString(url)
      setJson(
        'transcript',
        key,
        {
          content,
          source,
          metadata: metadata ?? null,
          service,
          resourceKey,
        },
        ttlMs
      )
    },
  }

  return { getText, getJson, setText, setJson, clear, close, transcriptCache }
}

export function clearCacheFiles(path: string) {
  rmSync(path, { force: true })
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value))
}

export function normalizeContentForHash(content: string): string {
  return content.replaceAll('\r\n', '\n').trim()
}

export function extractTaggedBlock(prompt: string, tag: 'instructions' | 'content'): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = prompt.indexOf(open)
  if (start === -1) return null
  const end = prompt.indexOf(close, start + open.length)
  if (end === -1) return null
  return prompt.slice(start + open.length, end).trim()
}

export function buildExtractCacheKey({
  url,
  options,
}: {
  url: string
  options: Record<string, unknown>
}): string {
  return hashJson({ url, options, formatVersion: CACHE_FORMAT_VERSION })
}

export function buildSummaryCacheKey({
  contentHash,
  promptHash,
  model,
  lengthKey,
  languageKey,
}: {
  contentHash: string
  promptHash: string
  model: string
  lengthKey: string
  languageKey: string
}): string {
  return hashJson({
    contentHash,
    promptHash,
    model,
    lengthKey,
    languageKey,
    formatVersion: CACHE_FORMAT_VERSION,
  })
}

export function getSqliteFileSizeBytes(path: string): number {
  let total = 0
  try {
    total += statSync(path).size
  } catch {
    // ignore
  }
  try {
    total += statSync(`${path}-wal`).size
  } catch {
    // ignore
  }
  try {
    total += statSync(`${path}-shm`).size
  } catch {
    // ignore
  }
  return total
}
