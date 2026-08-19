// ============================================================================
// 工具集—— get_time / run_command / read_file / write_file / edit_file /
// list_directory / make_directory / run_python
// ============================================================================
// 依据：ticket 003。三个工具的 schema（均无 cwd 参数，工作目录由 AgentRuntime
// 维护：初始 = paopao 启动目录，命令为 `cd <dir>` 时更新，后续命令在其下执行）。
//
// run_command 安全边界（003）：
// - 危险命令清单命中任一条 → 执行前经 confirm() 要 y/n（由 REPL 注入终端交互）
// - 超时 15s、输出截断 4KB
// read_file：相对 cwd 解析；上限 64KB；二进制/非 UTF-8 不展开
// ============================================================================
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { ToolRegistry } from './registry.js'
import { ToolExecutor } from './executor.js'

export const RUN_TIMEOUT_MS = 15_000 // 003：超时 15s
export const OUTPUT_LIMIT = 4_000 // 003：输出截断 4KB
const READ_FILE_LIMIT = 64 * 1024 // 003：read_file 上限 64KB
// 写文件和改文件共用上限，防止模型一次生成超大的源码或日志文件。
const WRITE_FILE_LIMIT = 256 * 1024

// 每个工具的输入 Schema：既用于校验模型参数，也用于自动生成 OpenAI 工具定义。
const getTimeSchema = z.object({ format: z.enum(['iso', 'human']).optional() })
const runCommandSchema = z.object({ command: z.string() })
const readFileSchema = z.object({ path: z.string() })
const writeFileSchema = z.object({ path: z.string(), content: z.string() })
const editFileSchema = z.object({ path: z.string(), oldText: z.string(), newText: z.string() })
const listDirectorySchema = z.object({ path: z.string().optional(), recursive: z.boolean().optional() })
const makeDirectorySchema = z.object({ path: z.string() })
const runPythonSchema = z.object({ path: z.string(), args: z.array(z.string()).optional() })

// 003：危险命令启发式清单——命中任一条，执行前要 y/n 确认
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\b[^;&|]*-[a-zA-Z]*[rR][a-zA-Z]*/, // 递归删除 rm -r / -rf / -fr / --recursive
  /\bdd\b/, // 写块设备
  /\bmkfs(?:\.[\w-]+)?\b/,
  /\bmkswap\b/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bsystemctl\s+(poweroff|reboot|halt)\b/,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:&\s*\};/, // fork 炸弹
  /\b(curl|wget)\b.*\|\s*(ba)?sh\b/, // 下载内容直接喂 shell
  /(>|>>)\s*\/dev\/(sd|nvme|vd|hd)[a-z0-9]*\b/, // 直写裸设备
  /\bchmod\s+(-R\s+)?(000|777|666)\s+[\/]/, // 对根目录权限破坏
  /\bchown\s+-R\s+\S+\s+\//,
  /\bfind\s+\/[^\s]*\s+-delete\b/,
]

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command))
}

// AgentRuntime：维护可变工作目录（003：schema 不带 cwd，由 Runtime 自己维护）
export interface ToolRuntime {
  cwd: string
}

export function createRuntime(cwd: string): ToolRuntime {
  return { cwd }
}

// ============================================================================
// shell 自动探测：Windows 优先使用 PowerShell，再尝试 bash（例如 Git Bash），
// 其他平台使用 bash → sh。Windows 的 bash 可能是 WSL 启动器；若先 spawn 它，
// 即使只是探测也可能弹出“请安装 WSL”，所以不能在 Windows 上把 bash 放首位。
// 探测只看"能不能 spawn"（ENOENT 才算不存在，命令本身报错不影响判定）。
// 结果缓存，只探测一次。
// ============================================================================
interface ResolvedShell {
  file: string // 实际 spawn 的可执行文件
  style: 'unix' | 'powershell' // 决定参数形态（-c / -Command）
}

let activeShell: ResolvedShell | null = null
let shellProbe: Promise<ResolvedShell> | null = null

// Windows 上 powershell 的标准绝对路径（PATH 里没有时兜底）
const POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function probeExecutable(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(file, ['-c', 'echo ok'])
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      resolve(v)
    }
    p.on('error', () => finish(false)) // ENOENT → 不存在
    p.on('close', () => finish(true)) // 能启动（哪怕命令报错）→ 存在
  })
}

function resolveShell(): Promise<ResolvedShell> {
  if (activeShell) return Promise.resolve(activeShell)
  if (!shellProbe) {
    shellProbe = (async (): Promise<ResolvedShell> => {
      if (process.platform === 'win32') {
        if (await probeExecutable('powershell')) return { file: 'powershell', style: 'powershell' }
        if (await probeExecutable(POWERSHELL_ABS)) return { file: POWERSHELL_ABS, style: 'powershell' }
      }
      if (await probeExecutable('bash')) return { file: 'bash', style: 'unix' }
      return { file: 'sh', style: 'unix' }
    })().then((s) => {
      activeShell = s
      return s
    })
  }
  return shellProbe
}

// 当前选中的 shell 标签（启动横幅用，方便确认探测结果）
export async function detectShellLabel(): Promise<string> {
  const s = await resolveShell()
  if (s.style === 'powershell') return 'powershell'
  return s.file === 'sh' ? 'sh' : 'bash'
}

// 执行一次工具调用，返回字符串结果（001/003：一律字符串、截断处带标记）
export async function executeTool(
  runtime: ToolRuntime,
  name: string,
  args: Record<string, unknown>,
  confirm: (desc: string) => Promise<boolean>,
): Promise<string> {
  return TOOL_EXECUTOR.execute(runtime, name, args, confirm)
}

function getTime(fmt: 'iso' | 'human'): string {
  const d = new Date()
  if (fmt === 'iso') return d.toISOString()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function truncate(s: string, limit = OUTPUT_LIMIT): string {
  if (s.length <= limit) return s
  return s.slice(0, limit) + '\n…(输出截断)'
}

// 模型通常生成 Unix 风格命令。Windows PowerShell 5 不支持 `&&`，且 `ls -la`
// 不是合法参数；同时旧版 PowerShell 默认按系统代码页输出，Node 按 UTF-8
// 解码后会把中文目录名显示成乱码。做最小兼容转换并显式切到 UTF-8 输出。
function preparePowerShellCommand(command: string): string {
  const normalized = command
    .replace(/\bpwd\b/g, 'Get-Location')
    .replace(/\bls\s+-(?:la|al)\b/g, 'Get-ChildItem -Force | Format-Table -AutoSize')
    .replace(/\s+&&\s+/g, '; ')
  return `$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${normalized}`
}

async function runCommand(runtime: ToolRuntime, command: string): Promise<string> {
  // `cd <dir>` 由 Runtime 维护工作目录（003），其余命令在维护的 cwd 下执行
  const cdMatch = command.match(/^cd\s+(.+)$/)
  if (cdMatch) {
    const target = path.resolve(runtime.cwd, cdMatch[1].trim())
    try {
      const st = await fs.stat(target)
      if (!st.isDirectory()) return `(cd 失败：${target} 不是目录)`
    } catch {
      return `(cd 失败：目录不存在 ${target})`
    }
    runtime.cwd = target
    return `已切换到 ${target}`
  }

  // 流式读输出，到 OUTPUT_LIMIT 就截断并杀掉子进程——不依赖 execFile 的 maxBuffer，
  // 递归/verbose 命令（ls -laR、find . 等）输出再大也不会报"执行失败"
  const shell = await resolveShell()
  return new Promise((resolve) => {
    // powershell 走 -Command；bash/sh 走 -c
    const prepared = shell.style === 'powershell' ? preparePowerShellCommand(command) : command
    const args = shell.style === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command', prepared] : ['-c', prepared]
    const child = spawn(shell.file, args, { cwd: runtime.cwd })
    let out = ''
    let exceeded = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, RUN_TIMEOUT_MS)
    const collect = (buf: Buffer) => {
      if (exceeded) return
      out += buf.toString('utf8')
      if (out.length > OUTPUT_LIMIT) {
        out = out.slice(0, OUTPUT_LIMIT)
        exceeded = true
        child.kill() // 只要前 4KB，多的杀掉，避免巨量输出占内存
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => {
      clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code
      resolve(`(无法启动命令解释器 ${shell.file}：${code ?? err.message})`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return resolve(`(超时：命令超过 ${RUN_TIMEOUT_MS / 1000}s 被终止)`)
      const body = out.trim() + (exceeded ? '\n…(输出截断)' : '')
      if (exceeded) return resolve(body || '(无输出)') // 我们主动截断，算成功
      if (code !== 0) return resolve(`(执行失败 exit ${code}) ${body || '(无输出)'}`)
      resolve(body || '(无输出)')
    })
  })
}

async function readFile(runtime: ToolRuntime, p: string): Promise<string> {
  const raw = String(p ?? '').trim()
  if (!raw) return '(read_file: path 为空)'
  const target = path.resolve(runtime.cwd, raw)
  let st: Stats
  try {
    st = await fs.stat(target)
  } catch {
    return `(文件不存在：${raw})`
  }
  if (!st.isFile()) return `(不是文件：${raw})`

  const buf = await fs.readFile(target)
  const text = buf.toString('utf8')
  if (buf.includes(0)) {
    return `(二进制文件 ${buf.length} 字节，不展开内容)`
  }
  const body = truncate(text, READ_FILE_LIMIT)
  if (buf.length > READ_FILE_LIMIT) return `(文件 ${buf.length} 字节 > 64KB 上限，已截断)\n${body}`
  return body
}

function resolveWorkspacePath(runtime: ToolRuntime, rawPath: string): { target: string } | { error: string } {
  const raw = rawPath.trim()
  if (!raw) return { error: '路径为空' }
  const target = path.resolve(runtime.cwd, raw)
  const relative = path.relative(runtime.cwd, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: `路径必须位于当前工作目录内：${raw}` }
  }
  return { target }
}

// 创建文件：新文件自动写入，已存在文件必须经用户确认后才能覆盖。
async function writeFile(
  runtime: ToolRuntime,
  p: string,
  content: string,
  confirm: (desc: string) => Promise<boolean>,
): Promise<string> {
  const resolved = resolveWorkspacePath(runtime, p)
  if ('error' in resolved) return `(写入失败：${resolved.error})`
  const data = Buffer.from(content, 'utf8')
  if (data.length > WRITE_FILE_LIMIT) return `(写入失败：文件超过 ${WRITE_FILE_LIMIT / 1024}KB 上限)`
  try {
    await fs.access(resolved.target)
    const ok = await confirm(`文件已存在，将覆盖：\n  ${resolved.target}`)
    if (!ok) return `(已取消，文件未覆盖：${p})`
  } catch {
    // 文件不存在，可以直接创建
  }
  try {
    await fs.writeFile(resolved.target, data)
    return `已写入文件：${resolved.target}（${data.length} 字节）`
  } catch (e) {
    return `(写入失败：${resolved.target}，${String(e)})`
  }
}

// 修改文件：要求 oldText 只匹配一次，避免模型因定位不精确误改多个位置。
async function editFile(
  runtime: ToolRuntime,
  p: string,
  oldText: string,
  newText: string,
  confirm: (desc: string) => Promise<boolean>,
): Promise<string> {
  const resolved = resolveWorkspacePath(runtime, p)
  if ('error' in resolved) return `(修改失败：${resolved.error})`
  if (!oldText) return '(修改失败：oldText 不能为空)'
  let current: string
  try {
    current = await fs.readFile(resolved.target, 'utf8')
  } catch {
    return `(文件不存在或不是 UTF-8 文本文件：${p})`
  }
  const occurrences = current.split(oldText).length - 1
  if (occurrences === 0) return `(修改失败：文件中找不到 oldText：${p})`
  if (occurrences > 1) return `(修改失败：oldText 匹配了 ${occurrences} 处，请提供更精确的文本)`
  const next = current.replace(oldText, newText)
  if (Buffer.byteLength(next, 'utf8') > WRITE_FILE_LIMIT) return `(修改失败：文件超过 ${WRITE_FILE_LIMIT / 1024}KB 上限)`
  const ok = await confirm(`即将修改文件：\n  ${resolved.target}`)
  if (!ok) return `(已取消，文件未修改：${p})`
  await fs.writeFile(resolved.target, next, 'utf8')
  return `已修改文件：${resolved.target}`
}

// 目录列表返回稳定、简洁的文本格式，不把 PowerShell 的平台专属表格暴露给模型。
async function listDirectory(runtime: ToolRuntime, p: string, recursive: boolean): Promise<string> {
  const resolved = resolveWorkspacePath(runtime, p || '.')
  if ('error' in resolved) return `(列目录失败：${resolved.error})`
  try {
    const st = await fs.stat(resolved.target)
    if (!st.isDirectory()) return `(不是目录：${p})`
    const lines: string[] = [`目录：${resolved.target}`]
    const visit = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const marker = entry.isDirectory() ? '[目录]' : '[文件]'
        lines.push(`${prefix}${marker} ${entry.name}`)
        if (recursive && entry.isDirectory()) await visit(path.join(dir, entry.name), `${prefix}  `)
        if (lines.join('\n').length > OUTPUT_LIMIT) return
      }
    }
    await visit(resolved.target, '')
    return truncate(lines.join('\n'))
  } catch (e) {
    return `(列目录失败：${String(e)})`
  }
}

// 目录创建允许递归创建，方便模型先搭建 Python 包目录再写入文件。
async function makeDirectory(runtime: ToolRuntime, p: string): Promise<string> {
  const resolved = resolveWorkspacePath(runtime, p)
  if ('error' in resolved) return `(创建目录失败：${resolved.error})`
  try {
    await fs.mkdir(resolved.target, { recursive: true })
    return `已创建目录：${resolved.target}`
  } catch (e) {
    return `(创建目录失败：${String(e)})`
  }
}

let pythonExecutable: string | null = null
let pythonProbe: Promise<string | null> | null = null

// Python 解释器只探测一次，并缓存结果；Windows 优先尝试 python/py，兼容常见安装方式。
function resolvePython(): Promise<string | null> {
  if (pythonExecutable) return Promise.resolve(pythonExecutable)
  if (!pythonProbe) {
    pythonProbe = (async () => {
      for (const candidate of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
        if (await probeExecutable(candidate)) {
          pythonExecutable = candidate
          return candidate
        }
      }
      return null
    })()
  }
  return pythonProbe
}

// 直接 spawn Python 而不是经 shell 执行，避免参数中的特殊字符被再次解释。
async function runPython(runtime: ToolRuntime, p: string, pyArgs: string[]): Promise<string> {
  const resolved = resolveWorkspacePath(runtime, p)
  if ('error' in resolved) return `(运行失败：${resolved.error})`
  if (path.extname(resolved.target).toLowerCase() !== '.py') return '(运行失败：只允许运行 .py 文件)'
  try {
    const st = await fs.stat(resolved.target)
    if (!st.isFile()) return `(运行失败：不是文件：${p})`
  } catch {
    return `(运行失败：文件不存在：${p})`
  }
  const executable = await resolvePython()
  if (!executable) return '(运行失败：未找到 Python，请先安装并加入 PATH)'
  return new Promise((resolve) => {
    const child = spawn(executable, ['-u', resolved.target, ...pyArgs], { cwd: runtime.cwd })
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, RUN_TIMEOUT_MS)
    const collect = (buf: Buffer) => {
      if (out.length >= OUTPUT_LIMIT) return
      out += buf.toString('utf8')
      if (out.length > OUTPUT_LIMIT) {
        out = out.slice(0, OUTPUT_LIMIT)
        child.kill()
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(`(运行失败：${String(e)})`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return resolve(`(运行超时：超过 ${RUN_TIMEOUT_MS / 1000}s)`)
      const body = out.trim() || '(无输出)'
      if (code !== 0) return resolve(`(Python exit ${code}) ${body}`)
      resolve(body + (out.length >= OUTPUT_LIMIT ? '\n…(输出截断)' : ''))
    })
  })
}

// 所有内置工具在模块末尾集中注册：函数声明已完成，注册表可直接引用各工具实现。
// TOOLS 仅作为兼容导出，真正的定义来源是 TOOL_REGISTRY。
export const TOOL_REGISTRY = new ToolRegistry()

TOOL_REGISTRY.register({
  name: 'get_time',
  description: '获取当前时间',
  inputSchema: getTimeSchema,
  dangerLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (_runtime, args) => getTime(args.format === 'human' ? 'human' : 'iso'),
})

TOOL_REGISTRY.register({
  name: 'run_command',
  description: '在本地执行一条 shell 命令并返回其输出',
  inputSchema: runCommandSchema,
  dangerLevel: 'high',
  isReadOnly: false,
  isConcurrencySafe: false,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args, confirm) => {
    const command = String(args.command ?? '').trim()
    if (!command) return '(run_command: 命令为空)'
    if (isDangerous(command)) {
      const ok = await confirm(`检测到危险命令，确认执行？\n  ${command}`)
      if (!ok) return `(已取消，危险命令未执行：${command})`
    }
    return runCommand(runtime, command)
  },
})

TOOL_REGISTRY.register({
  name: 'read_file',
  description: '读取文件内容（相对当前工作目录解析）',
  inputSchema: readFileSchema,
  dangerLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args) => readFile(runtime, String(args.path ?? '')),
})

TOOL_REGISTRY.register({
  name: 'write_file',
  description: '在当前工作目录内创建或写入一个 UTF-8 文本文件；父目录必须先存在',
  inputSchema: writeFileSchema,
  dangerLevel: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args, confirm) => writeFile(runtime, String(args.path ?? ''), String(args.content ?? ''), confirm),
})

TOOL_REGISTRY.register({
  name: 'edit_file',
  description: '在当前工作目录内用精确文本替换修改 UTF-8 文本文件',
  inputSchema: editFileSchema,
  dangerLevel: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args, confirm) =>
    editFile(runtime, String(args.path ?? ''), String(args.oldText ?? ''), String(args.newText ?? ''), confirm),
})

TOOL_REGISTRY.register({
  name: 'list_directory',
  description: '列出当前工作目录内的文件和子目录',
  inputSchema: listDirectorySchema,
  dangerLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args) => listDirectory(runtime, String(args.path ?? '.'), args.recursive === true),
})

TOOL_REGISTRY.register({
  name: 'make_directory',
  description: '在当前工作目录内创建目录',
  inputSchema: makeDirectorySchema,
  dangerLevel: 'low',
  isReadOnly: false,
  isConcurrencySafe: false,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args) => makeDirectory(runtime, String(args.path ?? '')),
})

TOOL_REGISTRY.register({
  name: 'run_python',
  description: '运行当前工作目录内的 Python 文件并返回输出',
  inputSchema: runPythonSchema,
  dangerLevel: 'high',
  isReadOnly: false,
  isConcurrencySafe: false,
  timeoutMs: RUN_TIMEOUT_MS,
  execute: async (runtime, args, confirm) => {
    const p = String(args.path ?? '')
    const pyArgs = Array.isArray(args.args) ? args.args.map(String) : []
    const ok = await confirm(`即将运行 Python 文件：\n  ${p}${pyArgs.length ? ` ${pyArgs.join(' ')}` : ''}`)
    return ok ? runPython(runtime, p, pyArgs) : `(已取消，Python 文件未执行：${p})`
  },
})

export const TOOL_EXECUTOR = new ToolExecutor(TOOL_REGISTRY)
export const TOOLS = TOOL_REGISTRY.getDefinitions()
