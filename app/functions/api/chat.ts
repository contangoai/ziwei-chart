/* ============================================================
   Cloudflare Pages Function — DeepSeek 共享额度代理

   设计目标:
   - DEEPSEEK_API_KEY 只存在于 Cloudflare 服务端环境变量，
     浏览器永不接触，避免 key 泄露。
   - 前端在用户未填自己的 API Key 时调用本站 /api/chat，
     由本函数注入 Authorization 头并转发到 DeepSeek。

   安全防护 (防止恶意脚本刷 key 烧钱):
   - 仅接受 POST + application/json
   - messages 条数与总字符数上限
   - max_tokens 硬上限 (普通/思考模式分开)
   - 可选: ALLOWED_ORIGINS 来源白名单 (逗号分隔)
   - 可选: RATE_LIMIT_KV KV 绑定 + 按 IP 限流
   ============================================================ */

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions'

/* 请求体安全上限 */
const MAX_MESSAGES = 10
const MAX_MESSAGE_CHARS = 20000
const MAX_TOKENS_NORMAL = 4096
const MAX_TOKENS_THINKING = 8000
const MIN_TOKENS = 200

/* ------------------------------------------------------------
   最小化类型定义 (不依赖 @cloudflare/workers-types)
   ------------------------------------------------------------ */

interface ChatMessage {
  role: string
  content: string
}

interface RateLimitKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

interface Env {
  DEEPSEEK_API_KEY?: string
  ALLOWED_ORIGINS?: string
  RATE_LIMIT_KV?: RateLimitKV
  RATE_LIMIT_REQUESTS?: string
  RATE_LIMIT_WINDOW_SECONDS?: string
}

interface EventContext {
  request: Request
  env: Env
}

interface ChatPayload {
  messages: ChatMessage[]
  model: string
  enableThinking: boolean
  stream: boolean
  maxTokens: number
}

/* ------------------------------------------------------------
   工具函数
   ------------------------------------------------------------ */

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/* 来源白名单校验 */
function checkOrigin(request: Request, env: Env): string | null {
  const allowed = env.ALLOWED_ORIGINS
  if (!allowed) return null

  const origin = request.headers.get('Origin')
  if (!origin) return '请求缺少来源信息'

  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.includes(origin)) return '请求来源不在允许列表中'

  return null
}

/* 按 IP 限流 (需要 RATE_LIMIT_KV KV 绑定，未绑定则跳过) */
async function checkRateLimit(context: EventContext): Promise<string | null> {
  const { request, env } = context
  const kv = env.RATE_LIMIT_KV
  if (!kv) return null

  const perWindow = Number(env.RATE_LIMIT_REQUESTS || 10)
  const windowSeconds = Number(env.RATE_LIMIT_WINDOW_SECONDS || 60)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
  const key = `rl:${ip}:${bucket}`

  const count = Number((await kv.get(key)) || '0')
  if (count >= perWindow) {
    return `请求过于频繁，请稍后再试 (每分钟最多 ${perWindow} 次)`
  }

  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds })
  return null
}

/* 解析并校验请求体，返回白名单后的载荷 */
async function parseChatRequest(request: Request): Promise<{ payload?: ChatPayload; error?: string }> {
  const contentType = request.headers.get('Content-Type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return { error: '仅接受 application/json 请求' }
  }

  let data: unknown
  try {
    data = await request.json()
  } catch {
    return { error: '请求体不是合法 JSON' }
  }

  if (!data || typeof data !== 'object') return { error: '请求体格式错误' }
  const record = data as Record<string, unknown>

  const messages = record.messages
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return { error: `messages 需包含 1-${MAX_MESSAGES} 条` }
  }

  const totalChars = messages.reduce((sum, m) => {
    if (!m || typeof m !== 'object') return sum + MAX_MESSAGE_CHARS
    const content = (m as Record<string, unknown>).content
    return sum + (typeof content === 'string' ? content.length : MAX_MESSAGE_CHARS)
  }, 0)
  if (totalChars > MAX_MESSAGE_CHARS) {
    return { error: '请求内容过长，请精简后再试' }
  }

  const model =
    typeof record.model === 'string' && record.model.trim()
      ? record.model.trim().slice(0, 100)
      : ''
  if (record.model !== undefined && !model) return { error: 'model 格式错误' }

  const enableThinking = record.enableThinking === true
  const stream = record.stream !== false
  const tokenCeiling = enableThinking ? MAX_TOKENS_THINKING : MAX_TOKENS_NORMAL
  const requestedTokens =
    typeof record.maxTokens === 'number' && Number.isFinite(record.maxTokens)
      ? Math.floor(record.maxTokens)
      : tokenCeiling
  const maxTokens = Math.min(Math.max(requestedTokens, MIN_TOKENS), tokenCeiling)

  return {
    payload: {
      messages: messages as ChatMessage[],
      model: model || 'deepseek-chat',
      enableThinking,
      stream,
      maxTokens,
    },
  }
}

/* ------------------------------------------------------------
   主处理器: POST /api/chat
   ------------------------------------------------------------ */

export async function onRequestPost(context: EventContext): Promise<Response> {
  const { env } = context
  const apiKey = env.DEEPSEEK_API_KEY

  // 服务端未配置共享 key 时，引导用户使用自己的 Key
  if (!apiKey) {
    return jsonResponse(503, {
      error: '站点暂未配置默认 AI 额度，请前往设置填写自己的 API Key',
    })
  }

  const originError = checkOrigin(context.request, env)
  if (originError) return jsonResponse(403, { error: originError })

  const rateError = await checkRateLimit(context)
  if (rateError) return jsonResponse(429, { error: rateError })

  const { payload, error } = await parseChatRequest(context.request)
  if (error || !payload) return jsonResponse(400, { error: error || '请求格式错误' })

  // 构建 DeepSeek 请求体 (白名单字段，max_tokens 已封顶)
  const upstreamBody: Record<string, unknown> = {
    model: payload.model,
    messages: payload.messages,
    stream: payload.stream,
    max_tokens: payload.maxTokens,
    thinking: {
      type: payload.enableThinking ? 'enabled' : 'disabled',
    },
  }
  if (payload.enableThinking) {
    upstreamBody.reasoning_effort = 'high'
  }

  // 服务端注入 API Key，浏览器看不到
  const upstream = await fetch(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  })

  if (!upstream.ok) {
    await upstream.text().catch(() => null)
    return jsonResponse(upstream.status, {
      error: `DeepSeek 服务暂不可用 (${upstream.status})`,
    })
  }

  // 流式/非流式原样转发
  const headers: Record<string, string> = {
    'Cache-Control': 'no-cache, no-transform',
  }
  headers['Content-Type'] = payload.stream
    ? 'text/event-stream; charset=utf-8'
    : 'application/json; charset=utf-8'

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}
