// ============================================================================
// CLI 入口（commander）—— 三种用法
// ============================================================================
//   paopao                      → 交互 REPL
//   paopao "问题"               → 单次问答
//   paopao models               → 列出可用模型
//   --base-url/--model/--api-key/--timeout/--temperature 覆盖配置（005）
// 依据：ticket 005（命令形态 + 排查提示）。
// ============================================================================
import { Command } from 'commander'
import { loadConfig, type ConfigOptions } from './config.js'
import type { Config } from './config.js'
import { runRepl } from './repl.js'
import { OpenAICompatibleClient } from './llm/OpenAICompatibleClient.js'
import { ChatError } from './llm/types.js'
import { DEFAULT_SYSTEM_PROMPT } from './systemPrompt.js'

const toInt = (v: string) => parseInt(v, 10)
const toFloat = (v: string) => parseFloat(v)

// 通用配置项：父命令与 models 子命令共用
function addConfigOptions(cmd: Command): void {
  cmd
    .option('--base-url <url>', '模型服务地址（默认 http://localhost:11434/v1）')
    .option('--model <name>', '模型名（默认 qwen3:8b）')
    .option('--api-key <key>', 'API key（Ollama 可省；DeepSeek 等云端必填）')
    .option('--timeout <sec>', '请求超时秒数（默认 120）', toInt)
    .option('--temperature <n>', '采样温度 0-2（默认 0.7）', toFloat)
}

// 单次问答：问一句 → 流式打印回答 → 退出；失败退出码 1
async function runOneShot(cfg: Config, prompt: string): Promise<void> {
  const client = new OpenAICompatibleClient({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  })
  try {
    for await (const ev of client.streamChat(
      [
        { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { temperature: cfg.temperature },
    )) {
      if (ev.type === 'content') process.stdout.write(ev.text)
    }
    console.log()
  } catch (e) {
    if (e instanceof ChatError) console.error(e.message)
    else console.error(String(e))
    process.exitCode = 1
  }
}

// paopao models：Ollama 走 /v1/models（001 已确认）；非 Ollama 显示静态提示
async function listModels(cfg: Config): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/models`
  const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { data?: Array<{ id: string }> }
    const ids = j.data?.map((m) => m.id) ?? []
    if (!ids.length) {
      console.log('没有可用模型。')
      return
    }
    console.log('可用模型：')
    for (const id of ids) console.log(`  ${id}`)
  } catch {
    // 取不到（非 Ollama 或服务没起）→ 静态提示（005）
    console.log(`无法列出模型：当前 base-url 是 ${cfg.baseUrl}`)
    console.log(`当前配置的模型：${cfg.model}`)
    console.log('Ollama 可在本地用 `ollama list` 查看；DeepSeek 等云端模型列表见其官网。')
  }
}

export function createCli(): Command {
  const program = new Command()
  program
    .name('paopao')
    .description('简易命令行聊天 CLI（Ollama + DeepSeek 兼容）')
    .version('0.1.0')
    .argument('[prompt...]', '单次问答的提问；不提供则进入交互 REPL')
    .action(async (prompt: string[], opts: ConfigOptions) => {
      const cfg = loadConfig(opts)
      if (prompt.length) await runOneShot(cfg, prompt.join(' '))
      else await runRepl(cfg)
    })
  addConfigOptions(program)

  const models = program.command('models').description('列出可用模型（Ollama /v1/models）')
  addConfigOptions(models)
  models.action(async (opts: ConfigOptions) => {
    await listModels(loadConfig(opts))
  })

  return program
}
