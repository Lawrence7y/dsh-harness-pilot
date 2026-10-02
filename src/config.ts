/**
 * Plugin registry: harness targets, defaults, and the Schemastery Config schema.
 *
 * 内置一份「本机实探过的 harness 目录」：CLI 类走 acp/headless/pty，GUI 类走 cdp/window。
 * 用户在 profile 里只写差异项（换路径、固定模型、加参数）。
 */
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
  modelsCommand: z.string().default(''),
  modelsArgs: z.array(z.string()).default([]),
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

/** 本机路径（由一次只读普查确定；换机器时在 profile 里覆盖即可）。 */
const WB_NODE_MODULES = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node_modules'
const ZCODE_CLI = 'D:\\zai\\ZCode\\resources\\glm\\zcode.cjs'
const CODEBUDDY_CLI = 'D:\\workbuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy'
const QODER_CLI = 'D:\\Qoder\\resources\\app\\resources\\bin\\x86_64_windows\\qodercli.exe'

/**
 * 内置目标目录。
 *
 * 顺序即真相：能走 ACP 就先 ACP（流式、结构化），其次一次性打印，再退到 PTY，
 * 最后才是 GUI 的 CDP / 窗口。
 */
export const KNOWN_TARGETS: readonly TargetConfig[] = [
  // ── OpenCode 系（ACP + 一次性打印 + ConPTY）──
  target({
    name: 'opencode',
    description: 'OpenCode CLI 2.0.14：支持 ACP、run 一次性打印、交互 TUI',
    command: 'opencode',
    args: ['run'],
    acpArgs: ['acp'],
    // opencode 的 ACP 默认模型走 OpenRouter（本机余额不足）；ACP 无 --model，只能会话内切。
    acpModel: 'opencode-go/deepseek-v4.1-flash',
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'opencode',
    modelsArgs: ['models'],
    order: ['acp', 'headless', 'pty'],
    window: { process: 'opencode', title: '/opencode/i' },
  }),
  target({
    name: 'opencode-flash',
    description: 'OpenCode CLI，模型固定为 opencode-go/deepseek-v4.1-flash（本机实测可用）；演示每个目标可绑定不同模型',
    command: 'opencode',
    args: ['run', '--model', 'opencode-go/deepseek-v4.1-flash'],
    acpArgs: ['acp'],
    acpModel: 'opencode-go/deepseek-v4.1-flash',
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'opencode',
    modelsArgs: ['models'],
    order: ['headless', 'pty'],
    window: { process: 'opencode', title: '/opencode/i' },
  }),
  target({
    name: 'opencode-tui',
    description: 'OpenCode 交互式 TUI（无参数）；给 harness_open / harness_send 用的 ConPTY 会话目标',
    command: 'opencode',
    args: [],
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'opencode',
    modelsArgs: ['models'],
    order: ['pty'],
    window: { process: 'opencode', title: '/opencode/i' },
  }),

  // ── 国内 harness 的 CLI 版（ACP 或一次性打印）──
  target({
    name: 'mimo-cli',
    description: '小米 MiMo CLI 0.1.4（mimocode，OpenCode 分支）：支持 acp 与 run',
    command: 'mimo',
    args: ['run'],
    acpArgs: ['acp'],
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'mimo',
    modelsArgs: ['models'],
    order: ['acp', 'headless', 'pty'],
    window: { process: 'mimo', title: '/mimo/i' },
  }),
  target({
    name: 'codebuddy',
    description: 'WorkBuddy 内置 CodeBuddy CLI：帮助文本声明支持 --acp 与 -p --model，但本机 bin 实际是坏的（Cannot find module \'../dist/codebuddy\'），跑不起来 —— 保留条目以便修复后可用；WorkBuddy 桌面端请用 workbuddy 目标',
    command: 'node',
    args: [CODEBUDDY_CLI, '-p'],
    acpArgs: [CODEBUDDY_CLI, '--acp'],
    order: ['acp', 'headless', 'pty'],
  }),
  target({
    name: 'zcode-cli',
    description: 'ZCode 内置 CLI 0.16.9（zcode.cjs，必须走 ELECTRON_RUN_AS_NODE）：-p 一次性打印。实测**没有 --model 参数**，模型只在 ~/.zcode/cli/config.json 或 TUI 的 /model 里选',
    command: 'D:\\zai\\ZCode\\ZCode.exe',
    args: [ZCODE_CLI, '-p'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    order: ['headless', 'pty'],
  }),
  target({
    name: 'qoder-cli',
    description: 'Qoder IDE 内置 qodercli 1.7.0：-p 一次性打印、-f json 机器可读',
    command: QODER_CLI,
    args: ['-p'],
    // Go 版 qodercli 的 --model 取固定档位（auto/efficient/gmodel/…），不是 provider/model
    modelArgs: ['--model', '{model}'],
    order: ['headless', 'pty'],
    timeoutMs: 900000,
  }),
  target({
    name: 'qodercli',
    description: 'Qoder CLI（qodersec 全局版 1.0.45）：布尔 -p + 位置参数，-o 指定输出格式',
    command: 'C:\\Users\\Administrator\\.qodersec\\bin\\qodercli.exe',
    args: ['-p'],
    modelArgs: ['-m', '{model}'],
    modelsCommand: 'C:\\Users\\Administrator\\.qodersec\\bin\\qodercli.exe',
    modelsArgs: ['--list-models'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'qoderclicn',
    description: 'Qoder CLI CN（qodersec 全局版 1.1.41）：布尔 -p + 位置参数',
    command: 'C:\\Users\\Administrator\\.qodersec\\bin\\qoderclicn.exe',
    args: ['-p'],
    modelArgs: ['-m', '{model}'],
    modelsCommand: 'C:\\Users\\Administrator\\.qodersec\\bin\\qoderclicn.exe',
    modelsArgs: ['--list-models'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'kimi',
    description: 'Kimi Code CLI：支持 acp 与 -p 一次性打印',
    command: 'C:\\Users\\Administrator\\.kimi-code\\bin\\kimi.exe',
    args: ['-p'],
    acpArgs: ['acp'],
    modelArgs: ['-m', '{model}'],
    order: ['acp', 'headless', 'pty'],
  }),
  target({
    name: 'grok-cli',
    description: 'Grok CLI（Rust）：-p/--single 一次性打印，--output-format json',
    command: 'C:\\Users\\Administrator\\AppData\\Local\\grok\\grok.exe',
    args: ['-p'],
    modelArgs: ['-m', '{model}'],
    modelsCommand: 'grok',
    modelsArgs: ['models'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'agy',
    description: 'Antigravity CLI 1.2.12（Google）：-p/--print 一次性打印，--output-format 可选 text/json/stream-json。注意 agy models 返回的是**目录**（14 个：Gemini 11 · Claude 2 · GPT-OSS 1），当前登录态下 entitlement 拉取被跳过，实际可用范围以运行为准；账号 <redacted>',
    command: 'agy',
    args: ['--output-format', 'json', '-p'],
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'agy',
    modelsArgs: ['models'],
    modelsTimeoutMs: 150000,
    order: ['headless', 'pty'],
    timeoutMs: 900000,
    window: { process: 'agy', title: '/agy|antigravity/i' },
  }),
  target({
    name: 'pi',
    description: 'Pi coding agent CLI：-p 非交互，--mode text|json|rpc',
    command: 'pi',
    args: ['-p'],
    modelArgs: ['--model', '{model}'],
    modelsCommand: 'pi',
    modelsArgs: ['--list-models'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'command-code',
    description: 'Command Code CLI 1.38.2：-p 非交互，--output-format json（NDJSON 事件流）',
    command: 'node',
    args: [`${WB_NODE_MODULES}\\command-code\\dist\\index.mjs`, '-p'],
    order: ['headless', 'pty'],
  }),

  // ── 国外 CLI ──
  target({
    name: 'claude',
    description: 'Claude Code 2.1.259（WorkBuddy 内置，PATH 上没有 claude shim）：-p 一次性打印',
    command: `${WB_NODE_MODULES}\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
    args: ['-p'],
    modelArgs: ['--model', '{model}'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'codex',
    description: 'OpenAI Codex CLI（原生 0.154.0-alpha）：codex exec 非交互；本版无 --full-auto，用 -s/-a 控制沙箱与审批',
    command: 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\bffc5354119c8421\\codex.exe',
    args: ['exec'],
    modelArgs: ['-m', '{model}'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'gemini',
    description: 'Gemini CLI（本机未安装；装了即可用 -p）',
    command: 'gemini',
    args: ['-p'],
    order: ['headless', 'pty'],
  }),
  target({
    name: 'qwen',
    description: 'Qwen Code CLI（本机未安装；装了即可用 -p）',
    command: 'qwen',
    args: ['-p'],
    order: ['headless', 'pty'],
  }),

  // ── GUI / Electron harness：CDP 读 DOM 优先，窗口级操控兜底 ──
  target({
    name: 'zcode',
    description: 'ZCode 桌面端 3.14.4（z.ai；Electron）。实测账号级可用 5 家供应商 / 8 个模型：opencode(deepseek-v4.1-flash, mimo-v2.6-flash) · xiaomi-mimo(mimo-v2.6-pro, mimo-v2.6-flash) · step(step-5-preview) · synapse(claude-opus-5-5) · bigmodel(GLM-5.3, GLM-5.3-Flash)；套餐路由均 coding_plan_not_entitled。GUI 读不到正文时改用 zcode-cli 目标',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\zai\\ZCode\\ZCode.exe',
    window: { process: 'ZCode.exe', title: '/ZCode/i', openInputKeys: ['ctrl+n'] },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9333 },
  }),
  target({
    name: 'mimo-ai',
    description: '小米 MiMo AI 桌面端（第二个安装/账号 <redacted> · SGP；Electron）。账号级模型 7 个：mimo-v2.6-pro / mimo-v2.6-flash + 3 个 TTS + mimo-v2.5-asr + gpt-image-2（图像，与非 AI 版的 Seedream 不同），默认 mimo-v2.6-pro；模型只能在它自己的界面里选。没在跑时由 cdp 带调试端口拉起，已在跑则退回窗口通道',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\mimo\\Xiaomi MiMo AI\\Xiaomi MiMo AI.exe',
    window: { process: 'Xiaomi MiMo AI.exe', title: '/MiMo/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9335 },
  }),
  target({
    name: 'mimo',
    description: '小米 MiMo 桌面端（Electron；账号 <redacted> · CN）。账号级模型 7 个：mimo-v2.6-pro / mimo-v2.6-flash（文本）+ 3 个 TTS + mimo-v2.5-asr + Doubao-Seedream-5.0-pro（图像），默认 mimo-v2.6-pro；模型只能在它自己的界面里选。CLI 版见 mimo-cli 目标',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\mimo\\Xiaomi MiMo\\Xiaomi MiMo.exe',
    window: { process: 'Xiaomi MiMo.exe', title: '/MiMo/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9334 },
  }),
  target({
    name: 'workbuddy',
    description: 'WorkBuddy 桌面端 5.6.2（腾讯；Electron）。内置 CodeBuddy CLI 见 codebuddy 目标',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\workbuddy\\WorkBuddy.exe',
    window: { process: 'WorkBuddy', title: '/WorkBuddy/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9340 },
  }),
  target({
    name: 'qoder',
    description: 'Qoder IDE 1.26（阿里；VSCode fork）。内置 qodercli 见 qoder-cli 目标',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\Qoder\\Qoder.exe',
    window: { process: 'Qoder.exe', title: '/Qoder/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9342 },
  }),
  target({
    name: 'qoder-cn',
    description: 'Qoder CN IDE 1.30（阿里云；VSCode fork）。实测界面可选 14 档（含 Auto）：Qwen3.8-Max/Qwen3.8-Flash(当前)/Qwen3.7-Max/Plus/Flash · DeepSeek-V4-Pro/DeepSeek-Flash · GLM-5.3/5.3-Flash/5.2 · Kimi-K3/K2.8-Preview · MiniMax-M2.7；账号 <redacted>（IDE 已登录，CLI qoderclicn 未登录）',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\Qoder CN IDE\\Qoder CN IDE.exe',
    window: { process: 'Qoder CN IDE.exe', title: '/Qoder/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9336 },
  }),
  target({
    name: 'qoder-cn-app',
    description: 'Qoder CN 桌面端；Electron 独立 App，聊天发送按钮通过 aria-label 定位。',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\Qoder CN\\Qoder CN.exe',
    window: { process: 'Qoder CN.exe', title: '/^Qoder CN$/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9344, sendSelector: '[aria-label="发送消息"]' },
  }),
  target({
    name: 'antigravity',
    description: 'Antigravity IDE 2.18.1（Google；Electron）。实测界面可选 7 个模型：Gemini 3.8 Flash(High/Fast，当前) · 3.7 Flash(Medium) · 3.6 Flash(Medium) · 3.1 Pro(Low) · Claude Sonnet 4.6(Thinking) · Claude Opus 4.6(Thinking) · GPT-OSS 120B(Medium)；账号 <redacted>。CLI 版见 agy 目标',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
    window: { process: 'Antigravity.exe', title: '/Antigravity/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9337 },
  }),
  target({
    name: 'minimax',
    description: 'MiniMax Code 桌面端 3.1.0（稀宇；Electron）。自带 mavis CLI 的 shim 已失效',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\minimax\\MiniMax Code\\MiniMax Code.exe',
    window: { process: 'MiniMax Code.exe', title: '/MiniMax/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9338 },
  }),
  target({
    name: 'grok',
    description: 'Grok Bot 桌面端 0.29（Electron）。CLI 版见 grok-cli 目标',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\Grok bot\\Grok Bot.exe',
    window: { process: 'Grok Bot.exe', title: '/Grok/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9339 },
  }),
  target({
    name: 'cursor',
    description: 'Cursor IDE 3.11.13（VSCode fork）。实测无 agent 一次性模式（cursor agent 的 options 为空、也没有 cursor-agent），只能 GUI 操控',
    transport: 'cdp',
    order: ['cdp', 'window'],
    command: 'D:\\cursor\\Cursor.exe',
    window: { process: 'Cursor.exe', title: '/Cursor/i' },
    cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9341 },
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
