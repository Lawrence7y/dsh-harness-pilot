/**
 * 供应商 / 模型的 **可编辑操作** 与 **受约束选择**（P4）。
 *
 * ## 这个模块解决的两个真问题
 *   1. 「能不能改」不是我们说了算，而是**能力探测**说了算。宿主/外部 CLI 真实支持哪些操作、
 *      不支持哪些，必须**探出来**并如实拒绝；绝不允许做出一个「看起来能改」的界面或接口。
 *   2. 「选什么」不许是任意填写的字符串。选择必须从**真实发现的目录**出发，并且
 *      已配置 / 可发现 / 认证有效 / 实际可用 **四态分清**；「手填」这条路必须由调用方
 *      显式打开、并被明确标注为**未验证**。
 *
 * ## 三层，谁也不许冒充谁（这是本文件的中心纪律）
 *   · **发现层**（discovered）—— 真实探测出来的目录：DSH 本 profile 的路由（`dsh-native`）
 *     与某个外部 CLI 自己的模型列表（`harness-native`）。**只读**：现实本来就不由我们编辑。
 *   · **声明层**（declared）—— 本插件自己的「这个账号声明可用哪些模型」。**可编辑**，
 *     因为它是插件拥有的状态，而且有真实读取方（自动切换的模型兼容闸门）。
 *   · **托管命令层**（admin-command）—— 外部 CLI **自己**的供应商管理子命令
 *     （实测例：`kimi provider add/remove/list`）。可执行与否由该 CLI 的帮助文本**探**出来。
 *
 * DSH 侧的供应商/模型与外部 CLI 侧的供应商/模型是**两份互不相干的东西**：本模块产出的每个
 * 候选项都带 `owner`，跨 owner 的选择一律**拒绝**（`resolveCatalogSelection`），
 * 从结构上防住「把 DSH 的列表冒充成外部 CLI 的列表」以及反过来。
 *
 * ## `actual` 的诚实性（本模块最容易被做假的一处）
 * 已知实测反例（别被它骗）：**ACP 的 `session/set_config_option` 对不存在的模型 id 也会成功**
 * —— 调用成功只证明「会话配置被要求改成这个值」，**不证明**该模型真的服务了本轮。
 * 更普遍地，`sessions.ts` 的 `foldOutcomeIdentity()` 在通道没有明确报「换模型失败」时，
 * 会把 `identity.model` **直接填成请求值**（`actualModel = requestedModel`）。也就是说
 * 项目里那个 `actual.model` 字段在多数路径上**就是请求值的副本**。
 * 因此本模块的 `verifyActualSelection()`：
 *   · 永远把 `setter-ack`（"设置调用成功了"）与 `substitutedFromRequest: true` 的证据**排除**，
 *     并在 `excluded` 里写清排除理由；
 *   · 只有**独立观测**（harness 自己的原生会话记录 / 未做替换的派发身份回报）与请求值一致时
 *     才判 `proven`；
 *   · 一条证据都没有时判 `not-observed` —— **绝不**读成「一致」。
 *
 * 本文件只 import `./federation/types.js` / `./federation/registry.js` 与 `node:*`，可脱离宿主单独跑
 * （见 `probe/verify-catalog-edit.mjs`）。它**不**自己 spawn 任何会写用户配置的命令：
 * 计划与执行分开，执行靠调用方注入的执行器（`executeCatalogEdit`）。
 * 唯一的例外是 {@link runHarnessAdminHelp} —— 它只跑 `<cli> <sub> --help`（只读、零副作用、零额度）。
 */
import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'

import { resolveInvocation } from './federation/registry.js'
import type { Availability } from './federation/types.js'

// ═══════════════════════════ 1. 词汇 ═══════════════════════════

/** 一份目录**属于谁**。跨 owner 使用一律拒绝：这是「不冒充」的结构性保证。 */
export type CatalogOwner = 'dsh-native' | 'harness-native'

/** 可编辑面的种类。每一个都必须由**真探测**决定支持与否。 */
export type CatalogSurfaceId = 'dsh-llm-service' | 'harness-admin-command' | 'plugin-declared-allowlist'

export type CatalogOp =
  | 'list'
  | 'select'
  | 'add-provider'
  | 'remove-provider'
  | 'edit-provider'
  | 'add-model'
  | 'remove-model'
  | 'edit-model'
  | 'declare-models'

/**
 * `supported`        —— 有真实路径，且探测到了依据
 * `read-only`        —— 只能读（列出来），写没有落点
 * `refused-by-policy`—— 技术上也许做得到，但**本插件明确拒绝**（例如会改写用户部署默认值、
 *                       或属于凭据面）；拒绝理由必须能直接展示给用户
 * `unsupported`      —— 宿主/该 CLI 根本没有这条路径
 */
export type CapabilityVerdict = 'supported' | 'read-only' | 'refused-by-policy' | 'unsupported'

/** 执行该操作的**副作用形状** —— 结构化标注，供执行侧做门禁（不用去正则匹配证据文本）。 */
export type CatalogSideEffect = 'writes-user-cli-config'

export interface CatalogCapability {
  readonly surface: CatalogSurfaceId
  readonly owner: CatalogOwner
  readonly op: CatalogOp
  readonly verdict: CapabilityVerdict
  /** 探针**做了什么**（可复现的动作描述）。 */
  readonly probe: string
  /** 逐字观测到的依据（帮助文本原文、方法名、落盘字段名…）。 */
  readonly evidence: readonly string[]
  /** `verdict !== 'supported'` 时**必须**有：给用户的显式拒绝理由。 */
  readonly refusal?: string
  /** 有副作用时如实标注；执行侧据此要求显式确认。 */
  readonly sideEffect?: CatalogSideEffect
  /** 该面执行一个动作时命令的前缀（实测例：`['provider']`）。计划阶段据它拼 argv。 */
  readonly argvPrefix?: readonly string[]
}

/** 能力报告：把「探到了什么」与「据此允许什么」放在一起，调用方直接展示即可。 */
export interface CapabilityReport {
  readonly at: string
  readonly capabilities: readonly CatalogCapability[]
  readonly editable: readonly string[]
  readonly refused: readonly string[]
}

/** 汇总成可直接进接口/界面的报告。**不省略任何一条拒绝**。 */
export function capabilityReport(capabilities: readonly CatalogCapability[], at = new Date().toISOString()): CapabilityReport {
  return {
    at,
    capabilities,
    editable: capabilities
      .filter((c) => c.verdict === 'supported')
      .map((c) => `${c.surface}/${c.owner}/${c.op}`),
    refused: capabilities
      .filter((c) => c.verdict !== 'supported')
      .map((c) => `${c.surface}/${c.owner}/${c.op} [${c.verdict}] ${c.refusal ?? '(缺少拒绝理由 —— 这是缺陷)'}`),
  }
}

/**
 * `read-only` 的固定说明。
 *
 * 为什么要给「只读」也配一句拒绝理由：对**编辑**这件事来说，「只能读」与「不支持」是同一个
 * 答案（都不能改），调用方与界面需要的是同一件事 —— **为什么不能改**。
 * 少了这句话，界面上就会出现一个「有列表、没按钮、也没解释」的半成品。
 */
const READ_ONLY_REFUSAL =
  '该面只能**读**：它能列出供应商/模型，但没有任何写入路径（没有可写字段、也没有可执行的写命令）'
  + ' ⇒ 本插件在这个面上不提供编辑，也不做「看起来能改」的输入框。'

/** 取某条能力的判定；找不到 = `undefined`（缺探测一律按「不许做」处理，不是「大概可以」）。 */
export function capabilityOf(
  capabilities: readonly CatalogCapability[],
  op: CatalogOp,
  surface?: CatalogSurfaceId,
): CatalogCapability | undefined {
  return capabilities.find((c) => c.op === op && (surface === undefined || c.surface === surface))
}

// ═══════════════════ 2a. 能力探测：DSH 宿主的 llm 服务面 ═══════════════════

/**
 * 服务对象的结构性探测结果。**这是观测，不是判断**。
 * 判断在 {@link dshCatalogCapabilities} 里，且必须写明为什么某个方法不算「目录写入」。
 */
export interface ServiceShapeProbe {
  readonly available: boolean
  /** 观测到的方法名（自有 + 原型链，去重排序）。 */
  readonly observedMethods: readonly string[]
  /** 名字像「目录写入」的方法 —— 真探测到的话，结论就要跟着变。 */
  readonly mutationCandidates: readonly string[]
  /** 名字像写入但**只是声明/登记**的方法（必须逐条说明为什么不改目录）。 */
  readonly registrationOnly: readonly string[]
  readonly note: string
}

/** 名字像「增删改供应商/模型/路由/目录」的方法。 */
const MUTATION_LIKE = /^(add|create|insert|remove|delete|drop|rename|update|edit|set|upsert|write|unregister)[A-Z_]?(Provider|ProviderRoute|Model|Models|Route|Catalog|Directory)/

/**
 * 名字像写入但**不改目录**的方法 —— 逐个列名，避免正则把它们误判成写入能力。
 *
 * 为什么它们不算「可编辑供应商/模型」：
 *   · `registerAdapter` —— 只把**本插件自己的**适配器挂到给定路由上；路由来自配置，不是它新建的。
 *   · `registerConfigurableProviders` —— **声明**一组「可配置」路由供配置界面激活；
 *     是**声明目录**，写配置的是配置面，不是它。
 *   · `registerModelDiscovery` —— 只提供「替某个 settings 命名空间去问端点」的服务；
 *     宿主契约原文：`nothing here reads or writes settings or credentials — the caller owns both`。
 */
const REGISTRATION_ONLY = new Set(['registerAdapter', 'registerConfigurableProviders', 'registerModelDiscovery'])

/** 把服务对象（自有 + 原型链）的方法名枚举出来。深度有上限，绝不在宿主对象上乱走。 */
export function probeServiceShape(service: unknown): ServiceShapeProbe {
  if (service === null || service === undefined || (typeof service !== 'object' && typeof service !== 'function')) {
    return {
      available: false,
      observedMethods: [],
      mutationCandidates: [],
      registrationOnly: [],
      note: '拿不到 llm 服务实体（`ctx.get("llm")` 返回空）⇒ 连只读能力都无法探测，更不得声称可编辑。',
    }
  }
  const names = new Set<string>()
  let node: object | null = service as object
  let depth = 0
  while (node !== null && depth < 6) {
    for (const key of Object.getOwnPropertyNames(node)) {
      if (key === 'constructor') continue
      let value: unknown
      try {
        value = (node as Record<string, unknown>)[key]
      } catch {
        // 取值抛错（getter 有副作用）就跳过：探测不许碰宿主状态。
        continue
      }
      if (typeof value === 'function') names.add(key)
    }
    node = Object.getPrototypeOf(node) as object | null
    depth += 1
  }
  const observed = [...names].sort()
  return {
    available: true,
    observedMethods: observed,
    mutationCandidates: observed.filter((n) => MUTATION_LIKE.test(n)),
    registrationOnly: observed.filter((n) => REGISTRATION_ONLY.has(n)),
    note: `逐层枚举服务对象的方法名（自有 + 原型链，深度上限 6），共观测到 ${observed.length} 个方法。`,
  }
}

const REGISTRATION_EXCLUSION =
  'registerAdapter / registerConfigurableProviders / registerModelDiscovery 是**声明与登记**，不是目录写入：'
  + 'route 来自配置，registerModelDiscovery 的宿主契约原文写着 `nothing here reads or writes settings or credentials — the caller owns both`。'

/**
 * 由结构探测结果推出 DSH 侧的**可编辑范围**。
 *
 * 结论不是硬编码：`mutationCandidates` 非空时结论直接变成 `supported`，并把方法名列进证据。
 * 在本机 rc.2 上观测到的方法面是
 * `discoverModels / fileRequestText / imageRequestPricing / listModels / listProviders /
 *  prepareCall / providerRetryPolicy / registerAdapter / registerConfigurableProviders /
 *  registerModelDiscovery / remoteDiscoverModels / resolveCallConfig / resolveModelInfo / stream`
 * —— 没有一个是目录写入。
 */
export function dshCatalogCapabilities(shape: ServiceShapeProbe): CatalogCapability[] {
  const out: CatalogCapability[] = []
  const methods = shape.observedMethods
  const methodEvidence = methods.length > 0
    ? `观测到的 llm 服务方法（${methods.length} 个）：${methods.join(', ')}`
    : '没有观测到任何方法名（服务实体不可用）'
  const listable = methods.includes('listProviders') || methods.includes('listModels')
  const probe = shape.note

  out.push({
    surface: 'dsh-llm-service',
    owner: 'dsh-native',
    op: 'list',
    verdict: listable ? 'read-only' : 'unsupported',
    probe,
    evidence: [methodEvidence],
    ...(listable
      ? { refusal: READ_ONLY_REFUSAL }
      : { refusal: '没有观测到 listProviders / listModels —— 连读都读不到，不得声称能列。' }),
  })

  // 目录写入：只看真观测到的 mutationCandidates。
  const writeOps: CatalogOp[] = ['add-provider', 'remove-provider', 'edit-provider', 'add-model', 'remove-model', 'edit-model']
  for (const op of writeOps) {
    const supported = shape.mutationCandidates.length > 0
    out.push({
      surface: 'dsh-llm-service',
      owner: 'dsh-native',
      op,
      verdict: supported ? 'supported' : 'unsupported',
      probe,
      evidence: [
        methodEvidence,
        shape.mutationCandidates.length > 0
          ? `观测到疑似目录写入的方法：${shape.mutationCandidates.join(', ')}`
          : '在观测到的方法名里**没有任何一个**匹配「增删改供应商/模型/路由/目录」的形状。',
        REGISTRATION_EXCLUSION,
      ],
      ...(supported
        ? {}
        : {
            refusal:
              '宿主 llm 服务没有提供任何「增删改供应商/模型」的方法：它只暴露只读发现'
              + '（listProviders / listModels / resolveModelInfo）与**调用参数级**的取用'
              + '（prepareCall / stream 的 provider+model 是本次调用的入参，不落任何配置）。'
              + 'DSH 本 profile 的供应商路由与模型目录**由配置拥有**：插件能做的只是'
              + '「声明一组可配置路由供配置界面激活」（registerConfigurableProviders），'
              + '写配置的是配置面，不是插件。因此本插件**拒绝**提供宿主侧的供应商/模型增删改。',
          }),
    })
  }

  out.push({
    surface: 'dsh-llm-service',
    owner: 'dsh-native',
    op: 'select',
    verdict: 'refused-by-policy',
    probe,
    evidence: [
      methodEvidence,
      '宿主里唯一会把「选中的模型」写进**部署默认值**的路径是 sessionController.selectModel → agentDefaultModel.saveSelection'
      + '（本插件已实测并在 llm-adapter 里装了闸门）。',
      'llm 服务自身没有「只影响下一次派发」的目录写入方法；prepareCall / stream 只接受 provider+model 作为**调用参数**。',
      '宿主契约原文：`catalog membership remains advisory and does not control request routing`'
      + ' —— 目录成员资格是建议性的，**不约束路由**。所以「受约束」这件事必须由我们自己做，不能指望宿主替我们拦。',
    ],
    refusal:
      '本插件**不用**宿主模型走 `sessionController.selectModel`：那会真的改写用户的部署默认模型。'
      + '宿主 llm 服务也没有「只改本次派发」的选择方法。因此 DSH 侧的模型选择只能由用户在该 DSH 自己的选择器里做，'
      + '本插件只提供**读取**与**候选项**，不提供写入。',
  })

  return out
}

// ═══════════════════ 2b. 能力探测：外部 CLI 自己的管理子命令 ═══════════════════

export interface AdminVerb {
  /** 动词（去掉参数与逗号后缀）。 */
  readonly verb: string
  /** 该行的参数部分（如 `[options] <url>`）。 */
  readonly args: string
  /** 该行的说明文字（逐字保留）。 */
  readonly description: string
  /** 原始整行（逐字保留，作证据）。 */
  readonly line: string
}

/** 会终止「子命令清单」小节的小节标题。 */
const SECTION_HEAD = /^(options|flags|global flags|arguments|description|usage|examples|documentation|aliases|notes)\b/i
/** 「子命令清单」的标题。 */
const COMMANDS_HEAD = /^(commands|subcommands)\b\s*:?\s*$/i
/** 打印帮助时**不产生副作用**的动词 —— 这些行不会进能力判定。 */
const HELP_VERBS = new Set(['help'])

/**
 * 从 `<cli> <sub> --help` 的输出里解析出**子命令清单**。
 *
 * 实测两种排布都要认：
 *   · commander 风格（kimi）：`Commands:` 之后是 `  add [options] <url>  Import every provider …`
 *   · yargs 风格（opencode）：`SUBCOMMANDS` 之后是 `  auth               manage AI providers and credentials`
 *
 * 解析不出来就返回空数组 —— **宁可空也不要编**（编出来的动词会直接变成「看起来能改」）。
 */
export function parseAdminVerbs(helpText: string): AdminVerb[] {
  const lines = helpText.split(/\r?\n/)
  const head = lines.findIndex((l) => COMMANDS_HEAD.test(l.trim()))
  if (head < 0) return []
  const out: AdminVerb[] = []
  for (const raw of lines.slice(head + 1)) {
    if (raw.trim().length === 0) {
      // 空行之后若已经收到过动词，就认为小节结束。
      if (out.length > 0) break
      continue
    }
    // 未缩进 = 新小节开始。
    if (!/^\s/.test(raw)) break
    const trimmed = raw.trim()
    if (SECTION_HEAD.test(trimmed)) break
    // 这类表格靠「两空格以上」分列：第一列是动词（+参数），其余列是说明。
    const fields = trimmed.split(/\s{2,}/).map((f) => f.trim()).filter((f) => f.length > 0)
    const headField = fields[0]
    if (headField === undefined) continue
    const tokens = headField.split(/\s+/)
    const verb = (tokens[0] ?? '').replace(/,$/, '')
    if (verb.length === 0 || HELP_VERBS.has(verb)) continue
    out.push({
      verb,
      args: tokens.slice(1).join(' '),
      description: fields.slice(1).join(' ').trim(),
      line: trimmed,
    })
  }
  return out
}

/** 一个动词是不是「凭据面」的动词（登录/登出/换账号/令牌）。 */
const CREDENTIAL_DESC = /credential|authenticat|\blog ?in\b|\blogout\b|sign ?in|token|api[\s-]?key|secret/i
const PROVIDER_NOUN = /providers?\b/i
const ADD_LIKE = /\badd\b|\bimport\b|\binstall\b|\bregister\b|\bcreate\b/i
const REMOVE_LIKE = /\bremove\b|\bdelete\b|\buninstall\b|\bdrop\b/i
const EDIT_LIKE = /\bedit\b|\bupdate\b|\brename\b|\bmodify\b|\bset\b/i

export interface HarnessAdminProbeInput {
  readonly harnessId: string
  /** 该 CLI 的供应商管理子命令（例如 `provider`）；null = 该 CLI 没有这样的子命令。 */
  readonly subcommand: string | null
  /** 帮助文本是怎么来的（argv，作证据）。 */
  readonly probeArgv: readonly string[]
  readonly helpText: string | null
  /** 帮助命令的退出码；非 0 且没有子命令清单时要如实说「探不出来」。 */
  readonly exitCode?: number | null
  /** 该 CLI 是否被实测确认有「配置目录隔离」开关。false ⇒ 执行会写用户真实配置，必须显式确认。 */
  readonly configDirIsolated: boolean
}

/**
 * 由**真实帮助文本**推出该 CLI 自己的供应商/模型管理能力。
 *
 * 判定纪律：
 *   · 动词必须出现在 `Commands`/`SUBCOMMANDS` 小节里、且说明文字里点到 provider，才算「供应商级」；
 *   · 说明里出现凭据词（credential/login/token/api key）的动词一律判 `refused-by-policy`
 *     —— 那是凭据面，本插件不代管凭据；
 *   · **模型级**动词必须有独立动词（`model`/`models`/`alias`）才算；
 *     说明里顺带提到 model 不算（实测例：kimi 的 `remove` 说明是
 *     "Remove a provider and every model alias that referenced it" —— 模型别名是**随供应商**
 *     一起被移除的，不是模型级能力。不这样区分就会凭空多出一个「能单独删模型」的假能力）。
 */
export function harnessCatalogCapabilities(input: HarnessAdminProbeInput): CatalogCapability[] {
  const argvText = input.probeArgv.length > 0 ? input.probeArgv.join(' ') : '(未执行)'
  const verbs = input.helpText === null ? [] : parseAdminVerbs(input.helpText)
  const verbList = verbs.map((v) => v.verb).join(', ')
  const evidenceHead = input.helpText === null
    ? '未执行任何管理子命令探测（该 CLI 未提供供应商管理子命令）⇒ 帮助文本为空。'
    : `执行 \`${argvText}\`（只读；退出码 ${String(input.exitCode ?? 'unknown')}），`
      + `从子命令清单小节解析出 ${verbs.length} 个动词：${verbList.length > 0 ? verbList : '(无)'}`
  const rawLines = verbs.map((v) => `逐字：${v.line}`)
  const probe = `真实执行 ${argvText} 并解析子命令清单${input.helpText === null ? '（未执行：该 CLI 没有管理子命令）' : ''}`

  const providerVerbs = verbs.filter((v) => PROVIDER_NOUN.test(v.description))
  const credentialVerbs = providerVerbs.filter((v) => CREDENTIAL_DESC.test(v.description))
  const catalogVerbs = providerVerbs.filter((v) => !CREDENTIAL_DESC.test(v.description))
  const addHit = catalogVerbs.find((v) => ADD_LIKE.test(v.description))
  const removeHit = catalogVerbs.find((v) => REMOVE_LIKE.test(v.description))
  const editHit = catalogVerbs.find((v) => EDIT_LIKE.test(v.description))
  const listHit = catalogVerbs.find((v) => /\blist\b|\bshow\b/i.test(v.description) || /^list$/i.test(v.verb))
  const modelVerb = verbs.find((v) => /^(models?|aliases?)$/i.test(v.verb))

  const base = {
    surface: 'harness-admin-command' as const,
    owner: 'harness-native' as const,
    probe,
    ...(input.subcommand === null ? {} : { argvPrefix: [input.subcommand] }),
    // 没有隔离开关 ⇒ 执行会写用户真实的 CLI 配置。结构化标注，别让执行侧去猜。
    ...(input.configDirIsolated ? {} : { sideEffect: 'writes-user-cli-config' as const }),
  }
  const out: CatalogCapability[] = []
  const verbText = verbList.length > 0 ? verbList : '(无)'
  const credentialNote = credentialVerbs.length > 0
    ? `该子命令下还有**凭据面**动词：${credentialVerbs.map((v) => v.verb).join(', ')}（逐字：${credentialVerbs.map((v) => v.line).join(' | ')}）。本插件不代管凭据。`
    : ''

  // ── 只读：list ──
  out.push({
    ...base,
    op: 'list',
    verdict: listHit !== undefined ? 'read-only' : (credentialVerbs.length > 0 ? 'refused-by-policy' : 'unsupported'),
    evidence: [evidenceHead, ...rawLines, ...(credentialNote.length > 0 ? [credentialNote] : [])],
    ...(listHit !== undefined
      ? { refusal: READ_ONLY_REFUSAL }
      : {
          refusal: credentialVerbs.length > 0
            ? `该 CLI 的供应商相关动词全在**凭据面**（${credentialVerbs.map((v) => v.verb).join(', ')}）—— 本插件不代管凭据，`
              + '因此不通过它的凭据面去列供应商/模型；该 CLI 的模型目录请走**发现层**（它自己的 `models` 类命令）。'
            : '该 CLI 的管理子命令清单里没有只读的列出动词 ⇒ 列不出来，不得编。',
        }),
  })

  // ── 增 / 删 / 改 供应商 ──
  out.push({
    ...base,
    op: 'add-provider',
    verdict: addHit !== undefined ? 'supported' : (credentialVerbs.length > 0 ? 'refused-by-policy' : 'unsupported'),
    evidence: [evidenceHead, ...rawLines],
    ...(addHit !== undefined
      ? {}
      : {
          refusal: credentialVerbs.length > 0
            ? `该 CLI 的供应商相关动词都在**凭据面**（${credentialVerbs.map((v) => v.verb).join(', ')}），本插件不代管凭据 ⇒ 拒绝。`
            : `该 CLI 的管理子命令清单里没有「新增/导入供应商」的动词（逐字见证据：${verbText}）⇒ 不支持。`,
        }),
  })
  out.push({
    ...base,
    op: 'remove-provider',
    verdict: removeHit !== undefined ? 'supported' : (credentialVerbs.length > 0 ? 'refused-by-policy' : 'unsupported'),
    evidence: [evidenceHead, ...rawLines],
    ...(removeHit !== undefined
      ? {}
      : {
          refusal: credentialVerbs.length > 0
            ? '该 CLI 的供应商相关动词都在**凭据面**，本插件不代管凭据 ⇒ 拒绝。'
            : `该 CLI 的管理子命令清单里没有「删除供应商」的动词（逐字见证据：${verbText}）⇒ 不支持。`,
        }),
  })
  out.push({
    ...base,
    op: 'edit-provider',
    verdict: editHit !== undefined ? 'supported' : 'unsupported',
    evidence: [evidenceHead, ...rawLines],
    ...(editHit !== undefined
      ? {}
      : { refusal: `该 CLI 的管理子命令清单里**没有**「编辑/更新供应商」的动词（逐字见证据：${verbText}）⇒ 不支持原地修改；只能先删后加（若删/加都在）。` }),
  })

  // ── 模型级（必须有独立动词才算，见函数头注释） ──
  const modelOps: { op: CatalogOp, like: RegExp }[] = [
    { op: 'add-model', like: ADD_LIKE },
    { op: 'remove-model', like: REMOVE_LIKE },
    { op: 'edit-model', like: EDIT_LIKE },
  ]
  for (const { op, like } of modelOps) {
    const hit = modelVerb !== undefined && like.test(modelVerb.description)
    out.push({
      ...base,
      op,
      verdict: hit ? 'supported' : 'unsupported',
      evidence: [
        evidenceHead,
        ...rawLines,
        modelVerb === undefined
          ? '子命令清单里没有模型级动词（只有供应商级动词）。'
          : `模型级动词「${modelVerb.verb}」的说明：${modelVerb.description}`,
      ],
      ...(hit
        ? {}
        : {
            refusal:
              '该 CLI **没有模型级的增删改动词**：模型是随供应商导入的别名（逐字证据见上），'
              + '所以本插件不提供「单独增/删/改一个模型」的操作 —— 那条路只能靠改供应商实现。',
          }),
    })
  }

  return out
}

// ═══════════════════ 2c. 能力探测：插件自己的声明层 ═══════════════════

export interface DeclaredAllowlistProbeInput {
  readonly accountId: string
  /** 真实写入路径的可读描述（例如 `poolExtras.update → updatePoolState → savePoolState`）。 */
  readonly writePath: string
  /** 在**纯内存副本**上跑一次 `{entry:{accountId, models:[…]}}` 之后，该条目落地了哪些字段名。 */
  readonly entryKeysAfterModelsPatch: readonly string[]
  /** 同一副本上再跑一次带 `providers` 的 patch 之后，该条目落地了哪些字段名。 */
  readonly entryKeysAfterProvidersPatch: readonly string[]
  /** 探针动作的逐字说明。 */
  readonly note: string
}

/**
 * 由**真实写入路径的行为**（在内存副本上跑的，不落盘）推出声明层的可编辑范围。
 *
 * 为什么必须做这个探测：如果不去写一次、只看类型声明，就会做出一个「能填供应商清单」的
 * 界面 —— 而那个字段写下去**没有任何读取方**，是被静默丢弃的。那正是「看起来能改」。
 */
export function declaredAllowlistCapabilities(input: DeclaredAllowlistProbeInput): CatalogCapability[] {
  const modelsLanded = input.entryKeysAfterModelsPatch.includes('models')
  const providersLanded = input.entryKeysAfterProvidersPatch.includes('providers')
  const keysText = (keys: readonly string[]): string => keys.length > 0 ? keys.join(', ') : '(该条目不存在)'
  const evidence = [
    `写入路径：${input.writePath}`,
    input.note,
    `带 models 的 patch 落地后的条目字段：${keysText(input.entryKeysAfterModelsPatch)}`,
    `带 providers 的 patch 落地后的条目字段：${keysText(input.entryKeysAfterProvidersPatch)}`,
  ]
  const base = {
    surface: 'plugin-declared-allowlist' as const,
    owner: 'harness-native' as const,
    probe: `在内存副本上真实跑一次 ${input.writePath}，观察落地字段`,
  }
  return [
    {
      ...base,
      op: 'declare-models',
      verdict: modelsLanded ? 'supported' : 'unsupported',
      evidence,
      ...(modelsLanded ? {} : { refusal: '实测该写入路径没有让 models 落地 ⇒ 不提供该编辑面。' }),
    },
    {
      ...base,
      op: 'add-provider',
      verdict: providersLanded ? 'supported' : 'unsupported',
      evidence,
      ...(providersLanded
        ? {}
        : {
            refusal:
              '实测：给该写入路径传 `providers` **不会落地任何字段**（落地字段清单里没有它），'
              + '也就是说写下去没有任何读取方。既然改了等于没改，本插件就**不提供**这一栏 —— '
              + '不做「看起来能改」的假输入框。（供应商层面的增删改请看 `harness-admin-command` 面：那才是真的。）',
          }),
    },
  ]
}

// ═══════════════════ 2d. 「去探哪个子命令」本身也要有依据 ═══════════════════

export interface AdminSubcommandHint {
  readonly subcommand: string | null
  /** 为什么是它 / 为什么**不去探** —— 逐字依据，直接进证据串。 */
  readonly evidence: string
}

/**
 * 该 Harness 的供应商管理子命令是什么。
 *
 * ⚠️ 这张表**只放已经实测过的东西**，而且**只影响「去探哪个子命令」**，不影响任何结论 ——
 * 结论永远由 `runHarnessAdminHelp` 的真实帮助文本算出来。这样即使表写错了，
 * 最坏也只是「探错地方 → 探不出动词 → 判 unsupported」，**不会**凭空多出一个能力。
 *
 * 没有依据的 Harness 一律返回 `null` 并**不去探**：本机踩过的教训是「负结果与猜错无法区分」，
 * 猜一个子命令去跑，跑出来的空结果会被误当成「该 CLI 没有这个能力」。
 */
export function adminSubcommandFor(harnessId: string): AdminSubcommandHint {
  switch (harnessId) {
    case 'kimi':
      return {
        subcommand: 'provider',
        evidence: '实测 `kimi --help` 的 Commands 段有 `provider  Manage LLM providers non-interactively.`',
      }
    case 'opencode':
      return {
        subcommand: 'auth',
        evidence: '实测 `opencode --help` 的 SUBCOMMANDS 段有 `auth  manage AI providers and credentials`'
          + '（凭据面；分类器会把目录级操作判 refused-by-policy）。',
      }
    case 'mimo':
      return {
        subcommand: null,
        evidence: '既有实测结论：`mimo providers` 是 `auth` 的**别名**且会管理凭据，为免打印或提示凭据材料**未执行** ⇒ 不去探。',
      }
    default:
      return {
        subcommand: null,
        evidence: '该 Harness 没有已知的供应商管理子命令；没有依据就不去探（负结果与猜错无法区分）。',
      }
  }
}

export interface AdminHelpResult {
  readonly argv: readonly string[]
  readonly code: number | null
  readonly text: string
  readonly error?: string
}

/**
 * 跑一次该 CLI 的**只读**管理子命令帮助（`<entry> <sub> --help`）。
 *
 * 为什么这个可以放在本模块里、而**写**命令不行：`--help` 不产生任何副作用、不消耗额度、
 * 不碰凭据。真正的写命令一律通过 {@link CatalogEditExecutors.runHarnessAdminCommand}
 * 由调用方注入 —— 本模块不会自己去执行会改用户环境的命令。
 */
export function runHarnessAdminHelp(
  entry: string,
  subcommand: string,
  options: { readonly timeoutMs?: number, readonly wrapping?: string } = {},
): Promise<AdminHelpResult> {
  const argv = [subcommand, '--help']
  return new Promise<AdminHelpResult>((resolve) => {
    const inv = resolveInvocation(entry, argv, options.wrapping ?? 'none')
    execFile(
      inv.file,
      inv.argv,
      {
        timeout: options.timeoutMs ?? 30_000,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
        windowsHide: true,
        maxBuffer: 8 << 20,
      },
      (error, stdout, stderr) => {
        // 合并 stdout+stderr：实测这两种 CLI 都打在 stdout，但别赌 —— 与发现层同一个口径。
        const text = `${stdout ?? ''}\n${stderr ?? ''}`
        const code = error === null || error === undefined
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : null
        resolve({
          argv: inv.argv,
          code,
          text,
          ...(error === null || error === undefined
            ? {}
            : { error: String((error as { message?: string }).message ?? error).slice(0, 200) }),
        })
      },
    )
  })
}

// ═══════════════════ 3. 受约束选择 ═══════════════════

/** 一个**来自真实发现**的候选项。`owner` 必须如实标注，跨 owner 使用一律拒绝。 */
export interface CatalogCandidate {
  readonly id: string
  readonly owner: CatalogOwner
  readonly availability: Availability
  readonly evidence?: string
  /** 该候选项属于哪个 harness（`dsh-native` 侧用 `'__dsh__'`）。 */
  readonly harnessId: string
}

/** 四态排序（与 federation/types.ts 的 Availability 一致）：不得跳级宣称。 */
const AVAILABILITY_RANK: Record<Availability, number> = {
  unavailable: 0,
  configured: 1,
  discoverable: 2,
  'auth-valid': 3,
  usable: 4,
}

export interface CatalogInventoryLike {
  readonly harnessId: string
  readonly discovered: readonly { readonly id: string, readonly availability: Availability, readonly evidence?: string }[]
  readonly dshNative?: readonly {
    readonly id: string
    readonly models: readonly { readonly id: string, readonly availability: Availability, readonly evidence?: string }[]
  }[]
}

/**
 * 把一次四态发现的结果摊成**受约束选择的候选清单**。
 *
 * 关键：`dshNative` 出来的候选项 owner 一律是 `dsh-native`，外部 harness 的一律是
 * `harness-native` —— 这是「不冒充」在数据结构上的落点。两边**永远不会**进同一个 owner。
 */
export function candidatesFromInventory(inventory: CatalogInventoryLike): CatalogCandidate[] {
  const out: CatalogCandidate[] = []
  for (const m of inventory.discovered) {
    out.push({
      id: m.id,
      owner: 'harness-native',
      availability: m.availability,
      harnessId: inventory.harnessId,
      ...(m.evidence === undefined ? {} : { evidence: m.evidence }),
    })
  }
  for (const p of inventory.dshNative ?? []) {
    for (const m of p.models) {
      out.push({
        id: `${p.id}/${m.id}`,
        owner: 'dsh-native',
        availability: m.availability,
        harnessId: '__dsh__',
        evidence: m.evidence ?? `DSH 本 profile 的供应商 ${p.id}`,
      })
    }
  }
  return out
}

export interface SelectionRequest {
  /** 本次选择要落在哪个面上。它决定**只允许**哪个 owner 的候选项。 */
  readonly surface: CatalogOwner
  /** 该面上的 harness（用于提示与证据；`dsh-native` 面传 `'__dsh__'`）。 */
  readonly harnessId: string
  readonly requested: string
  readonly candidates: readonly CatalogCandidate[]
  /** 是否允许「目录里没有」的手填值。**默认 false**。打开时结果一定被标成未验证。 */
  readonly allowUnlisted?: boolean
  /** 最低可用性门槛，默认 `discoverable`（「列得出来」）。 */
  readonly minAvailability?: Availability
}

export type SelectionOutcome =
  | {
      readonly ok: true
      readonly value: string
      readonly owner: CatalogOwner
      /** `catalog` = 来自真实发现；`unlisted-manual` = 调用方显式允许的手填值（未验证）。 */
      readonly origin: 'catalog' | 'unlisted-manual'
      readonly availability: Availability
      readonly evidence: string
      readonly warnings: readonly string[]
    }
  | {
      readonly ok: false
      readonly owner: CatalogOwner
      readonly reason: string
      /** 目录里最接近的几个 id（给用户选，而不是让他继续瞎填）。 */
      readonly suggestions: readonly string[]
    }

/** 只做前缀 / 子串匹配的简单建议，**不做**花哨的相似度（宁可少给也不要给错）。 */
function suggest(requested: string, pool: readonly CatalogCandidate[]): string[] {
  const needle = requested.toLowerCase()
  const head = needle.split(/[/:]/)[0] ?? needle
  const scored: { id: string, score: number }[] = []
  for (const c of pool) {
    const id = c.id.toLowerCase()
    let score = 0
    if (id === needle) score = 100
    else if (id.startsWith(needle)) score = 80
    else if (id.includes(needle)) score = 60
    else if (head.length > 2 && id.includes(head)) score = 40
    else if (id.length > 3 && needle.includes(id)) score = 20
    if (score > 0) scored.push({ id: c.id, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5).map((s) => s.id)
}

/**
 * 受约束选择。**这是全部入口唯一允许的选择判定实现**（多入口一致性靠这一点）。
 *
 * 判定顺序（每一步拒绝都给出理由与候选项）：
 *   ① 空值 → 拒绝；
 *   ② **owner 不匹配** → 拒绝（这是「不得冒充」的执行点）；
 *   ③ 在目录里 → 检查四态门槛，够就通过（证据来自发现结果）；
 *   ④ 不在目录里 → `allowUnlisted` 未打开就拒绝 + 给建议；打开了才通过，并**标注未验证**。
 */
export function resolveCatalogSelection(request: SelectionRequest): SelectionOutcome {
  const owner = request.surface
  const requested = request.requested.trim()
  const mine = request.candidates.filter((c) => c.owner === owner)
  const theirs = request.candidates.filter((c) => c.owner !== owner)

  if (requested.length === 0) {
    return {
      ok: false,
      owner,
      reason: '没有给出要选的模型/供应商 id。禁止用「空值」表示「用默认的」—— 那会让界面上看起来选了什么、实际什么都没选。',
      suggestions: mine.slice(0, 5).map((c) => c.id),
    }
  }

  const hit = mine.find((c) => c.id === requested)
  if (hit === undefined) {
    // ② 是不是拿错了另一边的目录？
    const foreign = theirs.find((c) => c.id === requested)
    if (foreign !== undefined) {
      return {
        ok: false,
        owner,
        reason:
          `「${requested}」属于**另一边**的目录（owner=${foreign.owner}，harness=${foreign.harnessId}），`
          + `而本次选择面是 owner=${owner}（harness=${request.harnessId}）。`
          + 'DSH 本 profile 的供应商/模型与外部 CLI 的供应商/模型是两份互不相干的东西，**不得互相冒充**：'
          + '把 DSH 的列表当外部 CLI 的列表（或反过来）是缺陷，不是便利。',
        suggestions: mine.slice(0, 5).map((c) => c.id),
      }
    }
  }

  const minAvailability = request.minAvailability ?? 'discoverable'
  if (hit !== undefined) {
    if (AVAILABILITY_RANK[hit.availability] < AVAILABILITY_RANK[minAvailability]) {
      return {
        ok: false,
        owner,
        reason:
          `「${requested}」确实在该 harness 自己的目录里，但它的可用性是 **${hit.availability}**，`
          + `低于本次要求的下限 **${minAvailability}**。四态是**有序**的（configured < discoverable < auth-valid < usable），`
          + '不得跳级宣称 —— 列得出来不等于凭据被接受，凭据被接受也不等于真实跑通过一次。',
        suggestions: mine.slice(0, 5).map((c) => c.id),
      }
    }
    return {
      ok: true,
      value: hit.id,
      owner,
      origin: 'catalog',
      availability: hit.availability,
      evidence: hit.evidence ?? '(该候选项没有带证据串 —— 这是缺陷)',
      warnings: [],
    }
  }

  if (request.allowUnlisted !== true) {
    return {
      ok: false,
      owner,
      reason:
        `「${requested}」**不在**该 harness 的真实发现结果里（owner=${owner}，harness=${request.harnessId}，`
        + `目录里共 ${mine.length} 项）。受约束选择要求从真实目录出发；`
        + '确实要手填一个目录里没有的值，必须由调用方显式打开 allowUnlisted。',
      suggestions: suggest(requested, mine),
    }
  }

  return {
    ok: true,
    value: requested,
    owner,
    origin: 'unlisted-manual',
    availability: 'unavailable',
    evidence: `调用方显式允许未列出的手填值；该值**未被任何发现证据支持**（目录里共 ${mine.length} 项，不含它）`,
    warnings: [
      '⚠️ 这个值是**手填**的，目录里没有它：它没有「已配置 / 可发现 / 认证有效 / 实际可用」里的任何一态证据。'
      + '**不得**把它显示成可用；真实能否跑通只能看派发后的独立核验结果。',
    ],
  }
}

// ═══════════════════ 4. `actual` 真实核验 ═══════════════════

export type ActualEvidenceSource =
  /** 设置调用回执（ACP `session/set_config_option` 成功之类）。**永远不算证明**。 */
  | 'setter-ack'
  /** 独立回读该 harness 自己的目录（`--list-models` / `models`）。能证伪，不能证明「被采用」。 */
  | 'catalog-read'
  /** 派发身份回报。只有 `substitutedFromRequest !== true` 时才算独立观测。 */
  | 'dispatch-identity'
  /** 该 harness 自己的原生会话记录（落盘日志等）。最强的独立来源。 */
  | 'native-session-log'

export interface ActualEvidence {
  readonly source: ActualEvidenceSource
  /** 观测到的值；没观测到就留空。 */
  readonly observed?: string
  /** `catalog-read` 专有：该 harness 自己的目录里到底有没有请求的这个 id。 */
  readonly listed?: boolean
  readonly detail?: string
  /**
   * **关键标志**：该证据是不是「把请求值抄过来的」。
   *
   * 实测依据：`sessions.ts` 的 `foldOutcomeIdentity()` 在通道没有明确报「换模型失败」时
   * 直接写 `actualModel = requestedModel` —— 也就是说项目里的 `actual.model` 在多数路径上
   * 就是请求值的副本。凡是从那条路径来的证据，调用方**必须**标 true，否则本模块会把它
   * 当成独立观测，那就等于用请求值给自己背书。
   */
  readonly substitutedFromRequest?: boolean
}

export type ActualVerdictKind = 'proven' | 'mismatch' | 'unproven' | 'not-observed'

export interface ActualVerdict {
  readonly verdict: ActualVerdictKind
  /** 只有 `proven` 才为 true。 */
  readonly proven: boolean
  readonly requested: string
  /** 独立观测到的值（可能 ≠ 请求值）；没有独立观测则 undefined。 */
  readonly observed?: string
  /** 判定所依据的那一条来源；没有则 undefined。 */
  readonly reliedOn?: ActualEvidenceSource
  /** 被**刻意排除**的证据及理由（含 `setter-ack` 与「抄请求值」的证据）。 */
  readonly excluded: readonly { readonly source: ActualEvidenceSource, readonly reason: string }[]
  /** 人话结论。**必须**能直接展示。 */
  readonly reason: string
}

const SETTER_ACK_REASON =
  '「设置调用成功了」不是「该模型被采用了」的证据。本机实测反例：ACP 的 `session/set_config_option` '
  + '对**不存在的模型 id 也会成功**（请求一个瞎编的模型 → 该调用成功 → 随后 harness 以 refusal 结束本轮）。'
  + '所以这类回执一律排除。'

const SUBSTITUTED_REASON =
  '该证据是**把请求值抄过来的**（sessions.ts 的 foldOutcomeIdentity 在通道未明确报失败时直接写 '
  + '`actualModel = requestedModel`）—— 用请求值给请求值背书等于没核验，一律排除。'

/**
 * `actual` 真实核验。**纯函数**、可离线单测。
 *
 * 判定（独立观测优先）：
 *   ① 有 `native-session-log` / 未做替换的 `dispatch-identity`：
 *      与请求值一致 → `proven`；不一致 → `mismatch`（并回报观测到的值）；
 *   ② 只有 `catalog-read`：`listed === false` → `mismatch`（目录里根本没有这个 id，不可能被采用）；
 *      `listed === true` → `unproven`（「列得出来」只说明它存在，不说明本轮用了它）；
 *   ③ 只有被排除的证据 → `unproven`；一条都没有 → `not-observed`。
 */
export function verifyActualSelection(input: {
  readonly requested: string
  readonly evidences: readonly ActualEvidence[]
}): ActualVerdict {
  const requested = input.requested.trim()
  const excluded: { source: ActualEvidenceSource, reason: string }[] = []
  const usable: ActualEvidence[] = []
  for (const e of input.evidences) {
    if (e.source === 'setter-ack') {
      excluded.push({ source: e.source, reason: SETTER_ACK_REASON })
      continue
    }
    if (e.substitutedFromRequest === true) {
      excluded.push({ source: e.source, reason: SUBSTITUTED_REASON })
      continue
    }
    usable.push(e)
  }

  const strongest = (['native-session-log', 'dispatch-identity'] as const)
    .map((s) => usable.find((e) => e.source === s))
    .find((e) => e !== undefined)
  if (strongest !== undefined && strongest.observed !== undefined && strongest.observed.length > 0) {
    if (strongest.observed === requested) {
      return {
        verdict: 'proven',
        proven: true,
        requested,
        observed: strongest.observed,
        reliedOn: strongest.source,
        excluded,
        reason: `独立观测（${strongest.source}）与请求值一致：实际采用的模型就是「${requested}」。`
          + (strongest.detail === undefined ? '' : ` 观测说明：${strongest.detail}`),
      }
    }
    return {
      verdict: 'mismatch',
      proven: false,
      requested,
      observed: strongest.observed,
      reliedOn: strongest.source,
      excluded,
      reason: `⚠️ 请求「${requested}」，但独立观测（${strongest.source}）看到的实际值是「${strongest.observed}」`
        + ' —— 配置值 ≠ 实际值，**不得**按请求值记。'
        + (strongest.detail === undefined ? '' : ` 观测说明：${strongest.detail}`),
    }
  }

  const catalogRead = usable.find((e) => e.source === 'catalog-read')
  if (catalogRead !== undefined && catalogRead.listed === false) {
    return {
      verdict: 'mismatch',
      proven: false,
      requested,
      reliedOn: 'catalog-read',
      excluded,
      reason: `该 harness **自己的目录里没有**「${requested}」这个 id ⇒ 它不可能被本轮采用。`
        + '这条是否定证据（目录成员资格可以证伪）；但它**不能**反过来证明「被采用了」。',
    }
  }
  if (catalogRead !== undefined && catalogRead.listed === true) {
    return {
      verdict: 'unproven',
      proven: false,
      requested,
      reliedOn: 'catalog-read',
      excluded,
      reason: `「${requested}」确实在该 harness 自己的目录里（可发现），但**目录成员资格不证明本轮采用了它** —— `
        + '缺一条独立观测（harness 自己的会话记录 / 未做替换的身份回报），所以判「未证实」，不判「一致」。',
    }
  }

  if (excluded.length > 0) {
    return {
      verdict: 'unproven',
      proven: false,
      requested,
      excluded,
      reason: `只拿到被排除的证据（${excluded.map((e) => e.source).join(', ')}）：没有任何独立观测，`
        + '**不得**把请求值当作实际值。',
    }
  }
  return {
    verdict: 'not-observed',
    proven: false,
    requested,
    excluded,
    reason: '一条证据都没有：实际采用值**未被观测**。这既不是「一致」也不是「不一致」，只允许显示为「未观测」。',
  }
}

// ═══════════════════ 5. 可编辑操作：计划 / 执行 / 落地核验 ═══════════════════

export interface DeclaredModelsPatch {
  readonly accountId: string
  readonly models: readonly string[]
}

export interface CatalogEditRequest {
  readonly op: CatalogOp
  readonly harnessId: string
  readonly accountId?: string
  readonly providerId?: string
  readonly models?: readonly string[]
  /** 真实发现的候选（受约束选择用）。 */
  readonly candidates: readonly CatalogCandidate[]
  /** 能力探测结果（决定这一操作到底能不能做）。 */
  readonly capabilities: readonly CatalogCapability[]
  /** 之前声明的清单（用于算出增/删/改的差）。 */
  readonly currentDeclared?: readonly string[]
  /** `add-provider` 的 registry url（实测例：`kimi provider add <url>` 需要一个 api.json）。 */
  readonly registryUrl?: string
  /** 显式允许目录里没有的手填值。默认 false。 */
  readonly allowUnlisted?: boolean
  /** 显式确认「已知会写用户真实的 CLI 配置」。默认 false。 */
  readonly confirmWritesUserConfig?: boolean
}

export interface CatalogEditPlan {
  readonly ok: true
  readonly op: CatalogOp
  readonly surface: CatalogSurfaceId
  /** 该操作会跑的命令（若有）。**计划阶段绝不执行**。 */
  readonly argv?: readonly string[]
  /** 该操作会写的状态补丁（若有）。 */
  readonly patch?: DeclaredModelsPatch
  /** 逐条写清「改了之后**哪里**会跟着变」——不许含糊。 */
  readonly effects: readonly string[]
  /** 逐条写清「改完怎么核验」，必须是**独立来源**的回读。 */
  readonly verification: readonly string[]
  readonly warnings: readonly string[]
  readonly declaredOrigin: readonly { readonly id: string, readonly origin: 'catalog' | 'unlisted-manual' }[]
}

export interface CatalogEditRefusal {
  readonly ok: false
  readonly op: CatalogOp
  readonly surface: CatalogSurfaceId
  readonly verdict: CapabilityVerdict
  /** 显式拒绝理由（可直接展示）。 */
  readonly reason: string
  readonly evidence: readonly string[]
  readonly suggestions: readonly string[]
}

const EFFECT_DECLARED_MODELS = [
  '自动切换的**切换前验证**：index.ts 的 verifyTarget 读 `poolState.entries[accountId].models`',
  ' → autoswitch.ts 的 judgeTargetVerification()：请求的模型不在该清单里时**拒绝切换**（"绝不静默换模型"）。',
  '手动切换判定：poolconfig.ts 的 planManualSwitch() 用它算 modelPreserved，决定是否显示「模型会改变」的警告。',
]
const VERIFY_DECLARED_MODELS = [
  '独立回读落盘的 account-pool.json（**不用**写入函数的返回值 —— 那等于自己给自己背书）。',
  '从每个出口各回读一次（落盘文件 / GET /pool / 任何新增出口），**逐出口**比对；某个出口表达不了这个字段，'
  + '要如实记为「该出口为盲」而不是「一致」。',
]

/**
 * 计划一次目录编辑。**纯函数，不执行任何东西**（执行见 {@link executeCatalogEdit}）。
 *
 * 每一个分支都先查能力判定：没探到 `supported` 就返回 {@link CatalogEditRefusal}，
 * 绝不返回一个「计划好了但落不了地」的东西。
 */
export function planCatalogEdit(request: CatalogEditRequest): CatalogEditPlan | CatalogEditRefusal {
  const refuse = (
    surface: CatalogSurfaceId,
    verdict: CapabilityVerdict,
    reason: string,
    evidence: readonly string[] = [],
    suggestions: readonly string[] = [],
  ): CatalogEditRefusal => ({ ok: false, op: request.op, surface, verdict, reason, evidence, suggestions })

  const adminOp = (['add-provider', 'remove-provider', 'edit-provider', 'add-model', 'remove-model', 'edit-model'] as CatalogOp[])
    .includes(request.op)

  if (request.op === 'declare-models') {
    const cap = capabilityOf(request.capabilities, 'declare-models', 'plugin-declared-allowlist')
    if (cap === undefined || cap.verdict !== 'supported') {
      return refuse(
        'plugin-declared-allowlist',
        cap?.verdict ?? 'unsupported',
        cap?.refusal ?? '没有对「声明层」做过写入路径探测 ⇒ 不许做（缺探测不是「大概可以」）。',
        cap?.evidence ?? [],
      )
    }
    const accountId = request.accountId ?? ''
    if (accountId.length === 0) {
      return refuse('plugin-declared-allowlist', 'unsupported', 'declare-models 必须给出 accountId：声明是**按账号**的，没有账号就没有落点。')
    }
    const models = request.models ?? []
    const declaredOrigin: { id: string, origin: 'catalog' | 'unlisted-manual' }[] = []
    const warnings: string[] = []
    for (const m of models) {
      const outcome = resolveCatalogSelection({
        surface: 'harness-native',
        harnessId: request.harnessId,
        requested: m,
        candidates: request.candidates,
        allowUnlisted: request.allowUnlisted === true,
        // 声明层是「用户显式声明」，门槛放到 configured：允许声明一个只出现在原生配置里的模型。
        minAvailability: 'configured',
      })
      if (!outcome.ok) return refuse('plugin-declared-allowlist', cap.verdict, outcome.reason, cap.evidence, outcome.suggestions)
      declaredOrigin.push({ id: outcome.value, origin: outcome.origin })
      warnings.push(...outcome.warnings.map((w) => `${outcome.value}: ${w}`))
    }
    const before = request.currentDeclared ?? []
    const added = models.filter((m) => !before.includes(m))
    const removed = before.filter((m) => !models.includes(m))
    return {
      ok: true,
      op: 'declare-models',
      surface: 'plugin-declared-allowlist',
      patch: { accountId, models },
      effects: EFFECT_DECLARED_MODELS,
      verification: VERIFY_DECLARED_MODELS,
      warnings: [
        ...warnings,
        '这份清单是**用户显式声明**的东西，不是发现的结论：它不会让一个模型变得可用，只会让闸门按它判定。'
        + '真实的「有没有这个模型、能不能用」永远看发现层与派发后的独立核验。',
        ...(models.length === 0
          ? [
              '空清单的语义是「**取消声明**」（该字段会被写入路径整条丢弃），不是「声明了一个空集」。',
              '实测（本机活宿主）：HTTP 写入口对 `models: null` 会**静默忽略** —— 它只在 `Array.isArray(models)` 时才把字段放进 patch，'
              + '所以 `null` 根本到不了写入函数；要清空必须传 `[]`。这条差异写在这里，免得调用方以为「传 null 就清掉了」。',
            ]
          : []),
        `本次实际变化：新增 ${added.length} 项（${added.join(', ') || '无'}）；移除 ${removed.length} 项（${removed.join(', ') || '无'}）。`,
      ],
      declaredOrigin,
    }
  }

  if (adminOp) {
    const cap = capabilityOf(request.capabilities, request.op, 'harness-admin-command')
    if (cap === undefined || cap.verdict !== 'supported') {
      return refuse(
        'harness-admin-command',
        cap?.verdict ?? 'unsupported',
        cap?.refusal ?? `没有对该 CLI 的管理子命令做过探测 ⇒ 不许做「${request.op}」（缺探测不是「大概可以」）。`,
        cap?.evidence ?? [],
      )
    }
    // 结构化副作用门禁：会写用户真实 CLI 配置的操作必须被显式确认。
    if (cap.sideEffect === 'writes-user-cli-config' && request.confirmWritesUserConfig !== true) {
      return refuse(
        'harness-admin-command',
        'refused-by-policy',
        `该 CLI 没有实测确认的配置目录隔离开关：执行「${request.op}」会写进**用户真实的** CLI 配置，`
        + '而且没有可复现的回滚方式。因此本插件要求调用方显式确认（confirmWritesUserConfig=true）才继续；'
        + '默认一律拒绝，而不是替你静默改掉用户的环境。',
        cap.evidence,
      )
    }
    const prefix = cap.argvPrefix ?? []
    const effectsCommand = [
      '该 CLI 会改**它自己的**供应商/模型配置（不是 DSH 的）。',
      '该 CLI 自己的只读列表命令（发现层用的同一条）会跟着变 —— 这就是「改完能核验」的独立出口。',
    ]
    if (request.op === 'add-provider') {
      const url = request.registryUrl?.trim() ?? ''
      if (url.length === 0) {
        return refuse(
          'harness-admin-command',
          'unsupported',
          '该 CLI 的「新增供应商」需要一个 registry（`api.json`）地址：它的语义是「导入该 registry 里列出的每一个供应商」，'
          + '不是逐条手填。没有地址就没有可执行的动作，因此拒绝。',
          cap.evidence,
        )
      }
      return {
        ok: true,
        op: request.op,
        surface: 'harness-admin-command',
        argv: [...prefix, 'add', url],
        effects: effectsCommand,
        verification: [
          '独立回读：跑该 CLI 自己的只读列表命令（发现层用的同一条），确认新增的供应商/模型真的出现了。',
          'argv 里**绝不**带任何凭据参数（例如 `--api-key`）：本插件不代管凭据。',
        ],
        warnings: ['⚠️ 这会写用户真实的 CLI 配置（该 CLI 没有实测确认的配置目录隔离开关）。回滚只能靠该 CLI 自己的反向命令。'],
        declaredOrigin: [],
      }
    }
    if (request.op === 'remove-provider') {
      const id = request.providerId?.trim() ?? ''
      if (id.length === 0) {
        return refuse('harness-admin-command', 'unsupported', 'remove-provider 必须给出 providerId（该 CLI 的 `remove <providerId>` 需要一个 id）。', cap.evidence)
      }
      return {
        ok: true,
        op: request.op,
        surface: 'harness-admin-command',
        argv: [...prefix, 'remove', id],
        effects: [
          ...effectsCommand,
          '影响范围**大于**「删一个供应商」：该 CLI 的说明写着它会连同**所有引用它的模型别名**一起移除。',
        ],
        verification: ['独立回读该 CLI 自己的只读列表命令，确认该供应商与它的模型别名都消失了。'],
        warnings: ['⚠️ 同上：这会写用户真实的 CLI 配置。'],
        declaredOrigin: [],
      }
    }
    return refuse(
      'harness-admin-command',
      'unsupported',
      `能力判定说「${request.op}」在这个 CLI 上不支持，计划阶段不会绕过它（没有已探到的动词就不拼命令）。`,
      cap.evidence,
    )
  }

  return refuse(
    'dsh-llm-service',
    'unsupported',
    `本模块不处理操作「${request.op}」：读取与选择见 resolveCatalogSelection，宿主侧写入一律拒绝（见 dshCatalogCapabilities）。`,
  )
}

/** 一次落地核验：**每个出口各回读一次**，并如实标出「表达不了这个字段」的出口。 */
export interface DeclaredModelsReadback {
  readonly entrance: string
  /** 该出口读到的值；`undefined` = 该出口**表达不了**这个字段（盲）。 */
  readonly models?: readonly string[]
}

export interface DeclaredModelsVerification {
  readonly accountId: string
  readonly requested: readonly string[]
  readonly verdict: 'applied' | 'not-applied' | 'unverified' | 'consistent'
  readonly readbacks: readonly { readonly entrance: string, readonly value: string, readonly matches: boolean | null }[]
  /** 表达不了该字段的出口 —— 必须单独列出来，不能被算成「一致」。 */
  readonly blindEntrances: readonly string[]
  readonly reason: string
}

/** 声明的**落地**核验（与「模型是否真的服务了本轮」是两件事，别混）。 */
export function verifyDeclaredModelsApplied(input: {
  readonly accountId: string
  readonly requested: readonly string[]
  readonly readbacks: readonly DeclaredModelsReadback[]
}): DeclaredModelsVerification {
  const blind: string[] = []
  const rows: { entrance: string, value: string, matches: boolean | null }[] = []
  let anyIndependent = false
  let anyMismatch = false
  for (const rb of input.readbacks) {
    if (rb.models === undefined) {
      blind.push(rb.entrance)
      rows.push({ entrance: rb.entrance, value: '(该出口没有这个字段 —— 盲)', matches: null })
      continue
    }
    anyIndependent = true
    const same = rb.models.length === input.requested.length && rb.models.every((m) => input.requested.includes(m))
    if (!same) anyMismatch = true
    rows.push({ entrance: rb.entrance, value: rb.models.length === 0 ? '(空)' : rb.models.join(', '), matches: same })
  }
  if (!anyIndependent) {
    return {
      accountId: input.accountId,
      requested: input.requested,
      verdict: 'unverified',
      readbacks: rows,
      blindEntrances: blind,
      reason: '没有任何出口能读到这份声明 ⇒ **未核验**（不是「已生效」，也不是「没生效」）。'
        + (blind.length > 0 ? `表达不了该字段的出口：${blind.join('、')} —— 这些出口对「声明了什么模型」是**盲的**。` : ''),
    }
  }
  if (anyMismatch) {
    return {
      accountId: input.accountId,
      requested: input.requested,
      verdict: 'not-applied',
      readbacks: rows,
      blindEntrances: blind,
      reason: '至少一个出口回读到的清单与请求的不一致 ⇒ 落地**不完整或未落地**，按「没改成功」处理。',
    }
  }
  return {
    accountId: input.accountId,
    requested: input.requested,
    verdict: blind.length > 0 ? 'applied' : 'consistent',
    readbacks: rows,
    blindEntrances: blind,
    reason: '所有**能表达该字段**的出口回读一致 ⇒ 声明已落地。'
      + (blind.length > 0
        ? `注意：仍有 ${blind.length} 个出口表达不了这个字段（${blind.join('、')}）—— 那些出口上「看不到」不等于「没生效」，`
          + '但也不能算作「一致」，必须单独修或单独标注。'
        : ''),
  }
}

/** 执行器：**由调用方注入**。模块自己不 spawn 会写用户配置的命令。 */
export interface CatalogEditExecutors {
  /** 写入账号池的声明清单（index.ts 注入：updatePoolState + savePoolState 那一处）。 */
  readonly applyDeclaredModels?: (patch: DeclaredModelsPatch) => Promise<{ readonly ok: boolean, readonly error?: string }>
  /** **独立**回读落盘声明（不要复用写入路径的返回值）。 */
  readonly readDeclaredModels?: (accountId: string) => Promise<readonly string[] | undefined>
  /** 其它出口的回读（例如 `GET /pool` 的 HTTP 出口）；返回 undefined = 该出口表达不了这个字段。 */
  readonly readDeclaredModelsFromEntrance?: (entrance: string, accountId: string) => Promise<readonly string[] | undefined>
  /** 跑该 CLI 自己的管理子命令（kimi provider add/remove 之类）。**未注入 = 该面不可执行**。 */
  readonly runHarnessAdminCommand?: (input: {
    readonly harnessId: string
    readonly entry: string
    readonly argv: readonly string[]
    readonly timeoutMs?: number
  }) => Promise<{ readonly code: number | null, readonly stdout: string, readonly stderr: string }>
}

export interface CatalogEditResult {
  readonly ok: boolean
  readonly op: CatalogOp
  readonly executed: boolean
  /** 执行后**独立**核验的结果；没执行则为 undefined。 */
  readonly verification?: DeclaredModelsVerification
  /** 该 CLI 管理命令的真实输出（若跑了）。 */
  readonly commandOutput?: { readonly code: number | null, readonly stdout: string, readonly stderr: string }
  readonly reason: string
  readonly warnings: readonly string[]
}

/**
 * 执行一次已经计划好的编辑，**并用独立来源核验落地**。
 *
 * 纪律：
 *   · 计划是拒绝的就绝不执行；
 *   · 没有注入对应执行器就拒绝（"组合里没接上" 不等于 "可以绕过"）；
 *   · `declare-models` 执行完必须回读（落盘 + 每个可注入的出口），并按
 *     {@link verifyDeclaredModelsApplied} 如实报「已落地 / 没落地 / 未核验 / 有出口是盲的」。
 */
export async function executeCatalogEdit(
  plan: CatalogEditPlan | CatalogEditRefusal,
  executors: CatalogEditExecutors,
  options: { readonly entrances?: readonly string[], readonly harnessEntry?: string, readonly timeoutMs?: number } = {},
): Promise<CatalogEditResult> {
  if (!plan.ok) {
    return {
      ok: false,
      op: plan.op,
      executed: false,
      reason: `已拒绝，未执行：${plan.reason}`,
      warnings: plan.evidence.slice(0, 4),
    }
  }
  if (plan.op === 'declare-models') {
    const patch = plan.patch
    if (patch === undefined) {
      return { ok: false, op: plan.op, executed: false, reason: '计划缺少 patch ⇒ 不执行（计划不完整就执行是缺陷）。', warnings: [] }
    }
    if (executors.applyDeclaredModels === undefined) {
      return {
        ok: false,
        op: plan.op,
        executed: false,
        reason: '本组合没有注入「写入账号池声明」的执行器 ⇒ 拒绝执行（不会自己去开一条绕过既有写入路径的口子）。',
        warnings: plan.warnings,
      }
    }
    const applied = await executors.applyDeclaredModels(patch)
    if (!applied.ok) {
      return {
        ok: false,
        op: plan.op,
        executed: false,
        reason: `写入失败：${applied.error ?? '未知原因'}（**没有**落地，不得按成功记）。`,
        warnings: plan.warnings,
      }
    }
    const readbacks: DeclaredModelsReadback[] = []
    if (executors.readDeclaredModels !== undefined) {
      readbacks.push({ entrance: '落盘 account-pool.json（独立回读）', models: await executors.readDeclaredModels(patch.accountId) })
    }
    for (const entrance of options.entrances ?? []) {
      if (executors.readDeclaredModelsFromEntrance === undefined) break
      readbacks.push({ entrance, models: await executors.readDeclaredModelsFromEntrance(entrance, patch.accountId) })
    }
    if (readbacks.length === 0) {
      return {
        ok: true,
        op: plan.op,
        executed: true,
        reason: '写入已完成，但**没有任何独立回读来源** ⇒ 落地状态未核验（不得声称已生效）。',
        warnings: [...plan.warnings, '请注入 readDeclaredModels：没有独立回读的写入等于没核验。'],
      }
    }
    const verification = verifyDeclaredModelsApplied({ accountId: patch.accountId, requested: patch.models, readbacks })
    return {
      ok: verification.verdict === 'applied' || verification.verdict === 'consistent',
      op: plan.op,
      executed: true,
      verification,
      reason: verification.reason,
      warnings: [...plan.warnings, ...(verification.blindEntrances.length === 0
        ? []
        : [`⚠️ 有 ${verification.blindEntrances.length} 个出口对「声明了什么模型」是盲的：${verification.blindEntrances.join('、')}`])],
    }
  }

  // 该 CLI 自己的管理子命令。
  if (plan.argv === undefined) {
    return { ok: false, op: plan.op, executed: false, reason: '计划里没有可执行 argv ⇒ 不执行。', warnings: plan.warnings }
  }
  if (executors.runHarnessAdminCommand === undefined) {
    return {
      ok: false,
      op: plan.op,
      executed: false,
      reason: '本组合没有注入「跑该 CLI 管理子命令」的执行器 ⇒ 拒绝执行。'
        + '本插件**不会**为了「看起来能改」而自己 spawn 一个会写用户 CLI 配置的命令。',
      warnings: plan.warnings,
    }
  }
  const entry = options.harnessEntry ?? ''
  if (entry.length === 0) {
    return { ok: false, op: plan.op, executed: false, reason: '没有解析到该 CLI 的真实入口 ⇒ 无法执行（也不该猜一个）。', warnings: plan.warnings }
  }
  const out = await executors.runHarnessAdminCommand({
    harnessId: plan.surface,
    entry,
    argv: plan.argv,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const ok = out.code === 0
  return {
    ok,
    op: plan.op,
    executed: true,
    commandOutput: out,
    reason: ok
      ? '该 CLI 自己的管理命令以 0 退出。**注意**：这仍然只是「命令回执」—— 是否真的改到了目录，'
        + '必须再跑一次该 CLI 自己的只读列表命令独立核验（见 plan.verification）。'
      : `该 CLI 自己的管理命令以非 0 退出码 ${String(out.code)} 结束 ⇒ **不得**按成功记。`,
    warnings: plan.warnings,
  }
}

// ═══════════════════ 6. 极小的本地回读工具 ═══════════════════

/**
 * 读一个 JSON 文件（只做**独立回读**用）。
 *
 * 之所以自己读文件而不复用写入路径的内存状态：写入函数返回的东西**不是**独立证据。
 * 只读前 1 MiB，够用且不会把大文件整个拉进内存。
 */
export function readJsonHead(file: string, bytes = 1 << 20): unknown {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** 从落盘状态里回读某个账号的声明模型清单（独立于写入路径）。 */
export function readDeclaredModelsFromFile(file: string, accountId: string): readonly string[] | undefined {
  const parsed = readJsonHead(file)
  if (parsed === null || typeof parsed !== 'object') return undefined
  const entries = (parsed as { entries?: unknown }).entries
  if (entries === null || typeof entries !== 'object') return undefined
  const entry = (entries as Record<string, unknown>)[accountId]
  if (entry === null || typeof entry !== 'object') return undefined
  const models = (entry as { models?: unknown }).models
  if (!Array.isArray(models)) return undefined
  return models.map((m) => String(m))
}
