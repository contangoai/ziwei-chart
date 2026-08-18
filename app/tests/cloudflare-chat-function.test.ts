import { describe, expect, it, vi, afterEach } from 'vitest'
import { onRequestPost } from '../functions/api/chat'

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('Cloudflare chat proxy function', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 503 when DEEPSEEK_API_KEY is not configured', async () => {
    const response = await onRequestPost({
      request: makeRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      env: {},
    })
    expect(response.status).toBe(503)
    const data = (await response.json()) as { error: string }
    expect(data.error).toContain('API Key')
  })

  it('injects the server-side key upstream and never leaks it to the client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await onRequestPost({
      request: makeRequest({ messages: [{ role: 'user', content: '帮我解读' }], model: 'deepseek-v4-pro' }),
      env: { DEEPSEEK_API_KEY: 'sk-server-secret' },
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('sk-server-secret')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-server-secret')

    const sent = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    expect(sent.messages).toEqual([{ role: 'user', content: '帮我解读' }])
    expect(sent.stream).toBe(true)
  })

  it('rejects oversized message bodies', async () => {
    const response = await onRequestPost({
      request: makeRequest({ messages: [{ role: 'user', content: 'x'.repeat(21000) }] }),
      env: { DEEPSEEK_API_KEY: 'sk' },
    })
    expect(response.status).toBe(400)
  })

  it('rejects too many messages', async () => {
    const messages = Array.from({ length: 11 }, () => ({ role: 'user', content: 'hi' }))
    const response = await onRequestPost({
      request: makeRequest({ messages }),
      env: { DEEPSEEK_API_KEY: 'sk' },
    })
    expect(response.status).toBe(400)
  })

  it('caps max_tokens to the hard ceiling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await onRequestPost({
      request: makeRequest({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 999999 }),
      env: { DEEPSEEK_API_KEY: 'sk' },
    })

    const [, init] = fetchMock.mock.calls[0]
    const sent = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    expect(sent.max_tokens).toBe(4096)
  })

  it('rate limits per IP when a KV binding is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const kv = {
      value: 0,
      async get() {
        return String(this.value)
      },
      async put() {
        this.value += 1
      },
    }
    const context = {
      request: makeRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        { 'CF-Connecting-IP': '1.2.3.4' }
      ),
      env: {
        DEEPSEEK_API_KEY: 'sk',
        RATE_LIMIT_KV: kv,
        RATE_LIMIT_REQUESTS: '2',
        RATE_LIMIT_WINDOW_SECONDS: '60',
      },
    }

    await onRequestPost(context)
    await onRequestPost(context)
    const blocked = await onRequestPost(context)
    expect(blocked.status).toBe(429)
  })
})
