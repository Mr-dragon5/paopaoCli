# Wayfinding tracker（local-markdown）

本目录是 wayfinder 地图的本地实现。无外部 issue tracker，默认使用此形式。

## 结构

- `map.md` — 地图（label: `wayfinder:map`）。索引，低分辨率总览。
- `tickets/<id>-<slug>.md` — ticket，每张是地图的子 issue。

## Ticket frontmatter

- `id` — 数字 id
- `title` — 名称（人类可读）
- `type` — research | prototype | grilling | task
- `status` — open | closed
- `assignee` — 认领人；**认领 = 先写 assignee 再做任何工作**；空 = 未认领
- `blocked_by` / `blocks` — id 列表，阻塞边
- `label` — `wayfinder:<type>`

## 操作

- **查询 frontier**：`status=open` 且所有 `blocked_by` 已 closed 且未 assignee 的 ticket
- **决议**：在 ticket 追加 `## Resolution` 段，置 `status=closed`，并在 `map.md` 的 `## Decisions so far` 追加一行 gist + 链接
- **阻塞**：在 frontmatter 维护 `blocked_by` / `blocks`
- **越界**：ticket 落在目的地之外 → 关闭它，并在 `map.md` 的 `## Out of scope` 留一行 gist + 链接；不进 Decisions so far

## 引用

人类可读时一律用 ticket 的 **title**（name），不裸用 id。

## 备注

本仓库非 git 仓库，research 成果直接写入 ticket 的 `## Resolution` 段（无分支）。
