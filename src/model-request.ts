/**
 * **模型引用**的统一解析与校验（纯函数；工具面 / 任务面 / 子代理面共用一份）。
 *
 * ## 为什么需要它（现状与风险）
 * `harness_dispatch` / `harness_agent` / `harness_task_start` 的 `model` 以前是**完全自由的字符串**：
 * 直接塞进 `-m <model>`，写错（过期 id、别家 harness 的 id、把目标名当模型名）只能等外部 CLI
 * 报一个各不相同的错，或者更糟 —— 被 CLI 静默忽略，于是「选了 A 实际跑了 B」无法察觉。
 * 现在模型目录已经有**逐条分类**（`src/model-sources.ts`：可选择 / 仅展示 / 别名 / 当前默认 + 来源），
 * 所以这里把它变成**可校验的引用**。
 *
 * ## 接受的三种形态（都在实际使用中出现过）
 *   ① `cli-default`               —— 保留值：不下发 `--model`，用该 CLI 自己的默认档；
 *   ② `<provider>/<model>`        —— 原生模型选择器里的形态（provider 形如 `harness-qoder-cn`）；
 *      必须与本次 `target` 属于**同一条 harness**，否则拒绝（别把 A 的模型塞给 B）；
 *   ③ `<target>::<model>`         —— 历史组合形态（`pilot-cli` 路由下用过）；
 *   ④ 纯 `<model>`                —— 该 target 自己的模型 id。
 *
 * ## 校验纪律
 *   · 清单**真的拿到了**（`measured`）且非空：不在清单里 ⇒ **显式拒绝**，并把可用清单与
 *     「怎么重新列一遍」写进恢复指引（绝不换一个模型替你跑）；
 *   · 清单**没拿到**（未测量 / 该 CLI 没有列举能力）：**放行但标注**（`verified:false` + note），
 *     因为「不知道」不等于「不存在」；
 *   · 目标**没有模型开关**（既无 `modelArgs` 也无 `acpArgs`）时，显式给 model 是**无意义的**：
 *     拒绝并说明（GUI 目标由它自己的 UI 选模型；要硬塞请用 `extra_args`）。
 */
import { CLI_DEFAULT_MODEL_ID } from './harness-llm.js'

export type ModelRefForm = 'cli-default' | 'provider-model' | 'target-model' | 'plain'

export interface ModelRequestInput {
  /** 本次要跑的目标名（`agy` / `wb-managed-a` / …）。 */
  readonly targetName: string
  /** 该目标所属 harness 的 provider id（形如 `harness-antigravity`）；用于校验 `provider/model` 形态。 */
  readonly providerId?: string
  /** 调用方给的模型引用（可空 = 用该 CLI 默认档）。 */
  readonly explicit?: string
  /** 该目标**当前可选择**的模型 id（来自 `selectableIds(entries)`；不含 `cli-default`）。 */
  readonly selectable: readonly string[]
  /** 这份清单是不是**真的测量过**（true 才会因为「不在清单里」而拒绝）。 */
  readonly measured: boolean
  /** 该目标有没有模型开关（`modelArgs` 或 `acpArgs` 之一非空）。 */
  readonly modelSwitchable: boolean
  /** 调用方是否另外给了 `extra_args`（给了就允许在「无模型开关」的目标上自行拼参数）。 */
  readonly hasExtraArgs?: boolean
}

export type ModelRequestOutcome =
  | {
    readonly ok: true
    /** 真正要下发到 CLI 的模型 id；`undefined` = 不下发（用 CLI 默认档）。 */
    readonly model: string | undefined
    readonly form: ModelRefForm
    /** 是否**核对过**清单（false = 没测量过，只是放行）。 */
    readonly verified: boolean
    readonly note: string
  }
  | {
    readonly ok: false
    readonly reason: string
    readonly recovery: string
  }

/** 供恢复指引用：列出前 N 个可选模型。 */
function sampleOf(list: readonly string[], limit = 12): string {
  const head = list.slice(0, limit)
  return `${head.join(', ')}${list.length > limit ? ` …（共 ${list.length} 个）` : ''}`
}

export function resolveModelRequest(input: ModelRequestInput): ModelRequestOutcome {
  const raw = typeof input.explicit === 'string' ? input.explicit.trim() : ''
  const target = input.targetName
  if (raw.length === 0) {
    return { ok: true, model: undefined, form: 'cli-default', verified: false, note: `未指定模型 ⇒ 用「${target}」自己的默认档` }
  }
  if (raw === CLI_DEFAULT_MODEL_ID) {
    return { ok: true, model: undefined, form: 'cli-default', verified: true, note: `模型引用是保留值 \`${CLI_DEFAULT_MODEL_ID}\` ⇒ 不下发 --model，用「${target}」自己的默认档` }
  }

  // ② provider/model（原生模型选择器形态）
  let model = raw
  let form: ModelRefForm = 'plain'
  if (raw.startsWith('harness-') && raw.includes('/')) {
    const slash = raw.indexOf('/')
    const provider = raw.slice(0, slash)
    const rest = raw.slice(slash + 1).trim()
    if (input.providerId !== undefined && provider !== input.providerId) {
      return {
        ok: false,
        reason: `模型引用里的 provider「${provider}」不是目标「${target}」所属的那条（应为「${input.providerId}」）`,
        recovery: `要么把 target 改成该 provider 对应的目标，要么直接用纯模型 id（不要带 provider 前缀）。`,
      }
    }
    if (rest.length === 0) {
      return { ok: false, reason: `模型引用「${raw}」缺模型名（形如 \`${provider}/<model>\`）`, recovery: '用 harness_models(target=…) 看该 harness 的可选模型。' }
    }
    model = rest
    form = 'provider-model'
  } else if (raw.includes('::')) {
    // ③ target::model（历史形态）
    const at = raw.indexOf('::')
    const owner = raw.slice(0, at).trim()
    const rest = raw.slice(at + 2).trim()
    if (owner.length > 0 && owner !== target) {
      return {
        ok: false,
        reason: `模型引用里的目标「${owner}」与本次 target「${target}」不一致`,
        recovery: `历史组合形态必须与本次 target 相同（\`${target}::<model>\`）；或直接给纯模型 id。`,
      }
    }
    if (rest.length === 0) {
      return { ok: false, reason: `模型引用「${raw}」缺模型名（形如 \`${target}::<model>\`）`, recovery: '用 harness_models(target=…) 看可选模型。' }
    }
    model = rest
    form = 'target-model'
  }

  // 无模型开关的目标：显式 model 无意义（GUI 目标在自己 UI 里选）
  if (!input.modelSwitchable && input.hasExtraArgs !== true) {
    return {
      ok: false,
      reason: `目标「${target}」没有可用的模型开关（既无 modelArgs 也无 acpArgs）⇒ 这个 model 参数会被它忽略`,
      recovery: '该 harness 的模型由它自己的界面/会话决定；要在命令行硬塞请改用 harness_dispatch 的 extra_args（自己拼 flag），'
        + '或换一条有 modelArgs 的目标。',
    }
  }

  if (input.measured && input.selectable.length > 0) {
    if (!input.selectable.includes(model)) {
      return {
        ok: false,
        reason: `模型「${model}」不在「${target}」**当前**报出的可选清单里（清单里没有它）`,
        recovery: `可用（${input.selectable.length} 个）：${sampleOf(input.selectable)}\n`
          + `先确认 id：harness_models(target="${target}", refresh=true)。`
          + `本次**不派发**：换一个模型替你跑会让「选了 A 实际跑了 B」无法察觉。`,
      }
    }
    return { ok: true, model, form, verified: true, note: `已核对可选清单（${input.selectable.length} 个）` }
  }
  return {
    ok: true, model, form, verified: false,
    note: `没能核对清单（该目标没有可用的模型列举能力，或本轮未测量）⇒ **按原样放行**，实际是否被接受由该 CLI 回答`,
  }
}
