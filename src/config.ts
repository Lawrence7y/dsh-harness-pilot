/**
 * Plugin registry: harness targets, defaults, and the Schemastery Config schema.
 *
 * 内置一份「本机实探过的 harness 目录」：CLI 类走 acp/headless/pty，GUI 类走 cdp/window。
 * 用户在 profile 里只写差异项（换路径、固定模型、加参数）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { CdpSpec, TargetConfig, WindowSpec } from './types.js'

export interface Config {
  /** 追加/覆盖内置目标，按 name 合并。 */
  targets: TargetConfig[]
  /** `harness_dispatch` 省略 target 时用的默认目标。 */
  defaultTarget: string
  /** 窗口助手使用的 python 解释器；留空自动探测。 */
  pythonPath: string
  /** 回给模型的正文上限（字符）。 */
  maxReplyChars: number
  /** 单次窗口文本读取上限（字符）。 */
  maxScreenChars: number
  /** 允许的 CDP 调试端口起点。 */
  cdpPortBase: number
  /**
   * HTTP 写接口（/harness-pilot/api/dispatch|models|send）的共享令牌。
   * 留空 = 不校验（webServer 只监听 loopback）；非空时必须带 `x-harness-pilot-token`。
   */
  apiToken: string
}

const windowSchema = z.object({
  title: z.string().default(''),
  process: z.string().default(''),
  launch: z.string().default(''),
  submitKeys: z.array(z.string()).default(['enter']),
  openInputKeys: z.array(z.string()).default([]),
  newlineKeys: z.array(z.string()).default(['shift+enter']),
  appearTimeoutMs: z.number().default(20000),
  settleMs: z.number().default(1500),
})

const cdpSchema = z.object({
  launchArgs: z.array(z.string()).default([]),
  port: z.number().default(0),
  busySelector: z.string().default(''),
  transcriptSelector: z.string().default(''),
  inputSelector: z.string().default(''),
  sendSelector: z.string().default(''),
  pageMatch: z.string().default(''),
  readback: z.object({
    sessionIdExpression: z.string().default(''),
    command: z.string().default(''),
    args: z.array(z.string()).default([]),
    extract: z.string().default(''),
    timeoutMs: z.number().default(30000),
  }).default({}),
})

const targetSchema = z.object({
  name: z.string().required(),
  transport: z.string().default('auto'),
  description: z.string().default(''),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  acpArgs: z.array(z.string()).default([]),
  acpModel: z.string().default(''),
  modelArgs: z.array(z.string()).default([]),
  /** 推理等级声明（可选；缺省 = 不提供推理等级选择）：见 types.ts TargetConfig.thinking。 */
  thinking: z.object({
    levels: z.array(z.object({ id: z.string(), name: z.string() })),
    default: z.string(),
    args: z.array(z.string()),
  }),
  /**
   * 结构化原生会话协议能力（可选；缺省 = 不启用 JSONL 原生解析，旧 text CLI 路径不变）。
   * 声明了本能力的目标支持持久逻辑会话与原生 ID 精确恢复（`transports/native-cli.ts`）。
   * ⚠️ schemastery 没有 enum 构造器：协议取值在类型层约束（'claude-stream-json' | 'agy-jsonl'），
   * 运行时由 dispatchNativeCli 显式校验（未知值显式拒绝，不静默按某家解析）。
   */
  nativeCli: z.object({
    protocol: z.string(),
    newSessionArgs: z.array(z.string()).default([]),
    resumeArgs: z.array(z.string()).default([]),
    outputArgs: z.array(z.string()).default([]),
    // prompt 内联旗标（可选）：`{prompt}` 占位符。声明的目标 native/headless 两路都把
    // prompt 放进 argv（不再走 stdin）。见 types.ts NativeCliConfig.promptArg。
    // 空数组 = 未声明（缺省 stdin 行为不变）。
    promptArg: z.array(z.string()).default([]),
  }),
  modelsCommand: z.string().default(''),
  modelsArgs: z.array(z.string()).default([]),
  modelsFile: z.string().default(''),
  /**
   * 厂商**产品配置缓存**（`…/cache/acc-product-config-v3.json`）——该 CLI/桌面端认的**完整模型名册**。
   *
   * 与 `modelsFile` 的区别（为什么两个都要）：
   *   · `modelsFile`（如 `~/.codebuddy/models.json`）是**底层目录快照**，里面的 `r-*` **不能**作为
   *     `--model` 取值（实测 CLI 会响亮拒绝）⇒ 只能展示；
   *   · 本字段指向厂商 product config，里面 `models[]` 是**名册**（本机实测：国内 55 条 / 国际 30 条），
   *     带 `id` / `name` / `vendor` / `isDefault` / `maxInputTokens` / `maxOutputTokens` /
   *     `supportsToolCall|Reasoning|Images` / `relatedModels` —— 这些是**元数据**，让界面能说清
   *     「哪些能选、哪些只是名册里的、每条的上下文与输出上限、哪个是厂商默认」。
   *
   * ⚠️ 安全边界（与 `native-model-catalog.ts` 的读取纪律一致）：**只读 `models[]` 数组**，
   * 绝不读取同文件里的 `authentication` 等任何凭据字段。该文件里**确实有**认证相关键，
   * 所以这条边界由离线探针**静态断言**（源码里不得出现 `authentication`）。
   */
  productConfigFile: z.string().default(''),
  modelsFixed: z.array(z.string()).default([]),
  modelsCacheMs: z.number().default(300000),
  modelsTimeoutMs: z.number().default(25000),
  promptViaStdin: z.boolean().default(false),
  cwd: z.string().default(''),
  env: z.dict(z.string()).default({}),
  timeoutMs: z.number().default(600000),
  order: z.array(z.string()).default(['acp', 'headless', 'pty', 'cdp', 'window']),
  window: windowSchema,
  cdp: cdpSchema,
})

export const Config: z<Config> = z.object({
  targets: z.array(targetSchema).default([]),
  defaultTarget: z.string().default(''),
  pythonPath: z.string().default(''),
  maxReplyChars: z.number().default(16000),
  maxScreenChars: z.number().default(8000),
  cdpPortBase: z.number().default(9333),
  apiToken: z.string().default(''),
})

function windowSpec(patch: Partial<WindowSpec> = {}): WindowSpec {
  return {
    title: '',
    process: '',
    launch: '',
    submitKeys: ['enter'],
    openInputKeys: [],
    newlineKeys: ['shift+enter'],
    appearTimeoutMs: 20000,
    settleMs: 1500,
    ...patch,
  }
}

function cdpSpec(patch: Partial<CdpSpec> = {}): CdpSpec {
  return {
    launchArgs: [],
    port: 0,
    busySelector: '',
    transcriptSelector: '',
    inputSelector: '',
    sendSelector: '',
    pageMatch: '',
    readback: {
      sessionIdExpression: '',
      command: '',
      args: [],
      extract: '',
      timeoutMs: 30000,
    },
    ...patch,
  }
}

/** 目标补丁：window/cdp 允许只写差异字段。 */
export type TargetPatch = Partial<Omit<TargetConfig, 'window' | 'cdp'>> & {
  name: string
  window?: Partial<WindowSpec>
  cdp?: Partial<CdpSpec>
}

function target(patch: TargetPatch): TargetConfig {
  const { window: windowPatch, cdp: cdpPatch, ...rest } = patch
  const defaults: TargetConfig = {
    name: patch.name,
    transport: 'auto',
    description: '',
    command: '',
    args: [],
    acpArgs: [],
    acpModel: '',
    modelArgs: [],
    modelsCommand: '',
    modelsArgs: [],
    modelsFile: '',
    productConfigFile: '',
    modelsFixed: [],
    modelsCacheMs: 300000,
    modelsTimeoutMs: 25000,
    promptViaStdin: false,
    cwd: '',
    env: {},
    timeoutMs: 600000,
    order: ['acp', 'headless', 'pty', 'cdp', 'window'],
    window: windowSpec(),
    cdp: cdpSpec(),
  }
  return {
    ...defaults,
    ...rest,
    window: windowSpec(windowPatch),
    cdp: cdpSpec(cdpPatch),
  }
}

/** 各 CLI 实测支持的推理档位词表（与 2026-10-15 的 `--help` 输出一一核对）。 */
const EFFORTS_CODEX = { levels: [
  { id: 'minimal', name: 'Minimal（最省）' },
  { id: 'low', name: 'Low（低）' },
  { id: 'medium', name: 'Medium（中）' },
  { id: 'high', name: 'High（高）' },
], default: 'medium', args: ['-c', 'model_reasoning_effort={effort}'] } as const
const EFFORTS_CLAUDE = { levels: [
  { id: 'low', name: 'Low（低）' },
  { id: 'medium', name: 'Medium（中）' },
  { id: 'high', name: 'High（高）' },
  { id: 'xhigh', name: 'XHigh（超高）' },
  { id: 'max', name: 'Max（最大）' },
], default: 'medium', args: ['--effort', '{effort}'] } as const
const EFFORTS_PI = { levels: [
  { id: 'off', name: 'Off（关闭）' },
  { id: 'minimal', name: 'Minimal（最省）' },
  { id: 'low', name: 'Low（低）' },
  { id: 'medium', name: 'Medium（中）' },
  { id: 'high', name: 'High（高）' },
  { id: 'xhigh', name: 'XHigh（超高）' },
  { id: 'max', name: 'Max（最大）' },
], default: 'medium', args: ['--thinking', '{effort}'] } as const

/** 本机路径（由一次只读普查确定；换机器时在 profile 里覆盖即可）。 */
const WB_NODE_MODULES = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node_modules'

/**
 * 随包受管 bootstrap 适配器的**绝对路径**（目标 argv 需要绝对路径；解析相对本模块的 lib/ 位置，
 * 因此无论插件安装在哪、或跑在暂存副本里，都指向**它自己**的 assets——不指向源根）。
 */
function packagedManagedAdapter(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'workbuddy-managed.cjs')
  } catch {
    return 'workbuddy-managed.cjs'
  }
}

/** WorkBuddy 受管账号的隔离档案容器（wrapper 的默认 profile 根；冻结 HOME 的源）。 */
const ACCOUNTS_ROOT = 'C:\\Users\\Administrator\\.dsh\\harness-accounts'

function safeExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * 解析「安装目录名易变」的 GUI 目标的可执行文件路径。
 *
 * 背景：Qoder CN IDE 升级/重装会把安装目录在 `D:\Qoder CNide` 与 `D:\Qoder CN IDE`
 * 之间改名（本机 2026-10-09 实测就是这种情况：旧的 `D:\Qoder CN IDE` 只剩
 * `resources/` + `debug.log`，exe 已在 `D:\Qoder CNide`）。`command` 一旦对不上，
 * cdp 通道会因「命令无法解析」直接 skip、window 通道也匹配不到进程，**整个目标静默失效**
 * —— 而且因为目录还在，光看路径存在性还发现不了。
 *
 * 所以这里按「已知候选（新的在前）→ 扫描常见根目录下带同名 exe 的目录」两段解析，
 * 让目录改名不再需要改配置。
 */
/**
 * 内置目标目录。
 *
 * 顺序即真相：能走 ACP 就先 ACP（流式、结构化），其次一次性打印，再退到 PTY，
 * 最后才是 GUI 的 CDP / 窗口。
 */
export function installedCodexEntry(root = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')): string {
  try {
    for (const entry of readdirSync(root).sort()) {
      const file = join(root, entry, 'codex.exe')
      if (safeExists(file)) return file
    }
  } catch { /* fall back to the installed CLI on PATH */ }
  return 'codex'
}

export const KNOWN_TARGETS: readonly TargetConfig[] = [
  /**
   * ⚠️ 2026-10-15 二次收缩（用户指示）：
   *   · 从本插件删除：opencode 全家（CLI/flash/TUI/桌面端）、command-code、grok、cursor
   *     （其中 Grok Bot 已从本机卸载）；zcode / zcode-cli / kimi / minimax 因「无法获取模型」删除
   *     （kimi 未登录且 provider 表为空；zcode CLI 无模型枚举机制；minimax 仅 GUI 且 mavis shim 失效）。
   *   · 2026-10-15 三改：MiMo Code CLI（`C:\Users\Administrator\.mimocode`，@mimo-ai/plugin 0.1.14）
   *     已按用户指示卸载（PATH 条目一并清除），mimo-cli 目标随之删除；只保留 MiMo 桌面端。
   *   · 保留的都是「DeepSeek 宿主原生调不了」的 CLI / 桌面端。
   */

  // ── 国外 CLI ──
  // ⚠️ 2026-10-16 headless 写盘授权（统筹会话修复请求，用户指令）：
  //   这四个通道以非交互模式跑卡（`-p` / `exec`），审批请求无人应答 ⇒ Write/Bash 一律
  //   「非交互模式下需审批→被拒」，派给它们的卡只能只读分析、落不了盘。
  //   因此为它们显式声明权限旁路旗标（词表各家 --help 实测，2026-10-16 本机）：
  //     · workbuddy-native / workbuddy-ai-native（claude 系）：`--permission-mode bypassPermissions`
  //       （choices: acceptEdits, bypassPermissions, default, plan, dontAsk, auto —— camelCase）
  //     · qoder-cn-native（claude 系）：`--permission-mode bypass_permissions`
  //       （choices: default, accept_edits, bypass_permissions, dont_ask, auto —— snake_case）
  //     · codex：`--dangerously-bypass-approvals-and-sandbox`
  //       （codex exec 无 --full-auto；-s 的 danger-full-access 只关沙箱不关审批，
  //        审批在 exec 里仍会被拒 —— 该旗标才同时跳过审批与沙箱，是 bypassPermissions 的等效物）
  //   这是**有意的产品化决定**（不是掩盖接入缺陷）：旁路只作用于用户显式派卡的受管通道，
  //   目标 description 里可见、可审计。
  target({
    name: 'claude',
    description: 'Claude Code 2.1.259（WorkBuddy 内置，PATH 上没有 claude shim）：-p 一次性打印',
    command: `${WB_NODE_MODULES}\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    args: ['-p'],
    promptViaStdin: true,
    modelArgs: ['--model', '{model}'],
    thinking: EFFORTS_CLAUDE,
    order: ['headless', 'pty'],
  }),
  target({
    name: 'codex',
    description: 'OpenAI Codex CLI：exec 非交互；模型由 -m 选择，版本以运行探测为准。带 --dangerously-bypass-approvals-and-sandbox（exec 非交互无人应答审批，不旁路则只能只读；2026-10-16 统筹请求）',
    command: installedCodexEntry(),
    args: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-'],
    promptViaStdin: true,
    modelArgs: ['-m', '{model}'],
    thinking: EFFORTS_CODEX,
    order: ['headless', 'pty'],
  }),
  target({
    name: 'pi',
    description: 'Pi coding agent CLI：-p 非交互，--mode text|json|rpc',
    command: 'pi',
    args: ['-p'],
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'pi',
    modelsArgs: ['--list-models'],
    thinking: EFFORTS_PI,
    order: ['headless', 'pty'],
  }),

  // ── GUI / Electron harness：CDP 读 DOM 优先，窗口级操控兜底 ──
  target({
    name: 'mimo',
    description: '小米 MiMo 桌面端（Electron；账号 3207006862 · CN）。账号级文本模型 mimo-v2.6-pro / mimo-v2.6-flash（另有 TTS/ASR/图像），默认 mimo-v2.6-pro；模型只能在它自己的界面里选（MiMo Code CLI 已卸载，无枚举命令，选择器只展示「CLI 默认模型」档）',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\mimo\\Xiaomi MiMo\\Xiaomi MiMo.exe',
    window: { process: 'Xiaomi MiMo.exe', title: '/MiMo/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9334 },
  }),

  // ── 持久原生会话的五路产品入口（最小改造执行计划 P2）─────────────────────
  // 协议依据：work/cli-session-audit/（2026-10-15 两轮进程间恢复实测）。
  // 声明了 nativeCli 的目标支持持久逻辑会话 + 原生 ID 精确恢复；
  // Qoder CN IDE 无等价 headless CLI，不声明协议能力，只保留桌面入口（不冒充 CLI 会话）。
  target({
    name: 'workbuddy-native',
    description: 'WorkBuddy（CN；受管 bootstrap workbuddy-a，密钥保护/冻结 HOME/适配器哈希+厂商版本门禁在派发前实测）：-p --output-format stream-json；--session-id 新建 / --resume 精确恢复（两轮进程间恢复已实测）。带 --permission-mode bypassPermissions（-p 非交互无人应答审批，不旁路则 Write/Bash 全被拒、落不了盘；2026-10-16 统筹请求）',
    command: 'D:\\workbuddy\\WorkBuddy.exe',
    args: [packagedManagedAdapter(), 'workbuddy-a', '-p', '--permission-mode', 'bypassPermissions'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    promptViaStdin: true,
    nativeCli: {
      protocol: 'claude-stream-json',
      newSessionArgs: ['--session-id', '{sessionId}'],
      resumeArgs: ['--resume', '{sessionId}'],
      outputArgs: ['--output-format', 'stream-json', '--verbose'],
    },
    order: ['headless'],
  }),
  target({
    name: 'workbuddy-ai-native',
    description: 'WorkBuddy.AI（国际；受管 bootstrap workbuddy-ai-b，独立入口与档案，不与 CN 版混用认证/默认模型/恢复目录）：协议同 workbuddy-native（两轮进程间恢复已实测）。带 --permission-mode bypassPermissions（同 workbuddy-native：非交互不旁路则落不了盘；2026-10-16 统筹请求）',
    command: 'D:\\workbuddy ai\\WorkBuddyAI\\WorkBuddyAI.exe',
    args: [packagedManagedAdapter(), 'workbuddy-ai-b', '-p', '--permission-mode', 'bypassPermissions'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    promptViaStdin: true,
    nativeCli: {
      protocol: 'claude-stream-json',
      newSessionArgs: ['--session-id', '{sessionId}'],
      resumeArgs: ['--resume', '{sessionId}'],
      outputArgs: ['--output-format', 'stream-json', '--verbose'],
    },
    order: ['headless'],
  }),
  target({
    name: 'qoder-cn-native',
    description: 'Qoder CN CLI（--config-dir 绑定 qoder-cn-a 隔离档案；注意：CLI 会话与 Qoder CN 工作台/IDE 两个桌面产品的账号/额度继承**未验证**，不互相冒充）：-p --output-format stream-json；--session-id 新建 / --resume 精确恢复（已实测）。带 --permission-mode bypass_permissions（该 CLI 词表是 snake_case，--help 实测；非交互不旁路则落不了盘；2026-10-16 统筹请求）',
    command: 'C:\\Users\\Administrator\\.qodersec\\bin\\qoderclicn.exe',
    args: ['--config-dir', join(ACCOUNTS_ROOT, 'qoder-cn-a'), '-p', '--permission-mode', 'bypass_permissions'],
    promptViaStdin: true,
    nativeCli: {
      protocol: 'claude-stream-json',
      newSessionArgs: ['--session-id', '{sessionId}'],
      resumeArgs: ['--resume', '{sessionId}'],
      outputArgs: ['--output-format', 'stream-json'],
    },
    order: ['headless'],
  }),
  target({
    name: 'qoder-cn-ide',
    description: 'Qoder CN IDE（独立桌面产品；bin/qodercn.cmd 会把 CLI 参数分流到桌面 IDE ⇒ 无等价低内存 headless 通道）。**不声明** nativeCli：本入口只做桌面 CDP/窗口派发；其账号/额度继承未验证，不与 qoder-cn-native 互相冒充',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\Qoder CNide\\Qoder CN IDE.exe',
    window: { process: 'Qoder CN IDE.exe', title: '/Qoder CN IDE/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9346, pageMatch: 'lingma/agents-window' },
  }),
  target({
    name: 'antigravity-native',
    description: 'Antigravity（agy CLI）：-p <prompt> --output-format stream-json；首轮由 CLI 生成 conversation id（mint），恢复用 --conversation <id>（明确会话 ID，**不用** --continue；两轮进程间恢复已实测）。⚠️ prompt 走 `-p` 内联（2026-10-16 现场实测：`-p` 是必须紧跟参数的旗标，原话 `flag needs an argument: -p`，**不接受** stdin）',
    command: 'C:\\Users\\Administrator\\AppData\\Local\\agy\\bin\\agy.cmd',
    args: [],
    promptViaStdin: false,
    nativeCli: {
      protocol: 'agy-jsonl',
      newSessionArgs: [],
      resumeArgs: ['--conversation', '{sessionId}'],
      outputArgs: ['--output-format', 'stream-json'],
      promptArg: ['-p', '{prompt}'],
    },
    order: ['headless'],
  }),
]

export interface ResolvedConfig extends Config {
  resolvedTargets: TargetConfig[]
}

function mergeTarget(base: TargetConfig, patch: Partial<TargetConfig>): TargetConfig {
  return {
    ...base,
    ...patch,
    window: { ...base.window, ...(patch.window ?? {}) },
    cdp: { ...base.cdp, ...(patch.cdp ?? {}) },
    env: { ...base.env, ...(patch.env ?? {}) },
    name: base.name,
  }
}

/** 合并内置目录与用户配置；`apply()` 直接调用（无 loader 默认值）时也能得到完整配置。 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const input = (raw ?? {}) as Partial<Config>
  const merged = new Map<string, TargetConfig>()
  for (const entry of KNOWN_TARGETS) merged.set(entry.name, entry)
  for (const entry of input.targets ?? []) {
    if (entry === undefined || entry === null || typeof entry.name !== 'string' || entry.name.length === 0) continue
    const existing = merged.get(entry.name)
    merged.set(entry.name, existing === undefined ? target(entry) : mergeTarget(existing, entry))
  }
  const resolvedTargets = [...merged.values()]
  const defaultTarget = input.defaultTarget !== undefined && input.defaultTarget.length > 0
    ? input.defaultTarget
    : (resolvedTargets[0]?.name ?? '')
  return {
    targets: input.targets ?? [],
    defaultTarget,
    pythonPath: input.pythonPath ?? '',
    maxReplyChars: input.maxReplyChars ?? 16000,
    maxScreenChars: input.maxScreenChars ?? 8000,
    cdpPortBase: input.cdpPortBase ?? 9333,
    apiToken: input.apiToken ?? '',
    resolvedTargets,
  }
}

/** 按名字或别名找一个目标（大小写不敏感）。 */
export function findTarget(config: ResolvedConfig, name: string): TargetConfig | undefined {
  const needle = name.trim().toLowerCase()
  return config.resolvedTargets.find(entry => entry.name.toLowerCase() === needle)
}
