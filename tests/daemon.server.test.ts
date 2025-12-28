import { describe, expect, it } from 'vitest'

import { buildHealthPayload } from '../src/daemon/server.js'
import { resolvePackageVersion } from '../src/version.js'

describe('daemon/server health payload', () => {
  it('includes daemon version and pid', () => {
    const payload = buildHealthPayload(import.meta.url)
    expect(payload.ok).toBe(true)
    expect(payload.pid).toBe(process.pid)
    expect(payload.version).toBe(resolvePackageVersion(import.meta.url))
  })
})
