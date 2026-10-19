/**
 * 模型发现：把「DSH 里已配置的供应商模型」与「各个 harness 自己认的模型」都查出来。
 *
 * 两条来源：
 *  1. DSH 侧 —— `ctx.llm.listProviders()` / `listModels(provider)`：当前 profile 配了哪些路由与模型。
 *  2. harness 侧 —— 目标配置里的 `modelsCommand`（如 `opencode models`、`agy models`），
 *     直接问那个 CLI 自己有哪些模型；结果按 `modelsCacheMs` 缓存，避免每次都起进程。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { authBlockedInOutput, parseModelListOutput } from './federation/providers.js'
import { buildArgv } from './launcher.js'
import type { TargetConfig } from './types.js'
import { discoverLocalModelCatalog, type NativeCatalogEntry } from './native-model-catalog.js'
import { classifyTarget, loginModeOf } from './harness-groups.js'
import {
  classifyModelEntries,
  countByKind,
  discoveryStateOf,
  selectableIds,
  type DiscoveryState,
  type ModelEntry,
} from './model-sources.js'

export interface HarnessModels {
  readonly models: string[]
  /** 查询方式（给 UI/模型看的说明）。 */
  readonly note: string
  /** Full native catalog, including explicitly display-only entries. */
  readonly catalog?: readonly NativeCatalogEntry[]
  /**
   * **结构化**的逐条分类（来源 / 四类 / 能否作为模型参数）。`models` 是它的可选子集，
   * 保留是为了不让既有调用方（选择器、任务工具、探针）断掉。
   */
  readonly entries?: readonly ModelEntry[]
  /** 四态（未安装 / 未登录 / 没有配置供应商 / 没有模型列举能力 / 就绪 / 未知）+ 证据。 */
  readonly state?: DiscoveryState
}

/**
 * 把各处观测到的名字汇成结构化条目。
 *
 * 来源映射（**唯一一处**，不许在别处再写一遍）：
 *   · 真实 CLI 查询输出 → `cli-query`
 *   · 原生目录里 `source==='native-config'`（settings.json / config.toml / zcode config.json）→ `native-config`
 *   · 原生目录里 `native-cache` / `native-catalog`（models_cache.json、models.json、厂商 product 缓存）→ `official-cache`
 *   · 原生目录里 `official-alias` / `configured-alias`，以及 `modelsFixed` 登记档位 → `official-alias`
 */
export function modelEntriesFor(input: {
  readonly cliQuery?: readonly string[]
  readonly catalog?: readonly NativeCatalogEntry[]
  readonly modelsFixed?: readonly string[]
  readonly catalogFile?: { readonly models: readonly string[], readonly note: string }
  readonly cliQueryEvidence?: string
}): ModelEntry[] {
  const nativeConfig: { id: string, selectable: boolean, evidence: string, provider?: string, meta?: NonNullable<ModelEntry['meta']> }[] = []
  const officialCache: { id: string, selectable: boolean, evidence: string, provider?: string, meta?: NonNullable<ModelEntry['meta']> }[] = []
  const officialAlias: { id: string, selectable: boolean, evidence: string }[] = []
  for (const entry of input.catalog ?? []) {
    const observation = {
      id: entry.id,
      selectable: entry.selectable,
      evidence: entry.evidence,
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      ...(entry.meta === undefined ? {} : { meta: entry.meta }),
    }
    if (entry.source === 'native-config') nativeConfig.push(observation)
    else if (entry.source === 'native-cache' || entry.source === 'native-catalog') officialCache.push(observation)
    else officialAlias.push({ id: entry.id, selectable: entry.selectable, evidence: entry.evidence })
  }
  for (const id of input.modelsFixed ?? []) {
    officialAlias.push({ id, selectable: true, evidence: '本插件登记的该 CLI 可选档位（依据见 src/config.ts 该目标的注释：CLI 自己 `--help` 的 Currently supported 列表 / 实测矩阵）' })
  }
  for (const id of input.catalogFile?.models ?? []) {
    officialCache.push({ id, selectable: true, evidence: input.catalogFile?.note ?? '模型目录文件' })
  }
  const currentDefault = (input.catalog ?? []).find((entry) => entry.role === 'default')?.id ?? null
  return classifyModelEntries({
    ...(input.cliQuery === undefined ? {} : {
      cliQuery: input.cliQuery.map((id) => ({ id, evidence: input.cliQueryEvidence ?? '该 CLI 自己的模型列举命令返回的 id' })),
    }),
    nativeConfig,
    officialCache,
    officialAlias,
    currentDefault,
  })
}

/** 四态输入的采集（把「有没有入口 / 有没有列举能力 / 有没有原生配置」三件事集中判一次）。 */
export function harnessStateFor(input: {
  readonly target: TargetConfig
  readonly catalog: readonly NativeCatalogEntry[]
  readonly entries: readonly ModelEntry[]
  readonly entryResolved: boolean
  readonly authBlocked: boolean
  readonly measured: boolean
  readonly loginRequired: boolean
  readonly notes: readonly string[]
}): DiscoveryState {
  const hasListCapability = input.target.modelsCommand.trim().length > 0
    || (input.target.modelsFile ?? '').trim().length > 0
    || input.catalog.length > 0
    || (input.target.modelsFixed ?? []).length > 0
  return discoveryStateOf({
    entryResolved: input.entryResolved,
    loginRequired: input.loginRequired,
    authBlocked: input.authBlocked,
    hasListCapability,
    nativeConfigSeen: input.catalog.some((entry) => entry.source === 'native-config') || (input.target.modelsFixed ?? []).length > 0,
    measured: input.measured,
    selectableCount: selectableIds(input.entries).length,
    notes: input.notes,
  })
}

const stateFor = harnessStateFor

/**
 * **概览**用的四态：只依赖缓存/静态可得的信息（**不起进程**）。
 *
 * 缓存里有四态就直接用（那是一次真实测量的结论，`/api/models` 存进去的）；
 * 没有就把 `measured:false` 如实传下去 —— 于是结果是「未知（证据不足）」而不是
 * 「没有配置供应商」（后者是**把没问过说成没有**）。
 */
export function overviewStateFor(input: {
  readonly target: TargetConfig
  readonly catalog: readonly NativeCatalogEntry[]
  readonly entries: readonly ModelEntry[]
  readonly probeAvailable: boolean
  readonly cachedState?: DiscoveryState
  readonly notes: readonly string[]
}): DiscoveryState {
  if (input.cachedState !== undefined) return input.cachedState
  const missingArg = missingEntryArgOf(input.target)
  return harnessStateFor({
    target: input.target,
    catalog: input.catalog,
    entries: input.entries,
    entryResolved: input.probeAvailable && missingArg === null,
    authBlocked: false,
    measured: false,
    loginRequired: loginModeOf(classifyTarget(input.target).key) !== 'unknown',
    notes: missingArg === null ? input.notes : [...input.notes, `启动参数里的绝对路径不存在：${missingArg}`],
  })
}

/**
 * 从 harness 自带的模型**目录文件**里读出模型 id（WorkBuddy/CodeBuddy 的 `models.json` 就是这种）。
 *
 * ⚠️ 安全边界（与 `federation/providers.readConfiguredNames` 同一纪律）：**只提取名字字段**
 * （`id` / `model` / `modelId` / `name`），绝不读取任何值字段 —— 这类目录文件里可能紧挨着密钥
 * （本机那份就带 `apiKey`）。读出的候选再过两道护栏：形状必须像模型 id，且像令牌的一律丢。
 */
export function readModelCatalogFile(file: string): HarnessModels {
  const fail = (note: string): HarnessModels => ({ models: [], note })
  if (!existsSync(file)) return fail(`catalog file not found: ${file}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fail(`catalog file is not valid JSON: ${file}`)
  }
  const models: string[] = []
  const looksLikeSecret = (s: string): boolean =>
    /eyJ[A-Za-z0-9_-]{10,}/.test(s) || /^[A-Za-z0-9+/=_-]{40,}$/.test(s) || /^(sk|pk|ghp|ox)[-_]/i.test(s)
  const take = (value: unknown): void => {
    if (typeof value !== 'string') return
    const id = value.trim()
    if (id.length === 0 || id.length > 120) return
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/.test(id)) return
    if (looksLikeSecret(id)) return
    if (!models.includes(id)) models.push(id)
  }
  const collectFromList = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (item === null || typeof item !== 'object') {
        take(item)
        continue
      }
      const rec = item as Record<string, unknown>
      if (rec.visibility === 'hide') continue
      if (rec.id !== undefined) take(rec.id)
      else if (rec.slug !== undefined) take(rec.slug)
      else if (rec.model !== undefined) take(rec.model)
      else if (rec.modelId !== undefined) take(rec.modelId)
      else if (rec.name !== undefined) take(rec.name)
    }
  }
  if (Array.isArray(parsed)) collectFromList(parsed)
  else if (parsed !== null && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    collectFromList(root.models ?? root.data ?? root.list)
  }
  if (models.length === 0) return fail(`catalog file has no model ids (只取名字字段，值字段未读取): ${file}`)
  return { models, note: `catalog file ${file} — 只提取模型 id（名字），未读取任何值字段` }
}

/**
 * 目标的「入口」是否**真的存在**。
 *
 * ⚠️ 只看 `command` 是不够的：本机实测（2026-10-14 卸载 `command-code` 之后）
 * `command` 是 `node`（存在！），而被删掉的是**参数里那个绝对路径**
 * `…\node_modules\command-code\dist\index.mjs` ⇒ 进程能起来、脚本找不到，
 * 输出是 `Cannot find module`，于是被误判成「列举命令跑通了但没有模型」= **没有配置供应商**。
 * 那是把「没装」说成「没配」—— 四态的判据必须包含「参数里的文件在不在」。
 *
 * 只检查**绝对路径**且**带脚本/可执行后缀**的参数（相对路径可能是 CLI 自己解析的子命令，
 * 拿它当入口会误报）。
 */
export function missingEntryArgOf(target: Pick<TargetConfig, 'args'>): string | null {
  for (const arg of target.args) {
    if (arg.startsWith('-')) continue
    if (!/^[A-Za-z]:[\\/]/.test(arg)) continue
    if (!/\.(mjs|cjs|js|exe|cmd|bat|ps1)$/i.test(arg)) continue
    if (!existsSync(arg)) return arg
  }
  return null
}

/** 跑一次 `modelsCommand` 并解析出模型 id 列表；失败不抛错，返回空列表 + 原因。 */
export async function listHarnessModels(target: TargetConfig, timeoutMs = 25000): Promise<HarnessModels> {
  const local = discoverLocalModelCatalog(target)
  const loginRequired = loginModeOf(classifyTarget(target).key) !== 'unknown'
  // ⓪ 入口（参数里的绝对路径）不存在 ⇒ 直接判「未安装」，不再去起进程：
  //    起也只会得到 `Cannot find module`，那会被误读成「没配置供应商」。
  const missingArg = missingEntryArgOf(target)
  if (missingArg !== null) {
    const entries = modelEntriesFor({ catalog: local.entries, modelsFixed: (target.modelsFixed ?? []).filter((entry) => entry.trim().length > 0) })
    return {
      models: [],
      entries,
      catalog: local.entries,
      note: `启动参数里的绝对路径不存在：${missingArg}`,
      state: stateFor({
        target, catalog: local.entries, entries, entryResolved: false, authBlocked: false, measured: false, loginRequired,
        notes: [`启动参数里的绝对路径不存在：${missingArg}`],
      }),
    }
  }
  // ① 静态清单优先：只出 `--model` **实测能生效**的取值（例：CodeBuddy 的四个别名）。
  //    把“目录里能列出来”的 id 冒充“能选”是假功能 —— 矩阵实测 r-* 会被 CLI 响亮拒绝。
  const fixed = (target.modelsFixed ?? []).filter((entry) => entry.trim().length > 0)
  if (fixed.length > 0) {
    const entries = modelEntriesFor({ modelsFixed: fixed, catalog: local.entries })
    return {
      models: selectableIds(entries),
      entries,
      catalog: local.entries,
      note: 'CLI 可选档位；完整原生目录另列，目录 ID 不冒充可选值',
      state: stateFor({ target, catalog: local.entries, entries, entryResolved: true, authBlocked: false, measured: true, loginRequired, notes: [] }),
    }
  }
  const command = target.modelsCommand.trim()
  if (command.length === 0) {
    // 没有列模型命令的 harness：若配置了模型**目录文件**，从文件读（只取名字，不读值）。
    const catalogFile = (target.modelsFile ?? '').trim()
    let file: HarnessModels | undefined
    if (catalogFile.length > 0) {
      const read = readModelCatalogFile(catalogFile)
      if (read.models.length > 0 || local.selectableModels.length === 0) file = read
    }
    const entries = modelEntriesFor({
      catalog: local.entries,
      ...(file === undefined ? {} : { catalogFile: { models: file.models, note: file.note } }),
    })
    return {
      models: selectableIds(entries),
      entries,
      catalog: local.entries,
      note: file !== undefined && file.models.length > 0
        ? file.note
        : local.entries.length > 0 ? local.note : '该 CLI 没有可用的模型列举命令或原生目录',
      state: stateFor({
        target, catalog: local.entries, entries, entryResolved: true, authBlocked: false, measured: true, loginRequired,
        notes: file !== undefined && file.models.length === 0 ? [file.note] : [],
      }),
    }
  }
  let argv: string[]
  let verbatim = false
  try {
    const built = buildArgv(command, target.modelsArgs)
    argv = built.verbatim ? built.verbatimArgv : built.argv
    verbatim = built.verbatim
  } catch (error: unknown) {
    const entries = modelEntriesFor({ catalog: local.entries })
    return {
      models: selectableIds(entries),
      entries,
      catalog: local.entries,
      note: `无法解析模型列表命令；${local.note}（${error instanceof Error ? error.message : String(error)}）`,
      state: stateFor({
        target, catalog: local.entries, entries, entryResolved: false, authBlocked: false, measured: false, loginRequired,
        notes: [`argv 解析失败：${error instanceof Error ? error.message : String(error)}`],
      }),
    }
  }
  return await new Promise<HarnessModels>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let spawnFailed = false
    let authBlocked = false
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
      // ⚠️ 与**发现层同一个解析器**：老实现「每行取第一个 token」把空白对齐表格的
      // **供应商列**（以及表头词 `provider`）当成模型名 —— 实测 pi 因此被报成 7 个「模型」，
      // 而同一能力的 /providers 出口正确报出 98 个 `provider/model`。同一能力多出口不一致，
      // 比没有这个能力更糟（本项目栽过四次）。解析仍**宁可空也不要编**。
      const parsed = parseModelListOutput(`${stdout}\n${stderr}`)
      authBlocked = authBlocked || authBlockedInOutput(stdout, stderr)
      const entries = modelEntriesFor({
        ...(parsed.length === 0 ? {} : {
          cliQuery: parsed.map((m) => m.id),
          cliQueryEvidence: `该 CLI 自己的列举命令（${command} ${target.modelsArgs.join(' ')}）返回`,
        }),
        catalog: local.entries,
      })
      const notes: string[] = []
      if (parsed.length === 0) notes.push(`${local.note}`)
      if (authBlocked) notes.push('列举输出里出现认证相关字样')
      resolve({
        models: selectableIds(entries),
        entries,
        catalog: local.entries,
        note: parsed.length > 0 ? note : `${note}；${local.note}`,
        state: stateFor({
          target, catalog: local.entries, entries,
          entryResolved: !spawnFailed, authBlocked, measured: true, loginRequired, notes,
        }),
      })
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
    child.on('error', (error: Error) => {
      // `spawn ENOENT` = 入口不存在 ⇒ 四态里的**未安装**（这一条是实测证据，不是推断）。
      if (/ENOENT|not found|cannot find/i.test(error.message)) spawnFailed = true
      finish(`spawn failed: ${error.message}`)
    })
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
 *
 * ⚠️ **本函数已被取代，不要再拿它当解析器**：它对**空白对齐的表格**（`pi --list-models`）
 * 会取到**供应商列**（连表头词 `provider` 一起）当成模型 —— 实测 pi 被报成 7 个「模型」。
 * `listHarnessModels` 现已改走发现层那**唯一**一份解析器
 * （`./federation/providers.js` 的 `parseModelListOutput`，输出 `provider/model`）。
 * 这里**保留导出**只为不让既有探针的 import 断掉（`probe/verify-catalog-edit.mjs` 会 import 它）。
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
