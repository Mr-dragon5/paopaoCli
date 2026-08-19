---
id: 005
title: 决策: 配置与命令面
type: grilling
status: closed
assignee: main-session
blocked_by: [002]
blocks: []
label: wayfinder:grilling
---

## Question

配置与命令怎么组织？

- 配置合并优先级与覆盖面：默认值 → 环境变量 → CLI 参数；base-url / model / api-key / 超时 / 温度
- 命令形态：`paopao`（REPL）、`paopao "问题"`（单次）、`paopao models`（列出可用模型，便于排查）、`--help`
- 排查提示：Ollama 服务未启动 / 模型未安装时的友好报错，是否提示 `ollama list`

基于 002 的 REPL 体验决定。

## Resolution

HITL 拍板（1B 2A 3ok）：

- **配置覆盖面（Q1=B）**：base-url / model / api-key / timeout / temperature 全部可配，env + flag 双通道，优先级 **默认值 < 环境变量 < CLI 参数**：
  - 环境变量：`PAOPAO_BASE_URL` / `PAOPAO_MODEL` / `PAOPAO_API_KEY` / `PAOPAO_TIMEOUT`（秒）/ `PAOPAO_TEMPERATURE`
  - CLI 参数：`--base-url` / `--model` / `--api-key` / `--timeout` / `--temperature`
  - 默认值：base=`http://localhost:11434/v1`、model=`qwen3:8b`、api-key 空、timeout=120s、temperature=0.7
- **解析框架（Q2=A）**：commander（与栈决定一致）。`paopao` 无参进 REPL；`paopao "问题"` 用 `.argument('[prompt...]')` 接住作单次；`paopao models` 为子命令；`--help` / `-V` 由 commander 自带。
- **命令形态与排查（Q3=ok）**：
  - `paopao models`：Ollama 走 `/v1/models`（001 已确认）列出可用模型；非 Ollama base URL 显示静态提示（如「DeepSeek 模型列表见官网，当前：`<model>`」）。
  - 连不上服务 → 「Ollama 没启动？试试 `ollama serve`」+ 提示 `paopao models` 自查。
  - 模型不存在 → 「试试 `ollama list`」+ 提示 `paopao models`。
