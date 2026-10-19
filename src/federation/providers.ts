/**
 * 供应商 / 模型**真实发现**（P3）—— 四态分离，任何一态都不得越级宣称。
 *
 *   configured   —— 该 Harness 的**原生配置**里确实写着它
 *   discoverable —— 该 Harness **自己列得出来**（`--list-models` / `models` / 目录命令）
 *   auth-valid   —— 有正面证据说明**该账号的凭据被接受**（认证门槛之后的列表命令成功）
 *   usable       —— **真实完成过一次模型请求**（账本里有 non-empty 回复）
 *
 * 三条硬约束（对应验收要求）：
 *   1. **不许**把 DSH 本 profile 的供应商/模型混进外部 Harness 的列表。DSH 侧单独一栏
 *      （`dshNative`），来源标 `dsh-native`；外部列表里出现 `dsh-native` 一律视为缺陷。
 *   2. **不许**在没有证据时把模型说成可用。列不出来就返回空数组 + 明确原因，
 *      **不编造**、不用 DSH 的列表填充。
 *   3. **不许**只给一个可任意填写的字符串。本模块产出的是一组**受约束的候选项**，
 *      每个都带四态与证据；「手动输入」必须由调用方显式标注为未验证。
 *
 * 本文件只 import `./types.js` / `./catalog.js` 与 `node:*`，可脱离宿主单独跑。
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { HarnessSeed } from './catalog.js'
import { resolveInvocation } from './registry.js'
import type { Availability, ModelRecord, ProviderInventory, ProviderRecord } from './types.js'
import type { TargetConfig } from '../types.js'
import { discoverLocalModelCatalog, type NativeCatalogEntry } from '../native-model-catalog.js'

/** 一次**真实完成**的模型请求证据（来自插件自己的任务账本，不是推断）。 */
export interface UsableEvidence {
  readonly runId: string
  readonly target: string
  /** 账本里记录的实际模型；null = 当时用的是该 harness 的默认模型。 */
  readonly model: string | null
  readonly at: string
  readonly transport: string
  readonly outputChars: number
  readonly excerpt: string
}

/** 落盘 diagnostic 里的「非 0 退出」痕迹（headless 通道只在 code≠0 时才写这句话）。 */
const NONZERO_EXIT_IN_DIAGNOSTIC = /exited with code\s+(-?\d+)/i
/** 落盘 diagnostic 里的「被信号终止」痕迹。 */
const SIGNAL_IN_DIAGNOSTIC = /terminated by signal\s+\S+|signal\s+SIG[A-Z]+/i
/**
 * 「整条正文就是一句认证提示」的形状：CLI 的登录/鉴权错误行，**不是**模型回复。
 * 只用于**整条**正文的判定（见 `usableEvidenceRejection` 的长度上限），不做子串扫描。
 */
const AUTH_NOTICE_HEAD = /^(not logged in|please (run )?\/?log ?in\b|log ?in required|login required|not authenticated|unauthenticated|unauthorized[.:!]?|invalid api key|failed to authenticate|authentication (required|failed))/i
/** 认证提示的正文长度上限（超过这个长度就不再当作「只是一句登录提示」）。 */
const AUTH_NOTICE_MAX_CHARS = 200

/**
 * 一条**已落盘**的派发记录不足以当作「模型可用」证据的原因（`undefined` = 判据通过）。
 *
 * ## 为什么必须看 `diagnostic`，而不是只看「有非空文本」
 * headless 通道曾经把「非 0 退出**但**有 stdout」报成 `stopReason: 'completed'`
 * （原始证据逐字留在 `probe/out/auto-switch-live.json` 的 `realDispatches[1]`：
 * `text="Not logged in · Please run /login"`、
 * `diagnostic="harness exited with code 1 after producing output"`，而 `stopReason` 写着 `completed`）。
 * 因此这类「认证失败的 stdout」在**落盘时** `status` 与 `result.stopReason` 双双是 `completed`
 * —— 光看这两个字段**认不出来**。
 *
 * ⚠️ 上级明确「历史账本不清洗」：本函数**只改读取判据**，绝不改写任何落盘记录；
 * 它依据的是**当时那一轮落盘的字面内容**（`diagnostic` / `text`），不是事后推断。
 *
 * 判据（任一命中即**不**计入 usable 证据）：
 *   1. `diagnostic` 里有 `exited with code N` 且 N ≠ 0 ⇒ 进程非正常退出；
 *   2. `diagnostic` 里有被信号终止的痕迹 ⇒ 这一轮没有正常跑完；
 *   3. 整条正文（≤ {@link AUTH_NOTICE_MAX_CHARS} 字符）就是一句「请先登录」的认证提示
 *      ⇒ 那是 CLI 的鉴权错误，**不是**一次模型完成。
 *
 * 纯函数、只读、可离线单测：判据必须能被探针直接调用，否则它只会是「看起来写了」。
 */
export function usableEvidenceRejection(record: {
  readonly stopReason?: unknown
  readonly diagnostic?: unknown
  readonly text?: unknown
}): string | undefined {
  const diagnostic = typeof record.diagnostic === 'string' ? record.diagnostic : ''
  const exit = NONZERO_EXIT_IN_DIAGNOSTIC.exec(diagnostic)
  if (exit !== null) {
    const code = Number(exit[1])
    if (Number.isFinite(code) && code !== 0) {
      return `该轮进程以非 0 退出码 ${code} 结束（落盘 diagnostic 原文：${diagnostic.replace(/\s+/g, ' ').slice(0, 160)}）`
        + '—— 这不是一次真实的模型完成，不得计为 usable 证据。'
    }
  }
  if (SIGNAL_IN_DIAGNOSTIC.test(diagnostic)) {
    return `该轮进程被信号终止（落盘 diagnostic 原文：${diagnostic.replace(/\s+/g, ' ').slice(0, 160)}）`
      + '—— 没有正常跑完，不得计为 usable 证据。'
  }
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (text.length > 0 && text.length <= AUTH_NOTICE_MAX_CHARS && AUTH_NOTICE_HEAD.test(text)) {
    return `该轮正文整条都是认证提示（${text.replace(/\s+/g, ' ').slice(0, 80)}）`
      + '—— 那是 CLI 的登录/鉴权错误，不是模型回复，不得计为 usable 证据。'
  }
  return undefined
}

/** 读任务账本，挑出「真的完成了、并且真的回了内容」的记录。 */
export function readUsableEvidence(taskDir: string, limit = 2000): UsableEvidence[] {
  const out: UsableEvidence[] = []
  let names: string[]
  try {
    names = readdirSync(taskDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue
    try {
      const view = JSON.parse(readFileSync(join(taskDir, name), 'utf8')) as {
        task_id?: string
        target?: string
        model?: string | null
        status?: string
        transport?: string
        updated_at?: number
        output_chars?: number
      }
      // 只有真正成功终态才算证据；`timeout`/`error`/`interrupted` 一律不算。
      if (view.status !== 'completed') continue
      if ((view.output_chars ?? 0) <= 0) continue
      const resultPath = join(taskDir, `${view.task_id ?? name.replace(/\.json$/, '')}.result.json`)
      if (!existsSync(resultPath)) continue
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { stopReason?: string; text?: unknown; diagnostic?: unknown }
      const text = typeof result.text === 'string' ? result.text : ''
      // 空回复不算「用得了」—— 这正是本轮要防的假阳性。
      if (text.trim().length === 0) continue
      if (result.stopReason !== undefined && !/^(completed|end_turn)$/i.test(result.stopReason)) continue
      // 光看上面两个字段**认不出**历史里那些「非 0 退出却写着 completed」的记录（历史不清洗），
      // 所以这里必须再按**当时那一轮落盘的 diagnostic / text** 判一次。
      const rejected = usableEvidenceRejection({ stopReason: result.stopReason, diagnostic: result.diagnostic, text })
      if (rejected !== undefined) continue
      // §20 裁定（Lead 定）：再按 **view 侧**的 diagnostic 判一次。
      // 起因：上面只读了 `.result.json` 的 diagnostic，**没读 TaskView 的**。就本账本实测
      // 「仅 view 侧有痕迹」为 0 例（34 条痕迹在 view / result **两侧都有**），所以这是
      // **结构性闭合**（将来某条只在 view 侧留痕也不会漏），不改变任何既有判定结果。
      // 刻意**不扫 facts**：那会引入新的形状依赖，收益未见、风险多一处。
      const rejectedView = usableEvidenceRejection({
        stopReason: result.stopReason,
        diagnostic: (view as { diagnostic?: unknown }).diagnostic,
        text,
      })
      if (rejectedView !== undefined) continue
      out.push({
        runId: String(view.task_id ?? name),
        target: String(view.target ?? ''),
        model: typeof view.model === 'string' && view.model.length > 0 ? view.model : null,
        at: new Date(view.updated_at ?? Date.now()).toISOString(),
        transport: String(view.transport ?? ''),
        outputChars: Number(view.output_chars ?? 0),
        excerpt: text.replace(/\s+/g, ' ').slice(0, 120),
      })
      if (out.length >= limit) break
    } catch {
      // 单条坏记录不该拖垮整份清单。
    }
  }
  return out
}

function availabilityRank(a: Availability): number {
  return { unavailable: 0, configured: 1, discoverable: 2, 'auth-valid': 3, usable: 4 }[a]
}

/** 取两态里更高的那个（四态是**有序**的，不能跳级凭空宣称）。 */
function higher(a: Availability, b: Availability): Availability {
  return availabilityRank(a) >= availabilityRank(b) ? a : b
}

// ─────────────────────── 列表输出解析 ───────────────────────

/** 剥 ANSI / 项目符号，供文本解析用。 */
function stripDecorations(line: string): string {
  return line
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^[\s*•·\-–—>]+/, '')
    .trim()
}

/** 按「制表符 / 2 个以上空格」切列 —— 各家表格都是用这种对齐方式。 */
function splitColumns(line: string): string[] {
  return line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0)
}

/** 常见 JSON 形状里的模型条目。 */
interface JsonModelLike {
  id?: unknown
  slug?: unknown
  model?: unknown
  name?: unknown
  displayName?: unknown
  provider?: unknown
  owned_by?: unknown
}

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,120}$/

/**
 * 明显的**噪声行**：表头、进度提示、纯英文句子。实测踩过：
 * pi 的 `--list-models` 是**空白对齐的表格**，首行是
 * `provider  model  context  max-out  thinking  images`；
 * agy 会先打 `Fetching available models...`。不排掉就会产出名叫
 * "provider"/"Fetching"/"No" 的假模型 —— 这正是本轮必须防的编造。
 */
const NOISE_WORDS = /^(no|none|n\/a|na|provider|providers|model|models|name|id|ids|available|fetching|loading|total|list|context|max-out|maxout|thinking|images|usage|options|commands|flags|usage|error|warning|note|hint|tip)$/i

/** 表格表头判定：一行里同时出现 provider 与 model 两个列名。 */
function isTableHeader(line: string): boolean {
  return /\bprovider\b/i.test(line) && /\bmodel\b/i.test(line)
}

/**
 * 表头里 provider / model 两列的位置（实测 `provider  model  context …` ⇒ 0 / 1）。
 * 拿不到列序时返回 null —— 那时只能靠行的形状判断，不能硬编码列号。
 */
function headerColumnIndexes(line: string): { provider: number, model: number } | null {
  const cols = splitColumns(line)
  const provider = cols.findIndex((c) => /^providers?$/i.test(c))
  const model = cols.findIndex((c) => /^models?$/i.test(c))
  if (provider < 0 || model < 0 || provider === model) return null
  return { provider, model }
}

/**
 * 一条候选 id 是否**像**模型 id（而不是某个英文单词、表头词或纯数字）。
 *
 * 为什么要求「含字母」**且**「含数字或分隔符」：
 *  - `pi --list-models` 的第一列是**供应商名**，供应商名与散文词（`Fetching`/`Available`）
 *    都是纯英文单词 ⇒ 无数字无分隔符的一律不是模型 id；
 *  - `401` / `2024` 这类纯数字出现在错误输出里也不能当 id ⇒ 必须含至少一个字母。
 * 实测踩过的坑（表头 `provider`、供应商列 `antigravity`、认证散文 `You are not authenticated.`）
 * 都在这条判据上收口。
 */
function looksLikeModelId(token: string): boolean {
  if (token.length < 2 || token.length > 120) return false
  if (!ID_SHAPE.test(token)) return false
  if (NOISE_WORDS.test(token)) return false
  if (!/[A-Za-z]/.test(token)) return false
  if (!/[0-9._:/#@+-]/.test(token)) return false
  return true
}

/** 一次解析的**形状**（给探针/审计用：证明表头与供应商列是在哪一步被排除的）。 */
export interface ModelListShape {
  readonly shape: 'json' | 'table' | 'lines' | 'empty'
  /** 表头行原文；没有表头 = null。 */
  readonly headerLine: string | null
  /** 被判为**供应商列**的取值（同一个词在第一列反复出现 ≥2 次）。 */
  readonly providerColumns: readonly string[]
  /** 参与判定的非空数据行数（表头不计）。 */
  readonly dataLines: number
  /** 表格形状下按「供应商列 + 模型列」处理的行数。 */
  readonly tableRows: number
}

interface AnalyzedList {
  readonly shape: ModelListShape
  readonly models: ModelRecord[]
}

/**
 * **唯一**一份解析实现：`parseModelListOutput`（模型集合）与 `modelListShape`（形状）
 * 都从这里取结果 —— 两个出口共用一份判定，不允许各自长出一套（这正是本模块踩过的坑）。
 */
function analyzeModelList(raw: string): AnalyzedList {
  const models = new Map<string, ModelRecord>()

  const push = (id: string, name?: string, provider?: string): void => {
    const trimmed = id.trim()
    if (!looksLikeModelId(trimmed)) return
    const key = provider !== undefined && provider.length > 0 ? `${provider}/${trimmed}` : trimmed
    if (models.has(key)) return
    models.set(key, {
      id: key,
      name: name !== undefined && name.trim().length > 0 ? name.trim() : undefined,
      // 能被列出来 = discoverable。**不得**在这里直接写 usable。
      availability: 'discoverable',
      evidence: '由该 harness 自己的模型列表命令列出',
    })
  }

  // ── 1) JSON（codex `debug models` 这类）──
  const text = raw.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      const arrays: unknown[][] = []
      const visit = (node: unknown, depth: number): void => {
        if (depth > 4 || node === null || node === undefined) return
        if (Array.isArray(node)) {
          if (node.length > 0 && node.every((x) => typeof x === 'object' && x !== null)) arrays.push(node as unknown[])
          return
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (Array.isArray(v) && /model|data|item|catalog/i.test(k)) arrays.push(v as unknown[])
            else visit(v, depth + 1)
          }
        }
      }
      visit(parsed, 0)
      for (const arr of arrays) {
        for (const entry of arr) {
          const m = entry as JsonModelLike
          // 真实字段名在不同 CLI 里不同：codex 用 slug，多数用 id。
          const id = [m.slug, m.id, m.model].find((v): v is string => typeof v === 'string' && v.trim().length > 0)
          if (id === undefined) continue
          const name = [m.displayName, m.name].find((v): v is string => typeof v === 'string')
          const provider = typeof m.provider === 'string' ? m.provider : (typeof m.owned_by === 'string' ? m.owned_by : undefined)
          push(id, name, provider)
        }
      }
      if (models.size > 0) {
        return {
          shape: { shape: 'json', headerLine: null, providerColumns: [], dataLines: 0, tableRows: 0 },
          models: [...models.values()],
        }
      }
    } catch {
      // 不是 JSON，继续。
    }
  }

  // ── 2) 空白对齐表格：`provider  model  context …` ──
  const lines = raw.split(/\r?\n/).map((l) => stripDecorations(l))
  const nonEmptyLines = lines.filter((l) => l.length > 0).length
  const headerIndex = lines.findIndex((l) => isTableHeader(l))
  const headerCols = headerIndex >= 0 ? headerColumnIndexes(lines[headerIndex] ?? '') : null

  // 没有表头时的**结构性**判据：同一个词反复出现在**第一列** ⇒ 那一列是供应商列，不是模型。
  // （只统计多列行；逐行一个 id 的输出里偶尔夹一两行两列文本不会凑够 ≥2 次。）
  const firstColumnCount = new Map<string, number>()
  for (const line of lines) {
    if (line.length === 0 || isTableHeader(line) || /^[-=]{3,}$/.test(line)) continue
    const cols = splitColumns(line)
    const head = cols[0]
    if (cols.length < 2 || head === undefined) continue
    firstColumnCount.set(head, (firstColumnCount.get(head) ?? 0) + 1)
  }
  const providerColumns = [...firstColumnCount.entries()].filter(([, n]) => n >= 2).map(([token]) => token)
  const multiColumnLines = [...firstColumnCount.values()].reduce((a, b) => a + b, 0)
  const tableLike = headerIndex >= 0
    || (providerColumns.length > 0 && multiColumnLines >= 2 && multiColumnLines * 2 >= nonEmptyLines)

  let tableRows = 0
  if (tableLike) {
    for (const line of (headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines)) {
      if (line.length === 0 || isTableHeader(line) || /^[-=]{3,}$/.test(line)) continue
      const cols = splitColumns(line)
      const first = cols[0]
      if (first === undefined) continue
      // 第一列是不是供应商列？表头给出列序时以表头为准；无表头时看「是否反复出现 / 是否像模型 id」。
      const providerIsFirst = headerCols !== null || providerColumns.includes(first) || !looksLikeModelId(first)
      if (providerIsFirst) {
        const providerAt = headerCols?.provider ?? 0
        const modelAt = headerCols?.model ?? 1
        const provider = cols[providerAt] ?? first
        const model = cols[modelAt]
        // 只有一列 ⇒ 这一行不是表格行（**供应商单独成行**就在这里被排除）。
        if (model === undefined) continue
        tableRows += 1
        push(model, undefined, provider)
      } else {
        // 第一列本身就是模型 id，第二列是展示名（agy 那种 `id<TAB>显示名`）。
        tableRows += 1
        push(first, cols[1])
      }
    }
    if (models.size > 0) {
      return {
        shape: {
          shape: 'table',
          headerLine: headerIndex >= 0 ? (lines[headerIndex] ?? null) : null,
          providerColumns,
          dataLines: nonEmptyLines - (headerIndex >= 0 ? 1 : 0),
          tableRows,
        },
        models: [...models.values()],
      }
    }
  }

  // ── 3) 逐行文本（`provider/model`、`id\tdisplay name`）──
  for (const line of lines) {
    if (line.length === 0) continue
    if (isTableHeader(line)) continue
    if (/^[-=]{3,}$/.test(line)) continue
    if (/^(error|warning|usage)\b/i.test(line)) continue
    // 取**第一个 token**：说明文字/展示名都在它后面（`grok-build (default)` 这种也要拿到 id）。
    const head = line.split(/\s+/)[0] ?? ''
    if (head.length === 0) continue
    const cleaned = head.replace(/[),;.]+$/, '')
    // 同一个词在前面被判成**供应商列** ⇒ 它是供应商行，不是模型。
    if (providerColumns.includes(cleaned) || providerColumns.includes(head)) continue
    const cols = splitColumns(line)
    const display = cols.length >= 2 && cols[0] === head ? cols[1] : undefined
    const slash = cleaned.indexOf('/')
    if (slash > 0 && slash < cleaned.length - 1) {
      push(cleaned.slice(slash + 1), display, cleaned.slice(0, slash))
    } else {
      push(cleaned, display)
    }
  }
  return {
    shape: {
      shape: models.size > 0 ? 'lines' : 'empty',
      headerLine: headerIndex >= 0 ? (lines[headerIndex] ?? null) : null,
      providerColumns,
      dataLines: nonEmptyLines,
      tableRows,
    },
    models: [...models.values()],
  }
}

/**
 * 解析模型清单输出。依次尝试：JSON → 空白对齐表格 → 逐行文本。
 * 解析不出来就返回空数组 —— **宁可空也不要编**。
 *
 * ⚠️ 这是本插件**唯一**的「harness 自己列了哪些模型」解析器：`/providers`、`/models`、
 * overview 三处必须都走它，否则同一次真实发现会在不同出口给出不同答案（实测缺陷）。
 */
export function parseModelListOutput(raw: string): ModelRecord[] {
  return analyzeModelList(raw).models
}

/** 上面那次解析的**形状**（表头行、供应商列、行数）—— 只读、纯函数，供探针取证。 */
export function modelListShape(raw: string): ModelListShape {
  return analyzeModelList(raw).shape
}

// ─────────────────────── 原生配置解析 ───────────────────────

/**
 * 从该 Harness 的原生配置文件里读出「已配置」的供应商/模型**名字**。
 *
 * 只提取**名字**，绝不读值 —— 配置文件里紧挨着名字的往往是密钥，本模块不碰。
 * 同时拒绝任何像令牌的字符串（长度大且含 base64/JWT 特征），避免误把凭据当模型名。
 */
export function readConfiguredNames(file: string): ModelRecord[] {
  const out: ModelRecord[] = []
  if (!existsSync(file)) return out
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  const looksLikeSecret = (s: string): boolean =>
    /eyJ[A-Za-z0-9_-]{10,}/.test(s) || /^[A-Za-z0-9+/=_-]{40,}$/.test(s) || /^(sk|pk|ghp|xox)[-_]/i.test(s)

  const push = (id: string): void => {
    const trimmed = id.trim()
    if (trimmed.length === 0 || trimmed.length > 120) return
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/.test(trimmed)) return
    if (looksLikeSecret(trimmed)) return
    if (out.some((m) => m.id === trimmed)) return
    out.push({
      id: trimmed,
      availability: 'configured',
      evidence: `出现在原生配置 ${file}`,
    })
  }

  // JSON 形态：找 provider / model 名字字段。
  const fileName = file.toLowerCase()
  try {
    const parsed: unknown = JSON.parse(text)
    const seen = new Set<string>()
    const visit = (node: unknown, key: string, depth: number): void => {
      if (depth > 6 || node === null || node === undefined) return
      if (typeof node === 'string') {
        if (/^(provider|providers|model|models|defaultModel|defaultProvider|modelId)$/i.test(key)) {
          if (!seen.has(node)) {
            seen.add(node)
            push(node)
          }
        }
        return
      }
      if (Array.isArray(node)) {
        for (const v of node) visit(v, key, depth + 1)
        return
      }
      if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          // `providers: { <name>: {...} }` 这种：键名就是供应商名。
          if (/^(providers|model_providers|models)$/i.test(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
            for (const name of Object.keys(v as Record<string, unknown>)) push(name)
          }
          visit(v, k, depth + 1)
        }
      }
    }
    visit(parsed, '', 0)
    if (out.length > 0) return out
  } catch {
    // 不是 JSON（例如 codex 的 config.toml），走文本解析。
  }

  // 文本 / TOML-lite：`[model_providers.<name>]`、`model = "<name>"`、`"<name>": {`
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const section = /^\[\s*(?:model_)?providers?\.([A-Za-z0-9._-]+)\s*\]$/.exec(line)
    if (section?.[1] !== undefined) {
      push(section[1])
      continue
    }
    const kv = /^(?:model|default_model|defaultModel|modelId)\s*[=:]\s*["']?([A-Za-z0-9._:/#@+-]+)["']?/.exec(line)
    if (kv?.[1] !== undefined) {
      push(kv[1])
      continue
    }
    if (/\.json$/i.test(fileName)) {
      const jsonKey = /^"([A-Za-z0-9._:/#@+-]{2,60})"\s*:\s*\{/.exec(line)
      if (jsonKey?.[1] !== undefined) push(jsonKey[1])
    }
  }
  return out
}

// ─────────────────────── 列表命令执行 ───────────────────────

export interface ListCommandResult {
  readonly argv: readonly string[]
  readonly ok: boolean
  readonly stdoutChars: number
  readonly models: readonly ModelRecord[]
  /** 非空 = 命令失败或被认为受认证阻塞，此时**不得**把结果当已认证。 */
  readonly error?: string
  readonly authBlocked: boolean
}

const AUTH_PATTERNS = /not logged in|authentication required|unauthor|please log ?in|login required|not authenticated|invalid api key|401/i

/**
 * 输出里是否出现**认证相关字样**（与列表命令同一份判据，导出给 `models.ts` 复用）。
 *
 * ⚠️ 只看**短文本**：stderr 全部 + stdout 前 2KB。全量扫描会把 605KB JSON 里任何一处
 * `not authenticated`/`401`（可能是某个未用供应商的元数据）误判成整批模型认证受阻。
 */
export function authBlockedInOutput(stdout: string, stderr: string): boolean {
  return AUTH_PATTERNS.test(`${stderr.slice(0, 4096)}\n${stdout.slice(0, 2048)}`)
}

export function runModelListCommand(
  entry: string,
  argv: readonly string[],
  childEnv: Record<string, string>,
  timeoutMs: number,
  wrapping = 'none',
): Promise<ListCommandResult> {
  const runArgv = [...argv]
  return new Promise<ListCommandResult>((resolve) => {
    if (runArgv.length === 0) {
      resolve({ argv: runArgv, ok: false, stdoutChars: 0, models: [], error: '该 harness 没有配置模型列表命令', authBlocked: false })
      return
    }
    // 与版本探测走**同一套**入口解析：`.js` 入口要用 node 跑（pi 就是这种），
    // `.cmd` 要经 cmd /c，需要 Electron Node 模式的要带 ELECTRON_RUN_AS_NODE。
    const inv = resolveInvocation(entry, runArgv, wrapping)
    execFile(
      inv.file,
      inv.argv,
      { timeout: timeoutMs, env: { ...process.env, ...childEnv, ...inv.env }, windowsHide: true, maxBuffer: 8 << 20 },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ''}`
        const err = `${stderr ?? ''}`
        const combined = `${out}\n${err}`
        // 认证判定只看**短文本**：stderr 全部 + stdout 前 2KB。
        // 为什么不能扫全量：codex `debug models` 是 605KB 的 JSON，模型元数据里
        // 任何一处出现 "not authenticated"/"401" 字样，就会把**整批模型**误判成
        // 「认证受阻」，进而把已经通过的 auth-valid 全部降级 —— 实测踩过这个坑。
        const authBlocked = authBlockedInOutput(out, err)
        // 解析**合并后**的输出：实测 mimo 与 agy 把模型表打到 stderr，
        // 只看 stdout 会得出「0 字节 = 没有模型」的错误结论。
        const models = parseModelListOutput(combined)
        if (models.length > 0) {
          resolve({
            argv: inv.argv,
            ok: true,
            stdoutChars: out.length,
            models,
            // 非零退出但**确实列出了模型** → 记成备注而不是失败（实测 agy 正是这种）。
            error: error === null || error === undefined
              ? undefined
              : `命令以非零退出但仍列出了模型：${String((error as { message?: string }).message ?? '').slice(0, 160)}`,
            authBlocked,
          })
          return
        }
        if (error !== null && error !== undefined) {
          resolve({
            argv: inv.argv,
            ok: false,
            stdoutChars: out.length,
            models: [],
            error: `${String((error as { message?: string }).message ?? 'command failed')}${err.trim().length > 0 ? ` | stderr: ${err.trim().slice(0, 200)}` : ''}`,
            authBlocked,
          })
          return
        }
        // **空结果是合法结果**，但要如实说清楚是因为空还是因为被拦。
        resolve({
          argv: inv.argv,
          ok: true,
          stdoutChars: out.length,
          models: [],
          error: authBlocked
            ? '列表命令成功但输出为空，且输出里出现认证相关字样'
            : `列表命令成功但没有任何可解析的模型（stdout ${out.length} / stderr ${err.length} 字节）`,
          authBlocked,
        })
      },
    )
  })
}

// ─────────────────────── 汇总 ───────────────────────

export interface InventoryOptions {
  readonly target?: TargetConfig
  readonly harnessId: string
  readonly accountId: string
  readonly seed?: HarnessSeed
  /** 目标名（账本里用的名字），用于把 usable 证据对上。 */
  readonly targetName?: string
  /** 已解析的真实入口；为空则不做命令发现。 */
  readonly entry?: string | null
  readonly env?: Readonly<Record<string, string>>
  readonly measure?: boolean
  readonly timeoutMs?: number
  readonly usable?: readonly UsableEvidence[]
  /** DSH 本 profile 的供应商 —— 单独一栏，**绝不**并入 native。 */
  readonly dshNative?: readonly ProviderRecord[]
}

export interface InventoryResult extends ProviderInventory {
  readonly catalog?: readonly NativeCatalogEntry[]
  readonly dshNative: readonly ProviderRecord[]
  readonly declared: {
    readonly listCommand: readonly string[]
    readonly configFiles: readonly string[]
    readonly authBlocked: boolean
  }
}

/**
 * 收集一个 Harness/账号的供应商与模型清单。
 *
 * 四态判定顺序（**只升不降**，且每一级都要证据）：
 *   configured（原生配置里有）
 *     → discoverable（该 harness 自己能列出来）
 *     → auth-valid（认证门槛之后的列表命令成功 = 凭据被接受）
 *     → usable（账本里有该模型的一次真实完成、非空回复）
 */
export async function collectProviderInventory(options: InventoryOptions): Promise<InventoryResult> {
  const seed = options.seed
  const measure = options.measure !== false
  const errors: string[] = []
  const native: ModelRecord[] = []
  const byId = new Map<string, ModelRecord>()
  const localCatalog = options.target === undefined ? undefined : discoverLocalModelCatalog(options.target)

  const upsert = (record: ModelRecord, source: string): void => {
    const prev = byId.get(record.id)
    if (prev === undefined) {
      byId.set(record.id, { ...record, evidence: `${source}: ${record.evidence ?? ''}`.trim() })
      return
    }
    byId.set(record.id, {
      ...prev,
      availability: higher(prev.availability, record.availability),
      evidence: `${prev.evidence ?? ''}；${source}: ${record.evidence ?? ''}`,
    })
  }

  // 1) configured —— 原生配置
  for (const entry of localCatalog?.entries ?? []) {
    upsert({ id: entry.id, availability: entry.source === 'native-config' ? 'configured' : 'discoverable', evidence: `${entry.evidence}；${entry.selectable ? '可选择；实际可用性待执行确认' : '仅展示，不可作为 CLI 模型参数'}` }, entry.source)
  }
  const configFiles = seed?.providerConfigFiles ?? []
  for (const file of configFiles) {
    for (const m of readConfiguredNames(file)) upsert(m, '原生配置')
  }

  // 2) discoverable —— 该 harness 自己的列表命令
  let listCommand: readonly string[] = []
  let authBlocked = false
  if (seed !== undefined) {
    // 种子里的 `modelListArgs` **已经是 argv**（生成脚本已剥掉命令名、清洗掉占位符散文），
    // 这里绝不能再剥一次 —— 实测事故：重复剥离把 codex 的 `debug models` 削成 `models`，
    // 于是 `codex.exe models` 直接报 "stdin is not a tty"，模型列表整批消失。
    const parts = options.target && options.target.modelsArgs.length > 0 ? options.target.modelsArgs : seed.modelListArgs
    listCommand = parts
    if (measure && options.entry !== null && options.entry !== undefined && parts.length > 0) {
      const result = await runModelListCommand(
        options.entry,
        parts,
        { ...(options.env ?? {}) },
        options.timeoutMs ?? 30000,
        seed.shimWrappingRequired,
      )
      if (!result.ok) {
        errors.push(`列表命令失败：${result.error ?? '未知原因'}`)
        authBlocked = result.authBlocked
      } else if (result.models.length === 0) {
        // 空列表**照实报空**，不拿别的东西填。
        errors.push(`列表命令返回空：${result.error ?? '没有可解析的模型'}`)
        authBlocked = result.authBlocked
      } else {
        // 列出了模型：如果命令本身报过非零退出，把原因记成**备注**而不是抹掉。
        if (result.error !== undefined) errors.push(`备注：${result.error}`)
        authBlocked = result.authBlocked
        for (const m of result.models) {
          // 只有**认证门槛之后成功**才升到 auth-valid。若输出里同时出现认证字样
          // （例如「未登录，以下是目录」），就只到 discoverable —— 不许越级。
          upsert(
            {
              ...m,
              availability: result.authBlocked ? 'discoverable' : 'auth-valid',
              evidence: result.authBlocked
                ? `该 harness 列出了它，但输出里出现认证相关字样，故只算 discoverable`
                : `列表命令在认证门槛后成功（stdout ${result.stdoutChars} 字节；解析自 stdout+stderr）`,
            },
            result.authBlocked ? 'discoverable' : 'discoverable+auth',
          )
        }
      }
    } else if (parts.length === 0) {
      errors.push('该 harness 没有可用的模型列表命令，无法通过命令发现模型')
    }
  }

  // 3) usable —— 账本里的真实完成记录
  const targetName = options.targetName ?? options.harnessId
  const usableRuns = (options.usable ?? []).filter((u) => u.target === targetName)
  for (const run of usableRuns) {
    if (run.model === null) continue
    const id = run.model
    const prev = byId.get(id)
    upsert(
      {
        id,
        name: prev?.name,
        availability: 'usable',
        evidence: `真实完成过一次请求（run ${run.runId.slice(0, 8)}，${run.outputChars} 字节回复，transport=${run.transport}）`,
      },
      'usable',
    )
  }

  const models = [...byId.values()].sort((a, b) => availabilityRank(b.availability) - availabilityRank(a.availability) || a.id.localeCompare(b.id))
  // 供应商：模型 id 里带 `provider/` 的按前缀分组；其余归到 harness 默认供应商。
  const providerMap = new Map<string, ModelRecord[]>()
  for (const m of models) {
    const slash = m.id.indexOf('/')
    const catalogProvider = localCatalog?.entries.find((entry) => entry.id === m.id)?.provider
    const providerId = catalogProvider ?? (slash > 0 ? m.id.slice(0, slash) : `${options.harnessId}:default`)
    const list = providerMap.get(providerId) ?? []
    list.push(m)
    providerMap.set(providerId, list)
  }
  const providers: ProviderRecord[] = [...providerMap.entries()].map(([id, ms]) => ({
    id,
    displayName: id.endsWith(':default') ? `${options.harnessId} 默认` : id,
    source: ms.every((m) => localCatalog?.entries.some((entry) => entry.id === m.id)) ? 'cli-native-config' : 'cli-list-command',
    models: ms,
    availability: ms.reduce<Availability>((acc, m) => higher(acc, m.availability), 'configured'),
    evidence: ms.map((m) => m.evidence ?? '').filter((e) => e.length > 0).slice(0, 3),
  }))

  return {
    harnessId: options.harnessId,
    accountId: options.accountId,
    native: providers,
    discovered: models,
    errors,
    collectedAt: new Date().toISOString(),
    ...(localCatalog === undefined ? {} : { catalog: localCatalog.entries }),
    dshNative: options.dshNative ?? [],
    declared: { listCommand, configFiles, authBlocked },
  }
}
