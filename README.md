# paopao — 简易命令行聊天 CLI

一个连本地模型的命令行聊天工具：交互式 REPL + 单次问答两种模式，流式输出，
支持切换 DeepSeek 等 OpenAI 兼容 API。

## 快速开始

```bash
pnpm install        # 装依赖（tsx / tsup / commander）
pnpm paopao         # 进入交互聊天 —— 像进入 mysql 那样出现提示符
pnpm paopao "你好"  # 单次问答：问一句、流式打印回答、即退
pnpm paopao models  # 列出可用模型（Ollama /v1/models）
```

```text
paopao · qwen3:14b @ http://localhost:11434/v1
输入 /help 查看命令。回答中 Ctrl+C 中断；提示符处 Ctrl+C 退出。
❯ 你好
paopao › 思考中 🤔        ← 模型冷加载/思考中（不用再敲回车）
paopao › 2。              ← 思考过程灰显实时滚动，正式回答一出整段擦除，只剩回答
❯ /exit                  ← 退出（相当于 mysql 里的 exit）
```

REPL 命令：`/exit` 退出 · `/clear` 清屏 · `/help` 帮助。

## 命令与配置

```
paopao                      → 交互 REPL
paopao "问题"               → 单次问答
paopao models               → 列出可用模型（非 Ollama 显示静态提示）
paopao --help               → 帮助（commander 自动）
```

配置优先级：**默认值 < `.env` / 环境变量 < CLI 参数**，五样都可配。

> `.env`：项目根目录放 `.env` 即可（`PAOPAO_BASE_URL=…` 一行一个），零依赖自动加载；
> 真实 shell 环境变量优先于 `.env`。`.env` 已被 .gitignore 忽略，放心放 key。

| 项 | 环境变量 | CLI 参数 | 默认值 |
|---|---|---|---|
| 服务地址 | `PAOPAO_BASE_URL` | `--base-url` | `http://localhost:11434/v1` |
| 模型 | `PAOPAO_MODEL` | `--model` | `qwen3:14b` |
| API key | `PAOPAO_API_KEY` | `--api-key` | 空（Ollama 免 key） |
| 超时(秒) | `PAOPAO_TIMEOUT` | `--timeout` | 120 |
| 温度 | `PAOPAO_TEMPERATURE` | `--temperature` | 0.7 |

换 DeepSeek 示例：

```bash
PAOPAO_BASE_URL=https://api.deepseek.com \
PAOPAO_MODEL=deepseek-v4-flash \
PAOPAO_API_KEY=你的key \
pnpm paopao "你好"
```

## 本地模型是怎么跑起来的

模型不是装在本项目里的，而是由 **Ollama** 这个程序跑成一个常驻的本地 HTTP 服务：

- 启动服务：`ollama serve`（或安装 Ollama 桌面应用后常驻）
- 模型（本机已装 `qwen3:14b`）由 Ollama 进程加载到内存里负责计算
- 常用命令：`ollama list` 看本机有哪些模型 · `ollama pull <名字>` 下载新模型

## 怎么连到本项目

本项目通过 HTTP 向本地服务发请求，走 **OpenAI 兼容协议**，Ollama 和 DeepSeek
共用一份代码（只是 base-url / model / key 不同）：

```
POST http://localhost:11434/v1/chat/completions
body: { model: "qwen3:14b", messages: [...], stream: true }
```

模型边算边用 SSE 流式回文字，客户端把两家响应归一成统一事件
（`thinking` / `content` / `usage` / `done`，思考字段 Ollama 的 `reasoning` 与
DeepSeek 的 `reasoning_content` 合并成 `thinking`）。核心代码：

- [src/llm/OpenAICompatibleClient.ts](src/llm/OpenAICompatibleClient.ts) — 统一客户端
- [src/llm/streaming.ts](src/llm/streaming.ts) — SSE 解析器
- [src/repl.ts](src/repl.ts) — 交互循环
- [src/cli.ts](src/cli.ts) — commander 命令面

## 交互细节

- 回车后立刻出现 `paopao › 思考中 🤔`：模型冷加载可能好几秒，这行字让你知道
  程序在工作，首字一到就擦掉，**无需再敲第二次回车**。
- 模型的**思考过程用灰色实时显示**；正式回答一开始，整段思考过程被从屏幕
  **擦除**（按终端列宽计折行，避免残留），只留回答。
- 回答进行中按 **Ctrl+C** 中断；提示符处按 Ctrl+C 干净退出。
- 多轮上下文（见 [src/context.ts](src/context.ts)）：完整历史 + token 预算截断
  （默认 ~24K），system 提示永远保留。

## 开发

```bash
pnpm paopao        # dev 直接跑 TS（tsx，无需构建）
pnpm typecheck     # tsc --noEmit
pnpm build         # tsup 打包到 dist/
npm start          # 运行构建产物（需先 build）
npm i -g .         # 全局安装，之后任意目录用 `paopao`
```

## 技术栈

TypeScript + Node ≥ 22 · [commander](https://github.com/tj/commander.js)（CLI）·
[tsx](https://tsx.is)（dev 运行）· [tsup](https://tsup.egoist.dev)（构建）。
