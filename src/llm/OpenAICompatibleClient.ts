// ============================================================================
// OpenAICompatibleClient —— 统一的模型客户端（Ollama / DeepSeek 通吃）
// ============================================================================
// 依据：ticket 003（类 + 归一化事件流）+ 001（协议事实）+ 002（工具调用扩展）。
//
// 两种形态：
// - streamChat()：流式最终回答（现有 REPL/单次问答用）。归一化成 StreamEvent。
// - complete()：非流式「工具判定回合」（002）。返回 content 或 toolCalls。
//   依据 001：工具判定回合必须非流式（Ollama 流式虽能出 delta.tool_calls，但
//   模型是否调用依赖措辞，DeepSeek 流式 schema 未记载 tool_calls）——
//   判定是否调工具，最可靠的信号是非流式的 message.tool_calls / finish_reason。
//
// 归一化关键点（001）：
// - base_url 去尾部斜杠 + 追加 /chat/completions
//   Ollama:   http://localhost:11434/v1      → …/v1/chat/completions
//   DeepSeek: https://api.deepseek.com       → …/chat/completions
// - 思考字段：Ollama delta.reasoning、DeepSeek delta.reasoning_content → thinking
// - usage 可能挂在任意 chunk，从携带它的 chunk 读
// ============================================================================
import { parseSseStream } from './streaming.js'
import {
  ChatError,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type CompleteResult,
  type StreamEvent,
} from './types.js'

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

export interface CompleteOptions {
  tools?: ChatTool[] // 暴露给模型的工具 schema（002）
  temperature?: number
  maxTokens?: number // 判定回合默认 4096（002：qwen3 reasoning 计入 max_tokens，1024 会被吃光）
  signal?: AbortSignal
}

interface RequestOptions extends CompleteOptions {
  stream: boolean
}

interface RequestHandle {
  res: Response
  finish: () => void // 清超时定时器、摘外部 abort 监听
  timedOut: boolean
}

// ChatMessage → OpenAI 兼容 wire 格式。tool 角色带 tool_call_id；
// assistant 带 tool_calls 时把 {id,name,arguments} 还原成 OpenAI 结构回传。
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

export class OpenAICompatibleClient {
  constructor(private readonly cfg: ClientConfig) {}

  // 共享请求管道：url/headers/body、超时 + 外部中断合并 signal、错误映射。
  // 成功返回 { res, finish, timedOut }；res 的 body 由调用方消费后调用 finish()。
  private async request(
    messages: ChatMessage[],
    opts: RequestOptions,
  ): Promise<RequestHandle> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 云端要 Authorization: Bearer <key>；Ollama 传了也会被忽略（001）
      ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    }
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: messages.map(toWireMessage),
      stream: opts.stream,
      temperature: opts.temperature ?? 0.7,
      // 流式沿用 1024（005）；非流式判定回合 4096（002：qwen3 reasoning 计入 max_tokens，1024 实测 finish=length 不发 tool_calls）
      max_tokens: opts.maxTokens ?? (opts.stream ? 1024 : 4096),
    }
    if (opts.stream) body.stream_options = { include_usage: true } // 结束前补 token 用量块
    if (opts.tools?.length) body.tools = opts.tools // 002：原生 function-calling

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
    return { res, finish, timedOut }
  }

  // 流式最终回答（现有 REPL / 单次问答走这里）
  async *streamChat(
    messages: ChatMessage[],
    opts: StreamChatOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const { res, finish, timedOut } = await this.request(messages, { ...opts, stream: true })
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

  // 非流式「工具判定回合」（002）：返回 content（=最终回答）或 toolCalls（=要调的工具）。
  async complete(
    messages: ChatMessage[],
    opts: CompleteOptions = {},
  ): Promise<CompleteResult> {
    const { res, finish, timedOut } = await this.request(messages, { ...opts, stream: false })
    try {
      const j = (await res.json()) as {
        choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const msg = j.choices?.[0]?.message ?? {}
      const rawCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined
      const toolCalls: ChatToolCall[] | null = rawCalls?.length
        ? rawCalls.map((tc) => ({
            id: String(tc.id ?? ''),
            name: String((tc.function as Record<string, unknown> | undefined)?.name ?? ''),
            arguments: String((tc.function as Record<string, unknown> | undefined)?.arguments ?? '{}'),
          }))
        : null
      const reasoning = msg.reasoning ?? msg.reasoning_content
      const usage = j.usage
      return {
        content: typeof msg.content === 'string' ? msg.content : '',
        toolCalls,
        finishReason: j.choices?.[0]?.finish_reason,
        reasoning: typeof reasoning === 'string' && reasoning ? reasoning : undefined,
        usage: usage
          ? {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
            }
          : undefined,
      }
    } catch (err) {
      throw this.mapStreamError(err, timedOut, opts.signal)
    } finally {
      finish()
    }
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
