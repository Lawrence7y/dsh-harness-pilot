/** Names-only native catalogs. Catalog presence never proves authentication or inference. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TargetConfig } from './types.js'

export interface NativeCatalogEntry {
  readonly id: string
  readonly provider?: string
  readonly selectable: boolean
  readonly source: 'official-alias' | 'native-cache' | 'native-config' | 'native-catalog' | 'configured-alias'
  readonly evidence: string
  /**
   * 该条目在 CLI 原生配置里的**角色**。
   *
   * `default` = 这条就是该 CLI 当前配置的默认模型（不传 `--model` 时跑的那个）。
   * ⚠️ 必须显式标出来，**不许**靠「evidence 里有没有『当前模型』这几个字」猜 ——
   * 那样文案一改就静默失效（本项目栽过多次「靠字符串约定代替契约」的坑）。
   */
  readonly role?: 'default'
  /** 厂商 product config 里带的**元数据**（仅展示用；没有就不写，不编造）。 */
  readonly meta?: {
    readonly name?: string
    readonly vendor?: string
    readonly maxInputTokens?: number
    readonly maxOutputTokens?: number
    readonly supportsToolCall?: boolean
    readonly supportsReasoning?: boolean
    readonly supportsImages?: boolean
    /** 厂商自己的别名关系（形如 `{lite: fast-model, reasoning: fast-model}`）。 */
    readonly relatedModels?: Readonly<Record<string, string>>
  }
}
export interface NativeModelCatalog {
  readonly entries: readonly NativeCatalogEntry[]
  readonly selectableModels: string[]
  readonly note: string
}
const safeName = (v: unknown): v is string => typeof v === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:/#@+\[\]-]{0,119}$/.test(v)
  && !/^(sk|pk|ghp|xox)[-_]/i.test(v) && !/eyJ[A-Za-z0-9_-]{10,}/.test(v)
  && !/^[A-Za-z0-9+/=_-]{40,}$/.test(v)
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
function json(file: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(file, 'utf8'))) } catch { return {} }
}

/**
 * 读厂商 **product config**（`…/cache/acc-product-config-v3.json`）里的 `models[]` 名册。
 *
 * ## 安全边界（**只有这一条读法**，离线探针静态断言）
 * 该文件里**确实有** `authentication` 一类凭据键（本机实测的顶层键里就有），
 * 所以这里**只取 `models` 数组**，并且每个条目只取白名单字段：
 * `id` / `name` / `vendor` / `isDefault` / `maxInputTokens` / `maxOutputTokens` /
 * `supportsToolCall` / `supportsReasoning` / `supportsImages` / `relatedModels`。
 * **不读取、不返回、不落盘**任何令牌/密钥/认证字段（`json()` 只解析整份文件，取值走白名单）。
 *
 * ## 归类纪律
 * 名册里的 id **一律 `selectable: false` + 来源 `native-cache`**：
 * 本机实测 CLI `--model` **不接受**名册里的底层 id（会响亮拒绝），
 * 所以它们只能「仅展示」；只有 `modelsFixed`（CLI 自己 `--help` 列的档位）才是可选。
 * `isDefault: true` 的条目给 `role: 'default'`（这才是「当前默认模型」的真实证据）。
 */
export function readProductConfigRoster(file: string): NativeCatalogEntry[] {
  const path = (file ?? '').trim()
  if (path.length === 0) return []
  const root = json(path)
  const list = root.models
  if (!Array.isArray(list)) return []
  const out: NativeCatalogEntry[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const m = object(raw)
    if (!safeName(m.id)) continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const meta: NonNullable<NativeCatalogEntry['meta']> = {
      ...(safeName(m.name) ? { name: m.name } : {}),
      ...(safeName(m.vendor) ? { vendor: m.vendor } : {}),
      ...(typeof m.maxInputTokens === 'number' && Number.isFinite(m.maxInputTokens) ? { maxInputTokens: m.maxInputTokens } : {}),
      ...(typeof m.maxOutputTokens === 'number' && Number.isFinite(m.maxOutputTokens) ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(typeof m.supportsToolCall === 'boolean' ? { supportsToolCall: m.supportsToolCall } : {}),
      ...(typeof m.supportsReasoning === 'boolean' ? { supportsReasoning: m.supportsReasoning } : {}),
      ...(typeof m.supportsImages === 'boolean' ? { supportsImages: m.supportsImages } : {}),
      ...(m.relatedModels !== null && typeof m.relatedModels === 'object' && !Array.isArray(m.relatedModels)
        ? {
          relatedModels: Object.fromEntries(
            Object.entries(m.relatedModels as Record<string, unknown>)
              .filter((entry): entry is [string, string] => safeName(entry[1]))
              .slice(0, 8),
          ),
        }
        : {}),
    }
    out.push({
      id: m.id,
      source: 'native-cache',
      selectable: false,
      evidence: '厂商 product config 缓存（acc-product-config-v3.json）的 models[] 名册条目；'
        + '**仅展示**：CLI `--model` 不接受名册里的底层 id。只读了 models 数组，未读取 authentication 等凭据字段。'
        + (safeName(m.name) ? ` 厂商名称：${m.name}。` : '')
        + (safeName(m.vendor) ? ` vendor=${m.vendor}。` : '')
        + (typeof m.maxOutputTokens === 'number' ? ` 输出上限 ${m.maxOutputTokens}。` : ''),
      ...(m.isDefault === true ? { role: 'default' as const } : {}),
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    })
  }
  return out
}

/** Read specific allowlisted name fields only; never expose auth/cache identity, URLs or options. */
export function discoverLocalModelCatalog(target: TargetConfig, home = homedir()): NativeModelCatalog {
  const entries: NativeCatalogEntry[] = []
  const push = (id: unknown, source: NativeCatalogEntry['source'], evidence: string, selectable = true, provider?: unknown, role?: 'default'): void => {
    if (!safeName(id) || entries.some((m) => m.id === id)) return
    entries.push({ id, source, evidence, selectable, ...(safeName(provider) ? { provider } : {}), ...(role === undefined ? {} : { role }) })
  }
  const signature = `${target.name} ${target.command} ${target.args.join(' ')}`.toLowerCase()
  if (/claude/.test(signature)) {
    // Stable aliases supported by installed 2.1.x; don't advertise newer version-specific aliases.
    for (const id of ['sonnet', 'opus', 'haiku', 'opusplan']) push(id, 'official-alias', 'Claude Code 官方模型别名：https://code.claude.com/docs/en/model-config；认证与实际可用性待执行确认')
    const settings = json(join(target.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json'))
    push(settings.model, 'native-config', 'Claude 原生 settings.model；未读取认证字段', true, undefined, 'default')
    const env = object(settings.env)
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      push(target.env[key] ?? env[key], 'native-config', `Claude 原生模型名字段 ${key}；不包含密钥`)
    }
    if (Array.isArray(settings.availableModels)) {
      const allowed = settings.availableModels.filter(safeName)
      if (allowed.length > 0) for (let i = entries.length - 1; i >= 0; i--) if (!allowed.includes(entries[i]!.id)) entries.splice(i, 1)
      for (const id of allowed) push(id, 'native-config', 'Claude 原生 availableModels 白名单')
    }
  } else if (/codex/.test(signature)) {
    const dir = target.env.CODEX_HOME ?? join(home, '.codex')
    let config = ''
    try { config = readFileSync(join(dir, 'config.toml'), 'utf8') } catch { /* absent */ }
    const field = (key: string): string | undefined => new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]+)"`, 'm').exec(config)?.[1]
    const provider = field('model_provider')
    push(field('model'), 'native-config', 'Codex 原生 config.toml 当前模型名称；未读取 model_providers 凭据', true, provider, 'default')
    const cache = json(join(dir, 'models_cache.json'))
    if (Array.isArray(cache.models)) for (const raw of cache.models) {
      const m = object(raw)
      // Native picker explicitly hides internal models; don't surface them as ordinary choices.
      if (m.visibility === 'hide') continue
      push(m.slug ?? m.id, 'native-cache', 'Codex 原生 models_cache.json 模型名称；缓存不证明当前认证有效', true, provider)
    }
  } else if (/workbuddy|codebuddy|wb-managed/.test(signature)) {
    for (const id of target.modelsFixed ?? []) push(id, 'configured-alias', 'CLI 支持的模型档位；底层目录与可选档位分开')
    const file = target.modelsFile || join(home, '.codebuddy', 'models.json')
    const catalog = json(file)
    if (Array.isArray(catalog.models)) for (const raw of catalog.models) {
      const m = object(raw)
      push(m.id, 'native-catalog', 'WorkBuddy 原生模型目录，仅展示；CLI --model 不接受底层 ID', false, m.vendor)
    }
    // ── 厂商 **product config** 里的完整名册（本机实测：国内 55 条 / 国际 30 条）──
    // 这一段是「WorkBuddy 模型数量不全」的正解：名册里的 id 大多**不能**作为 `--model` 取值
    // （所以一律 `selectable: false`，只有上面 `modelsFixed` 里 CLI 真正接受的才是可选），
    // 但它带了 vendor / isDefault / 上下文与输出上限 / 能力位 / 厂商自己的别名关系 ——
    // 这些让设置页能说清「有哪些模型、哪些只是名册里的、每条什么规格、哪个是厂商默认」。
    readProductConfigRoster(target.productConfigFile).forEach((entry) => entries.push(entry))
  } else if (/zcode/.test(signature)) {
    const cfg = json(join(home, '.zcode', 'cli', 'config.json'))
    const canSelect = target.modelArgs.length > 0
    push(cfg.model, 'native-config', 'ZCode 原生当前模型配置；无 --model 接口时仅展示', canSelect, undefined, 'default')
    for (const [provider, raw] of Object.entries(object(cfg.provider))) {
      for (const id of Object.keys(object(object(raw).models))) push(`${provider}/${id}`, 'native-config', 'ZCode 原生 provider.models 名称；未读取 options/密钥', canSelect, provider)
    }
  }
  return { entries, selectableModels: entries.filter((m) => m.selectable).map((m) => m.id), note: entries.length > 0 ? '来自该 CLI 原生配置、缓存或官方别名；认证与实际执行分别核验' : '没有原生目录或受支持的模型别名' }
}
