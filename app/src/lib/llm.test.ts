import { describe, expect, it } from 'vitest'
import { isSharedDefaultActive, hasUsableApiKey } from './llm'

describe('shared DeepSeek default', () => {
  it('activates only for deepseek without a user api key', () => {
    expect(isSharedDefaultActive('deepseek', '')).toBe(true)
    expect(isSharedDefaultActive('deepseek', 'sk-user-key')).toBe(false)
    expect(isSharedDefaultActive('kimi', '')).toBe(false)
    expect(isSharedDefaultActive('gemini', '')).toBe(false)
    expect(isSharedDefaultActive('claude', '')).toBe(false)
    expect(isSharedDefaultActive('custom', '')).toBe(false)
  })

  it('treats the shared default as a usable api key', () => {
    expect(hasUsableApiKey('deepseek', '')).toBe(true)
    expect(hasUsableApiKey('deepseek', 'sk-user-key')).toBe(true)
    expect(hasUsableApiKey('kimi', '')).toBe(false)
    expect(hasUsableApiKey('gemini', 'sk-user-key')).toBe(true)
  })
})
