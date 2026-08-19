// ============================================================================
// Agent 事件流
// ============================================================================
// 将代理生命周期统一成少量稳定事件，交互层可以据此渲染终端、日志或测试，
// 不必依赖 ReAct 循环内部的控制流细节。
import type { AgentTurnResult } from './loop.js'

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; argsText: string }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'final_chunk'; text: string }
  | { type: 'turn_end'; result: AgentTurnResult }

