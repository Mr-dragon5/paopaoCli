// ============================================================================
// 交互聊天（REPL）—— 常开代理模式（004）
// ============================================================================
// 用 `paopao`（或 `pnpm paopao`）进入。逐条输入消息回车，走 ReAct 循环：
// 模型先思考要不要调工具（get_time / run_command / read_file），要就执行、
// 结果回传，直到模型给出最终回答并流式输出。
//
// 命令：/exit 退出 · /clear 清屏 · /help 帮助
//
// 交互细节（004）：
//   - 回车后显示 spinner；模型 reasoning 以独立的低亮度思考区块完整展示。
//   - 工具调用、结果和最终回答都按独立区块显示，段落缩进两格并留空行。
//   - run_command 命中危险命令清单 → 先 y/n 确认（003）。
//   - Ctrl+C：危险确认中=取消该命令；判定/流式中=中断整轮；提示符处=退出。
//   - 中断/失败会把本轮追加的 user 与工具链从历史回滚。
//
// 历史（004）：system（AGENT_SYSTEM_PROMPT）+ 各轮的 user / assistant(tool_calls)
// / tool 结果 / assistant(最终回答)，按预算整轮截断（trimToBudget，002）。
// ============================================================================
import * as readline from 'node:readline/promises'
import { OpenAICompatibleClient } from './llm/OpenAICompatibleClient.js'
import { ChatError, type ChatMessage } from './llm/types.js'
import { AGENT_SYSTEM_PROMPT } from './systemPrompt.js'
import { runAgentTurn } from './agent/loop.js'
import { createRuntime, detectShellLabel } from './agent/tools.js'
import type { Config } from './config.js'

// ANSI 颜色转义码：\x1b[<样式>m 开始，\x1b[0m 结束
const ANSI = {
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}

// 助手回答的前缀
const PREFIX = 'paopao › '

const HELP = `
  /exit   退出
  /clear  清屏
  /help   显示本帮助
`.trim()

// 屏幕展示用截断（不截断喂给模型的完整结果，只截显示）
function displayTruncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

// 将模型的段落统一缩进，保持思考、工具结果和最终回答的视觉层级一致。
function indentBlock(s: string): string {
  return s
    .split(/\r?\n\r?\n/)
    .map((paragraph) => paragraph.split(/\r?\n/).map((line) => `  ${line}`).join('\n'))
    .join('\n\n')
}

export async function runRepl(cfg: Config): Promise<void> {
  const client = new OpenAICompatibleClient({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  })
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  // 历史：第一句是 system（agent 版提示词，004），后面按轮追加
  const messages: ChatMessage[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }]
  // Runtime 维护工作目录（003）：整场 REPL 会话共享，模型 cd 后后续命令跟着走
  const runtime = createRuntime(process.cwd())

  // 三个 AbortController：危险确认中 / 判定流式中 / 提示符处
  let turnAc: AbortController | null = null
  let confirmAc: AbortController | null = null
  let questionAc: AbortController | null = null

  // 接管 Ctrl+C。有监听器时 readline 不会自己 close（避免 AbortError 冒泡）。
  rl.on('SIGINT', () => {
    if (confirmAc) {
      confirmAc.abort() // 危险确认中 → 取消该命令，继续本轮
      return
    }
    if (turnAc) {
      turnAc.abort() // 判定/流式中 → 中断整轮
      return
    }
    questionAc?.abort() // 提示符处 → 干净退出
  })

  // 危险命令 y/n（003）：确认中 Ctrl+C = 取消，返回 false
  async function confirmDangerous(desc: string): Promise<boolean> {
    const ac = new AbortController()
    confirmAc = ac
    try {
      const ans = await rl.question(
        ANSI.yellow + desc + ANSI.reset + '\n' + ANSI.green + '是否执行？' + ANSI.reset + ' [y/N] ',
        { signal: ac.signal },
      )
      return /^y(es)?$/i.test(ans.trim())
    } catch {
      return false
    } finally {
      confirmAc = null
    }
  }

  // 启动横幅：当前连的模型与服务 + 探测到的 shell（方便确认 shell 自动探测）
  const shellLabel = await detectShellLabel()
  console.log(
    `${ANSI.bold}${ANSI.cyan}paopao${ANSI.reset} · ${ANSI.dim}${cfg.model} @ ${cfg.baseUrl}（代理模式 · shell: ${shellLabel}）${ANSI.reset}`,
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

    // 一轮 ReAct。失败/中断时回滚消息；达到执行上限时保留已完成的工具链。
    const startLen = messages.length
    messages.push({ role: 'user', content: line })

    const turn = new AbortController()
    turnAc = turn
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let spinnerTimer: NodeJS.Timeout | null = null
    let spinnerFrame = 0
    let answerStarted = false
    let answerAtLineStart = true
    // spinner 只表示当前正在等待模型，收到思考/工具/回答后会停止并换行。
    const renderSpinner = () => {
      process.stdout.write(`\r\x1b[K${ANSI.bold}${ANSI.yellow}${spinnerFrames[spinnerFrame]} 思考中${ANSI.reset}`)
      spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length
    }
    const startThinking = () => {
      if (spinnerTimer) return
      renderSpinner()
      spinnerTimer = setInterval(renderSpinner, 120)
    }
    const finishThinkingLine = () => {
      if (!spinnerTimer) return
      clearInterval(spinnerTimer)
      spinnerTimer = null
      process.stdout.write('\n')
    }
    const completeThinking = () => {
      finishThinkingLine()
      process.stdout.write(ANSI.bold + ANSI.green + '✓ 思考完成' + ANSI.reset + '\n')
    }
    const writeIndentedChunk = (text: string) => {
      let rest = text
      while (rest.length) {
        if (answerAtLineStart) {
          process.stdout.write('  ')
          answerAtLineStart = false
        }
        const newline = rest.indexOf('\n')
        if (newline === -1) {
          process.stdout.write(rest)
          return
        }
        process.stdout.write(rest.slice(0, newline + 1))
        rest = rest.slice(newline + 1)
        answerAtLineStart = true
      }
    }
    startThinking()
    try {
      await runAgentTurn(
        client,
        runtime,
        messages,
        {
          confirm: confirmDangerous,
          onThinking: (t) => {
            finishThinkingLine()
            process.stdout.write(ANSI.dim + '\n' + indentBlock(t) + ANSI.reset + '\n')
          },
          onToolCall: (name, argsText) => {
            finishThinkingLine()
            process.stdout.write(
              '\n' + ANSI.green + '▶ 调用工具：' + name + ANSI.reset +
                '\n' + ANSI.dim + '  参数：' + displayTruncate(argsText, 400) + ANSI.reset,
            )
          },
          onToolResult: (r) => {
            finishThinkingLine()
            process.stdout.write(
              '\n\n' + ANSI.dim + '↳ 工具结果' + ANSI.reset + '\n\n' +
                ANSI.dim + indentBlock(displayTruncate(r, 400)) + ANSI.reset + '\n',
            )
            startThinking()
          },
          onFinalChunk: (t) => {
            if (!answerStarted) {
              completeThinking()
              answerStarted = true
              answerAtLineStart = true
              process.stdout.write('\n\n' + ANSI.cyan + '回答' + ANSI.reset + '\n\n')
            }
            writeIndentedChunk(t)
          },
        },
        { signal: turn.signal, temperature: cfg.temperature },
      )
    } catch (e) {
      messages.length = startLen // 失败/中断回滚这轮 user 与工具链
      console.log()
      if (e instanceof ChatError) {
        if (e.kind === 'aborted') console.log(ANSI.dim + '(已中断)' + ANSI.reset)
        else console.log(ANSI.red + e.message + ANSI.reset)
      } else {
        console.log(ANSI.red + `未知错误：${String(e)}` + ANSI.reset)
      }
    } finally {
      finishThinkingLine()
      turnAc = null
    }
    console.log()
  }

  rl.close()
  console.log('bye')
}
