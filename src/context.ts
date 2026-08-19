// ============================================================================
// 上下文管理 —— token 估算 + 预算截断
// ============================================================================
// 依据：ticket 004。完整历史 + 预算截断：正常全量发送，估算超过预算就从
// 最旧的整轮开始丢（002：按整轮丢以保住 tool_calls 与其 tool 结果链），system 永远保留。
// 预算默认 ~24K tokens（qwen3:14b 窗口 40960，给输出/思考留余量；
// DeepSeek 1M 基本永不触发）。预算是否可配归 config/005。
// ============================================================================
import type { ChatMessage } from './llm/types.js'

export const CONTEXT_BUDGET_TOKENS = 24_000

// 零依赖近似：中文等全角 ≈1 字/token，ASCII ≈4 字符/token（不引 tokenizer 库）
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code > 0xff) tokens += 1
    else if (code >= 0x20) tokens += 0.25
  }
  return Math.ceil(tokens)
}

// 把 messages 裁剪到预算内（改的是副本，不影响原始历史）
// 按「整轮」丢：从最老的 user 消息起，把这一轮（到下一个 user 之前，含中间
// 的 assistant / tool 结果）整块丢弃。这样永远不拆散 assistant 的 tool_calls
// 与其 tool 结果链（002：拆散会让请求非法）。纯聊天时等价于丢成对的 user/assistant。
export function trimToBudget(
  messages: ChatMessage[],
  budget: number = CONTEXT_BUDGET_TOKENS,
): ChatMessage[] {
  const result = [...messages]
  const total = () => result.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) // +4 每条消息的框架开销
  while (result.length > 1 && total() > budget) {
    const first = result.findIndex((m) => m.role !== 'system')
    if (first === -1) break
    // 一轮的范围：从 first 到下一个 user 之前（含中间的 assistant / tool）
    let end = first + 1
    while (end < result.length && result[end].role !== 'user') end++
    result.splice(first, end - first)
  }
  return result
}
