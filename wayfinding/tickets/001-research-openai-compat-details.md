---
id: 001
title: 研究: 确认 OpenAI 兼容接入细节（Ollama /v1 + DeepSeek）
type: research
status: closed
assignee:
blocked_by: []
blocks: [003, 004]
label: wayfinder:research
---

## Question

为统一 OpenAI 兼容客户端（`/v1/chat/completions` + SSE 流）收集确切事实：

1. **Ollama** 的 OpenAI 兼容端点：base_url 形式（`http://localhost:11434/v1`）、鉴权要求（能否无 key）、流式 SSE 响应结构（流式与非流式的字段）、模型名规则（qwen3:8b 如何指定）、常用参数（temperature / max_tokens / stream_options）支持情况、错误形态（模型不存在 / 服务未启动）。
2. **DeepSeek**：base_url（api.deepseek.com 路径）、鉴权头（Bearer 形式）、流式 SSE delta 字段结构、模型名（deepseek-chat / deepseek-reasoner 差异与适用场景）、限流 / 计费注意点。
3. **两者差异**：字段上是否需要兼容处理（如 reasoning_content、usage、stream_options、base_url 尾部斜杠）。

产出：事实清单，每条附来源 URL，写入本 ticket 的 `## Resolution` 段并置 `status=closed`。

## Resolution

> 结论速览：**统一策略 = 归一化 base_url（去尾部斜杠）+ 追加 `/chat/completions`；请求体用 `max_tokens`（不是 max_completion_tokens）+ `stream: true`；SSE 解析必须容忍注释行/空行与不认识的 delta 字段（`reasoning` vs `reasoning_content`）；usage 从任意携带它的 chunk 读取。**

### 1. Ollama OpenAI 兼容端点

- **base_url**：`http://localhost:11434/v1`（SDK 示例写成 `.../v1/`，curl 直接打 `http://localhost:11434/v1/chat/completions`）。尾部斜杠可有可无，客户端应「去尾部斜杠 + 追加 `/chat/completions`」。https://docs.ollama.com/openai
- **鉴权**：API key「required but ignored」——传任意字符串（如 `"ollama"`）即可，本地服务器无真实鉴权；客户端有 key 就发 Bearer，Ollama 会忽略。https://docs.ollama.com/openai
- **流式 SSE 结构**（本机 0.32.14 ≥ 0.32.6，已是 OpenAI wire format；0.32.6 起变更）：每事件 `data: {json}`，结束 `data: [DONE]`。chunk 字段：`id`、`object:"chat.completion.chunk"`、`created`（全流共享同一时间戳）、`model`、`choices:[{index, delta, logprobs, finish_reason}]`。
  - 首个 chunk：`delta: {"role":"assistant","content":""}`；后续仅 `delta: {"content":"..."}`；收尾 chunk：`delta: {}` + `finish_reason:"stop"`（独立空 delta chunk）。
  - `stream_options: {include_usage: true}` 时，finish chunk 之后再发一个 `choices: []` 的 usage chunk（含 prompt_tokens/completion_tokens/total_tokens）。https://github.com/ollama/ollama/releases/tag/v0.32.6 、https://github.com/ollama/ollama/pull/17485 、https://github.com/ollama/ollama/pull/6784
  - **思考/推理 token 放在 `delta.reasoning`（不是 `reasoning_content`）**。https://github.com/ollama/ollama/pull/17485
  - 旧版（<0.32.6）wire format：role 每个 chunk 重复、finish_reason 挂在最后内容 chunk 上。防御性解析建议：任意 chunk 带上 role 就合并、任意 chunk 带 finish_reason 就取。https://github.com/ollama/ollama/pull/17485
- **非流式响应**：标准 OpenAI 形状——`choices[0].message.content`、`choices[0].finish_reason`，顶层 `usage` 恒有。https://deepwiki.com/ollama/ollama/3.4-openai-compatibility
- **模型名**：`"model": "qwen3:8b"`（name:tag），无需前缀。https://docs.ollama.com/openai
- **请求参数**（/v1/chat/completions）：支持 `model`、`messages`、`temperature`、`top_p`、`max_tokens`（**不支持 max_completion_tokens**）、`stream`、`stream_options.include_usage`、`response_format`(JSON mode)、`seed`、`stop`、`frequency_penalty`、`presence_penalty`、`tools`；不支持 `tool_choice`、`logit_bias`、`user`、`n`。https://docs.ollama.com/openai
- **错误形态**：
  - 模型不存在：HTTP **404**，body `{"error": "model '<name>' not found"}`；模型名为空则 `{"error": "model is required"}`。https://github.com/ollama/ollama/issues/6646 、https://github.com/ollama/ollama/pull/14949
  - 服务未启动：TCP 层 **connection refused（ECONNREFUSED）**，没有 HTTP 响应——客户端必须捕获网络层错误并给出友好提示。错误映射：400→invalid_request_error、404→not_found_error、500→api_error。https://deepwiki.com/ollama/ollama/3.4-openai-compatibility

### 2. DeepSeek

- **base_url**：`https://api.deepseek.com`，**没有 `/v1` 前缀**；OpenAI 兼容路径是 `https://api.deepseek.com/chat/completions`（官方 curl 直接打该地址）。https://api-docs.deepseek.com/
- **鉴权头**：`Authorization: Bearer ${DEEPSEEK_API_KEY}`。https://api-docs.deepseek.com/
- **流式 SSE delta 结构**：与 OpenAI 相同 SSE 框——`data: {json}` … `data: [DONE]`。
  - 首 chunk：`delta: {"content":"", "role":"assistant"}`、finish_reason null；内容 chunk：`delta: {"content":"..."}`；末 chunk：`delta: {"content":"", "role":null}`、`finish_reason:"stop"`，usage 可挂在该 chunk。
  - **`reasoning_content`**：位于 **delta 层**，是「最终回答之前的推理内容」；thinking 模式**默认开启**，所以默认就会出现在 delta 里，客户端必须容忍/忽略（或灰显）。https://api-docs.deepseek.com/api/create-chat-completion
  - `stream_options.include_usage: true` 时，`[DONE]` 前多一个 `choices: []` 的 usage chunk；其余 chunk `usage: null`。usage 字段含 prompt_tokens（= cache hit+miss）、completion_tokens、total_tokens、prompt_cache_hit_tokens、prompt_cache_miss_tokens、completion_tokens_details.reasoning_tokens。https://api-docs.deepseek.com/api/create-chat-completion
- **模型名**（2026 年中起）：
  - `deepseek-v4-flash`：快、便宜，通用对话/编码 —— **通用 chat CLI 推荐用这个**。
  - `deepseek-v4-pro`：顶级能力、复杂推理。两者均 1M 上下文、384K 最大输出。https://api-docs.deepseek.com/quick_start/pricing
  - 旧名 `deepseek-chat`（→v4-flash 非 thinking）、`deepseek-reasoner`（→v4-flash thinking）已废弃，DeepSeek API 于 **2026-07-24** 停用；直接使用 v4 名（第三方说明，官方文档已只列 v4 名可佐证）。https://github.com/arikusi/deepseek-mcp-server 、https://api-docs.deepseek.com/quick_start/pricing
  - thinking 模式默认**开启**；`thinking: {type:"enabled"|"disabled"}` 切换；`reasoning_effort` low/high/max（默认 high）。**thinking 开启时 temperature / top_p 被忽略**。https://api-docs.deepseek.com/api/create-chat-completion
- **限流 / 计费**：
  - 限流按**并发**而非 RPM/TPM（账户级）：v4-flash 2500 并发、v4-pro 500 并发；单线程 CLI 基本不可能触发。超限返回 HTTP 429。https://api-docs.deepseek.com/quick_start/rate_limit
  - 计费（USD/百万 token，peak/off-peak=半价，peak 为 01:00–04:00、06:00–10:00 UTC）：v4-flash cache-hit $0.007/$0.014、cache-miss $0.22/$0.44、output $0.66/$1.32；v4-pro cache-hit $0.022/$0.044、cache-miss $0.66/$1.32、output $1.98/$3.96。https://api-docs.deepseek.com/quick_start/pricing
  - **keep-alive**：请求期间服务端会发 SSE 注释行 `: keep-alive` 与空行——SSE 解析器必须跳过 `:` 开头行和空行，不能当事件解析。https://api-docs.deepseek.com/quick_start/rate_limit
- **错误形态**：HTTP 400 格式错 / 401 鉴权失败 / 402 余额不足 / 422 参数错 / 429 限流 / 500 服务错 / 503 过载；错误体为 OpenAI 风格 JSON（`error.message` / `error.type` / `error.code`，官方页面只列出 HTTP 状态码表），客户端应优先展示 `error.message`。https://api-docs.deepseek.com/quick_start/error_codes

### 3. 单一客户端必须兼容的跨平台差异

- **base_url 约定**：**归一化 = 去尾部斜杠 + 追加 `/chat/completions`**。Ollama base=`http://localhost:11434/v1`、DeepSeek base=`https://api.deepseek.com`，同一追加规则即可覆盖两者，无需特判 /v1。
- **推理字段名不同（最大差异）**：Ollama 用 `delta.reasoning`，DeepSeek 用 `delta.reasoning_content`。客户端两种键都应读取/忽略。
- **usage 位置不同**：Ollama（include_usage 时）→ finish chunk 之后的独立 `choices: []` chunk；DeepSeek → 可能挂在 finish chunk 上，也可能（include_usage 时）在 `[DONE]` 前独立空 choices chunk。客户端从「任何携带 usage 的 chunk」读取。
- **请求参数一致**：两者都用 `max_tokens`（都不用 max_completion_tokens）、都支持 temperature / top_p / stream / stream_options.include_usage / response_format。最小请求体：`model`、`messages`、`stream:true`、`temperature`、`max_tokens` 即可两者通吃。
- **stream**：`"stream": true` 非必需（默认即非流式），但本客户端要流式故显式设置；两者对 `data: {json}` … `data: [DONE]` 的解析完全一致。DeepSeek 的 `: keep-alive` 注释行是唯一解析陷阱。
- **finish_reason 取值**：两者都有 stop / length / tool_calls；DeepSeek 额外有 content_filter、insufficient_system_resource。
