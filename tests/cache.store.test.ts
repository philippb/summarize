import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createCacheStore } from '../src/cache.js'

describe('cache store', () => {
  it('round-trips text entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-cache-'))
    const path = join(root, 'cache.sqlite')
    const store = await createCacheStore({ path, maxBytes: 1024 * 1024 })

    store.setText('summary', 'key', 'value', null)
    expect(store.getText('summary', 'key')).toBe('value')

    store.close()
  })

  it('expires entries based on ttl', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-cache-'))
    const path = join(root, 'cache.sqlite')
    const store = await createCacheStore({ path, maxBytes: 1024 * 1024 })

    store.setText('summary', 'soon', 'value', -10)
    expect(store.getText('summary', 'soon')).toBeNull()

    store.close()
  })

  it('evicts oldest entries when size cap exceeded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-cache-'))
    const path = join(root, 'cache.sqlite')
    const store = await createCacheStore({ path, maxBytes: 60 })

    store.setText('summary', 'old', 'a'.repeat(50), null)
    store.setText('summary', 'new', 'b'.repeat(50), null)

    expect(store.getText('summary', 'old')).toBeNull()
    expect(store.getText('summary', 'new')).toBe('b'.repeat(50))

    store.close()
  })
})
