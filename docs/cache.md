---
summary: "CLI cache design, keys, config, and eviction."
read_when:
  - "When changing cache behavior, keys, or defaults."
---

# Cache (design)

Lightweight, CLI-only SQLite cache. Single DB file.

## Goals

- Avoid repeated transcripts/extractions/summaries.
- No file sprawl; bounded disk usage.
- Safe defaults; easy opt-out.
- Native SQLite only (Node 22 + Bun).

## Storage

- Default path: `~/.summarize/cache.sqlite`
- Override: `cache.path` in config.
- SQLite pragmas: WAL, NORMAL sync, busy timeout, incremental vacuum.

## What we cache

- **Transcripts**
  - key: `sha256({url, namespace, fileMtime?, formatVersion})` (local file paths include `fileMtime` for invalidation)
- **Extracted content** (URL → text/markdown)
  - key: `sha256({url, extractSettings, formatVersion})`
- **Summaries**
  - key: `sha256({contentHash, promptHash, model, length, language, formatVersion})`
  - cache hit even if URL differs (content hash wins).

## Keys / hashes

- `sha256` from Node `crypto` / Bun `crypto`.
- `contentHash` from normalized extracted content.
- `promptHash` from instruction block (custom prompt or default).
- `formatVersion`: hardcoded constant to invalidate on prompt format changes.

## Config

```json
{
  "cache": {
    "enabled": true,
    "maxMb": 512,
    "ttlDays": 30,
    "path": "~/.summarize/cache.sqlite"
  }
}
```

Defaults: `enabled=true`, `maxMb=512`, `ttlDays=30`, `path` unset.

## CLI flags

- `--no-cache`: bypass read + write.
- `--cache-stats`: print cache stats and exit.
- `--clear-cache`: delete cache DB (and WAL/SHM); must be used alone.

## Eviction policy

- TTL sweep on read/write.
- Size cap: if DB > `maxMb`, delete oldest entries by `last_accessed_at` until under cap.
- Optional count cap if needed later.

## Notes

- No extension cache (daemon uses CLI cache).
- No third-party SQLite deps.
- Transcript namespace currently includes the YouTube mode (e.g. `yt:auto`, `yt:web`).
