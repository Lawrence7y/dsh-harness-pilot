/**
 * 账号档案（P2）：同一 Harness 的多个账号、国内/国际并存、隔离披露与切换语义。
 *
 * ## 不可越过的边界（用户明确要求，写进代码而不是只写进文档）
 * - **绝不读取、导出、复制任何令牌或未解密凭据**。身份只用 CLI 自己**只读**报出来的
 *   稳定标识，并立即降为不可逆指纹（sha256 前 12 位）。
 * - **绝不关闭加密保护**，也不把凭据从厂商原生存储里搬走。
 * - **绝不把「登录成功」「身份可读」「模型请求认证有效」混为一谈** —— 三态分开存、分开显示。
 * - **绝不在配置或日志里明文保存令牌**。本模块不写任何凭据，只写指纹与结论。
 *
 * ## 隔离披露必须如实
 * 本机实测（见 `docs/verified/harness-probe.json`）：
 *   ✅ `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `PI_CODING_AGENT_DIR` 确实能把 CLI 切到登出态
 *   ✅ `QODERCN_CONFIG_DIR`（本模块用 CLI 的 `--config-dir`）实测两个账号身份不同
 *   ❌ opencode 试了 5 个开关（XDG_CONFIG_HOME / XDG_DATA_HOME / OPENCODE_CONFIG /
 *      OPENCODE_CONFIG_DIR / OPENCODE_DB）**全部无效** → 必须标「未隔离」，不得假装支持
 *   ⚠️ WorkBuddy / WorkBuddy.AI：**配置目录隔离，但认证槽位是厂商共享的**
 *      （`CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`，
 *       id 分别是 `workbuddy-desktop` / `workbuddy-desktop-ai`）→ 必须逐字披露。
 *
 * 本模块只 import `./types.js` / `./catalog.js` 与 `node:*`，可脱离宿主单独验收。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workBuddyStoredAccounts } from '../workbuddy-isolation.js'

import type { AccountIsolation, AccountLaunch, AccountProfile, AuthState, NativeAuthRef } from './types.js'
import { redactSecrets } from './types.js'

/** 身份指纹：只存不可逆短摘要。 */
export function fingerprintOf(primary: string): string {
  return createHash('sha256').update(primary).digest('hex').slice(0, 12)
}

/** 只读身份探测配方。 */
export interface IdentityProbe {
  /** 探测 argv；`{configDir}` 会被替换成该档案的配置目录。 */
  readonly args: readonly string[]
  /** 额外环境变量；`{configDir}` 同样会被替换。 */
  readonly env?: Readonly<Record<string, string>>
  /** 是否把配置目录作为 CLI 的 `--config-dir` 参数注入（qoder 系用这个）。 */
  readonly configDirFlag?: string
  /** 从 JSON 输出里取字段的点路径。 */
  readonly json?: {
    readonly loggedIn: string
    /** 身份主键（用于算指纹）；**不是**令牌。 */
    readonly identity: string
  }
  /** 该探测需要 managed bootstrap 才能跑（WorkBuddy 系）。 */
  readonly requiresManagedBootstrap?: boolean
  /** 说明该 Harness 没有可用的只读身份探测。 */
  readonly unavailableReason?: string
}

/** 账号种子：来自**实测**，不是推测。 */
export interface AccountSeed {
  readonly id: string
  /** 插件目标名（账本与派发用这个名字）。 */
  readonly targetName: string
  readonly harnessId: string
  readonly displayName: string
  readonly region: 'cn' | 'intl' | 'unknown'
  readonly configDir: string
  readonly nativeAuthRef: NativeAuthRef
  readonly isolation: AccountIsolation
  readonly launch: AccountLaunch
  readonly switchSemantics: { currentSession: AccountSwitchSemantics['currentSession']; note: string }
  readonly defaultProvider?: string
  readonly defaultModel?: string
  readonly limits: readonly string[]
  readonly identityProbe: IdentityProbe
}

type AccountSwitchSemantics = AccountProfile['switchSemantics']

const ACCOUNTS_ROOT = join(process.env.USERPROFILE ?? '', '.dsh', 'harness-accounts')

/**
 * 四个**已实测**账号（两个 Qoder CN + 两个 WorkBuddy）。
 *
 * 这些不是「配置愿望」：两个 Qoder 账号的 `logged_in:true` 与不同 username 是本次实跑读出的；
 * 两个 WorkBuddy 的身份指纹来自上一轮受管 bootstrap 适配器的实测交付
 * （`verification.json`，适配器 SHA-256 `3032e84f…ac1`）。
 */
export const ACCOUNT_SEEDS: readonly AccountSeed[] = [
  // ⚠️ 2026-10-15 拆分：WorkBuddy / WorkBuddy.AI / Qoder 的账号型接入已整体迁到
  // `@dsh-external/dsh-model-connect`（DPAPI 账号库 + 上游 API 直连 + 号池）。
  // 本插件不再内置它们的 CLI 账号档案（目标已删，这些种子已无目标可配）。
  // 用户经旧 CRUD 建的自定义档案（harness-accounts.json custom）保留在登记表里但同样无目标可派。
]

/**
 * **导入的**实测证据（不是本插件本次重测的）。
 *
 * 来源：上一轮交付 `…\outputs\workbuddy-cli\verification.json`（2026-10-13 14:28 CST），
 * 适配器 SHA-256 `118d3c26913118c588bf6e6a9343867a6d96c60c8131f3c97ffda8f09d07bc20`。
 * 那次四路并发里四个账号各自返回了唯一标记、`stopReason=end_turn`、工具请求 0。
 *
 * **必须如实标注为「上一次交付的实测、非本插件重测」**，因此它把状态推到
 * `model-request-authorized` 时，`detail` 里要写清出处；P7 重测后应替换为本插件自己的证据。
 */
export interface ImportedEvidence {
  readonly accountId: string
  readonly fingerprint: string
  readonly provenance: string
  readonly at: string
  readonly stopReason: string
  readonly markerReturned: boolean
}

export const IMPORTED_EVIDENCE: readonly ImportedEvidence[] = [
  // ⚠️ 2026-10-15：WorkBuddy 的两条导入证据随账号种子一起移除（账号型接入已拆到
  // dsh-model-connect）。登记表里引用旧账号 id 的历史条目由 tombstone/custom 承接，不再使用。
]

// ─────────────────────── 只读身份探测 ───────────────────────

export interface IdentityProbeResult {
  readonly loggedIn?: boolean
  readonly identity?: string
  readonly error?: string
  readonly argv: readonly string[]
  readonly at: string
  /** managed bootstrap 未建立时无法探测。 */
  readonly skipped?: string
}

function pluck(json: unknown, path: string): unknown {
  let node: unknown = json
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

/** 跑一次只读身份探测。**不读凭据、不打印令牌**。 */
export function probeIdentity(seed: AccountSeed, entry: string | null, timeoutMs = 20000): Promise<IdentityProbeResult> {
  const at = new Date().toISOString()
  const probe = seed.identityProbe
  if (probe.requiresManagedBootstrap === true) {
    return Promise.resolve({ argv: [], at, skipped: probe.unavailableReason ?? '需要 managed bootstrap' })
  }
  if (entry === null) {
    return Promise.resolve({ argv: [], at, error: '没有可用入口，无法做身份探测' })
  }
  const args = [...probe.args]
  if (probe.configDirFlag !== undefined) args.unshift(probe.configDirFlag, seed.configDir)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(probe.env ?? {})) env[k] = v.replace('{configDir}', seed.configDir)

  return new Promise<IdentityProbeResult>((resolve) => {
    execFile(
      entry,
      args,
      { timeout: timeoutMs, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ''}`.trim()
        const err = `${stderr ?? ''}`.trim()
        if (error !== null && error !== undefined && out.length === 0) {
          resolve({ argv: args, at, error: `${String((error as { message?: string }).message ?? 'failed')}${err.length > 0 ? ` | ${err.slice(0, 200)}` : ''}` })
          return
        }
        const jsonSpec = probe.json
        if (jsonSpec === undefined) {
          resolve({ argv: args, at, error: '该 Harness 未配置 JSON 身份字段，无法判定' })
          return
        }
        try {
          const parsed: unknown = JSON.parse(out)
          const loggedIn = pluck(parsed, jsonSpec.loggedIn)
          const identity = pluck(parsed, jsonSpec.identity)
          resolve({
            argv: args,
            at,
            loggedIn: loggedIn === true || loggedIn === 1,
            identity: typeof identity === 'string' && identity.length > 0 ? identity : undefined,
            // 没拿到身份主键就说清楚，不要留一个空指纹冒充成功。
            error: typeof identity === 'string' && identity.length > 0 ? undefined : '状态里没有可用的身份主键',
          })
        } catch (parseError: unknown) {
          resolve({ argv: args, at, error: `状态输出不是 JSON：${String(parseError instanceof Error ? parseError.message : parseError).slice(0, 120)}` })
        }
      },
    )
  })
}

/**
 * 三态判定。**必须分开**，任何一层成功都不得自动升级下一层：
 *   `login-ok`                  —— CLI 自己报告已登录
 *   `identity-readable`         —— 另外还读到了稳定身份主键
 *   `model-request-authorized`  —— 只有真实完成过一次模型请求才给
 */
export function deriveAuthState(input: {
  loggedIn?: boolean
  identityReadable: boolean
  modelRequestProven: boolean
  invalid?: boolean
}): AuthState {
  if (input.invalid === true) return 'auth-invalid'
  if (input.modelRequestProven) return 'model-request-authorized'
  if (input.identityReadable) return 'identity-readable'
  if (input.loggedIn === true) return 'login-ok'
  return 'unknown'
}

export interface CollectAccountsOptions {
  /** 目标名 → 已解析入口。缺省的账号跳过命令探测并说明原因。 */
  readonly entryForTarget: (targetName: string) => string | null
  readonly measure?: boolean
  readonly timeoutMs?: number
  /** 本插件**自己**的账号级模型请求证据（P7 会写）。 */
  readonly ownEvidence?: readonly ImportedEvidence[]
  readonly importPriorEvidence?: boolean
  readonly now?: () => Date
  /**
   * 要收集的账号种子。缺省=内置四个。
   * 传 `effectiveSeeds(registry)` 时，用户新增/删除/改名的档案会一并出现在结果里 ——
   * 否则「动态管理」在界面上看不出来。
   */
  readonly seeds?: readonly AccountSeed[]
}

/** 收集全部账号档案（含三态）。 */
export async function collectAccounts(options: CollectAccountsOptions): Promise<AccountProfile[]> {
  const measure = options.measure !== false
  const imported = options.importPriorEvidence === false ? [] : IMPORTED_EVIDENCE
  const own = options.ownEvidence ?? []
  const source = options.seeds ?? ACCOUNT_SEEDS
  const out: AccountProfile[] = []

  for (const seed of source) {
    const entry = options.entryForTarget(seed.targetName)
    let loggedIn: boolean | undefined
    let identityReadable = false
    let fingerprint: string | undefined
    let displayIdentity: string | undefined
    let detail: string | undefined
    let snapshotAuthorized = false

    if (measure) {
      const probe = await probeIdentity(seed, entry, options.timeoutMs ?? 20000)
      loggedIn = probe.loggedIn
      if (probe.identity !== undefined) {
        identityReadable = true
        displayIdentity = probe.identity
        fingerprint = fingerprintOf(probe.identity)
      }
      detail = probe.skipped ?? probe.error ?? (probe.identity !== undefined ? `只读探测：argv=[${probe.argv.join(' ')}]` : undefined)
    } else {
      detail = '本次为离线构建，未执行身份探测'
    }
    if (measure && seed.launch.mode === 'managed-bootstrap') {
      const stored = workBuddyStoredAccounts(seed.configDir).find(account => account.selected)
      if (stored) {
        fingerprint = stored.fingerprint
        identityReadable = true
        displayIdentity = stored.label
        detail = '原生加密独立账号快照；身份指纹来自该快照'
        snapshotAuthorized = typeof stored.authenticatedAt === 'string'
      }
    }

    // 模型请求证据：优先本插件自己的，其次**明确标注出处的**导入证据。
    const ownHit = own.find((e) => e.accountId === seed.id)
    const importedHit = imported.find((e) => e.accountId === seed.id)
    const modelRequestProven = snapshotAuthorized || (seed.launch.mode === 'managed-bootstrap' && fingerprint ? false : ownHit !== undefined || importedHit !== undefined)
    if (importedHit !== undefined && ownHit === undefined && fingerprint === undefined) {
      fingerprint = importedHit.fingerprint
      detail = `${detail ?? ''}；身份指纹来自导入证据：${importedHit.provenance}（**非本插件本次重测**）`.trim()
    }

    const state = deriveAuthState({
      loggedIn,
      identityReadable,
      modelRequestProven,
      // 只有在明确没有登录、且没有模型请求证据时才算失效；其余保持未知/较低状态。
      invalid: loggedIn === false && !modelRequestProven,
    })

    out.push({
      id: seed.id,
      harnessId: seed.harnessId,
      displayName: seed.displayName,
      region: seed.region,
      identity: { state, fingerprint, displayIdentity, checkedAt: (options.now ?? (() => new Date()))().toISOString(), detail },
      nativeAuthRef: seed.nativeAuthRef,
      configDir: seed.configDir,
      launch: seed.launch,
      isolation: seed.isolation,
      defaultProvider: seed.defaultProvider,
      defaultModel: seed.defaultModel,
      switchSemantics: seed.switchSemantics,
      limits: seed.limits,
    })
  }
  return out
}

// ─────────────────────── 落盘（只写指纹与结论，不写凭据） ───────────────────────

export interface AccountStateFile {
  readonly version: 1
  /** 每个账号的**默认**设定；切换只影响**新建**的执行。 */
  readonly defaults: Readonly<Record<string, { provider?: string; model?: string }>>
  readonly updatedAt: string
}

const EMPTY_STATE: AccountStateFile = { version: 1, defaults: {}, updatedAt: new Date(0).toISOString() }

export function loadAccountState(file: string): AccountStateFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountStateFile>
    return { version: 1, defaults: raw.defaults ?? {}, updatedAt: raw.updatedAt ?? EMPTY_STATE.updatedAt }
  } catch {
    return EMPTY_STATE
  }
}

export function saveAccountState(file: string, state: AccountStateFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** 写入前把形状像令牌的串替换掉 —— 双保险，本模块本来也不该出现凭据。 */
export function assertNoSecrets(text: string): string[] {
  const hits: string[] = []
  if (/eyJ[A-Za-z0-9_-]{10,}/.test(text)) hits.push('JWT-like')
  if (/(?:access_token|refresh_token|api[_-]?key|authorization)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i.test(text)) hits.push('token-assignment')
  return hits
}

// ─────────────────── WorkBuddy 受管 bootstrap 的版本门禁 ───────────────────

export interface BootstrapGateResult {
  readonly ok: boolean
  /** 不通过时的**显式**原因（绝不允许静默退化）。 */
  readonly reason?: string
  readonly requiredPrefix: string
  readonly observed?: string
}

/**
 * 受管 bootstrap 的版本门禁。
 *
 * 为什么必须有：该适配器依赖**厂商内部发布模块与启动协议**
 * （`resources/app.asar/main/process-cpu-sampler.js` 的内部 API、
 * `process._linkedBinding('electron_browser_workbuddy_storage')`、以及一次性命名管道 bootstrap）。
 * 厂商升级后这些内部面随时可能变。**版本不匹配时必须显式失败**，
 * 不能退化成「不带保护地启动」「关闭加密」「导出令牌」之类的做法。
 *
 * @param vendorVersion 厂商 CLI 的实测版本（例如 `2.156.0`）
 */
export function checkManagedBootstrapGate(seed: AccountSeed, vendorVersion: string | undefined): BootstrapGateResult {
  const required = seed.launch.bootstrap?.requiresVendorVersionPrefix
  if (seed.launch.mode !== 'managed-bootstrap') {
    return { ok: false, reason: `account ${seed.id} does not use managed-bootstrap`, requiredPrefix: required ?? '(n/a)' }
  }
  if (required === undefined) {
    return { ok: false, reason: 'managed-bootstrap 未声明 requiresVendorVersionPrefix（不允许无门禁运行）', requiredPrefix: '(none)' }
  }
  if (vendorVersion === undefined || vendorVersion.trim().length === 0) {
    // 测不到版本就**不放行** —— 「不知道版本」不等于「版本兼容」。
    return { ok: false, reason: '未能测到厂商 CLI 版本，无法确认受管 bootstrap 兼容；拒绝启动（显式失败）', requiredPrefix: required }
  }
  const observed = vendorVersion.trim()
  if (!observed.startsWith(required)) {
    return {
      ok: false,
      requiredPrefix: required,
      observed,
      reason:
        `厂商版本已从验收时的 ${required} 变为 ${observed}：受管 bootstrap 依赖厂商内部协议，`
        + '升级后必须重新验收，不能沿用旧结论。已显式拒绝启动（不降级、不关闭保护）。',
    }
  }
  return { ok: true, requiredPrefix: required, observed }
}

/** 已验收的 WorkBuddy 受管适配器指纹（与上一轮交付逐字节一致才算数）。 */
export const WORKBUDDY_ADAPTER_SHA256 = 'cfe9148cccb57d654534ad2471a17e47dd3970da86896d040920dc7c07b8ddf7'

/**
 * 校验随包适配器是否仍是**已验收过的那一份**。
 * 适配器被改动（或被厂商升级挤掉）必须能被发现，而不是悄悄跑一个没验过的版本。
 */
export function checkAdapterIntegrity(actualSha256: string | undefined): { ok: boolean; reason?: string } {
  if (actualSha256 === undefined) return { ok: false, reason: '未能计算适配器指纹' }
  const actual = actualSha256.trim().toLowerCase()
  if (actual !== WORKBUDDY_ADAPTER_SHA256) {
    return { ok: false, reason: `随包适配器指纹不匹配：期望 ${WORKBUDDY_ADAPTER_SHA256}，实际 ${actual}` }
  }
  return { ok: true }
}

// ═══════════════════════════════════════════════════════════════════════════
//  以下为「账号档案动态管理（CRUD）+ 原生登录/退出入口」。
//
//  三条不可越过的纪律（用户硬性要求，写进代码而不是只写进文档）：
//   ① **不复制 / 不解密 / 不导出**任何令牌；本模块从不读取认证文件内容，
//      只调用各 CLI **自己**的认证命令，并只保留「成功/失败 + 脱敏后的输出」。
//   ② **不关闭加密保护**；也不把凭据从厂商原生存储里搬走。
//   ③ **不伪造隔离支持**：只有拿到「实测有效」的隔离开关，才允许为该 harness
//      新增档案；否则 `createAccount` **显式拒绝**并说明差什么证据。
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────── ① 原生认证命令表（逐 CLI 实测） ───────────────────────
//
// 每一条都来自**本机实测的帮助输出**，不是猜的。命令一律是 CLI **自己**的流程；
// 本插件只负责「拼上该账号的配置目录参数」并把它交给 CLI 跑。
// 实测时间：2026-10-13（`<exe> --help` / `<exe> <sub> --help`）。

export interface NativeAuthSpec {
  /** 对应 `catalog.ts` 的 harness id。 */
  readonly harnessId: string
  /** 该 harness 的 CLI 入口名（用于给用户一条可自己粘贴的命令）。 */
  readonly entryName: string
  /** 登录 argv（不含入口本身，也不含账号配置目录参数）。 */
  readonly login?: readonly string[]
  /** 退出 argv。CLI 帮助里没有 logout 时**留空**，不编一个。 */
  readonly logout?: readonly string[]
  /** 只读状态 argv。**必须**保证不会打印凭据，否则留空并写明原因。 */
  readonly status?: readonly string[]
  /** 登录是否必须由用户在自己的终端里完成。 */
  readonly interactive: boolean
  /** `logout` 是否也可能交互（例如要先选账号）。 */
  readonly logoutInteractive: boolean
  /** 没有原生入口时的原因 + 用户应当去哪里完成。 */
  readonly unavailableReason?: string
  /** 实测出处（命令 + 观测到的原文）。 */
  readonly evidence: readonly string[]
  readonly limits: readonly string[]
}

export const NATIVE_AUTH: readonly NativeAuthSpec[] = [
  {
    harnessId: 'qoder-intl', entryName: 'qodercli', login: ['login'],
    logout: undefined, status: ['status', '-o', 'json'], interactive: true, logoutInteractive: true,
    evidence: ['本机 qodercli 1.0.45 --help 列出 login / status 与 --config-dir；fresh config root 的 status -o json 返回 logged_in:false。'],
    limits: ['未验证两个已登录国际账号并发；原生 login 必须由用户完成', '帮助未列出 logout，不删除凭据冒充退出'],
  },
  {
    harnessId: 'qoder-cn',
    entryName: 'qoderclicn',
    login: ['login'],
    // 帮助里**没有** logout —— 不能凭空编一个（编出来的会失败，或更糟：什么都不做却报成功）。
    logout: undefined,
    status: ['status', '-o', 'json'],
    interactive: true,
    logoutInteractive: true,
    evidence: [
      '实测 `qoderclicn --help` 子命令枚举：mcp, plugins|plugin, skills|skill, hooks|hook, agents|agent, login, commit, rollback, update, remote-control, status, security, feedback, config, wiki。',
      '实测 `qoderclicn login --help` = "Usage: qoderclicn login [options]" / "Sign in to your account"。',
      '实测 `qoderclicn status --help` = "-o, --output <format>  Output format (text, json)"。',
      '**帮助里没有 logout 子命令** —— 所以退出只能由用户在该 CLI/IDE 自己的界面里完成。',
    ],
    limits: [
      'CLI 只提供 login，**没有 logout**；本插件不会用「删配置文件」冒充退出（那等于绕过原生认证流程）',
      '登录是交互式的（会拉起浏览器/设备码），必须在真实终端里由用户完成',
    ],
  },
  {
    harnessId: 'codex',
    entryName: 'codex',
    login: ['login'],
    logout: ['logout'],
    status: ['login', 'status'],
    interactive: true,
    logoutInteractive: false,
    evidence: [
      '实测 `codex --help` 子命令列表含 `login  Manage login` 与 `logout  Remove stored authentication credentials`。',
      '已导入实测（`docs/verified/harness-probe.json`）：`codex login status` → exit 0，stderr "Logged in using ChatGPT"；'
      + '`CODEX_HOME=<fresh temp>` 时同一命令 exit 1、"Not logged in" —— 认证确实随 CODEX_HOME 走。',
    ],
    limits: ['登录需要浏览器/设备码交互，必须在真实终端里由用户完成'],
  },
  {
    harnessId: 'claude-code',
    entryName: 'claude',
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
    status: ['auth', 'status'],
    interactive: true,
    logoutInteractive: false,
    evidence: [
      '实测 `claude auth --help` → Commands: `login [options]  Sign in to your Anthropic account`、`logout  Log out from your Anthropic account`、`status [options]  Show authentication status`。',
      '已导入实测（`docs/verified/harness-probe.json`）：`claude auth status` 回 JSON（loggedIn/authMethod/configDirectory）；'
      + '`CLAUDE_CONFIG_DIR=<fresh temp>` 时 loggedIn=false、authMethod="none" —— 认证确实随该目录走。',
    ],
    limits: ['登录为 OAuth 交互流程，必须在真实终端里由用户完成'],
  },
  {
    harnessId: 'opencode',
    entryName: 'opencode',
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
    status: ['auth', 'list'],
    interactive: true,
    // `auth logout` 自身是 "log out of a saved account"，多账号时需要先选一个 → 视为交互。
    logoutInteractive: true,
    evidence: [
      '实测 `opencode auth --help` → SUBCOMMANDS: `list  list providers and credentials`、`login  log in to a provider`、`logout  log out of a saved account`、`switch  switch the active account for an integration`。',
      '`opencode auth list` 已导入实测为只读（回 provider/store 状态两列，不见凭据值）。',
    ],
    limits: [
      '**该 harness 的配置目录隔离开关实测全部无效**（5 个开关：XDG_CONFIG_HOME / XDG_DATA_HOME / OPENCODE_CONFIG / OPENCODE_CONFIG_DIR / OPENCODE_DB），'
      + '因此本插件**不允许**为它新增账号档案（见 isolationProfileFor）',
      '`auth logout` 可能要求先选账号，属于交互动作',
    ],
  },
  {
    harnessId: 'pi',
    entryName: 'pi',
    // 关键：`pi auth` 自己的帮助写着会 "Print credentials"。执行它可能把 API key / bearer token
    // 打到输出里 —— 那正是用户**明令禁止**的。所以这里不但不实现，还要写明为什么。
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason:
      '`pi auth` 的自身帮助写着 "Print credentials or check provider readiness" —— 执行它**可能把 API key 或 bearer token 打到输出里**。'
      + '用户明令禁止复制/明文导出令牌，因此本插件**拒绝**执行该命令，也不代管 pi 的凭据。'
      + '请在 pi 自己的 TUI 里用 `/login` 完成认证。',
    evidence: [
      '实测 `pi --help` → `pi auth <command>   Print credentials or check provider readiness`。',
      '已导入实测（`docs/verified/harness-probe.json`）：该命令**未被执行**，理由逐字为「Running it risks printing an API key or bearer token, which this probe is forbidden to do」。',
    ],
    limits: ['原生认证入口存在但**含打印凭据的风险**，本插件不实现该入口'],
  },
  {
    harnessId: 'grok',
    entryName: 'grok',
    login: ['login'],
    logout: ['logout'],
    status: undefined,
    interactive: true,
    logoutInteractive: false,
    evidence: [
      '实测 `grok --help` Commands 段：`login  Sign in to Grok`、`logout  Sign out and clear cached credentials`。',
      '同一份帮助里**没有**只读的登录状态子命令（`models` 会报 "You are not authenticated."，但那不是状态查询命令）。',
    ],
    limits: [
      '没有只读状态子命令 → 登录结果只能靠**真实模型请求**才能升级到「模型请求认证有效」',
      '该 harness 未找到配置目录隔离开关（实测帮助里只有 GROK_SANDBOX），因此不允许新增档案',
    ],
  },
  {
    harnessId: 'kimi',
    entryName: 'kimi',
    login: ['login'],
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    evidence: [
      '实测 `kimi --help` Commands 段：`login   Authenticate with Kimi Code CLI via the device-code flow.`、`provider   Manage LLM providers non-interactively.`、`doctor   Validate Kimi Code configuration files.`',
      '**帮助里没有 logout** —— 不编。',
    ],
    limits: ['设备码流程需要用户在浏览器里确认；CLI 没有 logout'],
  },
  {
    harnessId: 'antigravity-agy',
    entryName: 'agy-core',
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason:
      '实测 `agy-core --help` 的 "Available subcommands" 只有：agent, agents, changelog, help, install, mcp, mic-serve, models, plugin, plugins, remote-control, update —— '
      + '**没有 login / logout / status**。也就是说 Antigravity CLI 根本没有可调用的原生登录/退出入口。'
      + '账号认证由 Antigravity 桌面应用（`antigravity` 目标）管理；本插件不会自己实现一套登录。',
    evidence: [
      '实测 `agy-core --help`（2026-10-13）：Available subcommands = agent, agents, changelog, help, install, mcp, mic-serve, models, plugin, plugins, remote-control, update。',
      '已导入实测（`docs/verified/harness-probe.json`，antigravity-agy）："agy-core exposes no login/status subcommand"；`models` 返回目录但「proves nothing about authentication」。',
    ],
    limits: ['没有原生登录/退出入口 → 本插件**不提供** agy 的登录与退出（不伪造）'],
  },
  {
    harnessId: 'workbuddy',
    entryName: 'codebuddy',
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason:
      '已导入实测（`docs/verified/harness-probe.json`）：`codebuddy --help`（105 行）里**没有** login / auth status 子命令；'
      + '唯一候选只读面 `config list` 因为缺 `../dist/codebuddy` 包而不可用。因此没有可调用的原生认证入口。',
    evidence: ['已导入实测：codebuddy 无 login/auth status；`config list` / `config get` 因缺 bundle 而 exit 1。'],
    limits: ['认证由 WorkBuddy 桌面应用管理，本插件不代做'],
  },
  {
    harnessId: 'workbuddy-ai',
    entryName: 'codebuddy-ai',
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason: '与 workbuddy 同一套 CodeBuddy CLI：没有 login/auth status 子命令；认证槽位由厂商桌面应用共享管理。',
    evidence: ['结构事实：与 workbuddy 复用同一 FileAuthenticationStorage，仅 authentication.id 不同。'],
    limits: ['认证存储在厂商共享目录，本插件不触碰'],
  },
  {
    harnessId: 'mimo',
    entryName: 'mimo',
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason:
      '已导入实测（`docs/verified/harness-probe.json`）：`mimo providers` 是 `auth` 的别名、会管理凭据，'
      + '**未被执行**（可能打印或索取凭据材料）。因此本插件不提供该入口。',
    evidence: ['已导入实测：`mimo providers` 别名为 auth，因可能打印凭据而未执行；`auth.json` 2 字节（疑似空对象）。'],
    limits: ['认证入口含凭据面，不实现'],
  },
  {
    harnessId: 'zcode',
    entryName: 'zcode',
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason: '已导入实测：没有可达的只读登录状态命令；`.zcode\\cli\\config.json` 里的 apiKey 是静态密钥、不是 OAuth 会话，不能据此声称已登录。',
    evidence: ['已导入实测（catalog zcode.authNote）："No read-only CLI status command was reachable"。'],
    limits: ['没有原生登录/退出入口'],
  },
  {
    harnessId: 'dsh-native',
    entryName: 'dsh',
    login: undefined,
    logout: undefined,
    status: undefined,
    interactive: true,
    logoutInteractive: true,
    unavailableReason: 'DSH 自身不是外部 harness；它的登录由 DSH 自己的凭据配置管理，不属于本插件职责。',
    evidence: ['设计边界：本插件只驱动**外部 CLI** 的原生认证流程。'],
    limits: ['不适用'],
  },
]

export function nativeAuthFor(harnessId: string): NativeAuthSpec | undefined {
  return NATIVE_AUTH.find((spec) => spec.harnessId === harnessId)
}

// ─────────────────────── ② 隔离开关画像（决定「能不能加账号」） ───────────────────────
//
// 这是「不伪造隔离支持」的唯一判定点。`catalog.ts` 的 `multiAccount` 字段太粗
// （例如 mimo 标了 isolated-config-dir/isolationTested=true，但**详细实测**写的是
// 「Neither switch produced an empty/credential-free state, so credential isolation is
// NOT demonstrated」）。因此这里以**逐条实测原文**为准，宁可保守。

export interface IsolationProfile {
  readonly harnessId: string
  /** 配置目录能否按档案切换（有实测证据的开关）。 */
  readonly configDirIsolated: boolean
  /** 认证存储是否真的随配置目录走。false 时**不得**宣称认证隔离。 */
  readonly authStoreIsolated: boolean
  /** 实测有效的隔离开关（env 名或 CLI flag）；没有就是 null。 */
  readonly mechanism: string | null
  /** 开关怎么落到 launch 上。 */
  readonly launchKind: 'env' | 'argv' | 'none'
  readonly evidence: readonly string[]
  readonly disclosure: string
  /** 是否允许为这个 harness **新增**账号档案。 */
  readonly mayAddAccounts: boolean
  /** 不允许时的原因 + 差什么证据。 */
  readonly refuseReason?: string
  readonly limits: readonly string[]
}

const ISOLATION_PROFILES: readonly IsolationProfile[] = [
  {
    harnessId: 'qoder-intl', configDirIsolated: true, authStoreIsolated: true,
    mechanism: '--config-dir <dir>', launchKind: 'argv', mayAddAccounts: true,
    evidence: [
      'qodercli 1.0.45 --help 明确支持每次调用 --config-dir；本机 fresh root status -o json logged_in:false。默认根也未登录，未建立已登录身份变化正对照。',
      // 2026-10-14 本轮实测补上**正向对照**（两条都取自 CLI 自己的 run manifest / 输出，不是插件自述）：
      //   默认根（不带 --config-dir）→ `Not logged in · Please run /login`（error，零额度）；
      //   账号目录（--config-dir …harness-accounts\\qoder-intl-a）→ 成功回答，manifest argv 带该目录。
      //   ⇒ **认证可见性跟着配置目录走**（可分离），而不是机器级共享。
      //   反向对照：新建一个**空认证**的临时账号（fresh 目录）→ 失败，且 argv 指向那个临时目录
      //   （既不是已登录账号目录、也不是默认根）⇒ 不存在「静默回退到别的身份」。
      '2026-10-14 实测（两个方向）：默认根 `Not logged in · Please run /login` vs 账号目录成功回答'
      + '（argv 由 CLI 自己的 logs/runs/<ts>/manifest.json 佐证：--config-dir …\\harness-accounts\\qoder-intl-a）；'
      + '空认证临时账号 → 失败且 argv 指向它自己的目录。',
    ],
    disclosure: '使用国际版独立配置目录；允许创建待登录档案。'
      + '**认证可见性已实测跟着 `--config-dir` 走**（默认根未登录 / 账号目录成功；空认证账号不回退到任何别的目录），'
      + '但「两个**已登录**国际账号并行」仍未验证，凭据文件是否另有机器级副本未查 —— 不继承国内版两账号实测结论。',
    limits: ['两个已登录国际账号并行未验证', '令牌刷新未验证', '新档案必须通过自身原生登录及身份探测'],
  },
  {
    harnessId: 'qoder-cn',
    configDirIsolated: true,
    authStoreIsolated: true,
    mechanism: '--config-dir <dir>',
    launchKind: 'argv',
    evidence: [
      '实测：`qoderclicn --config-dir <档案A> status -o json` 与 `--config-dir <档案B>` 报出**不同 username**，'
      + '指纹分别是 1fab6738baa4 / 789e8704d79b（见 probe/out/federation-accounts.json）。',
      '结构事实：qoderclicn 的 `.auth/`（user、machine_id）位于该配置目录**内部** —— 换目录时认证文件一并被隔离。',
      '文档出处：`qoderclicn --help` 里 `--config-dir <dir>  Use a custom user-level config root for this run`（实测）。',
    ],
    disclosure: '配置目录与认证存储都由 `--config-dir` 指向本档案；实测两个账号身份不同、互不影响。',
    mayAddAccounts: true,
    limits: ['令牌到期刷新未验证', '登录是交互式的，必须由用户在自己的终端里完成'],
  },
  {
    harnessId: 'codex',
    configDirIsolated: true,
    authStoreIsolated: true,
    mechanism: 'CODEX_HOME',
    launchKind: 'env',
    evidence: [
      '已导入实测：`CODEX_HOME=<fresh temp>` 时 `codex login status` → exit 1 / "Not logged in"；默认根 → exit 0 / "Logged in using ChatGPT"。',
      '结论：**认证状态随 CODEX_HOME 变化**，不是「换目录但仍读同一个认证槽」。',
    ],
    disclosure: '配置与认证都由 `CODEX_HOME` 指向本档案（实测：换到空目录即为登出态）。',
    mayAddAccounts: true,
    limits: ['新增档案在首次使用前需要在该档案目录里跑一次 `codex login`（原生交互流程）'],
  },
  {
    harnessId: 'claude-code',
    configDirIsolated: true,
    authStoreIsolated: true,
    mechanism: 'CLAUDE_CONFIG_DIR',
    launchKind: 'env',
    evidence: [
      '已导入实测：`CLAUDE_CONFIG_DIR=<fresh temp>` → `claude auth status` 回 loggedIn=false、authMethod="none"、configDirectory 指向该临时目录；默认 → loggedIn=true、authMethod="oauth_token"。',
      '结论：**认证状态随 CLAUDE_CONFIG_DIR 变化**。',
    ],
    disclosure: '配置与认证都由 `CLAUDE_CONFIG_DIR` 指向本档案（实测：换到空目录即为登出态）。',
    mayAddAccounts: true,
    limits: ['新增档案在首次使用前需要在该档案目录里跑一次 `claude auth login`（原生 OAuth 流程）'],
  },
  {
    harnessId: 'pi',
    configDirIsolated: true,
    authStoreIsolated: true,
    mechanism: 'PI_CODING_AGENT_DIR',
    launchKind: 'env',
    evidence: [
      '已导入实测：`PI_CODING_AGENT_DIR=<fresh temp>` 时 `pi --list-models` 返回 "No models available. Use /login …"（3 行），'
      + '默认根返回 96 个模型；**并且该临时目录里出现了 auth.json 与 models-store.json** —— 认证文件确实落在该目录内。',
    ],
    disclosure: '配置与认证都由 `PI_CODING_AGENT_DIR` 指向本档案（实测：临时目录内出现 auth.json）。',
    mayAddAccounts: true,
    limits: ['`pi auth` 含打印凭据风险，本插件不调用；登录请在 pi 自己的 TUI 里用 `/login` 完成'],
  },
  {
    harnessId: 'opencode',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [
      '已导入实测：试了 5 个开关（XDG_CONFIG_HOME / XDG_DATA_HOME / OPENCODE_CONFIG / OPENCODE_CONFIG_DIR / OPENCODE_DB），'
      + '`opencode auth list` 在每一种下都返回**同样的 3 个已存 provider**；`--standalone` 也一样。',
      '很可能的原因（推断，未证明）：存在共享后台服务 `opencode.exe serve --service`，认证来自共享服务/DB。',
    ],
    disclosure: '**该 harness 无法按档案隔离认证**：5 个候选开关实测全部无效。本插件不会为它新增账号档案 —— 那只会造出一堆「名字不同、其实是同一个账号」的假档案。',
    mayAddAccounts: false,
    refuseReason:
      'opencode 的配置目录隔离开关**实测全部无效**（5 个候选：XDG_CONFIG_HOME / XDG_DATA_HOME / OPENCODE_CONFIG / OPENCODE_CONFIG_DIR / OPENCODE_DB），'
      + '新增档案不会改变实际使用的账号，只会产生「看起来是多账号、其实是同一个账号」的假象。'
      + '要支持它，需要先找到**可复现**的隔离开关（例如 --standalone 之外的服务级隔离）并留下实测证据。',
    limits: ['认证由共享后台服务/DB 提供，未找到可按档案切换的开关'],
  },
  {
    harnessId: 'mimo',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [
      '已导入实测：`MIMOCODE_CONFIG_DIR=<fresh temp>` → `mimo models` 仍返回全部 7 条，临时目录只多了一个 .gitignore（**无隔离效果**）；'
      + '`MIMOCODE_HOME=<fresh temp>` → 返回 4 条（数据根确实会移动，但**目录仍非空**）。',
      '原文结论："Neither switch produced an empty/credential-free state, so credential isolation is NOT demonstrated."',
    ],
    disclosure: '**认证隔离未被证实**：MIMOCODE_CONFIG_DIR 无效、MIMOCODE_HOME 只做到部分移动且目录仍非空。不得声称已隔离。',
    mayAddAccounts: false,
    refuseReason:
      'mimo 的两个候选开关实测都**没有**产生「空的、无凭据的」状态（MIMOCODE_CONFIG_DIR 无效果；MIMOCODE_HOME 只部分移动）。'
      + '在拿到「换目录 = 换认证身份」的可复现证据之前，不允许新增档案。',
    limits: ['认证隔离未证实'],
  },
  {
    harnessId: 'grok',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [
      '已导入实测：`grok --help` 里唯一文档化的环境变量是 GROK_SANDBOX（沙箱档位，不是配置隔离）；'
      + '没有 CODEX_HOME/CLAUDE_CONFIG_DIR 式的覆盖。候选名**没有被猜测并测试**（负结果与猜错无法区分）。',
    ],
    disclosure: '**未找到可验证的隔离开关**，因此不声称支持多账号。',
    mayAddAccounts: false,
    refuseReason: 'grok 没有文档化的配置目录开关，且未做（也无法做）「猜名字」式的验证。没有可复现证据 → 不允许新增档案。',
    limits: ['配置目录隔离：未知'],
  },
  {
    harnessId: 'kimi',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: ['已导入实测：`kimi --help` 里没有文档化的配置目录环境变量；候选名未被猜测并测试（负结果与猜错无法区分）。'],
    disclosure: '**未找到可验证的隔离开关**，因此不声称支持多账号。',
    mayAddAccounts: false,
    refuseReason: 'kimi 没有文档化的配置目录隔离开关；没有可复现证据 → 不允许新增档案。',
    limits: ['配置目录隔离：未知'],
  },
  {
    harnessId: 'antigravity-agy',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [
      '实测（本轮，见 probe/verify-agy-isolation.mjs）：`agy-core --help` 的 Available subcommands 里**没有** login/logout/status。',
      '实测（本轮）：`ANTIGRAVITY_EXECUTABLE_DATA_DIR=<全新临时目录>` 时 `agy-core models` 输出**逐字节相同**的 6 个模型，'
      + '且该临时目录**一个文件都没被创建** → 该变量名虽在二进制里出现，但**不具备隔离效果**。',
      '实测（本轮）：`XDG_CONFIG_HOME=<全新临时目录>` 同样输出相同目录、临时目录为空 → 无隔离效果。',
      '结构事实：agy 的状态落在 `~/.gemini/`（antigravity/、antigravity-cli/、config/）；没有发现可按调用切换的根。',
    ],
    disclosure:
      '**Antigravity CLI 目前不支持可验证的多账号隔离**：没有 login/logout/status 子命令，'
      + '两个候选数据根开关实测都没有效果。因此本插件**不新增** agy 账号档案 —— 那只会造出「名字不同、其实是同一个账号」的假档案。'
      + '桌面端（`antigravity` 目标，Electron）理论上可用 `--user-data-dir` 做独立 profile，但那需要**新增一个带该参数的目标**（属于目标表/配置改动，不在本插件账号模块的能力范围内）。',
    mayAddAccounts: false,
    refuseReason:
      'agy 没有可验证的隔离开关：`ANTIGRAVITY_EXECUTABLE_DATA_DIR` 与 `XDG_CONFIG_HOME` 两个候选实测都**没有**改变 agy 读到的东西'
      + '（模型目录逐字相同、全新临时目录零文件），而且 CLI 连 login/status 子命令都没有。'
      + '想支持 Antigravity 多账号，可行的路径是给桌面端 `antigravity` 目标加 `--user-data-dir=<每档案目录>`（cdp 通道已支持按 user-data-dir 判定独立 profile），'
      + '但那要改目标表；在拿到实测之前，本模块不允许新增 agy 档案。',
    limits: ['无原生认证入口', '两个候选数据根开关实测无效', '桌面端 user-data-dir 路径需要新增目标，未做'],
  },
  {
    harnessId: 'workbuddy',
    // ⚠️ 2026-10-14 修：这里此前是 `false`，与它**自己的 disclosure** 自相矛盾
    // （disclosure 写的是「配置目录可指定」，而布尔说不隔离），也与账号档案
    // （`workbuddy-a.isolation.configDirIsolated: true`，由受管 wrapper 注入 CODEBUDDY_CONFIG_DIR）相反。
    // 暴露到设置页后会直接对用户说错话，所以按实测口径统一为「配置目录隔离=是 / 认证槽=厂商共享」。
    configDirIsolated: true,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [
      '结构事实：发布包 FileAuthenticationStorage 用 fixed sharedDataPath 下的 auth/<authentication.id>.info，**不随** CODEBUDDY_CONFIG_DIR 变化。',
      '反证：同时指定 CODEBUDDY_CONFIG_DIR 与 WORKBUDDY_CONFIG_DIR 仍读同一个认证槽。',
      '配置目录这一半是**实测可用**的：受管 wrapper（`assets/workbuddy-managed.cjs <账号 id>`）把 CODEBUDDY_CONFIG_DIR 指向该档案目录；'
      + '本机两个 WB 账号（`workbuddy-a` / `workbuddy-ai-b`）各自带自己的目录运行（argv 与 /api/accounts 的 configDir 都可核）。',
      '⚠️ 桌面端目标（`workbuddy` / `workbuddy-ai`）没有按档案切目录的入口 —— 「配置目录隔离」只在**受管 CLI** 这条路上成立。',
    ],
    disclosure: '配置目录由受管 wrapper 注入 `CODEBUDDY_CONFIG_DIR` 指向本档案（**仅受管 CLI 路线**；桌面端目标不支持按档案切目录），'
      + '但**认证槽位是厂商共享的**（两个 WB 应用同处一个 auth 槽）。因此**配置目录隔离 ≠ 认证存储隔离**；'
      + '本档案不是任意数量、同区域多账号管理器。',
    mayAddAccounts: false,
    refuseReason:
      'WorkBuddy 的认证槽位在**厂商共享目录**里（`CodeBuddyExtension/Data/Public/auth/<authentication.id>.info`），'
      + '不随配置目录变化。再新增档案只会共享同一个认证槽 → 不是真的多账号。',
    limits: ['认证存储厂商共享'],
  },
  {
    harnessId: 'workbuddy-ai',
    // 同 workbuddy：配置目录隔离（受管 CLI 路线）成立，认证槽位与国内版同处厂商共享目录。
    configDirIsolated: true,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [
      '结构事实：与 workbuddy 同一套 FileAuthenticationStorage，仅 authentication.id 不同。',
      '配置目录这一半实测可用：`wb-managed-ai-b` 经受管 wrapper 带自己的目录运行（argv 与 /api/accounts 的 configDir 都可核）。',
    ],
    disclosure: '配置目录由受管 wrapper 注入 `CODEBUDDY_CONFIG_DIR` 指向本档案（仅受管 CLI 路线），'
      + '认证槽位与 WorkBuddy 同处厂商共享目录；**配置目录隔离 ≠ 认证存储隔离**。',
    mayAddAccounts: false,
    refuseReason: '与 workbuddy 共享同一套厂商认证存储；新增档案不会得到独立认证身份。',
    limits: ['认证存储厂商共享'],
  },
  {
    harnessId: 'zcode',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: ['已导入实测：没有可达的只读登录状态命令；`.zcode\\cli\\config.json` 里是静态 apiKey。'],
    disclosure: '**未知**：既没有只读状态命令，也没有验证过隔离开关。不声称支持多账号。',
    mayAddAccounts: false,
    refuseReason: 'zcode 的认证形态与隔离开关都未验证；没有可复现证据 → 不允许新增档案。',
    limits: ['隔离与认证形态均未知'],
  },
  {
    harnessId: 'dsh-native',
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: ['DSH 自身由 profile 的凭据配置管理，不属于本插件的账号档案体系。'],
    disclosure: '不适用：DSH 自身不是外部 harness。',
    mayAddAccounts: false,
    refuseReason: 'DSH 自身的认证由 profile 凭据配置管理，本插件不代管、也不为它建账号档案。',
    limits: ['不适用'],
  },
]

/**
 * 取某个 harness 的隔离画像。
 * **未知 harness 一律当作「不允许新增」** —— 默认拒绝，而不是默许。
 */
export function isolationProfileFor(harnessId: string): IsolationProfile {
  const found = ISOLATION_PROFILES.find((p) => p.harnessId === harnessId)
  if (found !== undefined) return found
  return {
    harnessId,
    configDirIsolated: false,
    authStoreIsolated: false,
    mechanism: null,
    launchKind: 'none',
    evidence: [`没有任何关于 harness "${harnessId}" 的隔离实测记录。`],
    disclosure: `**未知 harness**："${harnessId}" 不在已实测目录里，隔离能力完全未知。`,
    mayAddAccounts: false,
    refuseReason: `harness "${harnessId}" 不在已实测的 harness 目录里 —— 隔离能力未知时**默认拒绝**新增档案（默许等于伪造支持）。`,
    limits: ['隔离能力未知'],
  }
}

// ─────────────────────── ③ 原生登录 / 退出的执行计划 ───────────────────────

export type NativeAuthAction = 'login' | 'logout' | 'status'

export interface NativeAuthPlan {
  readonly ok: true
  readonly action: NativeAuthAction
  readonly harnessId: string
  readonly accountId: string
  /** 实际入口（绝对路径优先）。 */
  readonly command: string
  /** 完整 argv（含该档案的配置目录参数）。 */
  readonly argv: readonly string[]
  /** 用户可自己粘贴到终端里的命令（值已脱敏）。 */
  readonly cliLine: string
  /** `terminal` = 必须由用户在真实终端里完成；`pipe` = 可非交互执行并回收输出。 */
  readonly mode: 'terminal' | 'pipe'
  readonly note: string
}

export type NativeAuthPlanResult =
  | NativeAuthPlan
  | { readonly ok: false, readonly harnessId: string, readonly accountId: string, readonly reason: string, readonly alternative?: string }

function quoteCli(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * 生成「调用该 CLI **自己的**认证流程」的执行计划。**纯函数**：不执行任何东西。
 *
 * 三条必须成立的纪律：
 *   1. 只调用 CLI 自己的子命令 —— 本插件**不实现**任何登录协议；
 *   2. 账号的配置目录参数必须一并带上，否则登错账号；
 *   3. 登录一律 `mode: 'terminal'` —— 交互式流程**不允许**被管道捕获后当成「已经登录」。
 */
export function planNativeAuth(
  seed: Pick<AccountSeed, 'id' | 'harnessId' | 'launch'>,
  entry: string | null,
  action: NativeAuthAction,
  homeDir: string,
): NativeAuthPlanResult {
  const spec = nativeAuthFor(seed.harnessId)
  const base = { harnessId: seed.harnessId, accountId: seed.id }
  if (spec === undefined) {
    return { ok: false, ...base, reason: `没有 harness "${seed.harnessId}" 的原生认证记录（未知 harness 不猜命令）` }
  }
  const argvFor = action === 'login' ? spec.login : action === 'logout' ? spec.logout : spec.status
  if (argvFor === undefined) {
    if (action === 'login' && spec.unavailableReason !== undefined) {
      return { ok: false, ...base, reason: spec.unavailableReason, alternative: '请在该 CLI / 桌面应用自己的界面里完成认证；本插件不代管凭据，也不会自己实现一套登录。' }
    }
    return {
      ok: false,
      ...base,
      reason: `该 CLI 没有 ${action} 子命令（实测帮助里不存在）—— 不能凭空编一个`,
      alternative:
        action === 'logout'
          ? '退出请在该 CLI / 桌面应用自己的界面里完成。本插件**不会**用「删认证文件」来冒充退出 —— 那等于绕过原生流程、也会破坏厂商的加密保护。'
          : '请在该 CLI 自己的界面里完成该动作。',
    }
  }
  const configDir = join(homeDir, '.dsh', 'harness-accounts', seed.id)
  const subst = (value: string): string => value.replace(/\{configDir\}/g, configDir)
  const launchArgs = seed.launch.args.map(subst)
  const command = entry ?? seed.launch.command
  const argv = [...launchArgs, ...argvFor]
  const interactive = action === 'login' ? spec.interactive : action === 'logout' ? spec.logoutInteractive : false
  // `cliLine` 是给界面/日志看的 —— 它**不得**带上原始 accountId（本项目纪律）。
  // 配置目录用占位符表示；真实路径只在 argv 里，且出口必须再过一次脱敏。
  const safeArgs = [...launchArgs.map((a) => a.replace(configDir, '<configDir>')), ...argvFor]
  return {
    ok: true,
    action,
    harnessId: seed.harnessId,
    accountId: seed.id,
    command,
    argv,
    cliLine: redactSecrets([command, ...safeArgs].map(quoteCli).join(' ')),
    mode: interactive ? 'terminal' : 'pipe',
    note: interactive
      ? `这是 ${spec.entryName} **自己的**${action === 'login' ? '登录' : action}流程，必须在真实终端里由用户完成；`
        + '本插件不会捕获它的输出当成「已登录」，也不会把任何凭据写进配置或日志。'
      : `这是 ${spec.entryName} **自己的**${action === 'status' ? '只读状态查询' : action}命令；输出会在返回前做令牌形状脱敏。`,
  }
}

export interface NativeAuthRunResult {
  readonly ok: boolean
  readonly action: NativeAuthAction
  readonly accountId: string
  readonly argv: readonly string[]
  readonly exitCode: number | null
  /** **已脱敏**的输出。 */
  readonly stdout: string
  readonly stderr: string
  readonly redacted: boolean
  readonly note: string
  readonly at: string
}

/**
 * 执行一个**非交互**的原生认证动作（只允许 `pipe` 计划）。
 *
 * 交互式（`login`）一律**拒绝**在这里执行：管道捕获一个会等待用户输入的进程，
 * 只会得到「看起来跑了但什么都没发生」，比不做更糟。
 */
export function runNativeAuth(
  seed: Pick<AccountSeed, 'id' | 'harnessId' | 'launch'>,
  entry: string | null,
  action: NativeAuthAction,
  options: { readonly homeDir: string, readonly timeoutMs?: number, readonly now?: () => Date },
): Promise<NativeAuthRunResult> {
  const at = (options.now ?? (() => new Date()))().toISOString()
  const plan = planNativeAuth(seed, entry, action, options.homeDir)
  if (!plan.ok) {
    return Promise.resolve({
      ok: false, action, accountId: seed.id, argv: [], exitCode: null, stdout: '', stderr: '',
      redacted: true, note: `${plan.reason}${plan.alternative === undefined ? '' : ` ${plan.alternative}`}`, at,
    })
  }
  if (plan.mode !== 'pipe') {
    return Promise.resolve({
      ok: false, action, accountId: seed.id, argv: plan.argv, exitCode: null, stdout: '', stderr: '',
      redacted: true,
      note: `${action} 是**交互式**流程，拒绝在无终端环境里用管道捕获执行（那只会得到「跑了但没结果」）。`
        + `请让用户在真实终端里运行：${plan.cliLine}`,
      at,
    })
  }
  return new Promise<NativeAuthRunResult>((resolve) => {
    execFile(
      plan.command,
      [...plan.argv],
      {
        timeout: options.timeoutMs ?? 30_000,
        env: { ...process.env, ...seed.launch.env },
        windowsHide: true,
        maxBuffer: 1 << 20,
      },
      (error, stdout, stderr) => {
        const rawOut = `${stdout ?? ''}`
        const rawErr = `${stderr ?? ''}`
        const out = redactSecrets(rawOut)
        const err = redactSecrets(rawErr)
        const redacted = out !== rawOut || err !== rawErr
        // 双保险：脱敏之后如果**仍然**扫到令牌形状，就不把正文交出去。
        const hits = [...assertNoSecrets(out), ...assertNoSecrets(err)]
        const code = error === null || error === undefined
          ? 0
          : (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null)
        resolve({
          ok: error === null || error === undefined,
          action,
          accountId: seed.id,
          argv: plan.argv,
          exitCode: code,
          stdout: hits.length > 0 ? `[withheld: secret-shaped content detected: ${hits.join(', ')}]` : out.slice(0, 4000),
          stderr: hits.length > 0 ? '[withheld: secret-shaped content detected]' : err.slice(0, 4000),
          redacted: redacted || hits.length > 0,
          note: `执行的是 ${plan.command} 的原生 ${action} 命令；输出已做令牌形状脱敏。**本插件没有读取、复制或解密任何凭据文件。**`,
          at,
        })
      },
    )
  })
}

// ─────────────────────── ④ 账号档案的动态 CRUD ───────────────────────

export interface CustomAccountRecord {
  readonly id: string
  readonly harnessId: string
  /** 派发时用的目标名（必须是本 profile 里真实存在的目标）。 */
  readonly targetName: string
  readonly displayName: string
  readonly region: 'cn' | 'intl' | 'unknown'
  /** 配置目录相对 `~/.dsh/harness-accounts/` 的子目录名（默认 = id）。 */
  readonly configDirSubdir: string
  readonly defaultProvider?: string
  readonly defaultModel?: string
  readonly note?: string
  readonly createdAt: string
}

/** 对**任何**档案（内置或新增）的可改字段。留着空白=不改。 */
export interface AccountPatch {
  readonly displayName?: string
  readonly region?: 'cn' | 'intl' | 'unknown'
  readonly defaultProvider?: string | null
  readonly defaultModel?: string | null
  readonly note?: string | null
}

export interface AccountRegistryFile {
  readonly version: 1
  readonly custom: readonly CustomAccountRecord[]
  /** 被删除的内置档案 id（墓碑）。删内置只能「停用」，不能真删 —— 否则升级会复活它。 */
  readonly tombstones: readonly string[]
  readonly patches: Readonly<Record<string, AccountPatch>>
  readonly updatedAt: string
}

export const EMPTY_ACCOUNT_REGISTRY: AccountRegistryFile = {
  version: 1, custom: [], tombstones: [], patches: {}, updatedAt: new Date(0).toISOString(),
}

export function loadAccountRegistry(file: string): AccountRegistryFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountRegistryFile>
    if (raw.version !== 1) return EMPTY_ACCOUNT_REGISTRY
    return {
      version: 1,
      custom: Array.isArray(raw.custom) ? raw.custom.filter(isCustomRecord) : [],
      tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.filter((x): x is string => typeof x === 'string') : [],
      patches: raw.patches !== null && typeof raw.patches === 'object' ? raw.patches : {},
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : EMPTY_ACCOUNT_REGISTRY.updatedAt,
    }
  } catch {
    return EMPTY_ACCOUNT_REGISTRY
  }
}

function isCustomRecord(value: unknown): value is CustomAccountRecord {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<CustomAccountRecord>
  return typeof v.id === 'string' && typeof v.harnessId === 'string' && typeof v.displayName === 'string'
}

export function saveAccountRegistry(file: string, state: AccountRegistryFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** 合法档案 id：小写字母数字起头，只允许 `a-z0-9._-`，2–48 字符。 */
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/

export interface CreateAccountInput {
  readonly id: string
  readonly harnessId: string
  readonly targetName: string
  readonly displayName: string
  readonly region?: 'cn' | 'intl' | 'unknown'
  readonly configDirSubdir?: string
  readonly note?: string
  readonly defaultProvider?: string
  readonly defaultModel?: string
}

export type AccountCrudAction =
  | { readonly kind: 'create', readonly input: CreateAccountInput }
  | { readonly kind: 'update', readonly id: string, readonly patch: AccountPatch }
  | { readonly kind: 'delete', readonly id: string }
  | { readonly kind: 'restore', readonly id: string }

export type AccountCrudResult =
  | { readonly ok: true, readonly state: AccountRegistryFile, readonly id: string, readonly note: string }
  | { readonly ok: false, readonly reason: string, readonly recovery: string }

export interface AccountCrudContext {
  /** 本 profile 里真实存在的目标名（用于拒绝拼错的目标）。缺省时不做目标存在性校验。 */
  readonly knownTargets?: readonly string[]
  /** 目标名 → harness id。缺省时不做「账号与目标同 harness」校验。 */
  readonly harnessOfTarget?: (targetName: string) => string | undefined
  /** 内置档案 id 集合（默认取 ACCOUNT_SEEDS）。 */
  readonly builtinIds?: readonly string[]
}

function harnessOfTargetFromCatalog(targetName: string): string | undefined {
  const aliases: Readonly<Record<string, string>> = {
    codex: 'codex',
    claude: 'claude-code',
    pi: 'pi',
    qoderclicn: 'qoder-cn',
    'qoder-cn-acct-a': 'qoder-cn',
    'qoder-cn-acct-b': 'qoder-cn',
    qodercli: 'qoder-intl',
    'qoder-cli': 'qoder-intl',
    opencode: 'opencode',
    mimo: 'mimo',
    kimi: 'kimi',
    'grok-cli': 'grok',
    agy: 'antigravity-agy',
    zcode: 'zcode',
    // ⚠️ 2026-10-14 补：WorkBuddy 的**真实目标名**（`wb-managed-a` / `wb-managed-ai-b`）此前不在表里
    // ⇒ 用真实目标名创建的账号会被「声明的 targetName 与本 profile 可验证目标不一致」拒掉
    // （而内置档案又写着账号 id 形态的名字 ⇒ 谁也建不出/核对不了正确的那一条）。
    // 两个形态都认：`wb-managed-*` 是目标名，`workbuddy-a` / `workbuddy-ai-b` 是历史档案值。
    'wb-managed-a': 'workbuddy',
    'wb-managed-ai-b': 'workbuddy-ai',
    'workbuddy-a': 'workbuddy',
    'workbuddy-ai-b': 'workbuddy-ai',
    'workbuddy-ai': 'workbuddy-ai',
    codebuddy: 'workbuddy',
  }
  return aliases[targetName]
}

/** 账号创建时该 harness 默认的配置目录机制（决定 launch 怎么拼）。 */
function launchFor(profile: IsolationProfile, seedLike: AccountSeed | undefined, targetName: string): AccountLaunch {
  const command = seedLike?.launch.command ?? targetName
  if (profile.launchKind === 'argv' && profile.mechanism !== null) {
    // ⚠️ `mechanism` 是**给人看的**名字（例如 `--config-dir <dir>`）。
    // 拼 launch 时必须只取**旗标本身** —— 曾经把整串当参数传下去，
    // CLI 收到的是一个字面量 `--config-dir <dir>`，直接报 "unknown option"（实测抓到）。
    const flag = profile.mechanism.trim().split(/\s+/)[0] ?? ''
    if (/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(flag)) {
      return { mode: 'direct', command, args: [flag, '{configDir}'], env: {} }
    }
  }
  if (profile.launchKind === 'env' && profile.mechanism !== null) {
    return { mode: 'direct', command, args: [...(seedLike?.launch.args ?? [])], env: { [profile.mechanism]: '{configDir}' } }
  }
  return { mode: 'direct', command, args: [...(seedLike?.launch.args ?? [])], env: {} }
}

/**
 * 应用一次账号 CRUD 动作。**纯函数**（不落盘，调用方自己 save）。
 *
 * 这里承担「不伪造隔离支持」的**强制点**：
 *   · 只有 `isolationProfileFor(harnessId).mayAddAccounts === true` 才允许 **create**；
 *   · 其余 harness 一律拒绝，并把「差什么证据」原样回给调用方；
 *   · 拒绝消息里**不会**出现任何凭据 —— 本模块从头到尾没读过凭据文件。
 */
export function applyAccountCrud(
  state: AccountRegistryFile,
  action: AccountCrudAction,
  context: AccountCrudContext = {},
  at = new Date().toISOString(),
): AccountCrudResult {
  const builtinIds = context.builtinIds ?? ACCOUNT_SEEDS.map((s) => s.id)
  const harnessOfTarget = context.harnessOfTarget ?? harnessOfTargetFromCatalog

  if (action.kind === 'create') {
    const input = action.input
    if (!ACCOUNT_ID_RE.test(input.id)) {
      return {
        ok: false,
        reason: `档案 id "${input.id}" 不合法：只允许小写字母/数字开头，字符集 a-z0-9._-，长度 2–48`,
        recovery: '换一个 id（例如 qoder-cn-c）；id 会直接成为配置目录名，所以不允许路径分隔符或空格',
      }
    }
    if (builtinIds.includes(input.id)) {
      return { ok: false, reason: `档案 id "${input.id}" 与内置档案重名`, recovery: '换一个 id；内置档案只能改描述/默认值，不能覆盖' }
    }
    if (state.custom.some((c) => c.id === input.id)) {
      return { ok: false, reason: `档案 id "${input.id}" 已存在`, recovery: '改用 update 改它，或换一个 id' }
    }
    if (context.knownTargets !== undefined && !context.knownTargets.includes(input.targetName)) {
      return {
        ok: false,
        reason: `目标 "${input.targetName}" 不在本 profile 的目标表里（已知：${context.knownTargets.join(', ') || '(空)'}）`,
        recovery: '请选一个真实存在的目标；一个错字会留下永远解析不了的档案',
      }
    }
    const derived = harnessOfTarget(input.targetName)
    if (derived !== undefined && derived !== input.harnessId) {
      return {
        ok: false,
        reason: `目标 "${input.targetName}" 属于 harness "${derived}"，与声明的 "${input.harnessId}" 不一致`,
        recovery: `把 harnessId 改成 "${derived}"，或换一个属于 "${input.harnessId}" 的目标`,
      }
    }
    const qoderRegion = input.harnessId === 'qoder-cn' ? 'cn' : input.harnessId === 'qoder-intl' ? 'intl' : undefined
    if (qoderRegion !== undefined && input.region !== undefined && input.region !== qoderRegion) {
      return { ok: false, reason: 'Qoder 账号区域必须与 CLI 版本一致', recovery: '国内使用 qoderclicn，国际使用 qodercli' }
    }
    if (input.displayName.trim().length === 0) {
      return { ok: false, reason: 'displayName 不能为空', recovery: '给档案一个可读的显示名' }
    }
    const profile = isolationProfileFor(input.harnessId)
    if (!profile.mayAddAccounts) {
      // ★ 这就是「不伪造支持」的落点。
      return {
        ok: false,
        reason: `不能为 harness "${input.harnessId}" 新增账号档案：${profile.refuseReason ?? profile.disclosure}`,
        recovery:
          '先拿到**可复现的隔离证据**（换目录/换开关后认证身份确实改变），再把这个 harness 加进 ISOLATION_PROFILES 的 mayAddAccounts 白名单。'
          + '在此之前新增只会造出「名字不同、其实是同一个账号」的假档案。',
      }
    }
    const record: CustomAccountRecord = {
      id: input.id,
      harnessId: input.harnessId,
      targetName: input.targetName,
      displayName: input.displayName.trim(),
      region: qoderRegion ?? input.region ?? 'unknown',
      configDirSubdir: input.configDirSubdir ?? input.id,
      ...(input.defaultProvider === undefined ? {} : { defaultProvider: input.defaultProvider }),
      ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: at,
    }
    if (record.configDirSubdir.includes('/') || record.configDirSubdir.includes('\\') || record.configDirSubdir.includes('..')) {
      return { ok: false, reason: 'configDirSubdir 不允许包含路径分隔符或 ..', recovery: '用一个纯目录名（例如 qoder-cn-c）' }
    }
    return {
      ok: true,
      id: record.id,
      state: { ...state, custom: [...state.custom, record], updatedAt: at },
      note: `已新增档案 ${record.id}（${record.displayName}，harness=${record.harnessId}）。`
        + `默认 provider/model 未设置时留空，不会替它猜。`
        + `该 harness 的隔离依据：${profile.disclosure}`,
    }
  }

  if (action.kind === 'update') {
    const exists = builtinIds.includes(action.id) || state.custom.some((c) => c.id === action.id)
    if (!exists) {
      return { ok: false, reason: `档案 "${action.id}" 不存在`, recovery: '先 create 或核对 id' }
    }
    if (action.patch.displayName !== undefined && action.patch.displayName.trim().length === 0) {
      return { ok: false, reason: 'displayName 不能改成空串', recovery: '给一个非空显示名，或干脆不改这个字段' }
    }
    const owner = ACCOUNT_SEEDS.find((seed) => seed.id === action.id) ?? state.custom.find((record) => record.id === action.id)
    const fixedRegion = owner?.harnessId === 'qoder-cn' ? 'cn' : owner?.harnessId === 'qoder-intl' ? 'intl' : undefined
    if (fixedRegion !== undefined && action.patch.region !== undefined && action.patch.region !== fixedRegion) {
      return { ok: false, reason: 'Qoder 账号区域不能脱离其 CLI 版本', recovery: '创建对应区域的新档案' }
    }
    const merged: AccountPatch = { ...(state.patches[action.id] ?? {}), ...action.patch }
    return {
      ok: true,
      id: action.id,
      state: { ...state, patches: { ...state.patches, [action.id]: merged }, updatedAt: at },
      note: `已更新档案 ${action.id} 的字段：${Object.keys(action.patch).join(', ')}。`
        + '注意：改显示名/默认值**不改变**该账号在已运行任务里的身份 —— 运行中的任务绑定它创建时的账号。',
    }
  }

  if (action.kind === 'delete') {
    const isBuiltin = builtinIds.includes(action.id)
    const isCustom = state.custom.some((c) => c.id === action.id)
    if (!isBuiltin && !isCustom) {
      return { ok: false, reason: `档案 "${action.id}" 不存在`, recovery: '核对 id' }
    }
    if (isBuiltin) {
      if (state.tombstones.includes(action.id)) {
        return { ok: true, id: action.id, state, note: `内置档案 ${action.id} 已处于停用状态（幂等）` }
      }
      return {
        ok: true,
        id: action.id,
        state: { ...state, tombstones: [...state.tombstones, action.id], updatedAt: at },
        note: `内置档案 ${action.id} 已**停用**（墓碑），而不是从代码里删掉 —— 否则下次升级会把它复活，用户会以为删除没生效。`
          + '它已从账号池与派发候选中移除；如需恢复用 restore。',
      }
    }
    return {
      ok: true,
      id: action.id,
      state: { ...state, custom: state.custom.filter((c) => c.id !== action.id), updatedAt: at },
      note: `已删除新增档案 ${action.id}。**没有删除任何凭据**：该档案目录（若存在）保持原样，'
        + '因为里面的东西属于厂商原生认证存储，本插件不碰。如需彻底清理请用该 CLI 自己的退出流程。`,
    }
  }

  // restore
  if (!state.tombstones.includes(action.id)) {
    return { ok: false, reason: `档案 "${action.id}" 没有被停用过`, recovery: '只有被 delete 停用的内置档案才需要恢复' }
  }
  return {
    ok: true,
    id: action.id,
    state: { ...state, tombstones: state.tombstones.filter((id) => id !== action.id), updatedAt: at },
    note: `已恢复内置档案 ${action.id}。它默认仍**不在**启用的账号池内（自动切换默认关闭）。`,
  }
}

/**
 * 把注册表叠加到内置种子上，得到**实际生效**的账号列表。
 *
 * 顺序：内置（减墓碑、套 patch）→ 追加新增档案。
 * 新增档案的隔离披露**逐字**来自 `isolationProfileFor`，不允许调用方覆盖 ——
 * 否则「披露」就变成了可选项。
 */
export function effectiveSeeds(
  state: AccountRegistryFile,
  base: readonly AccountSeed[] = ACCOUNT_SEEDS,
): AccountSeed[] {
  const out: AccountSeed[] = []
  const patchOf = (id: string, seed: AccountSeed): AccountSeed => {
    const patch = state.patches[id]
    if (patch === undefined) return seed
    const next: AccountSeed = {
      ...seed,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.region === undefined ? {} : { region: patch.region }),
      ...(patch.defaultProvider === null ? { defaultProvider: undefined }
        : patch.defaultProvider === undefined ? {} : { defaultProvider: patch.defaultProvider }),
      ...(patch.defaultModel === null ? { defaultModel: undefined }
        : patch.defaultModel === undefined ? {} : { defaultModel: patch.defaultModel }),
      ...(patch.note === undefined || patch.note === null ? {} : { limits: [...seed.limits, `备注：${patch.note}`] }),
    }
    // 让「改过」这件事可见 —— 不许悄悄改掉实测结论。
    return { ...next, limits: [...next.limits.filter((l) => !l.startsWith('已由用户修改')), '已由用户修改：显示名/默认值可能不再等于实测记录'] }
  }

  for (const seed of base) {
    if (state.tombstones.includes(seed.id)) continue
    out.push(patchOf(seed.id, seed))
  }
  for (const record of state.custom) {
    const profile = isolationProfileFor(record.harnessId)
    const template = base.find((s) => s.harnessId === record.harnessId)
    const configDir = join(ACCOUNTS_ROOT, record.configDirSubdir)
    const launch = launchFor(profile, template, record.targetName)
    const patched = patchOf(record.id, {
      id: record.id,
      targetName: record.targetName,
      harnessId: record.harnessId,
      displayName: record.displayName,
      region: record.region,
      configDir,
      nativeAuthRef: {
        kind: profile.mechanism !== null && profile.launchKind === 'env' ? 'vendor-store' : 'file',
        scope: profile.authStoreIsolated ? 'isolated' : 'unknown',
        locator: profile.mechanism === null
          ? '(未找到隔离开关)'
          : `${profile.mechanism} → 本档案配置目录`,
      },
      isolation: {
        configDirIsolated: profile.configDirIsolated,
        authStoreIsolated: profile.authStoreIsolated,
        sharedWith: [],
        disclosure: profile.disclosure,
        // 依据必须能给出来；空数组 = 无依据声明，验收会判失败。
        evidence: [...profile.evidence],
      },
      launch,
      switchSemantics: {
        currentSession: 'requires-new-process',
        note: '配置目录/环境变量在进程启动时确定，切换必须起新进程；已在跑的派发继续用它创建时的账号。',
      },
      ...(record.defaultProvider === undefined ? {} : { defaultProvider: record.defaultProvider }),
      ...(record.defaultModel === undefined ? {} : { defaultModel: record.defaultModel }),
      limits: [
        `新增档案（创建于 ${record.createdAt}）——它的隔离结论沿用该 harness 的实测记录，未单独复测`,
        ...profile.limits,
      ],
      identityProbe: template?.identityProbe ?? (record.harnessId === 'qoder-intl' ? { args: ['status', '-o', 'json'], configDirFlag: '--config-dir', json: { loggedIn: 'logged_in', identity: 'username' } } : {
        args: [],
        unavailableReason: `harness "${record.harnessId}" 没有可用的只读身份探测配方，身份只能靠真实模型请求证明`,
      }),
    })
    out.push(patched)
  }
  return out
}

export { existsSync }

