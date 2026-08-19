// ============================================================================
// 配置加载 —— 优先级：默认值 < .env / 环境变量 < CLI 参数
// ============================================================================
// 依据：ticket 005。覆盖面：base-url / model / api-key / timeout / temperature，
// env 与 flag 双通道，开箱即用（默认连本地 Ollama qwen3:14b）。
//
// .env：零依赖加载 cwd/.env（无 dotenv）。真实 shell 环境变量 > .env > 默认值；
// CLI 参数仍然压过 env。
//
// 环境变量：PAOPAO_BASE_URL / PAOPAO_MODEL / PAOPAO_API_KEY / PAOPAO_TIMEOUT(秒) / PAOPAO_TEMPERATURE
// CLI 参数：--base-url / --model / --api-key / --timeout / --temperature
// ============================================================================
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

// 极简 .env 加载：读 cwd/.env，KEY=VALUE 填进 process.env。
// 只在未设置时填（真实环境变量优先），支持 # 注释与成对引号。
export function loadDotEnv(): void {
  let text: string
  try {
    text = readFileSync(path.join(process.cwd(), '.env'), 'utf8')
  } catch {
    return // 没有 .env 就算了
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv()

// commander 解析出来的 flag 值（秒/温度是数字）
export interface ConfigOptions {
  baseUrl?: string
  model?: string
  apiKey?: string
  timeout?: number // 秒
  temperature?: number
}

export interface Config {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
  temperature: number
}

const DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen3:14b',
  timeoutSec: 120,
  temperature: 0.7,
}

function envNum(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

// 取第一个合法数字（防 commander parseInt/parseFloat 传 NaN）
function firstValid(...values: Array<number | undefined>): number | undefined {
  return values.find((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

export function loadConfig(opts: ConfigOptions = {}): Config {
  // timeout：flag > env > 默认；只接受正数
  const timeoutSec = firstValid(opts.timeout, envNum('PAOPAO_TIMEOUT')) ?? DEFAULTS.timeoutSec
  // temperature：flag > env > 默认；范围 [0, 2]，越界回退默认
  const temperature = firstValid(opts.temperature, envNum('PAOPAO_TEMPERATURE')) ?? DEFAULTS.temperature

  return {
    baseUrl: opts.baseUrl ?? process.env.PAOPAO_BASE_URL ?? DEFAULTS.baseUrl,
    model: opts.model ?? process.env.PAOPAO_MODEL ?? DEFAULTS.model,
    apiKey: opts.apiKey ?? process.env.PAOPAO_API_KEY ?? undefined,
    timeoutMs: Math.round(Math.max(timeoutSec, 1) * 1000),
    temperature:
      temperature >= 0 && temperature <= 2 ? temperature : DEFAULTS.temperature,
  }
}
