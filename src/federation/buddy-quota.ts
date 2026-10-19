/**
 * Buddy Switch（本机桌面管理器）**积分快照**的只读读取。
 *
 * ## 为什么必须有这条路径
 * `AccountManagers` 的 HTTP 通道（`buddyUrl` → `/api/accounts?variant=…`）只存在于 Buddy Switch 的
 * **webui 构建**里；本机装的是 **Tauri 桌面版**（`buddy-switch-rust.exe`，`NextAgentX/trae-workbuddy-switch`），
 * 桌面端走 Tauri IPC，**不监听任何端口**。本机实测（2026-10-14）：全量监听端口扫描里没有该服务，
 * 插件里 `buddyUrl` 也是空串 ⇒ 那条通道在本机**不可用**，不是「配置漏了」。
 *
 * 而桌面版会把每个账号的**官方积分**落盘到 `%USERPROFILE%\.buddy-switch\state.json`：
 *
 *     { saved_at_ms, accounts: { "<managerId>": { realm, nickname, credits, credits_expiring,
 *         credits_refreshed_ms, disabled, breaker_until_ms, model_cooldowns, … } } }
 *
 * 这个文件**不含任何令牌**。（令牌在同目录的 `accounts.json` / `accounts.global.json` 里 ——
 * **本模块从不打开那两个文件**，连 `existsSync` 都不做。）
 *
 * ## 纪律（与 `readModelCatalogFile` 同一套，且更严）
 *   · **字段白名单**：只取下面列出的键，其它键一律不读、不外传；
 *   · 昵称只用于本地识别，**输出一律脱敏**（掩码），并且**像令牌的一律丢弃**；
 *   · 只读：不写、不复制、不解密、不修改厂商程序；
 *   · **陈旧快照一律判 `unknown`**：绝不用一份过期额度去触发「额度耗尽 → 换账号」，
 *     那是本插件里破坏性最强的自动化，判错会把还能用的账号停掉；
 *   · 未知就是未知：文件不存在 / 解析失败 / `credits` 不是有限数 ⇒ `unknown`，**不猜 0**。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** `credits` 里出现这些形状时一律丢弃（本机实测有个账号昵称就是 sk 开头的串）。 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}/,
  /^(sk|pk|ghp|ox|xox)[-_]/i,
  /^[A-Za-z0-9+/=_-]{40,}$/,
]

export type BuddyQuotaState = 'available' | 'exhausted' | 'unknown'

export interface BuddyQuotaAccount {
  /** 与 HTTP 通道同一套句柄公式，便于两条路径指向同一个账号。 */
  readonly handle: string
  /** 厂商服务区域：`cn` = 国内版，`ai` = 国际版（WorkBuddy AI）。管理员里叫 `global`。 */
  readonly region: 'cn' | 'ai' | 'unknown'
  /** 脱敏昵称（掩码后）。可能为空 —— 昵称为令牌形状时被丢弃。 */
  readonly label: string
  readonly credits: number | null
  /** 临期积分（7 天内到期）。管理器给不出时为 null。 */
  readonly expiring: number | null
  /** 这份积分的**采集时间**（ISO）；管理员没给则为 null。 */
  readonly refreshedAt: string | null
  /** 管理器自己标记的停用位（不等于额度耗尽）。 */
  readonly disabled: boolean
  /** 管理器熔断到期时间（ISO）；未熔断为 null。 */
  readonly breakerUntil: string | null
  readonly state: BuddyQuotaState
  /** 判定依据（必须能说清「你凭什么这么说」）。 */
  readonly reason: string
}

export interface BuddyQuotaSnapshot {
  /** 快照**是否可用**（文件在、能解析、且整体未过期）。 */
  readonly available: boolean
  readonly file: string
  readonly savedAt: string | null
  readonly accounts: readonly BuddyQuotaAccount[]
  /** 不可用时说明原因；可用时为空串。 */
  readonly reason: string
  /** 界面必须原样显示的边界说明。 */
  readonly note: string
}

/** 默认新鲜度上限：超过这个时长的积分快照不参与任何判定。 */
export const BUDDY_QUOTA_MAX_AGE_MS = 6 * 60 * 60 * 1000

const NOTE = '来自本机 Buddy Switch 桌面版落盘的**官方积分快照**（只读；该文件不含令牌）。'
  + '未绑定到执行档案 ⇒ **不参与**自动切换；陈旧或缺失一律显示「未知」，不会用过期额度停用账号。'

const isObj = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 有限非负数；其它一律 null（**不把 undefined 当 0**）。 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function iso(value: unknown): string | null {
  const ms = num(value)
  if (ms === null || ms <= 0) return null
  try {
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

function looksLikeSecret(value: string): boolean {
  return TOKEN_SHAPES.some((re) => re.test(value))
}

/** 昵称脱敏：邮箱留前两位 + 域名，其它留前 2 字；命中令牌形状直接丢弃。
 *
 * 掩码用 `…`（与项目里既有的 `acct:…-aa` 同一风格）而**不是 `***`**：
 * 星号会在「界面上不得出现字面 `**`」的冒烟断言里被当成 markdown 泄漏，造成假阳性。 */
export function maskNickname(value: string): string {
  const raw = value.trim()
  if (raw.length === 0) return ''
  if (looksLikeSecret(raw)) return ''
  const at = raw.indexOf('@')
  if (at > 0) {
    const head = raw.slice(0, at)
    const domain = raw.slice(at + 1)
    const keep = head.slice(0, Math.min(2, head.length))
    return keep + '\u2026@' + domain
  }
  if (raw.length <= 2) return raw.slice(0, 1) + '\u2026'
  return raw.slice(0, 2) + '\u2026'
}

/** 与 `account-managers.handleFor` 同一套公式：同一个账号在两条路径上得到同一个句柄。 */
export function buddyHandle(region: string, id: string): string {
  return 'mgr-' + createHash('sha256').update('buddy' + '\u0000' + region + '\u0000' + id).digest('hex').slice(0, 24)
}

/** `state.json` 的 `realm` → 管理器区域的 `variant` 取值。 */
export function buddyRegionOf(realm: string): 'cn' | 'ai' | 'unknown' {
  if (realm === 'cn') return 'cn'
  if (realm === 'global' || realm === 'ai') return 'ai'
  return 'unknown'
}

/** 默认快照路径；允许用环境变量覆盖（测试与多机场景）。 */
export function buddyStateFile(): string {
  const override = process.env.DSH_BUDDY_STATE_FILE
  if (typeof override === 'string' && override.length > 0) return override
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return home.length > 0 ? join(home, '.buddy-switch', 'state.json') : ''
}

const MAX_BYTES = 4 * 1024 * 1024

/**
 * 读一次积分快照。**永不抛错**：任何异常都折成 `available:false` + 原因。
 * 这是刻意的 —— 一个额度读取失败不该让整个账号池接口挂掉。
 */
export function readBuddyQuota(options: { file?: string; now?: number; maxAgeMs?: number } = {}): BuddyQuotaSnapshot {
  const file = options.file ?? buddyStateFile()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? BUDDY_QUOTA_MAX_AGE_MS
  const fail = (reason: string): BuddyQuotaSnapshot => ({ available: false, file, savedAt: null, accounts: [], reason, note: NOTE })

  if (file.length === 0) return fail('未定位到用户目录，无法确定 Buddy Switch 快照路径')
  if (!existsSync(file)) {
    return fail('未找到 Buddy Switch 快照（该桌面版未安装或从未运行过）；这不代表额度为 0')
  }
  let raw: string
  try {
    const size = statSync(file).size
    if (size > MAX_BYTES) return fail('快照文件超过大小上限，拒绝读取')
    raw = readFileSync(file, 'utf8')
  } catch {
    return fail('快照文件无法读取')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('快照文件不是有效 JSON（可能正在被管理器写入，稍后重试）')
  }
  const root = isObj(parsed) ? parsed : {}
  const savedAt = iso(root.saved_at_ms)
  const accountsRaw = isObj(root.accounts) ? root.accounts : {}
  const accounts: BuddyQuotaAccount[] = []
  for (const [id, value] of Object.entries(accountsRaw)) {
    if (id.length === 0 || !isObj(value)) continue
    const region = buddyRegionOf(str(value.realm))
    const credits = num(value.credits)
    const expiring = num(value.credits_expiring)
    const refreshedAt = iso(value.credits_refreshed_ms)
    const refreshedMs = num(value.credits_refreshed_ms)
    const breakerMs = num(value.breaker_until_ms)
    const disabled = value.disabled === true
    const stale = refreshedMs === null || now - refreshedMs > maxAgeMs
    let state: BuddyQuotaState = 'unknown'
    let reason = ''
    if (credits === null) {
      reason = '管理器没有给出可用积分数值 ⇒ 未知（不当作 0）'
    } else if (stale) {
      reason = '积分快照已过期（最后采集 ' + String(refreshedAt ?? '(未提供)') + '）⇒ 未知，不用陈旧额度做判定'
    } else if (credits <= 0) {
      state = 'exhausted'
      reason = '管理器采集到的官方积分为 0（采集时间 ' + String(refreshedAt ?? '(未提供)') + '）'
    } else {
      state = 'available'
      reason = '管理器采集到的官方积分 ' + String(credits) + '（采集时间 ' + String(refreshedAt ?? '(未提供)') + '）'
    }
    accounts.push({
      handle: buddyHandle(region === 'unknown' ? 'cn' : region, id),
      region,
      label: maskNickname(str(value.nickname)),
      credits,
      expiring,
      refreshedAt,
      disabled,
      breakerUntil: breakerMs !== null && breakerMs > 0 ? iso(breakerMs) : null,
      state,
      reason,
    })
  }
  if (accounts.length === 0) return Object.assign(fail('快照里没有任何账号记录'), { savedAt })
  // 整体新鲜度：以全部账号里**最新**的一次采集为准，用于给界面一个总开关式的提示。
  const newest = accounts.map((a) => (a.refreshedAt === null ? 0 : Date.parse(a.refreshedAt))).reduce((a, b) => (b > a ? b : a), 0)
  const overallStale = newest === 0 || now - newest > maxAgeMs
  return {
    available: !overallStale,
    file,
    savedAt,
    accounts: accounts.sort((a, b) => a.handle.localeCompare(b.handle)),
    reason: overallStale ? '积分快照已过期（超过 ' + String(Math.round(maxAgeMs / 60000)) + ' 分钟未刷新）⇒ 只展示，不参与判定' : '',
    note: NOTE,
  }
}
