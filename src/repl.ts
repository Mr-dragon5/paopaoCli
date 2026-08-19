// ============================================================================
// 交互聊天（REPL）—— 像 mysql 命令行那样，进去后一直等你输入
// ============================================================================
// 用 `paopao`（或 `pnpm paopao`）进入。逐条输入消息回车，模型流式回答。
//
// 命令：/exit 退出 · /clear 清屏 · /help 帮助
//
// 交互细节：
//   - 回车后立刻出现 "paopao › 思考中 🤔"：模型冷加载可能好几秒，这行字让
//     用户知道程序在工作；首字一到就擦掉。
//   - 思考过程灰显实时显示；正式回答一开始，整段思考过程被从屏幕擦除
//     （ANSI 多行擦除，按终端列宽计折行），只留回答。
//   - Ctrl+C 被接管：回答中中断本次回答；提示符处干净退出。
//
// 多轮上下文（004）：messages 攒在内存里，每轮发送前按 token 预算截断
// （trimToBudget），system 永远保留；历史只存正式回答，不回传思考过程。
// ============================================================================
import * as readline from 'node:readline/promises'
import { OpenAICompatibleClient } from './llm/OpenAICompatibleClient.js'
import { ChatError, type ChatMessage } from './llm/types.js'
import { DEFAULT_SYSTEM_PROMPT } from './systemPrompt.js'
import { trimToBudget } from './context.js'
import type { Config } from './config.js'

// ANSI 颜色转义码：\x1b[<样式>m 开始，\x1b[0m 结束
const ANSI = {
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}

// 助手回答的前缀（占 9 列，eraseReasoning / clearIndicator 用它定位）
const PREFIX = 'paopao › '
const PREFIX_COLS = PREFIX.length

const HELP = `
  /exit   退出
  /clear  清屏
  /help   显示本帮助
`.trim()

// 字符在终端里占几列：中日韩全角 ≈2、emoji ≈2、ASCII ≈1、控制符 ≈0。
// 用于估算思考过程折行后占多少"视觉行"。
function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!
  if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0
  if (
    (c >= 0x1100 && c <= 0x115f) || // 谚文字母
    c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // 中日韩统一表意文字等
    (c >= 0xac00 && c <= 0xd7a3) || // 谚文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容表意文字
    (c >= 0xfe10 && c <= 0xfe19) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) || // 全角字符
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) || // emoji
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x2fffd) ||
    (c >= 0x30000 && c <= 0x3fffd)
  ) return 2
  return 1
}

// 擦掉屏幕上从 `paopao › ` 之后到当前光标处的整块"思考过程"。
// rows = 思考过程占用的视觉行数（含首行，考虑自动折行）。
function eraseReasoning(rows: number): void {
  if (rows <= 0) return
  const up = rows - 1
  if (up > 0) process.stdout.write(`\x1b[${up}A`) // 上移到区域首行
  process.stdout.write(`\r\x1b[${PREFIX_COLS}C`) // 定位到 `paopao › ` 之后
  process.stdout.write('\x1b[K') // 清掉首行上 `paopao › ` 之后的思考文字
  for (let i = 1; i < rows; i++) {
    process.stdout.write('\x1b[1B') // 下一行
    process.stdout.write('\x1b[2K') // 整行清空
  }
  if (up > 0) process.stdout.write(`\x1b[${up}A`) // 回到首行
  process.stdout.write(`\r\x1b[${PREFIX_COLS}C`) // 停在 `paopao › ` 之后
}

export async function runRepl(cfg: Config): Promise<void> {
  const client = new OpenAICompatibleClient({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  })
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  // 对话历史：第一句是 system（004 扩展提示词），后面按轮追加
  const messages: ChatMessage[] = [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }]

  // 两个 AbortController 对应 Ctrl+C 的两种处境：流式回答中 / 提示符处
  let streamingAc: AbortController | null = null
  let questionAc: AbortController | null = null

  // 接管 Ctrl+C。有监听器时 readline 不会自己 close（避免 AbortError 冒泡），
  // 交给我们决定：回答中→中断；提示符处→abort question 干净退出。
  rl.on('SIGINT', () => {
    if (streamingAc) {
      streamingAc.abort()
      return
    }
    questionAc?.abort()
  })

  // 启动横幅：当前连的模型与服务
  console.log(
    `${ANSI.bold}${ANSI.cyan}paopao${ANSI.reset} · ${ANSI.dim}${cfg.model} @ ${cfg.baseUrl}${ANSI.reset}`,
  )
  console.log(ANSI.dim + '输入 /help 查看命令。回答中 Ctrl+C 中断；提示符处 Ctrl+C 退出。' + ANSI.reset)

  for (;;) {
    const q = new AbortController()
    questionAc = q
    let line: string
    try {
      line = (await rl.question(`${ANSI.green}❯ ${ANSI.reset}`, { signal: q.signal })).trim()
    } catch {
      break // 提示符处 Ctrl+C → 干净退出
    } finally {
      questionAc = null
    }
    if (!line) continue

    if (line.startsWith('/')) {
      const cmd = line.split(/\s+/)[0]
      if (cmd === '/exit') break
      if (cmd === '/clear') {
        console.clear()
        continue
      }
      if (cmd === '/help') {
        console.log(HELP)
        continue
      }
      console.log(ANSI.red + `未知命令：${cmd}` + ANSI.reset)
      continue
    }

    messages.push({ role: 'user', content: line })

    const ac = new AbortController()
    streamingAc = ac
    process.stdout.write(ANSI.cyan + PREFIX + ANSI.reset)
    process.stdout.write(ANSI.dim + '思考中 🤔' + ANSI.reset)
    let started = false // 是否已出第一个字
    let sawReasoning = false // 是否真的打印过思考过程（否则不用擦除）
    const cols = process.stdout.columns ?? 0 // 终端列宽（管道/未知 → 0，退回按 \n 计数）
    let reasoningRows = 1 // 思考过程占用的视觉行数（首行含 `paopao › `）
    let reasoningCol = PREFIX_COLS // 当前光标列（折行判断用）
    const walkReasoning = (t: string) => {
      for (const ch of t) {
        if (ch === '\n') {
          reasoningRows++
          reasoningCol = 0
          continue
        }
        const w = charWidth(ch)
        if (cols > 0 && reasoningCol + w > cols) {
          reasoningRows++
          reasoningCol = w
        } else {
          reasoningCol += w
        }
      }
    }
    const clearIndicator = () => {
      if (started) return
      started = true
      // 显式锚定到 `paopao › ` 后再清到行尾（🤔 是双宽 emoji，直接 \x1b[K 可能落点偏移）
      process.stdout.write(`\r\x1b[${PREFIX_COLS}C\x1b[K`)
    }
    let reply = ''
    try {
      // 发送前按预算截断历史（004），system 永远保留
      const toSend = trimToBudget(messages)
      for await (const ev of client.streamChat(toSend, {
        signal: ac.signal,
        temperature: cfg.temperature,
      })) {
        if (ev.type === 'thinking') {
          clearIndicator()
          sawReasoning = true
          walkReasoning(ev.text)
          process.stdout.write(ANSI.dim + ev.text + ANSI.reset) // 思考灰显
        } else if (ev.type === 'content') {
          clearIndicator()
          if (sawReasoning) {
            eraseReasoning(reasoningRows) // 正式回答一出，整块擦掉思考
            sawReasoning = false
          }
          process.stdout.write(ev.text)
          reply += ev.text
        }
        // usage / done 事件暂不展示
      }
    } catch (e) {
      messages.pop() // 失败/中断回滚这轮 user 消息
      console.log()
      if (e instanceof ChatError) {
        if (e.kind === 'aborted') console.log(ANSI.dim + '(已中断)' + ANSI.reset)
        else console.log(ANSI.red + e.message + ANSI.reset)
      } else {
        console.log(ANSI.red + `未知错误：${String(e)}` + ANSI.reset)
      }
      continue
    } finally {
      streamingAc = null
    }
    // 回答记进历史，下一轮它就能"记得"（历史只存 content，不回传思考）
    messages.push({ role: 'assistant', content: reply })
    console.log()
  }

  rl.close()
  console.log('bye')
}
