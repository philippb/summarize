import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const runCliMock = vi.fn(async () => {})

vi.mock('../src/run.js', () => ({
  runCli: runCliMock,
}))

describe('cli main wiring', async () => {
  const { handlePipeErrors, runCliMain } = await import('../src/cli-main.js')

  it('sets exit code and prints error when runCli throws', async () => {
    runCliMock.mockReset().mockRejectedValue(new Error('boom'))

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    let exitCode: number | null = null
    await runCliMain({
      argv: [],
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
      stderr,
      exit: () => {},
      setExitCode: (code) => {
        exitCode = code
      },
    })

    expect(exitCode).toBe(1)
    expect(stderrText.trim()).toBe('boom')
  })

  it('strips ANSI control sequences from non-verbose errors', async () => {
    runCliMock
      .mockReset()
      .mockRejectedValue(
        new Error(
          [
            '\u001b[31mred\u001b[0m',
            '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
            '\u001b]1337;SetUserVar=foo=YmFy\u001b\\ok\u001b\\',
            '\u001bXunknown',
          ].join(' ')
        )
      )

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })
    ;(stderr as unknown as { isTTY?: boolean }).isTTY = true

    let exitCode: number | null = null
    await runCliMain({
      argv: [],
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
      stderr,
      exit: () => {},
      setExitCode: (code) => {
        exitCode = code
      },
    })

    expect(exitCode).toBe(1)
    expect(stderrText.trim()).toBe('red link ok unknown')
  })

  it('exits with 0 on EPIPE', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream
    let exited: number | null = null
    handlePipeErrors(stream, (code) => {
      exited = code
    })

    stream.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' }))
    expect(exited).toBe(0)
  })

  it('rethrows non-EPIPE stream errors', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WritableStream
    handlePipeErrors(stream, () => {})

    const handler = stream.listeners('error')[0]
    expect(handler).toBeTypeOf('function')

    const error = Object.assign(new Error('nope'), { code: 'NOPE' })
    expect(() => (handler as (error: unknown) => void)(error)).toThrow(error)
  })

  it('prints stack and cause when verbose', async () => {
    const error = new Error('boom')
    error.cause = new Error('root')
    runCliMock.mockReset().mockRejectedValue(error)

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    let exitCode: number | null = null
    await runCliMain({
      argv: ['--verbose=true'],
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
      stderr,
      exit: () => {},
      setExitCode: (code) => {
        exitCode = code
      },
    })

    expect(exitCode).toBe(1)
    expect(stderrText).toContain('Error: boom')
    expect(stderrText).toContain('Caused by: Error: root')
  })

  it('prints string errors even when verbose is set', async () => {
    runCliMock.mockReset().mockRejectedValue('plain-error')

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    let exitCode: number | null = null
    await runCliMain({
      argv: ['--verbose'],
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
      stderr,
      exit: () => {},
      setExitCode: (code) => {
        exitCode = code
      },
    })

    expect(exitCode).toBe(1)
    expect(stderrText.trim()).toBe('plain-error')
  })

  it('prints fallback text for falsy errors', async () => {
    runCliMock.mockReset().mockRejectedValue(null)

    let stderrText = ''
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString()
        callback()
      },
    })

    let exitCode: number | null = null
    await runCliMain({
      argv: [],
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: new Writable({
        write(_c, _e, cb) {
          cb()
        },
      }),
      stderr,
      exit: () => {},
      setExitCode: (code) => {
        exitCode = code
      },
    })

    expect(exitCode).toBe(1)
    expect(stderrText.trim()).toBe('Unknown error')
  })

  it('loads .env for cli runs without mutating process.env', async () => {
    runCliMock.mockReset().mockResolvedValue(undefined)

    const directory = mkdtempSync(join(tmpdir(), 'summarize-dotenv-'))
    writeFileSync(
      join(directory, '.env'),
      ['SUMMARIZE_DOTENV_TEST_KEY=from-dotenv', 'DOTENV_ONLY=only', ''].join('\n'),
      'utf8'
    )

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(directory)

    const previous = process.env.SUMMARIZE_DOTENV_TEST_KEY
    process.env.SUMMARIZE_DOTENV_TEST_KEY = 'from-env'
    delete process.env.DOTENV_ONLY

    try {
      await runCliMain({
        argv: [],
        env: process.env,
        fetch: globalThis.fetch.bind(globalThis),
        stdout: new Writable({
          write(_c, _e, cb) {
            cb()
          },
        }),
        stderr: new Writable({
          write(_c, _e, cb) {
            cb()
          },
        }),
        exit: () => {},
        setExitCode: () => {},
      })

      expect(runCliMock).toHaveBeenCalledTimes(1)
      const merged = runCliMock.mock.calls[0]?.[1]?.env as Record<string, string | undefined>
      expect(merged.SUMMARIZE_DOTENV_TEST_KEY).toBe('from-env')
      expect(merged.DOTENV_ONLY).toBe('only')
      expect(process.env.DOTENV_ONLY).toBeUndefined()
    } finally {
      cwdSpy.mockRestore()
      if (typeof previous === 'string') process.env.SUMMARIZE_DOTENV_TEST_KEY = previous
      else delete process.env.SUMMARIZE_DOTENV_TEST_KEY
    }
  })
})
