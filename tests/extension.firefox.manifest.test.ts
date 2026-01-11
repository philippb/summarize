import { describe, expect, it } from 'vitest'
import extensionConfig from '../apps/chrome-extension/wxt.config.js'

describe('firefox extension manifest', () => {
  it('uses sidebar_action and omits sidePanel permission', () => {
    const manifestFactory = (extensionConfig as { manifest?: unknown }).manifest
    if (typeof manifestFactory !== 'function') {
      throw new Error('Missing manifest factory in WXT config')
    }

    const manifest = manifestFactory({ browser: 'firefox' }) as Record<string, unknown>
    expect(manifest.sidebar_action).toBeTruthy()
    expect('side_panel' in manifest).toBe(false)

    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
    expect(permissions).not.toContain('sidePanel')

    const commands = manifest.commands as Record<string, unknown> | undefined
    expect(commands?._execute_sidebar_action).toBeTruthy()
  })
})
