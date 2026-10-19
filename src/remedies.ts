/**
 * 单实例阻塞时的**补救物**：可直接复制的命令 + 一个可直接运行的脚本。
 *
 * 为什么单独成模块：`cdp.ts` 只负责"发现被阻塞"，而"人接下来该敲什么"是纯粹的
 * 展示/落盘问题。分开之后 cdp.ts 不必关心 PowerShell 引号转义，也便于单独测试。
 *
 * 设计要点：
 *   - 端口是**已经选好的那一个**（与插件真正会用的端口逐字一致），不是 `cdp.port` 的猜测值；
 *   - argv 由调用方用与启动时同一个 `launchArgsFor()` 生成，避免"手动起的端口和插件期望的不一样"；
 *   - 脚本落盘是 best-effort：写不出来也要把 [A]~[D] 四条出路照样给全。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginHome } from './settings.js'

export interface RelaunchRemedyInput {
  /** 目标名（zcode / mimo …）。 */
  readonly target: string
  /** 进程映像名（ZCode.exe）。 */
  readonly image: string
  /** 当前在跑的 pid 列表。 */
  readonly pids: readonly number[]
  /** 插件真正会使用的调试端口。 */
  readonly port: number
  /** 端口扫描起点（用于解释端口是怎么选出来的）。 */
  readonly portBase: number
  /** 目标可执行文件路径。 */
  readonly command: string
  /** 已解析成具体端口的启动参数（含 --remote-debugging-port=<port>）。 */
  readonly launchArgs: readonly string[]
  /** 启动工作目录（可选）。 */
  readonly cwd?: string
}

export interface RelaunchRemedy {
  /** 落盘的脚本绝对路径（写失败时为 undefined）。 */
  readonly scriptPath?: string
  /** 脚本写失败的原因（best-effort，不阻断）。 */
  readonly scriptError?: string
  /** 渲染好的、可直接贴给人看的整块文本。 */
  readonly text: string
}

/** PowerShell 单引号字面量转义：内部单引号翻倍。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 进程名（Get-Process -Name 不带 .exe）。 */
function processNameOf(image: string): string {
  return image.replace(/\.exe$/i, '')
}

/** 文件名安全的片段（目标名可能含空格/中文）。 */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'target'
}

function scriptBody(input: RelaunchRemedyInput): string {
  const name = processNameOf(input.image)
  const argList = input.launchArgs.map(psQuote).join(', ')
  const cwdLine = input.cwd !== undefined && input.cwd.length > 0
    ? `  -WorkingDirectory ${psQuote(input.cwd)} `
    : ''
  return `# 由 dsh-harness-pilot 生成：把 ${input.target} 关掉并用调试端口重新拉起。
#
# 为什么需要它：Electron 桌面端默认单实例。目标已经在跑、但**没有**带
# --remote-debugging-port 时，再启动一次只会把旧窗口拉到前台，CDP 永远不会出现。
# 本脚本只动映像名为 ${input.image} 的进程，不碰其它任何程序。
#
# 端口：${input.port}（与插件将使用的端口一致）
$ErrorActionPreference = 'Continue'
$image = ${psQuote(name)}

Write-Host "[1/3] 关闭 $image ..." -ForegroundColor Yellow
Get-Process -Name $image -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "      pid $($_.Id) 先请求正常关闭"
  try { $_.CloseMainWindow() | Out-Null } catch { }
}
Start-Sleep -Seconds 3
Get-Process -Name $image -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "      pid $($_.Id) 仍在，强制结束"
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

$left = @(Get-Process -Name $image -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
  Write-Host "仍有 $($left.Count) 个 $image 没能结束（pid $($left.Id -join ', ')）；请手动关闭后重试。" -ForegroundColor Red
  exit 1
}

Write-Host "[2/3] 带调试端口重新启动 ..." -ForegroundColor Yellow
Start-Process -FilePath ${psQuote(input.command)} -ArgumentList @(${argList}) ${cwdLine}-ErrorAction Stop

Write-Host "[3/3] 等待 CDP 端点 127.0.0.1:${input.port} ..." -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:${input.port}/json/version" -UseBasicParsing -TimeoutSec 3 | Out-Null
    $ok = $true
    break
  } catch { }
}
if ($ok) {
  Write-Host "OK：CDP 端点在 ${input.port} 上已就绪，可以回到会话里调用 harness_open。" -ForegroundColor Green
} else {
  Write-Host "CDP 端点还没起来。若应用仍在运行，说明它不接受本次参数；请改用窗口通道。" -ForegroundColor Red
  exit 2
}
`
}

/**
 * 生成补救物。**永不抛异常** —— 写脚本失败也要把命令清单给全。
 */
export function buildRelaunchRemedy(input: RelaunchRemedyInput): RelaunchRemedy {
  const name = processNameOf(input.image)
  const scriptName = `relaunch-${slug(input.target)}-${input.port}.ps1`
  let scriptPath: string | undefined
  let scriptError: string | undefined
  try {
    const directory = join(pluginHome(), 'remedies')
    mkdirSync(directory, { recursive: true })
    const candidate = join(directory, scriptName)
    writeFileSync(candidate, scriptBody(input), 'utf8')
    scriptPath = candidate
  } catch (error: unknown) {
    scriptError = error instanceof Error ? error.message : String(error)
  }

  const argLine = input.launchArgs.map(value => (/\s/.test(value) ? psQuote(value) : value)).join(' ')
  const stopLine = `Stop-Process -Name ${name} -Force`
  const relaunchLines = input.command.length > 0
    ? [
      `        ${stopLine} -ErrorAction SilentlyContinue`,
      `        Start-Process ${psQuote(input.command)} -ArgumentList @(${input.launchArgs.map(psQuote).join(', ')})`,
    ]
    : ['        (this target has no configured command — start it yourself with --remote-debugging-port=' + input.port + ')']

  const lines: string[] = [
    `target '${input.target}' is already running WITHOUT --remote-debugging-port`,
    `  image: ${input.image}   pids: ${input.pids.join(', ')}`,
    `  port this plugin would use: ${input.port}   (configured cdp.port / scan range ${input.portBase}..${input.portBase + 20})`,
    '',
    'Pick ONE:',
    '',
    '  [A] let the plugin do the whole thing',
    `        harness_open  target=${input.target}  kill_first=true`,
    '',
    '  [B] close it yourself, then harness_open (which relaunches with the flag)',
    `        ${stopLine}`,
    '',
    '  [C] close + relaunch with the flag, in one line (PowerShell)',
    ...relaunchLines,
    '',
    '  [D] skip CDP entirely — drive the window that is already open',
    `        harness_open  target=${input.target}  transport=window`,
  ]

  if (scriptPath !== undefined) {
    lines.push('', '  [E] ready-to-run script written for you (same as [C], with endpoint verification)', `        ${scriptPath}`)
  } else {
    lines.push('', `  [E] (could not write the helper script: ${scriptError ?? 'unknown error'})`)
  }
  // 2026-10-16：非破坏的防复发路线 —— 下次在应用**还没起来**时先 harness_launch，
  // 第一次启动就带调试端口，这个"只能杀"的局面根本不会出现。
  lines.push('', '  [F] prevent this next time (non-destructive): before the app starts, run', `        harness_launch  target=${input.target}  (starts it WITH --remote-debugging-port=${input.port}; never kills)`)
  if (argLine.length > 0) {
    lines.push('', `  launch argv this plugin uses: ${input.command} ${argLine}`)
  }
  return { ...(scriptPath === undefined ? {} : { scriptPath }), ...(scriptError === undefined ? {} : { scriptError }), text: lines.join('\n') }
}
