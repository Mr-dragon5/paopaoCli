// ============================================================================
// 协议层类型 —— 对话消息、错误、归一化事件流
// ============================================================================
// 依据：ticket 003（客户端协议层设计）+ 001（两家协议事实）。
// 设计要点：调用方（REPL / 单次问答）只面对归一化事件流，
// 不感知是 Ollama 还是 DeepSeek。
// ============================================================================

// 一条对话消息
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 错误类别：kind 决定提示语，message 对用户友好
export type ChatErrorKind =
  | 'network' // 连不上服务（Ollama 没启动 / 网络不可达）
  | 'http' // 服务端明确报错
  | 'auth' // 401 鉴权失败
  | 'model_not_found' // 404 模型不存在
  | 'aborted' // 被 Ctrl+C 中断
  | 'timeout' // 请求超时

export class ChatError extends Error {
  kind: ChatErrorKind

  constructor(kind: ChatErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

// 归一化事件流：客户端把两家流式响应统一成这几种事件
export type StreamEvent =
  | { type: 'thinking'; text: string } // 思考过程（Ollama reasoning / DeepSeek reasoning_content）
  | { type: 'content'; text: string } // 正式回答文字
  | { type: 'usage'; inputTokens: number; outputTokens: number } // token 用量
  | { type: 'done'; finishReason?: string } // 一次回答结束
