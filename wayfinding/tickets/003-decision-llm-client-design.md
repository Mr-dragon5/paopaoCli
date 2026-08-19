---
id: 003
title: 决策: OpenAI 兼容客户端协议层设计
type: grilling
status: closed
assignee: main-session
blocked_by: [001]
blocks: []
label: wayfinder:grilling
---

## Question

统一客户端怎么组织？

- 请求构造：messages 组装、system / temperature / max_tokens 等参数
- SSE 流式解析：delta 累积、错误事件处理
- 错误映射：连接拒绝 →「Ollama 服务未启动？」；404 →「模型不存在」；401 →「API key 错误」
- 超时 / AbortSignal

基于 001 的事实清单决定实现结构（单一 `OpenAICompatibleClient` 的模块划分）。

## Resolution

基于 001 事实清单与原型经验，HITL 拍板（1A 2A 3A 4ok）：

- **结构（Q1）**：类 `OpenAICompatibleClient`，参照 `D:\Pai\paicli-ts-main\src\llm\providers\OpenAICompatibleClient.ts` 的范式但缩到最小——不继承 BaseLlmClient、不做工具调用。构造 `(baseUrl, model, apiKey?)`，方法 `streamChat(messages, opts)` 产出流。
- **SSE 解析与字段归一（Q2）**：独立 `parseSseStream`（async generator）只管抽 `data:` 行，跳过 `:` 注释行 / 空行 / `[DONE]` / 坏 JSON；客户端把流归一成事件 `{type:'thinking'|'content'|'usage'|'done', …}`。**Ollama `delta.reasoning` 与 DeepSeek `delta.reasoning_content` 合并为一个 `thinking` 字段**，调用方（REPL）不感知 provider 差异。
- **错误与超时（Q3）**：保留 `ChatError(kind)`：network / http / auth / model_not_found / aborted，**新增 timeout**；可选 `timeoutMs`（默认 120s）超时抛「响应超时」；AbortSignal 保留（Ctrl+C）。
- **请求参数（Q4）**：完整 `messages` 透传（上下文裁剪归 004）；`temperature` 默认 0.7；`max_tokens` 默认 1024；`stream_options.include_usage` 默认开。
- **落地时机**：此结构在实现阶段落地（地图走完交接时）；当前原型 `src/streamChat.ts` 保持为 002 产物不动。
