/**
 * 模型发现：把「DSH 里已配置的供应商模型」与「各个 harness 自己认的模型」都查出来。
 *
 * 两条来源：
 *  1. DSH 侧 —— `ctx.llm.listProviders()` / `listModels(provider)`：当前 profile 配了哪些路由与模型。
 *  2. harness 侧 —— 目标配置里的 `modelsCommand`（如 `opencode models`、`agy models`），
 *     直接问那个 CLI 自己有哪些模型；结果按 `modelsCacheMs` 缓存，避免每次都起进程。
 */
import { spawn } from 'node:child_process'
import { buildArgv } from './launcher.js'
import type { TargetConfig } from './types.js'

export interface HarnessModels {
  readonly models: string[]
  /** 查询方式（给 UI/模型看的说明）。 */
  readonly note: string
}

/** 跑一次 `modelsCommand` 并解析出模型 id 列表；失败不抛错，返回空列表 + 原因。 */
export async function listHarnessModels(target: TargetConfig, timeoutMs = 25000): Promise<HarnessModels> {
  const command = target.modelsCommand.trim()
  if (command.length === 0) return { models: [], note: 'no modelsCommand configured for this harness' }
  let argv: string[]
  let verbatim = false
  try {
    const built = buildArgv(command, target.modelsArgs)
    argv = built.verbatim ? built.verbatimArgv : built.argv
    verbatim = built.verbatim
  } catch (error: unknown) {
    return { models: [], note: `cannot resolve "${command}": ${error instanceof Error ? error.message : String(error)}` }
  }
  return await new Promise<HarnessModels>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(argv[0]!, argv.slice(1), {
      env: { ...process.env, ...target.env, NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    })
    const finish = (note: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ models: parseModels(stdout), note })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已退出
      }
      finish(`${command} ${target.modelsArgs.join(' ')} (timed out after ${timeoutMs}ms)`)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => finish(`spawn failed: ${error.message}`))
    child.on('close', (code: number | null) => {
      const note = `${command} ${target.modelsArgs.join(' ')}`.trim()
      if (code !== 0 && stdout.trim().length === 0) {
        finish(`${note} exited ${String(code)}${stderr.trim().length > 0 ? `: ${stderr.trim().split(/\r?\n/)[0]?.slice(0, 120)}` : ''}`)
        return
      }
      finish(note)
    })
  })
}

/**
 * 从命令输出里解析模型 id：一行一个，取每行的第一个字段再校验。
 *
 * 各家输出格式差别很大：opencode 是一行一个纯 id；agy 是 `id<TAB>显示名`；
 * pi 是 `provider/id` 加说明文字。所以只取首个 token，并过滤说明行。
 */
export function parseModels(output: string): string[] {
  const models: string[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/^[\s*•\-–>]+/, '')
      .trim()
    if (line.length === 0 || line.length > 200) continue
    // 取第一个字段（Tab / 多空格分隔的显示名或说明都丢掉）
    const token = line.split(/[\t ]+/)[0] ?? ''
    if (token.length === 0 || token.length > 120) continue
    // 模型 id 形如 provider/model、纯 id 或 qoder 的档位名；排除明显的说明行
    if (!/^[\w.@][\w.@/:-]*$/.test(token)) continue
    if (!models.includes(token)) models.push(token)
  }
  return models
}

/** DSH 侧已配置的供应商路由与模型（llm 服务缺失时返回空）。 */
export interface DshProviderModels {
  readonly id: string
  readonly name: string
  readonly models: string[]
}

interface LlmLike {
  listProviders(): { id: string, name: string }[]
  listModels(provider: string): Promise<{ id: string }[]>
}

export async function listDshModels(llm: LlmLike | undefined): Promise<DshProviderModels[]> {
  if (llm === undefined) return []
  const providers: DshProviderModels[] = []
  let routes: { id: string, name: string }[] = []
  try {
    routes = llm.listProviders()
  } catch {
    return []
  }
  for (const route of routes) {
    let models: string[] = []
    try {
      models = (await llm.listModels(route.id)).map(model => model.id)
    } catch {
      models = []
    }
    providers.push({ id: route.id, name: route.name, models })
  }
  return providers
}
