#!/usr/bin/env node
/**
 * 把**已实测**的 `docs/verified/harness-probe.json` 生成为 `src/federation/catalog.ts`。
 *
 * 为什么要生成而不是手抄：那份 probe 是逐条实跑的产物（12 measured / 0 inferred /
 * 1 unknown），手抄会引入转录错误，而且下次复测后要能一键重生成。
 *
 * 注意生成物的定位：
 *   · 「这台机器的 CLI 长什么样」= **种子知识**（入口、版本探测 argv、通道支持、
 *     隔离开关名、模型列表命令、上游限制）；
 *   · 「现在实际是什么版本 / 现在能不能连」= **运行期探测**，由 registry.ts 测量，
 *     **不从这里读**。种子里的 version 只作为 `seedVersion` 保留作对照，
 *     绝不当成当前版本展示。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probe = JSON.parse(readFileSync(join(root, 'docs/verified/harness-probe.json'), 'utf8'))

/** 人工补充：厂商、种类、以及**版本探测 argv**（probe 记了结果但没记 argv）。 */
const META = {
  'dsh-native': { vendor: 'deepseek', kind: 'native', versionProbe: null },
  codex: { vendor: 'openai', kind: 'cli', versionProbe: ['--version'] },
  'claude-code': { vendor: 'anthropic', kind: 'cli', versionProbe: ['--version'] },
  opencode: { vendor: 'sst', kind: 'cli', versionProbe: ['--version'] },
  pi: { vendor: 'earendil', kind: 'cli', versionProbe: ['--version'] },
  'qoder-cn': { vendor: 'alibaba', kind: 'cli', versionProbe: ['--version'] },
  workbuddy: { vendor: 'tencent', kind: 'cli', versionProbe: ['--version'] },
  // WorkBuddy.AI 的 CLI 与 WorkBuddy **不是同一份安装**（各自 app 目录），但 probe 实测
  // 两者的 launcher SHA-256 相同、是同一份 CLI payload，且明确写了
  // "Same CLI; not separately re-probed here."。因此这里**显式继承** workbuddy 的
  // 通道/能力结论，并把 confidence 降级为 inferred —— 不许当作独立实测。
  'workbuddy-ai': { vendor: 'tencent', kind: 'cli', versionProbe: ['--version'], inheritsFrom: 'workbuddy' },
  mimo: { vendor: 'xiaomi', kind: 'cli', versionProbe: ['--version'] },
  kimi: { vendor: 'moonshot', kind: 'cli', versionProbe: ['--version'] },
  grok: { vendor: 'xai', kind: 'cli', versionProbe: ['--version'] },
  'antigravity-agy': { vendor: 'google', kind: 'cli', versionProbe: ['--version'] },
  zcode: { vendor: 'zai', kind: 'electron-gui', versionProbe: null },
}

/** probe 的通道键 → 本插件的 5 档 dispatch 通道 + tier。 */
const TRANSPORT_MAP = [
  ['acp', 'acp', 1],
  ['headlessOneShot', 'headless', 2],
  ['ptyTui', 'pty', 2],
  ['guiCdpWindow', 'cdp', 3],
]

/** 取「连接形状」：优先原生协议，其次一次性调用，最后 GUI。 */
function connectionOf(t) {
  const sup = (k) => t?.[k]?.supported === true
  if (sup('acp')) return 'acp'
  if (sup('appServerJsonRpc') || sup('rpc') || sup('jsonRpc')) return 'app-server'
  if (sup('httpApi') || sup('httpServer') || sup('serve') || sup('restApi')) return 'http'
  if (sup('headlessOneShot')) return 'agent-cli'
  if (sup('guiCdpWindow')) return 'gui'
  return null
}

function modelSelectOf(m) {
  if (m === undefined || m === null) return 'unknown'
  const mech = String(m.mechanism ?? '')
  if (m.acpModel !== undefined || /acp/i.test(mech)) return 'acp-config'
  if (m.flag !== undefined || /argv/i.test(mech) || /--model/.test(String(m.flag ?? ''))) return 'argv'
  if (m.note !== undefined && /only.*(UI|界面)/i.test(String(m.note))) return 'none'
  return m.flag === null && m.listCommand === undefined ? 'none' : 'unknown'
}

function multiAccountOf(iso) {
  if (iso === undefined || iso === null) return { multiAccount: 'unknown', multiAccountSwitch: undefined, isolationTested: false }
  const tested = iso.tested === true
  const result = String(iso.result ?? '')
  const failing = /no effect|not working|inconclusive|did not/i.test(result)
  if (!tested || failing) return { multiAccount: 'unknown', multiAccountSwitch: iso.switch ?? undefined, isolationTested: tested && !failing }
  return { multiAccount: 'isolated-config-dir', multiAccountSwitch: iso.switch ?? undefined, isolationTested: true }
}

/** 从数组或对象里安全取出字符串数组。 */
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

/**
 * 把 probe 里那句**人类可读的**列表命令说明，清洗成**可执行的 argv**。
 *
 * 为什么必须清洗：probe 的 `listCommand` 是散文，例如
 *   pi        `pi --list-models [search]`
 *   mimo      `mimo models [provider]`
 *   agy-core  `agy-core models ('List available models')`
 *   qoderclicn`qoderclicn --list-models (there is also a bare 'models' invocation path)`
 * 早先直接按空白切分，于是 `[search]` / `[provider]` / `('List` / `available` / `models')`
 * 全被当成参数传给了 CLI —— 实测直接把 pi / mimo / agy 跑成报错，模型列表全空。
 *
 * 清洗规则：丢掉命令名；然后**只保留像 CLI 语法的 token**（`-x`/`--xyz` 或小写单词
 * 子命令），遇到第一个不像的 token 就停（后面基本都是括号说明）。
 */
function sanitizeListArgs(listCommand) {
  if (typeof listCommand !== 'string' || listCommand.trim().length === 0) return { args: [], raw: null }
  const tokens = listCommand.trim().split(/\s+/)
  const rest = tokens.slice(1)
  const args = []
  for (const tok of rest) {
    const isFlag = /^--?[A-Za-z][A-Za-z0-9-]*$/.test(tok)
    const isSubcommand = /^[a-z][a-z0-9-]*$/.test(tok)
    if (!isFlag && !isSubcommand) break
    args.push(tok)
  }
  return { args, raw: listCommand.trim() }
}

const entries = []
for (const [id, h] of Object.entries(probe.harnesses)) {
  const meta = META[id]
  if (meta === undefined) throw new Error(`no META for harness "${id}" — add it rather than guessing`)
  // 继承：被继承者提供**能力**字段，自己只提供**身份**字段（入口/显示名/版本）。
  // 这样不会让未复测目标那份空 transports 覆盖掉已实测的结论。
  let cap = h
  let confidenceOverride = null
  let inheritedFrom = null
  if (meta.inheritsFrom !== undefined) {
    const p = probe.harnesses[meta.inheritsFrom]
    if (p === undefined) throw new Error(`inheritsFrom target "${meta.inheritsFrom}" not in probe`)
    inheritedFrom = meta.inheritsFrom
    confidenceOverride = 'inferred'
    cap = {
      ...p,
      displayName: h.displayName ?? p.displayName,
      entryPath: h.entryPath ?? p.entryPath,
      shimPath: h.shimPath ?? p.shimPath,
      shimWrappingRequired: h.shimWrappingRequired ?? p.shimWrappingRequired,
      entryResolution: `${h.entryResolution ?? ''} [能力字段继承自 "${inheritedFrom}"，未单独复测；身份字段为本目标实测]`.trim(),
      version: h.version ?? p.version,
      multiAccountIsolation: h.multiAccountIsolation ?? p.multiAccountIsolation,
    }
  }
  const t = cap.transports ?? {}
  const transports = TRANSPORT_MAP.map(([key, kind, tier]) => ({
    kind,
    tier,
    supported: t[key]?.supported === true,
    note: typeof t[key]?.note === 'string' ? t[key].note : undefined,
  }))
  // GUI 目标同时可作为 window 通道
  if (t.guiCdpWindow?.supported === true) {
    transports.push({ kind: 'window', tier: 3, supported: true, note: undefined })
  }
  const iso = multiAccountOf(cap.multiAccountIsolation)
  const ms = cap.modelSelection ?? {}
  const listArgs = sanitizeListArgs(ms.listCommand)
  const perm = cap.permissions ?? {}
  const rea = cap.reasoningEffort ?? {}
  const sr = cap.sessionResume ?? {}

  entries.push({
    id,
    displayName: h.displayName ?? id,
    vendor: meta.vendor,
    kind: meta.kind,
    entryPath: h.entryPath ?? null,
    shimPath: typeof h.shimPath === 'string' ? h.shimPath : null,
    shimWrappingRequired: h.shimWrappingRequired ?? 'unknown',
    entryResolution: h.entryResolution ?? '',
    versionProbe: meta.versionProbe,
    seedVersion: cap.version?.value ?? null,
    confidence: confidenceOverride ?? cap.confidence ?? 'unknown',
    inheritedFrom,
    connection: cap.inProcess === true ? 'native' : (connectionOf(t) ?? 'agent-cli'),
    transports,
    modelSelect: modelSelectOf(ms),
    modelFlag: typeof ms.flag === 'string' ? ms.flag : null,
    modelListArgs: listArgs.args,
    modelListCommandRaw: listArgs.raw,
    modelListCount: typeof ms.listCount === 'number' ? ms.listCount : null,
    providerConfigFiles: strs(cap.providerConfig?.files),
    multiAccount: iso.multiAccount,
    multiAccountSwitch: iso.multiAccountSwitch ?? null,
    isolationTested: iso.isolationTested,
    permissionModes: strs(perm.modes ?? perm.values ?? perm.flags),
    reasoningEfforts: strs(rea.values ?? rea.levels ?? rea.flags),
    sessionResume: sr.supported === true ? 'native-id' : (sr.supported === false ? 'none' : 'unknown'),
    sessionResumeNote: typeof sr.note === 'string' ? sr.note : null,
    mcpServer: t.mcp?.supported === true,
    authNote: typeof cap.authStatus === 'object' && cap.authStatus !== null ? JSON.stringify(cap.authStatus).slice(0, 400) : null,
    upstreamLimits: strs(cap.upstreamLimits),
  })
}

const q = (s) => (s === null || s === undefined ? 'null' : JSON.stringify(s))
const arr = (a) => (a === null || a === undefined || a.length === 0 ? '[]' : `[${a.map(q).join(', ')}]`)

// Regional overlay is separately measured; preserve the historical source probe.
const intlOverlay = JSON.parse(readFileSync(join(root, 'docs/verified/qoder-intl-profile.json'), 'utf8'))
entries.push(intlOverlay.seed)

const body = entries.map((e) => `  {
    id: ${q(e.id)},
    displayName: ${q(e.displayName)},
    vendor: ${q(e.vendor)},
    kind: ${q(e.kind)},
    entryPath: ${q(e.entryPath)},
    shimPath: ${q(e.shimPath)},
    shimWrappingRequired: ${q(e.shimWrappingRequired)},
    entryResolution: ${q(e.entryResolution)},
    versionProbe: ${arr(e.versionProbe)},
    seedVersion: ${q(e.seedVersion)},
    confidence: ${q(e.confidence)},
    inheritedFrom: ${q(e.inheritedFrom)},
    connection: ${q(e.connection)},
    transports: [
${e.transports.map((t) => `      { kind: ${q(t.kind)}, tier: ${t.tier}, supported: ${t.supported}, note: ${q(t.note)} },`).join('\n')}
    ],
    modelSelect: ${q(e.modelSelect)},
    modelFlag: ${q(e.modelFlag)},
    modelListArgs: ${arr(e.modelListArgs)},
    modelListCommandRaw: ${q(e.modelListCommandRaw)},
    modelListCount: ${e.modelListCount === null ? 'null' : e.modelListCount},
    providerConfigFiles: ${arr(e.providerConfigFiles)},
    multiAccount: ${q(e.multiAccount)},
    multiAccountSwitch: ${q(e.multiAccountSwitch)},
    isolationTested: ${e.isolationTested},
    permissionModes: ${arr(e.permissionModes)},
    reasoningEfforts: ${arr(e.reasoningEfforts)},
    sessionResume: ${q(e.sessionResume)},
    sessionResumeNote: ${q(e.sessionResumeNote)},
    mcpServer: ${e.mcpServer},
    authNote: ${q(e.authNote)},
    upstreamLimits: ${arr(e.upstreamLimits)},
  },`).join('\n')

const out = `/**
 * ⚠️ 本文件由 \`scripts/gen-federation-catalog.mjs\` 从 \`docs/verified/harness-probe.json\`
 * **自动生成**，请勿手改；要改就改生成脚本并重跑。
 *
 * 生成源是逐条实测的探针结果（${probe.summary ? `${probe.summary.entryPathResolvedCount}/12 harness 解析到真实入口` : '见 summary'}）。
 * 这里存的是**这台机器的 CLI 长什么样**（种子知识），
 * **不包括当前版本与当前连通性** —— 那两样由 \`registry.ts\` 在运行期测量。
 * \`seedVersion\` 只作对照，**禁止当作当前版本展示**。
 */

import type { ConnectionKind, TransportKind, TransportTier } from './types.js'

export interface HarnessSeedTransport {
  readonly kind: TransportKind
  readonly tier: TransportTier
  readonly supported: boolean
  readonly note: string | null
}

export interface HarnessSeed {
  readonly id: string
  readonly displayName: string
  readonly vendor: string
  readonly kind: 'cli' | 'electron-gui' | 'vscode-fork' | 'native'
  /** 实测到的真实入口（已解析 shim）；null = 没找到。 */
  readonly entryPath: string | null
  readonly shimPath: string | null
  /** 入口需要怎样的包裹才能跑（none / node / ELECTRON_RUN_AS_NODE…）。 */
  readonly shimWrappingRequired: string
  readonly entryResolution: string
  /** 版本探测 argv（附加在入口之后）；空数组 = 该目标不做版本探测。 */
  readonly versionProbe: readonly string[]
  /** 探针当时的版本，**仅作对照**。 */
  readonly seedVersion: string | null
  readonly confidence: string
  /** 非 null = 能力字段继承自哪个 harness（该目标未单独复测，必须按 inferred 展示）。 */
  readonly inheritedFrom: string | null
  readonly connection: ConnectionKind
  readonly transports: readonly HarnessSeedTransport[]
  readonly modelSelect: 'argv' | 'acp-config' | 'none' | 'unknown'
  readonly modelFlag: string | null
  readonly modelListArgs: readonly string[]
  /** probe 里那句**人类可读的**原始说明，仅供界面展示；**不要**当 argv 用。 */
  readonly modelListCommandRaw: string | null
  readonly modelListCount: number | null
  readonly providerConfigFiles: readonly string[]
  readonly multiAccount: 'isolated-config-dir' | 'vendor-shared-store' | 'unknown'
  readonly multiAccountSwitch: string | null
  /** 是否**实测**过隔离开关真的生效。false 时必须按「未验证」展示。 */
  readonly isolationTested: boolean
  readonly permissionModes: readonly string[]
  readonly reasoningEfforts: readonly string[]
  readonly sessionResume: 'native-id' | 'none' | 'unknown'
  readonly sessionResumeNote: string | null
  readonly mcpServer: boolean
  readonly authNote: string | null
  readonly upstreamLimits: readonly string[]
}

/** 逐条实测的种子目录（按 id 索引）。 */
export const HARNESS_SEEDS: readonly HarnessSeed[] = [
${body}
]

/** 探针整体结论，界面上要如实转述。 */
export const PROBE_SUMMARY = {
  generatedAt: ${q(probe.probe?.date ?? probe.probe?.generatedAt ?? null)},
  entryPathResolvedCount: ${probe.summary?.entryPathResolvedCount ?? 'null'},
  targetsWithoutResolvedEntry: ${arr(probe.summary?.targetsWithoutResolvedEntry)},
  isolationMeasuredWorking: ${arr(probe.summary?.isolationMeasuredWorking)},
  isolationMeasuredNotWorking: ${arr(probe.summary?.isolationMeasuredNotWorkingOrInconclusive)},
  liveModelRequestIssued: ${probe.summary?.liveModelRequestIssued === true},
} as const
`

writeFileSync(join(root, 'src/federation/catalog.ts'), out, 'utf8')
console.log(`wrote src/federation/catalog.ts with ${entries.length} harness seeds`)
console.log('connections:', entries.map((e) => `${e.id}=${e.connection}`).join(' '))
console.log('modelSelect :', entries.map((e) => `${e.id}=${e.modelSelect}`).join(' '))
console.log('shared/unknown isolation:', entries.filter((e) => e.multiAccount !== 'isolated-config-dir').map((e) => e.id).join(', ') || '(none)')
