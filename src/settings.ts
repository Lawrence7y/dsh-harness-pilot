/**
 * 运行时设置：设置页里可编辑、立即生效、重启后仍在的插件设置。
 *
 * 与 Config（cordis/Schemastery，改了要重载插件）分开：这些是用户会随手调的行为开关，
 * 落在 `<home>/plugins/harness-pilot/runtime-settings.json`，HTTP `/harness-pilot/api/settings`
 * 读写，client 设置页渲染成表单。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RuntimeSettings {
  /** 任务完成后主动把交付内容送回发起会话并唤醒它继续任务（回执）。 */
  notifyOnComplete: boolean
  /** 回执里附带 harness 的交付内容正文（截断到 maxResultChars）。 */
  deliverResult: boolean
  /** 交付内容正文的截断长度（字符）。 */
  maxResultChars: number
  /** 同时运行的异步任务上限；0 表示不限数量。 */
  maxConcurrent: number
  /** 异步任务默认硬超时（毫秒）。 */
  defaultTaskTimeoutMs: number
  /** 回执里附加的续办提示（空 = 用内置提示语）。 */
  resumeInstruction: string
  /**
   * **会话模型菜单**里每个 harness 最多列多少个模型（0 = 不限）。
   *
   * ⚠️ **2026-10-14 起这个旋钮不再生效**（保留字段只为兼容旧设置文件，改它没有任何效果）：
   * 模型目录已改成「**一个 harness 一个 provider 分组**」，宿主原生菜单是
   * 「供应商列表 → 钻进该供应商看它的全部模型」的两级形态 ⇒ 每组内部**不再截断**
   * （用户明确要求「点开折叠后才是该 harness 的全部模型」，也不允许「任意截断」）。
   * 当时引入这个旋钮是为了压住「单 provider 734 条扁平条目」，而那正是分组要解决的问题本身。
   */
  sessionModelLimit: number
}

export const DEFAULT_SETTINGS: RuntimeSettings = {
  notifyOnComplete: true,
  deliverResult: true,
  maxResultChars: 20000,
  maxConcurrent: 4,
  defaultTaskTimeoutMs: 600000,
  resumeInstruction: '',
  // 0 = 不截断（本字段已不再生效，见接口注释）。
  sessionModelLimit: 0,
}

/** 插件数据目录（任务落盘 + 运行时设置）。可用 HARNESS_PILOT_HOME 覆盖。 */
export function pluginHome(): string {
  const override = process.env.HARNESS_PILOT_HOME
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  return join(homedir(), '.dsh', 'plugins', 'harness-pilot')
}

export function settingsPath(): string {
  return join(pluginHome(), 'runtime-settings.json')
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 任意输入收敛成一份完整、合法的设置（缺字段补默认，越界钳位，类型错当缺省）。 */
export function normalizeSettings(raw: unknown, base: RuntimeSettings = DEFAULT_SETTINGS): RuntimeSettings {
  const input = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    notifyOnComplete: typeof input.notifyOnComplete === 'boolean' ? input.notifyOnComplete : base.notifyOnComplete,
    deliverResult: typeof input.deliverResult === 'boolean' ? input.deliverResult : base.deliverResult,
    maxResultChars: clampNumber(input.maxResultChars, base.maxResultChars, 500, 200000),
    maxConcurrent: typeof input.maxConcurrent === 'number' && Number.isFinite(input.maxConcurrent) && input.maxConcurrent >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(input.maxConcurrent)) : base.maxConcurrent,
    defaultTaskTimeoutMs: clampNumber(input.defaultTaskTimeoutMs, base.defaultTaskTimeoutMs, 5000, 24 * 60 * 60 * 1000),
    resumeInstruction: typeof input.resumeInstruction === 'string' ? input.resumeInstruction.slice(0, 4000) : base.resumeInstruction,
    sessionModelLimit: clampNumber(input.sessionModelLimit, base.sessionModelLimit, 0, 2000),
  }
}

/** 读盘上的设置；文件不存在/损坏时回默认（不抛）。 */
export function loadSettings(): RuntimeSettings {
  try {
    if (!existsSync(settingsPath())) return { ...DEFAULT_SETTINGS }
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 原子写回（tmp + rename），返回最终生效的设置。 */
export function saveSettings(raw: unknown, base: RuntimeSettings = DEFAULT_SETTINGS): RuntimeSettings {
  const next = normalizeSettings(raw, base)
  const path = settingsPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' })
  renameSync(tmp, path)
  return next
}
