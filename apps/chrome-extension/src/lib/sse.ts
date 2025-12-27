export type SseMessage = { event: string; data: string }

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let currentEvent = 'message'
  let currentData = ''

  const flush = () => {
    const data = currentData.trimEnd()
    const evt = currentEvent || 'message'
    currentEvent = 'message'
    currentData = ''
    return data ? ({ event: evt, data } as const) : null
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const rawLine = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      const line = rawLine.replace(/\r$/, '')

      if (line === '') {
        const msg = flush()
        if (msg) yield msg
        continue
      }

      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        currentEvent = line.slice('event:'.length).trim() || 'message'
        continue
      }
      if (line.startsWith('data:')) {
        currentData += `${line.slice('data:'.length).trim()}\n`
      }
    }
  }
}
