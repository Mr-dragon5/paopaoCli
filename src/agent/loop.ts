// ============================================================================
// ReAct 循环（004）—— 常开的代理回合
// ============================================================================
// 流程：判定回合（complete，非流式，带 tools）→ 有 toolCalls 则逐个执行、
// 结果以 role:"tool" 回传 → 再判定 … 直到模型返回 content（= 最终回答）。
//
// 依据 001/002：判定回合必须非流式（Ollama 流式虽能出 delta.tool_calls，但
// DeepSeek 流式未记载；最可靠信号是非流式 message.tool_calls）。
// 依据 003：工具执行走 executeTool（危险命令确认、超时、截断、Runtime cwd）。
//
// 最终回答两种呈现（004 决策）：
// - 本轮用过工具 → 流式重新请求最终回答（不带 tools，历史不含刚才的草稿），
//   让"代理组合回答"实时滚出；
// - 本轮没用工具（纯问答）→ 直接用非流式判定回合的 content，避免重复生成。
// ============================================================================
import { OpenAICompatibleClient } from '../llm/OpenAICompatibleClient.js'
import { trimToBudget } from '../context.js'
import type { ChatMessage } from '../llm/types.js'
import { TOOLS, executeTool, type ToolRuntime } from './tools.js'

// 单轮开发任务通常需要多次“写入→运行→修复”，8 轮过早截断；同时保留
// 工具调用次数和总时长上限，避免模型真正失控时无限运行。
export const MAX_AGENT_ROUNDS = 24
export const MAX_TOOL_CALLS = 40
export const MAX_AGENT_TURN_MS = 5 * 60 * 1000

// 最终回答流式 max_tokens（002 遗留注意：streamChat 默认 1024，长回答会 length 截断）
const FINAL_MAX_TOKENS = 8192

export interface AgentCallbacks {
  confirm(desc: string): Promise<boolean> // 危险命令 y/n（REPL 注入终端交互）
  onThinking(text: string): void // 判定回合的思考（灰显）
  onToolCall(name: string, argsText: string): void
  onToolResult(result: string): void
  onFinalChunk(text: string): void // 最终回答的流式 chunk（无工具时一次给全文）
}

export interface AgentTurnResult {
  content: string
  rounds: number
  exceeded: boolean
}

// 在 history 上执行一轮 ReAct（history 已含 system + 用户提问）。
// 副作用：把判定回合的 assistant(tool_calls)、tool 结果、最终回答全部追加进 history。
export async function runAgentTurn(
  client: OpenAICompatibleClient,
  runtime: ToolRuntime,
  history: ChatMessage[],
  callbacks: AgentCallbacks,
  opts: { signal?: AbortSignal; temperature?: number } = {},
): Promise<AgentTurnResult> {
  let rounds = 0
  let toolCalls = 0
  let usedTools = false
  const startedAt = Date.now()
  // 达到任意一项边界时正常结束本轮，保留已经产生的文件副作用和工具历史。
  const stopAtLimit = (reason: string): AgentTurnResult => {
    const content = `本轮${reason}，已保留已经完成的文件修改。`
    callbacks.onFinalChunk(content)
    history.push({ role: 'assistant', content })
    return { content, rounds, exceeded: true }
  }

  for (;;) {
    rounds++
    // 轮数限制防止模型在工具链中无止境地重新规划。
    if (rounds > MAX_AGENT_ROUNDS) return stopAtLimit(`达到 ${MAX_AGENT_ROUNDS} 轮执行上限`)
    if (toolCalls >= MAX_TOOL_CALLS) return stopAtLimit(`达到 ${MAX_TOOL_CALLS} 次工具调用上限`)
    if (Date.now() - startedAt >= MAX_AGENT_TURN_MS) {
      return stopAtLimit(`超过 ${MAX_AGENT_TURN_MS / 60_000} 分钟执行时长上限`)
    }

    const result = await client.complete(trimToBudget(history), {
      tools: TOOLS,
      signal: opts.signal,
      temperature: opts.temperature,
    })
    if (result.reasoning) callbacks.onThinking(result.reasoning)

    if (result.toolCalls?.length) {
      usedTools = true
      history.push({ role: 'assistant', content: '', toolCalls: result.toolCalls })
      for (const tc of result.toolCalls) {
        // 工具调用数和总时长分别限制模型的调用规模与单轮耗时。
        if (toolCalls >= MAX_TOOL_CALLS) return stopAtLimit(`达到 ${MAX_TOOL_CALLS} 次工具调用上限`)
        if (Date.now() - startedAt >= MAX_AGENT_TURN_MS) {
          return stopAtLimit(`超过 ${MAX_AGENT_TURN_MS / 60_000} 分钟执行时长上限`)
        }
        toolCalls++
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>
        } catch {
          // 001：arguments 不保证合法 JSON，容错
        }
        callbacks.onToolCall(tc.name, tc.arguments)
        const out = await executeTool(runtime, tc.name, args, callbacks.confirm)
        callbacks.onToolResult(out)
        history.push({ role: 'tool', toolCallId: tc.id, content: out })
      }
      continue
    }

    // 模型决定不再调工具 → result.content 是最终回答
    if (usedTools) {
      // 本轮用过工具：流式重新生成最终回答（不带 tools，历史不含刚才的草稿）
      let content = ''
      for await (const ev of client.streamChat(trimToBudget(history), {
        signal: opts.signal,
        temperature: opts.temperature,
        maxTokens: FINAL_MAX_TOKENS,
      })) {
        if (ev.type === 'content') {
          content += ev.text
          callbacks.onFinalChunk(ev.text)
        }
      }
      history.push({ role: 'assistant', content })
      return { content, rounds, exceeded: false }
    }

    // 纯问答：直接用非流式 content，避免重复生成
    const content = result.content
    callbacks.onFinalChunk(content)
    history.push({ role: 'assistant', content })
    return { content, rounds, exceeded: false }
  }
}
