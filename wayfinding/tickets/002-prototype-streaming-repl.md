---
id: 002
title: 原型: 流式聊天 REPL 的交互体验
type: prototype
status: closed
assignee: main-session
blocked_by: []
blocks: [004, 005]
label: wayfinder:prototype
---

## Question

流式聊天 REPL 的最小交互长什么样？要做出可观看的粗样并供人反应：

- 提示符样式与输入体验（readline 提示符、空行跳过、`/exit` 等命令形态）
- 流式打印节奏与消息分隔（回答逐字/逐块打印；用户/助手消息如何区分）
- 多轮对话的视觉呈现（历史如何回显）

产出：一个能跑的最简交互骨架（mock 或直连 Ollama 均可），链接为 asset。

## Resolution

**Asset**：`D:\learning\paopaoCli`（零依赖 TS 骨架：`bin/paopao.ts` + `src/streamChat.ts` + `src/repl.ts` + `src/systemPrompt.ts`）。`npm start` 进交互，`node bin/paopao.ts "问题"` 单次。直连本地 Ollama（qwen3:8b）实测通过。

**交互决策（HITL 拍板）**：
- **回车即答**：用户回车后立即显示 `paopao › 思考中 🤔`（灰显）。经复现确认此前"要按第二次回车"是**模型冷加载延迟**（5.2GB 加载 3–7s 静默），非 readline 双回车；指示符在首字到达时擦除，全程无需第二次回车。
- **思考过程灰显后擦除**：Ollama `delta.reasoning` / DeepSeek `delta.reasoning_content` 都读取，灰显实时打印；**正式回答一开始，整段思考过程从屏幕擦除**（ANSI 多行擦除：上移+清行+回到 `paopao ›` 后）。擦除行数按**终端列宽 + 字符显示宽度**（中文=2 列）计自动折行，避免残留（初版按 `\n` 计数会漏掉折出的视觉行，已修）。只留回答。单次模式只打正式回答。
- **Ctrl+C**：流式回答中中断本次请求（AbortController + readline SIGINT），回滚当轮 user 消息并提示 `(已中断)`；提示符处通过 abort 当前 `rl.question` 干净退出（修复原先冒泡的 `AbortError: Aborted with Ctrl+C`）。真机 TTY 行为待用户终端确认。
- **单次模式带 system**：REPL 与单次共用 `DEFAULT_SYSTEM_PROMPT`（你是 paopao，一个简洁的终端助手）。
- 错误映射沿用 001：404→模型不存在+提示 `ollama list`；连接拒绝→Ollama 未启动；401→检查 API key。

**备注**：qwen3:8b 思考过程较冗长（简单问题也想 ~10s），是否在实现阶段加"关闭思考/精简提示"选项留给 005/实现决定。
