type ArtifactRecord = {
  fileName: string
  mimeType: string
  contentBase64: string
  size: number
  createdAt: string
  updatedAt: string
}

export type ArtifactPayload = {
  fileName: string
  content: unknown
  mimeType?: string
}

// Artifacts are scoped per active tab session (keyed by tabId) and stored in session storage when available.
const STORAGE_PREFIX = 'automation.artifacts'

function getStorage() {
  // Prefer session storage so artifacts reset with the session.
  return chrome.storage?.session ?? chrome.storage?.local
}

function buildStorageKey(tabId: number) {
  return `${STORAGE_PREFIX}.${tabId}`
}

function toBinaryString(bytes: Uint8Array) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return binary
}

function toBase64(input: unknown): { base64: string; size: number; mimeType: string } {
  if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input)
    return {
      base64: btoa(toBinaryString(bytes)),
      size: bytes.length,
      mimeType: 'application/octet-stream',
    }
  }
  if (ArrayBuffer.isView(input)) {
    const bytes = new Uint8Array(input.buffer)
    return {
      base64: btoa(toBinaryString(bytes)),
      size: bytes.length,
      mimeType: 'application/octet-stream',
    }
  }
  if (typeof input === 'string') {
    const bytes = new TextEncoder().encode(input)
    return { base64: btoa(toBinaryString(bytes)), size: bytes.length, mimeType: 'text/plain' }
  }
  if (typeof input === 'object') {
    const json = JSON.stringify(input, null, 2)
    const bytes = new TextEncoder().encode(json)
    return { base64: btoa(toBinaryString(bytes)), size: bytes.length, mimeType: 'application/json' }
  }
  const fallback = String(input ?? '')
  const bytes = new TextEncoder().encode(fallback)
  return { base64: btoa(toBinaryString(bytes)), size: bytes.length, mimeType: 'text/plain' }
}

function normalizeFileName(fileName: string) {
  return fileName.trim()
}

async function loadArtifacts(tabId: number): Promise<Record<string, ArtifactRecord>> {
  const store = getStorage()
  if (!store) return {}
  const key = buildStorageKey(tabId)
  const res = await store.get(key)
  const raw = res?.[key]
  if (!raw || typeof raw !== 'object') return {}
  return raw as Record<string, ArtifactRecord>
}

async function saveArtifacts(tabId: number, records: Record<string, ArtifactRecord>) {
  const store = getStorage()
  if (!store) return
  await store.set({ [buildStorageKey(tabId)]: records })
}

export async function listArtifacts(tabId: number): Promise<ArtifactRecord[]> {
  const records = await loadArtifacts(tabId)
  return Object.values(records)
}

export async function getArtifactRecord(
  tabId: number,
  fileName: string
): Promise<ArtifactRecord | null> {
  const records = await loadArtifacts(tabId)
  const key = normalizeFileName(fileName)
  return records[key] ?? null
}

export async function upsertArtifact(
  tabId: number,
  payload: ArtifactPayload & { contentBase64?: string }
): Promise<ArtifactRecord> {
  const key = normalizeFileName(payload.fileName)
  if (!key) throw new Error('Missing fileName')
  const records = await loadArtifacts(tabId)
  const now = new Date().toISOString()

  let contentBase64: string
  let size: number
  let inferredMimeType: string

  if (typeof payload.contentBase64 === 'string' && payload.contentBase64.length > 0) {
    contentBase64 = payload.contentBase64
    size = Math.round((payload.contentBase64.length * 3) / 4)
    inferredMimeType = 'application/octet-stream'
  } else {
    const encoded = toBase64(payload.content)
    contentBase64 = encoded.base64
    size = encoded.size
    inferredMimeType = encoded.mimeType
  }

  const record: ArtifactRecord = {
    fileName: key,
    mimeType: payload.mimeType ?? inferredMimeType,
    contentBase64,
    size,
    createdAt: records[key]?.createdAt ?? now,
    updatedAt: now,
  }

  records[key] = record
  await saveArtifacts(tabId, records)
  return record
}

export async function deleteArtifact(tabId: number, fileName: string): Promise<boolean> {
  const key = normalizeFileName(fileName)
  if (!key) return false
  const records = await loadArtifacts(tabId)
  if (!records[key]) return false
  delete records[key]
  await saveArtifacts(tabId, records)
  return true
}

export function decodeArtifact(record: ArtifactRecord): string {
  const binary = atob(record.contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

export function parseArtifact(record: ArtifactRecord): unknown {
  const text = decodeArtifact(record)
  if (record.mimeType === 'application/json' || record.fileName.endsWith('.json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}
