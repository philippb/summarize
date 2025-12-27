# Summarize (Chrome Extension)

Chrome Side Panel UI for `summarize` via the local daemon (`summarize daemon …`).

## Build

- From repo root: `pnpm install`
- Dev: `pnpm -C apps/chrome-extension dev`
- Prod build: `pnpm -C apps/chrome-extension build`

## Load Unpacked

- Chrome → `chrome://extensions` → Developer mode → “Load unpacked”
- Pick: `apps/chrome-extension/.output/chrome-mv3`

## First Run (Pairing)

- Open side panel → “Setup” shows a token + install command.
- Run the command in Terminal (installs LaunchAgent + daemon).

