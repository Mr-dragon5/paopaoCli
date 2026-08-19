// ============================================================================
// 统一工具执行器
// ============================================================================
// ToolRegistry 只负责“找到哪个工具”；本类负责统一执行生命周期：参数校验、
// 超时、异常转换和字符串结果约定。工具内部仍可通过 confirm() 处理文件覆盖、
// 危险命令等具体交互。
import type { ToolRuntime } from './tools.js'
import type { ToolRegistry } from './registry.js'

export interface ToolExecutionRequest {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolExecutionResult {
  id: string
  name: string
  content: string
}

// 限制同一批只读工具的并发度，避免大量目录/文件查询挤占终端资源。
const MAX_CONCURRENT_READ_TOOLS = 4

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(
    runtime: ToolRuntime,
    name: string,
    args: Record<string, unknown>,
    confirm: (desc: string) => Promise<boolean>,
  ): Promise<string> {
    const tool = this.registry.get(name)
    if (!tool) return `(未知工具：${name}，可用工具：${this.registry.listNames().join(', ')})`

    const parsed = tool.inputSchema.safeParse(args)
    if (!parsed.success) return `(工具参数无效：${parsed.error.message})`

    try {
      return await this.withTimeout(
        tool.execute(runtime, parsed.data, confirm),
        tool.timeoutMs,
        name,
      )
    } catch (error) {
      return `(工具执行失败：${name}，${error instanceof Error ? error.message : String(error)})`
    }
  }

  async executeMany(
    runtime: ToolRuntime,
    requests: ToolExecutionRequest[],
    confirm: (desc: string) => Promise<boolean>,
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = []
    let index = 0

    while (index < requests.length) {
      const request = requests[index]
      const tool = this.registry.get(request.name)
      const canRunConcurrently = Boolean(tool?.isReadOnly && tool.isConcurrencySafe)

      if (!canRunConcurrently) {
        // 写入、执行命令等有副作用的工具严格按模型给出的顺序执行。
        results.push({
          ...request,
          content: await this.execute(runtime, request.name, request.args, confirm),
        })
        index++
        continue
      }

      // 只把连续的只读调用组成批次；遇到副作用工具立即结束当前批次，保留语义顺序。
      const batch: ToolExecutionRequest[] = []
      while (index < requests.length && batch.length < MAX_CONCURRENT_READ_TOOLS) {
        const candidate = requests[index]
        const candidateTool = this.registry.get(candidate.name)
        if (!candidateTool?.isReadOnly || !candidateTool.isConcurrencySafe) break
        batch.push(candidate)
        index++
      }
      const batchResults = await Promise.all(
        batch.map(async request => ({
          ...request,
          content: await this.execute(runtime, request.name, request.args, confirm),
        })),
      )
      // Promise.all 按输入顺序返回，确保回传给模型的 tool 结果与 tool_calls 对齐。
      results.push(...batchResults)
    }

    return results
  }

  private async withTimeout(task: Promise<string>, timeoutMs: number, name: string): Promise<string> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} 超过 ${timeoutMs / 1000}s 超时限制`)), timeoutMs)
    })
    try {
      return await Promise.race([task, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
