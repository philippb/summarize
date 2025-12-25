# YouTube mode

YouTube URLs use transcript-first extraction.

## `--youtube auto|web|apify|yt-dlp`

- `auto` (default): try `youtubei` → `captionTracks` → Apify (if token exists) → `yt-dlp` (if configured)
- `web`: try `youtubei` → `captionTracks` only
- `apify`: Apify only
- `yt-dlp`: download audio + transcribe (local `whisper.cpp` preferred; OpenAI/FAL fallback)

## `youtubei` vs `captionTracks`

- `youtubei`:
  - Calls YouTube’s internal transcript endpoint (`/youtubei/v1/get_transcript`).
  - Needs a bootstrapped `INNERTUBE_API_KEY`, context, and `getTranscriptEndpoint.params` from the watch page HTML.
  - When it works, you get a nice list of transcript segments.
- `captionTracks`:
  - Downloads caption tracks listed in `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`.
  - Fetches `fmt=json3` first and falls back to XML-like caption payloads if needed.
  - Often works even when the transcript endpoint doesn’t.

## Fallbacks

- If no transcript is available, we still extract `ytInitialPlayerResponse.videoDetails.shortDescription` so YouTube links can still summarize meaningfully.
- Apify is an optional fallback (needs `APIFY_API_TOKEN`).
  - By default, we use the actor id `faVsWy9VTSNVIhWpR` (Pinto Studio’s “Youtube Transcript Scraper”).
- `yt-dlp` requires the `yt-dlp` binary (either set `YT_DLP_PATH` or have it on `PATH`) and either local `whisper.cpp` (preferred) or `OPENAI_API_KEY` / `FAL_KEY`.
  - If OpenAI transcription fails and `FAL_KEY` is set, we fall back to FAL automatically.

## Example

```bash
pnpm summarize -- --extract "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s"
```
