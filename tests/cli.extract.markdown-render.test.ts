import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type { ExecFileFn } from '../src/markitdown.js'
import { runCli } from '../src/run.js'

describe('cli --extract markdown render', () => {
  const html =
    '<!doctype html><html><head><title>Ok</title></head>' +
    '<body><article><h1>Title</h1><p>Hello</p></article></body></html>'

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.url
    if (url === 'https://example.com') {
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  })

  const execFileMock = vi.fn((_file, _args, _opts, cb) => {
    cb(null, '# Title\n\n[A](https://example.com)\n', '')
  })

  const runExtract = async ({
    args,
    tty,
  }: {
    args: string[]
    tty: boolean
  }): Promise<string> => {
    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })
    if (tty) {
      ;(stdout as unknown as { isTTY?: boolean; columns?: number }).isTTY = true
      ;(stdout as unknown as { columns?: number }).columns = 80
    }

    await runCli(args, {
      env: { UVX_PATH: 'uvx', TERM: 'xterm-256color' },
      fetch: fetchMock as unknown as typeof fetch,
      execFile: execFileMock as unknown as ExecFileFn,
      stdout,
      stderr: new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }),
    })

    return stdoutText
  }

  it('renders markdown to ANSI when stdout is a TTY (default --render auto)', async () => {
    const out = await runExtract({
      args: ['--extract', '--timeout', '2s', 'https://example.com'],
      tty: true,
    })
    expect(out).toContain('\u001b]8;;https://example.com')
  })

  it('keeps raw markdown when stdout is not a TTY (default --render auto)', async () => {
    const out = await runExtract({
      args: ['--extract', '--timeout', '2s', 'https://example.com'],
      tty: false,
    })
    expect(out).toContain('# Title')
    expect(out).toContain('[A](https://example.com)')
    expect(out).not.toContain('\u001b]8;;https://example.com')
  })

  it('keeps raw markdown when --render plain is set (even in a TTY)', async () => {
    const out = await runExtract({
      args: ['--extract', '--render', 'plain', '--timeout', '2s', 'https://example.com'],
      tty: true,
    })
    expect(out).toContain('# Title')
    expect(out).toContain('[A](https://example.com)')
    expect(out).not.toContain('\u001b]8;;https://example.com')
  })
})
