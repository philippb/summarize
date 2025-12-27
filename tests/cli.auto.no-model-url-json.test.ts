import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

describe('--model auto no-model-url-json', () => {
  it('prints JSON output with llm=null when all model calls are skipped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-auto-no-model-url-json-'))
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      2000
    )}</p></article></body></html>`

    const fetchMock = vi.fn(async () => new Response(html, { status: 200 }))

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(
      [
        '--json',
        '--metrics',
        'off',
        '--max-output-tokens',
        '50',
        '--timeout',
        '2s',
        'https://example.com',
      ],
      {
        env: { HOME: root },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
      }
    )

    const parsed = JSON.parse(stdoutText) as { llm: unknown; summary: string }
    expect(parsed.llm).toBeNull()
    expect(parsed.summary).toContain('A'.repeat(50))
  }, 20_000)
})
