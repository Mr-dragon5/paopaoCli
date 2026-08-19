// ============================================================================
// 上下文管理 —— token 估算 + 预算截断
// ============================================================================
// 依据：ticket 004。完整历史 + 预算截断：正常全量发送，估算超过预算就从
// 最旧的 user/assistant 对开始丢，system 永远保留。
// 预算默认 ~24K tokens（qwen3:8b 窗口 40960，给输出/思考留余量；
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
export function trimToBudget(
  messages: ChatMessage[],
  budget: number = CONTEXT_BUDGET_TOKENS,
): ChatMessage[] {
  const result = [...messages]
  const total = () => result.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) // +4 每条消息的框架开销
  while (result.length > 1 && total() > budget) {
    const idx = result.findIndex((m) => m.role !== 'system')
    if (idx === -1) break
    result.splice(idx, 1)
    // 相邻的下一条非 system 也去掉，避免留下孤立的 user 消息
    if (result[idx] && result[idx].role !== 'system') result.splice(idx, 1)
  }
  return result
}
