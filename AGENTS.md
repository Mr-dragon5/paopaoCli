# AGENTS.md — 项目工作记录（精简版）

> 本文件只保留必读规则与关键摘要。完整对话记录与环境备忘见 [PROJECT_LOG.md](PROJECT_LOG.md)。

## 0. 新会话必读

1. 新会话先完整阅读本文件；需要历史细节时再读 `PROJECT_LOG.md`。
2. 新工作、新问题、新决策必须按时间顺序追加到 `PROJECT_LOG.md`，不得覆盖或删除历史。
3. 继续相关任务前先核对关键文件和既定决策，避免重复或冲突修改。
4. 新增或明显改动的代码必须补充简洁注释，重点说明用途、边界和非直观的设计原因；不要为显而易见的语句添加噪音注释。

## 1. 项目概述

`paopao` 是一个 TypeScript 命令行聊天 CLI，支持 Ollama/DeepSeek 兼容 API、交互式 REPL 和代理工具调用。
当前已处理 Windows REPL 执行本地命令时误触发 WSL 安装提示的问题：Windows 优先选择 PowerShell。

## 2. 关键文件清单

| 文件/目录 | 说明 |
| --- | --- |
| `src/agent/tools.ts` | 本地命令工具、工作目录和 shell 自动探测 |
| `src/agent/loop.ts` | REPL 的 ReAct 工具调用循环 |
| `src/repl.ts` | 交互式终端入口 |
| `PROJECT_LOG.md` | 完整工作记录，新会话追加 |

## 3. 完整对话记录

详情见 `PROJECT_LOG.md` 第 1 节。

## 4. 遇到的问题与解决方案

| # | 问题 | 解决方案 |
| --- | --- | --- |
| 1 | Windows 下 `bash` 可能是 WSL 启动器，探测/执行会触发 WSL 安装提示 | `src/agent/tools.ts` 在 Windows 上优先探测并使用 PowerShell，bash 仅作后备 |

## 5. 环境与工具备忘

- 工作目录：`D:\learning\paopaoCli`。
- Node.js 要求：`>=22`；常用校验：`pnpm typecheck`、`pnpm build`。
- 源码修改使用补丁；保留用户已有未提交改动。

## 6. 当前状态与下一步

### 已完成

- 修复 Windows shell 探测顺序，避免“查看当前目录”触发 WSL 安装提示。
- `pnpm typecheck` 和 `pnpm build` 已通过；本机验证 `pwd` 使用 `powershell` 并返回 `D:\learning\paopaoCli`。

### 建议的下一步

- 如需进一步回归，可启动 `pnpm paopao`，输入“查看当前目录”确认模型会正常调用本地命令工具。
- Wayfinder ReAct 地图的 `005 整合 + 实测` 已关闭，地图 frontier 为空；详见 `wayfinding/map-react.md`。
- Windows `run_command` 已增加 PowerShell UTF-8 输出与常见 Unix 命令兼容转换，`pwd && ls -la` 已验证通过。
- 工具集已扩展：`write_file`、`edit_file`、`list_directory`、`make_directory`、`run_python`，支持工作区内 Python 文件创建、修改和运行。
- ReAct 单轮边界现为 24 轮、40 次工具调用、5 分钟；达到上限会保留已完成修改和停止说明。
- Python 示例项目已移动到 `test/python_project`，根目录 `.gitignore` 已忽略整个 `test/` 目录。
- REPL 展示已调整为“spinner/思考文本 → 统一工具调用 → 工具结果 → 下一轮 spinner/思考 → 回答”的分块布局。
- spinner 行不带 `paopao ›`，`⠙ 思考中` 使用加粗高亮色，思考正文保持低亮度。
- 工具结果输出末尾必须换行后再启动下一轮 spinner；最终回答前显示绿色 `✓ 思考完成`。
