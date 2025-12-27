export type Settings = {
  token: string
  autoSummarize: boolean
  model: string
  maxChars: number
  fontFamily: string
  fontSize: number
}

const storageKey = 'settings'

export const defaultSettings: Settings = {
  token: '',
  autoSummarize: true,
  model: 'auto',
  maxChars: 120_000,
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  fontSize: 14,
}

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(storageKey)
  const raw = (res[storageKey] ?? {}) as Partial<Settings>
  return {
    ...defaultSettings,
    ...raw,
    token: typeof raw.token === 'string' ? raw.token : defaultSettings.token,
    model: typeof raw.model === 'string' ? raw.model : defaultSettings.model,
    autoSummarize:
      typeof raw.autoSummarize === 'boolean' ? raw.autoSummarize : defaultSettings.autoSummarize,
    maxChars: typeof raw.maxChars === 'number' ? raw.maxChars : defaultSettings.maxChars,
    fontFamily: typeof raw.fontFamily === 'string' ? raw.fontFamily : defaultSettings.fontFamily,
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : defaultSettings.fontSize,
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [storageKey]: settings })
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  await saveSettings(next)
  return next
}
