import ora from 'ora'

export function startSpinner({
  text,
  enabled,
  stream,
}: {
  text: string
  enabled: boolean
  stream: NodeJS.WritableStream
}): { stop: () => void; setText: (next: string) => void } {
  if (!enabled) {
    return { stop: () => {}, setText: () => {} }
  }

  const stop = () => {
    if (spinner.isSpinning) spinner.stop()
  }

  const setText = (next: string) => {
    spinner.text = next
  }

  const spinner = ora({
    text,
    stream,
    // Match Sweetistics CLI vibe; keep it clean.
    spinner: 'dots12',
    color: 'cyan',
    discardStdin: true,
  }).start()

  return { stop, setText }
}
