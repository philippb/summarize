import { describe, expect, it } from 'vitest'

import { buildExtractCacheKey, buildSummaryCacheKey, extractTaggedBlock } from '../src/cache.js'

describe('cache keys and tags', () => {
  it('extracts tagged blocks', () => {
    const prompt = '<instructions>Do the thing.</instructions>\n<content>Body</content>'
    expect(extractTaggedBlock(prompt, 'instructions')).toBe('Do the thing.')
    expect(extractTaggedBlock(prompt, 'content')).toBe('Body')
    expect(extractTaggedBlock('no tags here', 'instructions')).toBeNull()
  })

  it('changes summary keys when inputs change', () => {
    const base = buildSummaryCacheKey({
      contentHash: 'content',
      promptHash: 'prompt',
      model: 'openai/gpt-5.2',
      lengthKey: 'chars:140',
      languageKey: 'en',
    })
    const same = buildSummaryCacheKey({
      contentHash: 'content',
      promptHash: 'prompt',
      model: 'openai/gpt-5.2',
      lengthKey: 'chars:140',
      languageKey: 'en',
    })
    const diffModel = buildSummaryCacheKey({
      contentHash: 'content',
      promptHash: 'prompt',
      model: 'openai/gpt-4.1',
      lengthKey: 'chars:140',
      languageKey: 'en',
    })
    const diffLength = buildSummaryCacheKey({
      contentHash: 'content',
      promptHash: 'prompt',
      model: 'openai/gpt-5.2',
      lengthKey: 'chars:200',
      languageKey: 'en',
    })
    const diffLang = buildSummaryCacheKey({
      contentHash: 'content',
      promptHash: 'prompt',
      model: 'openai/gpt-5.2',
      lengthKey: 'chars:140',
      languageKey: 'de',
    })

    expect(same).toBe(base)
    expect(diffModel).not.toBe(base)
    expect(diffLength).not.toBe(base)
    expect(diffLang).not.toBe(base)
  })

  it('changes extract keys when transcript timestamp options change', () => {
    const base = buildExtractCacheKey({
      url: 'https://example.com/video',
      options: { youtubeTranscript: 'auto', transcriptTimestamps: false },
    })
    const withTimestamps = buildExtractCacheKey({
      url: 'https://example.com/video',
      options: { youtubeTranscript: 'auto', transcriptTimestamps: true },
    })

    expect(withTimestamps).not.toBe(base)
  })
})
