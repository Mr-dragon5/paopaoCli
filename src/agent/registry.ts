// ============================================================================
// Agent 工具注册表
// ============================================================================
// 第一阶段只负责工具的注册、查询和执行路由；参数校验与权限元数据在后续
// 阶段加入。这样 ReAct 循环不再依赖 tools.ts 中的静态数组和 switch。
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ChatTool } from '../llm/types.js'
import type { ToolRuntime } from './tools.js'

export type ToolExecutor = (
  runtime: ToolRuntime,
  args: Record<string, unknown>,
  confirm: (desc: string) => Promise<boolean>,
) => Promise<string>

export type ToolDangerLevel = 'safe' | 'low' | 'medium' | 'high'

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: ZodType<Record<string, unknown>>
  dangerLevel: ToolDangerLevel
  isReadOnly: boolean
  isConcurrencySafe: boolean
  timeoutMs: number
  execute: ToolExecutor
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>()

  register(tool: ToolRegistration): void {
    if (this.tools.has(tool.name)) throw new Error(`工具已注册：${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name)
  }

  listNames(): string[] {
    return [...this.tools.keys()]
  }

  getDefinitions(): ChatTool[] {
    return this.listNames().map((name) => {
      const tool = this.tools.get(name)!
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          // Zod 是运行时校验的单一来源，同时转换成 OpenAI function schema。
          parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
        },
      }
    })
  }

  async execute(
    runtime: ToolRuntime,
    name: string,
    args: Record<string, unknown>,
    confirm: (desc: string) => Promise<boolean>,
  ): Promise<string> {
    const tool = this.get(name)
    if (!tool) return `(未知工具：${name})`
    const parsed = tool.inputSchema.safeParse(args)
    if (!parsed.success) return `(工具参数无效：${parsed.error.message})`
    return tool.execute(runtime, parsed.data, confirm)
  }
}
