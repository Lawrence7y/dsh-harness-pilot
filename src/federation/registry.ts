/**
 * Harness 注册表（P1）：把这台机器上**实际装了什么、什么版本、能不能连、能力边界**
 * 变成可取用的 `HarnessRecord[]`。
 *
 * 三条纪律（对应验收要求，不得放宽）：
 *   1. **版本必须实测**。种子目录（`catalog.ts`）里的 `seedVersion` 只是探针当时的对照值，
 *      **禁止**当作「现在装的版本」展示。没测到就写 `unknown` 并给出失败原因。
 *   2. **入口必须解析到真实可执行文件**。shim（.cmd/.ps1）要解析到底层 exe/js；
 *      WorkBuddy 随包的 `bin\codebuddy` 是**坏的**（`require('../dist/codebuddy')` 不存在），
 *      必须用 `dist\codebuddy-headless.js`；`.js` 入口必须用 node 跑。
 *   3. **共享安装要标出来**。`claude`/`opencode`/`pi`/`dsh` 的 shim 都落在 WorkBuddy 自带的
 *      Node 前缀下，属**厂商共享存储**，不能宣称是各自独立安装。
 *
 * 本文件只 import 本目录的 `./types.js` / `./catalog.js` 与 `node:*`，
 * 因此可以脱离 DSH 宿主单独运行（`node probe/verify-federation-registry.mjs`）。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { HARNESS_SEEDS, PROBE_SUMMARY, type HarnessSeed } from './catalog.js'
import type {
  HarnessCapabilities,
  HarnessInstall,
  HarnessProbe,
  HarnessRecord,
  TransportCapability,
} from './types.js'

/** 插件目标的最小结构面（不 import `../config.js`，以保持本层可独立运行）。 */
export interface TargetLike {
  readonly name: string
  readonly description?: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly order?: readonly string[]
  readonly transport?: string
}

/** 用户可改、且要落盘的部分。 */
export interface HarnessOverride {
  readonly enabled?: boolean
  /** 用户指定的入口（覆盖种子里的实测入口）。 */
  readonly command?: string
  /** 用户备注，随记录一起回显。 */
  readonly note?: string
}

export interface RegistryState {
  readonly version: 1
  readonly overrides: Readonly<Record<string, HarnessOverride>>
  readonly updatedAt: string
}

/** 插件目标名 → 种子 id。两套名字是历史产物，这里**显式**列全，不靠猜。 */
const TARGET_TO_SEED: Readonly<Record<string, string>> = {
  opencode: 'opencode',
  'opencode-flash': 'opencode',
  'opencode-tui': 'opencode',
  'opencode-desktop': 'opencode',
  codex: 'codex',
  claude: 'claude-code',
  pi: 'pi',
  'mimo-cli': 'mimo',
  mimo: 'mimo',
  'mimo-ai': 'mimo',
  kimi: 'kimi',
  'grok-cli': 'grok',
  grok: 'grok',
  agy: 'antigravity-agy',
  antigravity: 'antigravity-agy',
  'zcode-cli': 'zcode',
  zcode: 'zcode',
  qodercli: 'qoder-intl',
  qoderclicn: 'qoder-cn',
  'qoder-cli': 'qoder-intl',
  'qoder-cn': 'qoder-cn',
  'qoder-cn-app': 'qoder-cn',
  qoder: 'qoder-intl',
  workbuddy: 'workbuddy',
  'workbuddy-a': 'workbuddy',
  'workbuddy-ai': 'workbuddy-ai',
  'workbuddy-ai-b': 'workbuddy-ai',
  codebuddy: 'workbuddy',
  // ⚠️ 2026-10-14 补：**真实目标名**（见 `src/config.ts`）此前整条缺失
  // ⇒ `seedForTarget('wb-managed-a')` 返回 undefined，凡是「目标 → 档案」的查找都拿不到东西
  // （实测：`wb-managed-a` 的账号绑定判定被迫回落成目标名，唯一正确的配对反被误判成跨 harness）。
  // 上面那两个「账号 id 形态」的旧名保留 —— 既有持久化引用/外部脚本还要用。
  'wb-managed-a': 'workbuddy',
  'wb-managed-ai-b': 'workbuddy-ai',
  // 同型补齐：Qoder 的账号绑定目标也只登记了 `qoder-cn` / `qoderclicn`。
  'qoder-cn-acct-a': 'qoder-cn',
  'qoder-cn-acct-b': 'qoder-cn',
  dsh: 'dsh-native',
}

/** 厂商共享 Node 前缀（实测：4 个 shim 都落在这里）。 */
const VENDOR_SHARED_NODE_PREFIX = /\.workbuddy[\\/]binaries[\\/]node[\\/]versions[\\/][^\\/]+[\\/]/i

const SEED_BY_ID = new Map(HARNESS_SEEDS.map((s) => [s.id, s]))

export function seedForTarget(targetName: string): HarnessSeed | undefined {
  const id = TARGET_TO_SEED[targetName]
  if (id !== undefined) return SEED_BY_ID.get(id)
  // 目标名**本身**就是种子 id 的情况：离线校验与 probe 会这样直接调用，
  // 不能因为没有别名映射就退化成「无种子」（那会把实测能力全丢掉）。
  return SEED_BY_ID.get(targetName)
}

/** 记录一次版本探测。没测到就把原因带上，绝不拿种子值顶替。 */
export interface VersionProbeResult {
  readonly version?: string
  readonly error?: string
  readonly argv: readonly string[]
  readonly at: string
  readonly durationMs: number
}

/**
 * 把入口 + 参数解析成真正要 spawn 的 argv。
 * 处理三种真实情况：`.js` 需要 node、`.cmd/.bat` 需要 cmd /c、需要 Electron 的 Node 模式。
 */
export function resolveInvocation(
  entry: string,
  args: readonly string[],
  wrapping: string,
): { file: string; argv: string[]; env: Record<string, string>; note: string } {
  const lower = entry.toLowerCase()
  const env: Record<string, string> = {}
  const wrap = wrapping.toLowerCase()
  const notes: string[] = []

  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    notes.push('入口是 JS，用 node 启动')
    return { file: process.execPath, argv: [entry, ...args], env, note: notes.join('；') }
  }
  if (wrap.includes('electron_run_as_node')) {
    env.ELECTRON_RUN_AS_NODE = '1'
    notes.push('需要 ELECTRON_RUN_AS_NODE=1')
    return { file: entry, argv: [...args], env, note: notes.join('；') }
  }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    notes.push('入口是 .cmd/.bat，经 cmd /c 启动')
    return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', entry, ...args], env, note: notes.join('；') }
  }
  return { file: entry, argv: [...args], env, note: '' }
}

/**
 * 从 `.asar` 归档里读它自己的 `package.json` 版本。
 *
 * asar 是 Chromium 归档格式：前 16 字节里 offset 12 是 header 长度（小端 u32），
 * 紧随其后是 JSON header，`files` 树里每个节点带 `offset`/`size`（相对文件头之后）。
 * 本机这套读法已在 DSH 自身（`app.asar`）上验证过；这里用来读打包版 Electron 应用。
 * **只读，不解包**：不为拿一个版本号把几百 MB 解出来。
 */
export function readAsarPackageVersion(asarPath: string): string | null {
  try {
    const buf = readFileSync(asarPath)
    const headerSize = buf.readUInt32LE(12)
    if (headerSize <= 0 || headerSize > buf.length) return null
    const raw = buf.subarray(16, 16 + headerSize).toString('utf8')
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      files?: Record<string, { offset?: string; size?: number; files?: unknown }>
    }
    const node = json.files?.['package.json']
    if (node === undefined || node.offset === undefined) return null
    const off = 16 + headerSize + Number(node.offset)
    const meta = JSON.parse(buf.subarray(off, off + Number(node.size ?? 0)).toString('utf8')) as { version?: unknown }
    return typeof meta.version === 'string' && meta.version.trim().length > 0 ? meta.version.trim() : null
  } catch {
    return null
  }
}

/**
 * 读 Electron / VSCode-fork 应用**自己的**产品版本。
 *
 * 为什么需要：这类应用的 exe 跑 `--version` 回的是 Electron 版本（实测 Qoder → v24.15.0），
 * 拿它当产品版本就是虚假陈述。但它们都会在自己的元数据里声明真实版本，本机实测三种形态：
 *   · 未打包 / VSCode fork：`<AppDir>/resources/app/package.json` 直接可读（Qoder、Qoder CN IDE）
 *   · 打包 Electron：`<AppDir>/resources/app.asar` 的 header package.json（只读 header，不解包）
 *   · 两者都没有：如实返回 null，由调用方按「无法确定产品版本」处理，不猜。
 */
export function readElectronAppVersion(entry: string): { version: string; source: string } | null {
  try {
    const dir = dirname(entry)
    const plain = join(dir, 'resources', 'app', 'package.json')
    if (existsSync(plain)) {
      const meta = JSON.parse(readFileSync(plain, 'utf8')) as { version?: unknown }
      if (typeof meta.version === 'string' && meta.version.trim().length > 0) {
        return { version: meta.version.trim(), source: plain }
      }
    }
    for (const rel of [['resources', 'app.asar'], ['resources', 'app.asar.unpacked']] as const) {
      const asar = join(dir, ...rel)
      if (!existsSync(asar)) continue
      const v = readAsarPackageVersion(asar)
      if (v !== null) return { version: v, source: `${asar} (header package.json)` }
    }
  } catch {
    // 读不到就是读不到，交给调用方按「无法确定产品版本」处理。
  }
  return null
}

/**
 * 判断一个入口是不是 Electron 应用的 exe。
 *
 * 为什么用文件布局而不是名字或种子 kind：插件里同一个 Harness 常同时有 **CLI 目标**
 * 与 **GUI 目标**（`agy` vs `antigravity`、`qodercli` vs `qoder`），两者共用一份种子，
 * 种子 kind 是 CLI 的。所以只能看真实入口本身。本机实测到**两种**真实布局：
 *   · 打包 Electron：`<AppDir>/resources/app.asar`（小米 MiMo）
 *   · VSCode fork / 未打包：`<AppDir>/resources/app/out/main.js` + `resources/app/package.json`（Qoder、Qoder CN IDE）
 */
function isElectronAppExe(entry: string): boolean {
  try {
    const dir = dirname(entry)
    const r = (...p: string[]): boolean => existsSync(join(dir, 'resources', ...p))
    return r('app.asar') || r('app.asar.unpacked') || r('app', 'package.json') || r('app', 'out', 'main.js')
  } catch {
    return false
  }
}

/**
 * 判定一次版本输出**是不是产品版本**。
 *
 * 为什么必须有这一步：本机实测发现，对 GUI/Electron 目标或裸 `node` 入口跑 `--version`，
 * 拿回来的是**运行时**版本而不是产品版本 —— 例如
 * `Antigravity.exe --version` → `v24.20.0`（Electron）、`node --version` → `v22.22.2`。
 * 把这种值当「真实安装版本」展示就是虚假陈述，因此这里显式拒绝，
 * 并把原始输出留在原因里（可复核），而不是编一个版本号。
 *
 * @returns 非 null = 这条输出不能当作产品版本，值为拒收原因。
 */
export function rejectRuntimeOnlyVersion(
  seed: HarnessSeed | undefined,
  entry: string,
  baseArgs: readonly string[],
  text: string,
): string | null {
  const trimmed = text.trim()
  const base = entry.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  // 裸 node：命令就是 node 而没有任何脚本参数 → 拿到的是 Node 自己的版本。
  if ((base === 'node.exe' || base === 'node') && baseArgs.length === 0) {
    return `入口是裸 node（未带脚本），"${trimmed}" 是 Node 运行时版本，不是产品版本`
  }
  // Electron 应用 exe：--version 由 Electron 处理，回的是 Electron 版本。
  if (isElectronAppExe(entry)) {
    return `入口是 Electron 应用（旁边有 resources/app.asar）："${trimmed}" 是 Electron 运行时版本，不是产品版本；产品版本需读该应用自身元数据（本次未探测）`
  }
  if (seed?.kind === 'electron-gui' || seed?.kind === 'vscode-fork') {
    return `GUI/Electron 目标："${trimmed}" 是运行时版本，不是产品版本`
  }
  // 刻意**不**加「路径里含 app/desktop/ide/studio 就拒收」这类模糊规则：
  // 实测会误伤 —— `...\AppData\Local\agy\bin\agy-core.exe` 的路径含 "App"，
  // 于是把 agy 合法的 "1.3.4" 也拒了。宁可漏判也不误判：漏判由上面的
  // Electron 布局检查兜底，误判则会直接消灭一个真版本。
  return null
}

/** 实测版本：真实 spawn，带超时；stdout/stderr 都看，失败如实记录。 */
export function probeVersion(
  entry: string,
  argv: readonly string[],
  wrapping: string,
  timeoutMs = 15000,
): Promise<VersionProbeResult> {
  const at = new Date().toISOString()
  const started = Date.now()
  if (argv.length === 0) {
    return Promise.resolve({ error: 'no version probe argv for this harness', argv: [], at, durationMs: 0 })
  }
  const inv = resolveInvocation(entry, argv, wrapping)
  return new Promise<VersionProbeResult>((resolve) => {
    execFile(
      inv.file,
      inv.argv,
      { timeout: timeoutMs, env: { ...process.env, ...inv.env }, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started
        const out = `${stdout ?? ''}`.trim()
        const err = `${stderr ?? ''}`.trim()
        if (error !== null && error !== undefined && out.length === 0) {
          resolve({ error: `${error.message}${err.length > 0 ? ` | stderr: ${err.slice(0, 300)}` : ''}`, argv, at, durationMs })
          return
        }
        const text = out.length > 0 ? out : err
        const firstLine = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)[0]
        resolve(
          firstLine === undefined
            ? { error: 'probe produced no output', argv, at, durationMs }
            : { version: firstLine.slice(0, 200), argv, at, durationMs },
        )
      },
    )
  })
}

/** 探测连通性：只做「入口是否可执行 + 版本是否可读」，**不派发任何任务**。 */
function connectionFromVersion(r: VersionProbeResult): HarnessProbe {
  if (r.version !== undefined) {
    return { at: r.at, connection: 'ok', latencyMs: r.durationMs, detail: `版本可读: ${r.version}` }
  }
  const timeout = /timed? ?out/i.test(r.error ?? '')
  return {
    at: r.at,
    connection: timeout ? 'timeout' : 'fail',
    latencyMs: r.durationMs,
    detail: r.error ?? '未知失败',
  }
}

export interface ResolvedEntry {
  readonly entry: string | null
  readonly resolvedFrom: HarnessInstall['resolvedFrom']
  readonly wrapping: string
  readonly sharedWithNote?: string
  readonly caveat?: string
}

/**
 * 解析某目标的真实入口，优先级：用户指定 > 插件目标配置 > 种子实测入口。
 * 顺带做两件诚实性检查：厂商共享 Node 前缀、以及已知坏入口。
 */
export function resolveEntry(seed: HarnessSeed | undefined, target: TargetLike | undefined, override?: HarnessOverride): ResolvedEntry {
  let candidate = override?.command?.trim() || target?.command?.trim() || seed?.entryPath || ''
  const caveats: string[] = []
  // 配置里写的是**裸命令名**（如 `agy`/`opencode`/`pi`）时，spawn 不会解析 PATH 上的
  // .cmd/.bat（Windows 实测 ENOENT）。种子里有已解析的真实入口，就用它，并说明换过。
  const isBareName = candidate.length > 0 && !candidate.includes('/') && !candidate.includes('\\')
  const overrideIsPath = override?.command !== undefined && override.command.trim().length > 0
  if (isBareName && !overrideIsPath && seed?.entryPath != null && seed.entryPath.length > 0) {
    caveats.push(`配置里是裸命令名 "${candidate}"（PATH 依赖，直接 spawn 会 ENOENT），已改用实测入口`)
    candidate = seed.entryPath
  }
  if (candidate.length === 0) {
    return { entry: null, resolvedFrom: 'path-scan', wrapping: 'none', caveat: '没有可用入口：配置与种子都没有给出路径' }
  }
  const resolvedFrom: HarnessInstall['resolvedFrom'] =
    overrideIsPath
      ? 'user-specified'
      : target !== undefined && target.command.trim().length > 0
        ? 'profile-config'
        : 'builtin-catalog'

  const shared = VENDOR_SHARED_NODE_PREFIX.test(candidate)
  if (shared) {
    caveats.push('位于 WorkBuddy 自带 Node 前缀下，属厂商共享安装，不是本 Harness 独立安装')
  }
  // WorkBuddy 随包的 bin\codebuddy 实测是坏的：require('../dist/codebuddy') 不存在。
  if (/[\\/]cli[\\/]bin[\\/]codebuddy(\.cmd)?$/i.test(candidate)) {
    caveats.push('该 bin\\codebuddy 实测已损坏（require("../dist/codebuddy") 不存在），应改用 dist\\codebuddy-headless.js')
  }
  if (!existsSync(candidate)) {
    caveats.push('入口路径当前不存在')
  }
  return {
    entry: candidate,
    resolvedFrom,
    wrapping: seed?.shimWrappingRequired ?? 'none',
    sharedWithNote: shared ? 'WorkBuddy 自带 Node 前缀（厂商共享）' : undefined,
    caveat: caveats.length > 0 ? caveats.join('；') : undefined,
  }
}

function capabilitiesFrom(seed: HarnessSeed | undefined, override?: HarnessOverride): HarnessCapabilities {
  if (seed === undefined) {
    return {
      modelSelect: 'unknown',
      providerConfigFiles: [],
      multiAccount: 'unknown',
      permissionModes: [],
      reasoningEfforts: [],
      sessionResume: 'unknown',
      mcpServer: false,
      canLead: 'no',
    }
  }
  return {
    modelSelect: seed.modelSelect,
    providerConfigFiles: seed.providerConfigFiles,
    modelListCommand: seed.modelListArgs.length > 0 ? seed.modelListArgs : undefined,
    multiAccount: override === undefined ? seed.multiAccount : seed.multiAccount,
    permissionModes: seed.permissionModes,
    reasoningEfforts: seed.reasoningEfforts,
    sessionResume: seed.sessionResume,
    mcpServer: seed.mcpServer,
    // 主控资格只能靠行为证据升级；种子从不给 verified。
    canLead: 'candidate',
  }
}

/** 种子里的通道支持 + 该目标配置里的实际 order，合成「配置的通道」列表。 */
function transportsFrom(seed: HarnessSeed | undefined, target: TargetLike | undefined): TransportCapability[] {
  const configured = new Set<string>(target?.order ?? [])
  const list: TransportCapability[] = []
  for (const t of seed?.transports ?? []) {
    list.push({
      kind: t.kind,
      tier: t.tier,
      available: t.supported,
      evidence: t.supported
        ? `探针实测支持${t.note !== null ? `（${t.note}）` : ''}`
        : '探针实测不支持',
      limits: t.note !== null ? [t.note] : undefined,
    })
  }
  // 配置里声明但种子没覆盖的通道，标成未验证而不是「可用」。
  for (const kind of configured) {
    if (!list.some((l) => l.kind === kind)) {
      list.push({ kind: kind as TransportCapability['kind'], tier: 3, available: false, evidence: '配置里有该通道，但探针未验证；按未验证处理' })
    }
  }
  return list.sort((a, b) => a.tier - b.tier)
}

/** 上游限制：种子记录 + 该目标自身的诚实边界。 */
function upstreamLimitsFrom(seed: HarnessSeed | undefined): string[] {
  const out: string[] = [...(seed?.upstreamLimits ?? [])]
  if (seed?.isolationTested === false && seed.multiAccount !== 'isolated-config-dir') {
    out.push('多账号隔离未实测通过，不得宣称已隔离')
  }
  if (seed?.inheritedFrom !== null && seed?.inheritedFrom !== undefined) {
    out.push(`能力字段继承自 "${seed.inheritedFrom}"，未单独复测`)
  }
  if (seed !== undefined && seed.versionProbe.length === 0) {
    out.push('该目标没有可用的版本探测命令，版本只能标为 unknown')
  }
  return out
}

export interface BuildOptions {
  readonly targets: readonly TargetLike[]
  readonly overrides: Readonly<Record<string, HarnessOverride>>
  /** 是否真的 spawn 去测版本（离线校验传 false）。 */
  readonly measure?: boolean
  readonly probeTimeoutMs?: number
}

/**
 * 构建注册表。`measure=false` 时**不做任何 spawn**，版本一律标为未测 —— 离线可跑。
 */
export async function buildRegistry(options: BuildOptions): Promise<HarnessRecord[]> {
  const measure = options.measure !== false
  const timeout = options.probeTimeoutMs ?? 15000
  const records: HarnessRecord[] = []

  for (const target of options.targets) {
    const seed = seedForTarget(target.name)
    const override = options.overrides[target.name] ?? options.overrides[seed?.id ?? '']
    const resolved = resolveEntry(seed, target, override)

    let install: HarnessInstall = {
      status: resolved.entry === null ? 'missing' : 'found',
      command: resolved.entry ?? '',
      resolvedFrom: resolved.resolvedFrom,
      sharedWithNote: resolved.sharedWithNote,
      versionError: resolved.caveat,
    }

    let probe: HarnessProbe | undefined
    const isElectron = resolved.entry !== null && isElectronAppExe(resolved.entry)
    if (measure && resolved.entry !== null && isElectron) {
      // GUI/Electron：`--version` 只会回运行时版本，**绝不能**当产品版本。
      // 改读应用自身元数据；读不到就如实拒收，不猜、不解包 asar。
      const meta = readElectronAppVersion(resolved.entry)
      const at = new Date().toISOString()
      if (meta !== null) {
        install = {
          ...install,
          version: meta.version,
          versionSource: 'app-metadata',
          versionProbe: [`<app-metadata> ${meta.source}`],
          versionCheckedAt: at,
          versionError: resolved.caveat,
        }
        probe = { at, connection: 'ok', latencyMs: 0, detail: `产品版本来自应用自身元数据: ${meta.source}` }
      } else {
        const v = await probeVersion(resolved.entry, ['--version'], resolved.wrapping, timeout)
        const detail = `Electron 应用且未找到可读的应用元数据；\`--version\` 返回 "${v.version ?? v.error ?? '(无输出)'}"，`
          + '那是 Electron/运行时版本，不予采信。产品版本需读该应用自身元数据（未探测到可读路径）'
        install = { ...install, versionSource: 'none', versionProbe: v.argv, versionCheckedAt: v.at, versionError: detail }
        probe = { at: v.at, connection: 'skipped', latencyMs: v.durationMs, detail }
      }
    } else if (measure && resolved.entry !== null && seed !== undefined && seed.versionProbe.length > 0) {
      // 版本探测的入口优先级：用户覆盖 > 该目标自己的 command > 种子的实测入口。
      // 为什么不能直接用 seed.entryPath：多个目标会共用一份种子，但它们的真实二进制不同
      // （`qodercli` 是国际版 1.0.45，`qoderclicn` 是国内版 1.1.41，两者分别映射到 qoder-intl / qoder-cn 种子），
      // 用种子入口会把两者测成同一个版本。
      // 为什么不能直接拼 target.args：`kimi -p` / `grok-cli -p` / `qoder-cli -p` 这些目标的
      // args 里带模式开关，拼上去 `--version` 就变成提示词（实测 `kimi -p --version` 报
      // "failed to load session"）。只有入口是**裸解释器**（node）时才需要从 args 里取脚本路径。
      // bare name（不含路径分隔符，例如 `opencode` / `pi` / `agy`）是留给 PATH 解析的，
      // 而 execFile 在 Windows 上不解析 PATH 里的 .cmd/.bat（实测 ENOENT），
      // 所以这种情况下用种子里**已解析好的真实入口**，而不是把这个名字丢给 spawn。
      const configured = target.command.trim()
      const isBareName = configured.length > 0 && !configured.includes('/') && !configured.includes('\\')
      const probeEntry = override?.command?.trim() || (isBareName ? (seed.entryPath ?? configured) : configured) || seed.entryPath || resolved.entry
      const basename = probeEntry.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
      const bareInterpreter = basename === 'node' || basename === 'node.exe'
      const jsArg = bareInterpreter ? (target.args ?? []).find((a) => /\.(js|mjs|cjs)$/i.test(a)) : undefined
      const probeArgs = jsArg === undefined ? seed.versionProbe : [jsArg, ...seed.versionProbe]
      const v = await probeVersion(probeEntry, probeArgs, resolved.wrapping, timeout)
      // 运行时版本不是产品版本：拒收并把原始输出留在原因里。
      const rejected = v.version === undefined ? null : rejectRuntimeOnlyVersion(seed, probeEntry, jsArg === undefined ? [] : [jsArg], v.version)
      install = {
        ...install,
        version: rejected === null ? v.version : undefined,
        versionSource: rejected === null && v.version !== undefined ? 'cli-version' : 'none',
        versionProbe: v.argv,
        versionCheckedAt: v.at,
        versionError: rejected ?? (v.version === undefined ? (v.error ?? resolved.caveat) : resolved.caveat),
      }
      probe = {
        at: v.at,
        connection: rejected !== null ? 'skipped' : (v.version === undefined && /timed? ?out/i.test(v.error ?? '') ? 'timeout' : (v.version === undefined ? 'fail' : 'ok')),
        latencyMs: v.durationMs,
        detail: rejected ?? (v.version === undefined ? (v.error ?? '未取到版本') : `版本可读: ${v.version}`),
      }
    } else if (seed !== undefined && resolved.entry !== null) {
      // 明确说明「没测」而不是留空。注意只在**有入口**时覆盖：
      // 入口缺失是更重要的原因，不能被「本次离线」顶掉。
      install = {
        ...install,
        versionError: measure
          ? '未执行版本探测（该目标没有探测 argv）'
          : '本次为离线构建，未执行版本探测',
      }
    }

    records.push({
      id: target.name,
      displayName: seed?.displayName ?? target.name,
      vendor: seed?.vendor ?? 'unknown',
      kind: seed?.kind ?? 'cli',
      enabled: override?.enabled !== false,
      install,
      connection: seed?.connection ?? 'agent-cli',
      transports: transportsFrom(seed, target),
      capabilities: capabilitiesFrom(seed, override),
      probe,
      upstreamLimits: upstreamLimitsFrom(seed),
    })
  }

  return records.sort((a, b) => a.id.localeCompare(b.id))
}

// ───────────────────────── 落盘 ─────────────────────────

export function loadRegistryState(file: string): RegistryState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RegistryState>
    return { version: 1, overrides: raw.overrides ?? {}, updatedAt: raw.updatedAt ?? new Date().toISOString() }
  } catch {
    return { version: 1, overrides: {}, updatedAt: new Date().toISOString() }
  }
}

export function saveRegistryState(file: string, state: RegistryState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** 合并一次更新（只接受已知字段，且 enabled 必须是布尔）。 */
export function applyOverride(state: RegistryState, target: string, patch: HarnessOverride): RegistryState {
  const previous = state.overrides[target] ?? {}
  const next: HarnessOverride = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : previous.enabled,
    command: typeof patch.command === 'string' && patch.command.trim().length > 0 ? patch.command.trim() : previous.command,
    note: typeof patch.note === 'string' ? patch.note : previous.note,
  }
  return {
    version: 1,
    overrides: { ...state.overrides, [target]: next },
    updatedAt: new Date().toISOString(),
  }
}

export { PROBE_SUMMARY }
export type { HarnessRecord }
