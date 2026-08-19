---
label: wayfinder:map
title: paopao — 简易命令行聊天 CLI（Ollama + DeepSeek 兼容）
---

# Map: paopao — 简易命令行聊天 CLI

> **地图完成**（2026-08-19）：frontier 为空，5 张 ticket 全部决议，进入实现交接。

## Destination

一个简易、能跑的命令行聊天 CLI **`paopao`**：默认连本地 Ollama（qwen3:8b），可配置切到 DeepSeek 等 OpenAI 兼容 API；交互式 REPL + 单次问答两种模式；流式输出；`npm i -g` 后任意目录 `paopao` 即用。

## Notes

领域：Node/TS CLI，学习项目。技术栈参照 `D:\Pai\paicli-ts-main`（pnpm + tsx dev + tsup build + commander），但**砍掉 AI-Agent 部分**（ink/react TUI、MCP、SQLite 记忆、工具系统）。
本机事实：Node 22.23（原生可跑 .ts，但按参照用 tsx）、Ollama 0.32.14 已装模型 `qwen3:8b`、无 Go/Rust、非 git 仓库。
每次会话先查 skill：`grilling` + `domain-modeling`；涉及 LLM API 细节时查 `claude-api` 与 DeepSeek/Ollama 官方文档。
本地 tracker 约定见 [wayfinding/README.md](README.md)。

## Decisions so far

<!-- 索引：每 closed ticket 一行 gist + 链接 -->

- [研究: 确认 OpenAI 兼容接入细节（Ollama /v1 + DeepSeek）](tickets/001-research-openai-compat-details.md) — 统一策略：base_url 去尾斜杠 + 追加 `/chat/completions`（Ollama=`…/v1`、DeepSeek=`api.deepseek.com`，一条规则通吃）；请求体 `max_tokens`+`stream:true` 两者通吃；SSE 解析需跳过 `:` 注释行/空行并容忍未知字段（推理字段 Ollama=`delta.reasoning`、DeepSeek=`delta.reasoning_content`）；usage 从任意携带它的 chunk 读。DeepSeek 旧模型名 deepseek-chat/reasoner 已停用，改用 deepseek-v4-flash/pro。
- [原型: 流式聊天 REPL 的交互体验](tickets/002-prototype-streaming-repl.md) — 零依赖 TS 骨架直连 Ollama，`npm start` 进交互。决策：`paopao ›` 后立即显示 `思考中 🤔`（冷加载 3–7s，无需第二次回车）；思考过程灰显实时显示、正式回答一出整段擦除；流式中 Ctrl+C 中断、提示符处干净退出（已修 AbortError）；单次模式也带 system 提示。错误映射沿用 001。
- [决策: OpenAI 兼容客户端协议层设计](tickets/003-decision-llm-client-design.md) — 类 `OpenAICompatibleClient`（无工具、不继承）+ 独立 `parseSseStream`（async generator）+ 归一化事件流（`thinking` 合并 Ollama `reasoning` / DeepSeek `reasoning_content`）；`ChatError(kind)` 新增 `timeout`（`timeoutMs` 默认 120s）；透传 messages、temperature 0.7、max_tokens 1024、include_usage 默认开。落地于实现阶段。
- [决策: 多轮上下文与系统提示](tickets/004-decision-conversation-context.md) — 完整历史 + 预算截断（默认 ~24K tokens，qwen3:8b 窗口 40960；从最旧对丢弃、system 永留）；扩展 system 提示（「先结论后理由、不编造、代码给最小示例」等，全文见 ticket）；历史只存正式回答、不回传思考过程；token 估算零依赖近似。
- [决策: 配置与命令面](tickets/005-decision-config-cli-surface.md) — commander；配置全覆盖（base-url/model/api-key/timeout/temperature，env+flag，默认值<env<参数）；命令：`paopao`(REPL)/`paopao "问题"`(单次)/`paopao models`(列模型)；排查提示带 `paopao models`/`ollama list` 引导。

## Not yet specified

（全部已决议或转出范围——见 Out of scope。发布/打包属于实现细节：目的地含「npm i -g 即可用」，bin/files 已在 package.json 里）

## Out of scope

- AI-Agent 能力（工具调用、MCP、长期记忆、多 Agent 编排）—— 参照 paicli-ts 的 Agent 部分，超出"简易聊天 CLI"目的地。
- 图形化 TUI（ink/react）—— REPL 用 Node `readline` 足够。
- REPL 内热切换模型/服务（运行中 `/model` 切换）—— 005 命令面未纳入，超出极简范围；将来需要时新起 effort。
- 对话历史持久化（保存/回放）—— 当前目的地不含。
