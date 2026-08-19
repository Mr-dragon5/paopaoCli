// ============================================================================
// OpenAICompatibleClient —— 统一的模型客户端（Ollama / DeepSeek 通吃）
// ============================================================================
// 依据：ticket 003（类 + 归一化事件流）+ 001（协议事实）。
// 缩到最小：不继承、不做工具调用；构造拿 baseUrl/model/apiKey，
// streamChat() 把两家流式响应归一成 StreamEvent。
//
// 归一化关键点（001）：
// - base_url 去尾部斜杠 + 追加 /chat/completions
//   Ollama:   http://localhost:11434/v1      → …/v1/chat/completions
//   DeepSeek: https://api.deepseek.com       → …/chat/completions
// - 思考字段：Ollama delta.reasoning、DeepSeek delta.reasoning_content → thinking
// - usage 可能挂在任意 chunk（finish chunk 或独立 choices:[] chunk），从携带它的 chunk 读
// ============================================================================
import { parseSseStream } from './streaming.js'
import { ChatError, type ChatMessage, type StreamEvent } from './types.js'

export interface ClientConfig {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number // 默认 120s（005）；请求卡死时抛 timeout
}

export interface StreamChatOptions {
  temperature?: number // 默认 0.7（005）
  maxTokens?: number // 默认 1024
  signal?: AbortSignal // 外部中断（REPL 的 Ctrl+C）
}

export class OpenAICompatibleClient {
  constructor(private readonly cfg: ClientConfig) {}

  async *streamChat(
    messages: ChatMessage[],
    opts: StreamChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 云端要 Authorization: Bearer <key>；Ollama 传了也会被忽略（001）
      ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    }
    const body = {
      model: this.cfg.model,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
      stream_options: { include_usage: true }, // 结束前补一个 token 用量块
    }

    // 超时 + 外部中断合并成一个 signal：谁先触发都 abort
    const timeoutMs = this.cfg.timeoutMs ?? 120_000
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, timeoutMs)
    const onExternalAbort = () => ac.abort()
    opts.signal?.addEventListener('abort', onExternalAbort)
    const finish = () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onExternalAbort)
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (err) {
      finish()
      throw this.mapStreamError(err, timedOut, opts.signal)
    }

    if (!res.ok) {
      finish()
      throw await this.mapHttpError(res)
    }
    if (!res.body) {
      finish()
      throw new ChatError('network', '响应体为空')
    }

    let sawDone = false
    try {
      for await (const ev of parseSseStream(res.body)) {
        if (ev.data === '[DONE]') {
          sawDone = true
          break
        }
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(ev.data) as Record<string, unknown>
        } catch {
          continue // 个别块解析失败不影响整条流
        }
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined
        if (!choices?.length) continue
        const delta = (choices[0].delta as Record<string, unknown> | undefined) ?? {}
        // 思考字段：Ollama reasoning / DeepSeek reasoning_content，合并成 thinking
        const reasoning = delta.reasoning ?? delta.reasoning_content
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'thinking', text: reasoning }
        }
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'content', text: delta.content }
        }
        // usage 可能挂在 finish chunk 或独立 choices:[] chunk，从携带它的 chunk 读
        const usage = chunk.usage as Record<string, number> | undefined
        if (usage) {
          yield {
            type: 'usage',
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
          }
        }
        const finishReason = choices[0].finish_reason
        if (finishReason) {
          yield { type: 'done', finishReason: String(finishReason) }
          sawDone = true
        }
      }
    } catch (err) {
      throw this.mapStreamError(err, timedOut, opts.signal)
    } finally {
      finish()
    }

    // 流没给 finish_reason 也补一个 done，保证调用方总能看到结束
    if (!sawDone) yield { type: 'done' }
  }

  // 把 fetch / 读流阶段的错误映射成对用户友好的 ChatError
  private mapStreamError(
    err: unknown,
    timedOut: boolean,
    externalSignal?: AbortSignal,
  ): ChatError {
    if (externalSignal?.aborted) return new ChatError('aborted', '已中断')
    if (timedOut) {
      const sec = Math.round((this.cfg.timeoutMs ?? 120_000) / 1000)
      return new ChatError('timeout', `响应超时（超过 ${sec}s）`)
    }
    return new ChatError(
      'network',
      '连不上服务：Ollama 可能没启动（试试 `ollama serve`），或网络不可达',
    )
  }

  // 把 HTTP 错误码映射成友好提示（依据 001 的错误形态）
  private async mapHttpError(res: Response): Promise<ChatError> {
    let msg = `HTTP ${res.status}`
    try {
      const j = (await res.json()) as { error?: { message?: string } | string }
      const e = j.error
      msg = typeof e === 'string' ? e : (e?.message ?? msg)
    } catch {
      // 响应不是 JSON 时保留默认 msg
    }
    if (res.status === 404) {
      return new ChatError('model_not_found', `模型不存在：${msg} —— 试试 \`ollama list\` 看有哪些模型`)
    }
    if (res.status === 401) {
      return new ChatError('auth', `鉴权失败：${msg} —— 检查 API key（环境变量 PAOPAO_API_KEY）`)
    }
    return new ChatError('http', `请求失败：${msg}`)
  }
}
