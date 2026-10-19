/**
 * 模型面向的工具面。七个工具，覆盖「发现 harness → 派发任务 → 交互式操控 → 团队身份」：
 *
 *   harness_list       列出本机可用的 harness（含通道可用性探测）
 *   harness_dispatch   一次性派发任务（自动选通道，返回 harness 的回答）
 *   harness_agent      以 DSH 子代理语义派发（走注册的 SubagentProvider）
 *   harness_open       打开/附着交互会话（窗口 / CDP / pty）
 *   harness_send       向会话注入文本或按键；不带输入时相当于「读当前屏幕」
 *   harness_sessions   列出或关闭会话
 *   harness_spawn_teammate  创建**由外部 Harness 承接**的团队成员（身份在首轮之前冻结）
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// 模型引用的统一解析与校验（唯一实现：`src/model-request.ts`）。
import { resolveModelRequest } from './model-request.js'
import { CLI_DEFAULT_MODEL_ID } from './harness-llm.js'
// 「一条 harness」的产品身份表：provider id 的唯一算法 + 分组判定。
import { classifyTarget, providerIdFor } from './harness-groups.js'
// 逐条分类（可选择 / 仅展示 / 别名 / 当前默认）。
import { countByKind, MODEL_KIND_LABEL, selectableIds } from './model-sources.js'
import { modelEntriesFor } from './models.js'
import type { AccountSeed } from './federation/accounts.js'
import { probeCommand } from './launcher.js'
// `ROUTE` = 本插件自己的 LLM 路由名（`pilot-cli`）。子代理的 per-child `agentOptions.provider`
// 只能是它：外部 harness 的子代理 provider 每轮都由外部 CLI 产生，换不了宿主供应商。
import { ROUTE } from './llm-adapter.js'
import { accountAliasNameFor, accountAliasRefusal, providerNameFor, redactedAccountAliasName } from './provider.js'
import { redactAccountId } from './task-tools.js'
// 持久原生会话（P1）：harness_sessions 的 persistent/release 两个动作读它。
import type { NativeSessionStore, SessionMutex } from './native-sessions.js'
import type { ResolvedConfig } from './config.js'
import type { ClickOutcome, SessionRegistry } from './sessions.js'
import type { TeamRouteIntent } from './team-routing.js'
import type { TransportKind } from './types.js'

/** `ctx.subagents` 的最小面（缺失时 harness_agent 会明确报错）。 */
export interface SubagentStartLike {
  start(name: string, request: {
    label: string
    prompt: ContentBlock[]
    parent: unknown
    signal: AbortSignal
    /**
     * per-child 选项。宿主只做「有值 ⇒ provider.capabilities.agentOptions 必须为真」这一道 gate
     * （rc.2 `dsh-subagent/lib/types/index.js:457-470`），字段级后果由 provider 承担。
     * 本插件用它承载「本次模型」；`HarnessProvider.start()` 真的把它落到 CLI 命令行。
     */
    agentOptions?: { provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number }
  }): Promise<{
    id: string
    result: Promise<{ output: readonly ContentBlock[]; stopReason: string; diagnostic?: string }>
    dispose(): Promise<void>
  }>
  /**
   * 已注册的 provider 名（可选）。
   *
   * `harness_agent` 的 `accountId` 路径**必须**拿它核对「这个别名到底注册没有」——
   * 否则一个拼错/已删除的账号会被交给 `start()`，失败原因就变成宿主内部的一句话，
   * 而不是我们这条「显式拒绝 + 不 fallback」的判定。
   */
  list?(): readonly string[]
}

export interface ToolDeps {
  readonly config: ResolvedConfig
  readonly registry: SessionRegistry
  readonly subagents?: SubagentStartLike
  /**
   * 会话级绑定（P5b）。`harness_dispatch` / `harness_agent` **没显式给 target/model 时**
   * 取它的值 —— 这就是会话页那套 Harness→账号→供应商→模型 选择的**真实作用点**。
   * 显式参数永远优先，绑定只补空缺。
   */
  readonly bindingFor?: (sessionId: string | undefined) => {
    harnessId?: string
    model?: string
    accountId?: string
    harnessKind?: 'native' | 'external'
  } | undefined
  /**
   * 当前**生效**的账号档案（内置 ± 用户增删改；已停用/删除的**不在**其中）。
   *
   * `harness_agent(accountId=…)` 用它判活：判据函数是 provider.ts 那**唯一**一份
   * `accountAliasRefusal`（不在就＝已停用/已删除）。**缺省时不猜** —— 那条路径显式拒绝，
   * 因为「注册过但已被删除」这件事没有它根本判不出来。
   */
  readonly accountSeeds?: () => readonly AccountSeed[]
  /**
   * **产品化团队身份**（`src/team-routing.ts`）。
   *
   * `harness_spawn_teammate` 的**全部**身份判定与冻结都走它，本文件不另写一套规则。
   * 缺省（未挂载）⇒ 该工具**显式拒绝**并说明原因，而不是退回「用成员名碰运气」。
   */
  readonly teamRouting?: TeamRoutingLike
  /**
   * 团队服务（`ctx.agentTeams`）。缺省 ⇒ `harness_spawn_teammate` **显式拒绝**。
   * 用的是与探针 / 宿主 `spawn_teammate` 工具**同一个**服务方法，团队生命周期因此不变。
   */
  readonly agentTeams?: AgentTeamsSpawnLike
  /**
   * `fresh` 上下文用的 provider 名（对应 agent-team 配置的 `freshProvider`，宿主缺省 `'spawn'`）。
   *
   * 用途**只是**把它写进请求（走宿主自己的配置语义）；`fork` 那一档刻意**不**跟着抄 —
   * 本插件不假装知道该 profile 的 `forkProvider`，所以只在 `fresh` 上用它，
   * 其余情况把宿主缺省 `'spawn'` 显式写出来，而不是留空让下游猜。
   */
  readonly teamFreshProvider?: string
  /**
   * 持久原生会话层（可选；P1/P3）。缺省 = harness_sessions 的 persistent/release 动作显式报错。
   */
  readonly nativeSessions?: { readonly store: NativeSessionStore, readonly mutex: SessionMutex }
}

/** 团队路由对工具面暴露的最小契约（实现见 `src/team-routing.ts`）。 */
export interface TeamRoutingLike {
  /** 校验并冻结一次成员身份。**必须**在真实的 `spawnTeammate` 之前调用。 */
  prepare(input: {
    readonly leadSessionId: string
    readonly parentSessionId?: string
    readonly memberName: string
    readonly description?: string
    readonly context?: 'fresh' | 'fork'
    readonly provider: string
    readonly target: string
    readonly accountId?: string
    readonly model?: string
  }): Promise<
    | { readonly ok: true, readonly intent: TeamRouteIntent, readonly spec: { readonly target: string, readonly account: string | null, readonly model: string | null, readonly accountApplied: boolean, readonly modelApplied: boolean } }
    | { readonly ok: false, readonly code: string, readonly reason: string }
  >
  /** 撤销未决意图（spawn 失败时必须调，否则留下永不兑现的身份）。 */
  abortIntent(leadSessionId: string, memberName: string, reason: string): boolean
}

/** `harness_spawn_teammate` 需要的团队服务面（与探针/宿主工具**同一批**服务方法）。 */
export interface AgentTeamsSpawnLike {
  /**
   * 创建一名成员。
   * 契约：`caller` 必须是**活着的 Lead Agent**（宿主在 caller 不是 Lead 时抛 `TEAM_LEAD_REQUIRED`），
   * `request.signal` 必须是**真的** AbortSignal（`roster.js` 走 `AbortSignal.any`）。
   */
  spawnTeammate(caller: unknown, request: {
    readonly name: string
    readonly description: string
    readonly prompt: readonly ContentBlock[]
    readonly context: 'fresh' | 'fork'
    readonly provider: string
    readonly signal: AbortSignal
  }): Promise<{ readonly member?: { readonly id?: string, readonly name?: string, readonly status?: string, readonly provider?: string } }>
}

function textOutput(text: string): { text: string } {
  return { text }
}

/** 所有工具的返回形状统一为一段文本（渲染成文本块）。 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

/** 调用方 Agent 的 workspace（Agent 形状随版本演进，按最小形状读取）。 */
function agentCwd(agent: unknown): string | undefined {
  const session = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** 调用方 Agent 的会话 id（绑定按它查）。字段名随版本可能不同，所以多取几个候选。 */
function agentSessionId(agent: unknown): string | undefined {
  const a = agent as { sessionId?: unknown, session?: { id?: unknown, header?: { id?: unknown } } } | undefined
  for (const candidate of [a?.sessionId, a?.session?.id, a?.session?.header?.id]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * 把「目标 + 模型引用」校验收口到**唯一实现**（`src/model-request.ts`）。
 *
 * 校验需要的三样东西都在这里取：
 *   · `selectable` / `measured`：来自该目标**当前**的逐条分类（`modelEntriesFor` + `selectableIds`），
 *     与设置页/选择器**同源**（不再各自解释 `note` 字符串）；
 *   · `modelSwitchable`：该目标有没有 `modelArgs` / `acpArgs`（没有就是 GUI 自己在界面上选）；
 *   · `providerId`：由产品身份表算（`harness-<id>`），用于校验 `provider/model` 形态。
 *
 * ⚠️ 只**读**：`registry.targetModels()` 命中缓存时不起进程；未命中会问一次该 CLI 的**模型列举命令**
 * （零额度、零推理）。
 */
async function validateModelRef(
  registry: SessionRegistry,
  target: { name: string, modelArgs: string[], acpArgs: string[] },
  explicit: string | undefined,
  hasExtraArgs: boolean,
): Promise<ReturnType<typeof resolveModelRequest>> {
  const known = await registry.targetModels(registry.target(target.name))
  const entries = known.entries ?? modelEntriesFor({})
  return resolveModelRequest({
    targetName: target.name,
    providerId: providerIdFor(classifyTarget({ name: target.name })),
    ...(explicit === undefined ? {} : { explicit }),
    selectable: selectableIds(entries),
    measured: known.state !== undefined && known.state.code !== 'unknown',
    modelSwitchable: target.modelArgs.length > 0 || target.acpArgs.length > 0,
    hasExtraArgs,
  })
}

/** 校验失败的**统一输出**（工具面必须把「为什么不行 + 怎么办」一起说清，别只抛一个错）。 */
function modelRefRefusal(outcome: { readonly reason: string, readonly recovery: string }): string {
  return `✗ 模型引用被拒绝（**没有派发**）\n原因：${outcome.reason}\n怎么办：${outcome.recovery}`
}

/**
 * 解析「本次派发到底用哪个目标/模型」。
 * **显式参数 > 会话绑定 > config 默认目标** —— 顺序不能反，否则会话绑定会覆盖调用方的显式意图。
 * @returns 目标名、模型、以及哪些值是绑定补上的（用于在输出里如实标注来源）。
 */
function resolveTargetAndModel(
  deps: ToolDeps,
  exec: unknown,
  explicitTarget: unknown,
  explicitModel: unknown,
): { wanted: string, model: string | undefined, fromBinding: string[] } {
  const explicitT = typeof explicitTarget === 'string' && explicitTarget.trim().length > 0 ? explicitTarget.trim() : undefined
  const explicitM = typeof explicitModel === 'string' && explicitModel.trim().length > 0 ? explicitModel.trim() : undefined
  const binding = deps.bindingFor?.(agentSessionId((exec as { agent?: unknown } | undefined)?.agent))
  const fromBinding: string[] = []
  let wanted = explicitT
  let model = explicitM
  if (wanted === undefined && binding !== undefined && binding.harnessKind === 'external'
    && binding.harnessId !== undefined && binding.harnessId.length > 0) {
    wanted = binding.harnessId
    fromBinding.push('target')
  }
  if (model === undefined && binding?.model !== undefined && binding.model.length > 0) {
    model = binding.model
    fromBinding.push('model')
  }
  return { wanted: wanted ?? deps.config.defaultTarget, model, fromBinding }
}

function formatOutcome(outcome: Awaited<ReturnType<SessionRegistry['dispatch']>>, target: string): string {
  const head = `harness=${target} transport=${outcome.transport} stop=${outcome.stopReason}`
  const facts = outcome.facts === undefined
    ? ''
    : ` (${Object.entries(outcome.facts).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${String(value)}`).join(', ')})`
  const body = outcome.text.trim().length > 0 ? outcome.text.trim() : '(no text returned)'
  const diagnostic = outcome.diagnostic === undefined ? '' : `\ndiagnostic: ${outcome.diagnostic}`
  /**
   * **偏差必须显示**（需求 ⑧：请求值 ≠ 实际值时提示）。
   *
   * 这里以前只印 facts 与 diagnostic —— `mismatch`（通道/配置层面的偏差，例如
   * 「请求的模型没生效」「extra_args 在 ACP 通道根本不会被追加」）**一行都不显示**，
   * 于是调用方读到的是一份「干净的成功」。记账里有、回执里有，但**工具面没有**，
   * 而工具面正是派发方唯一会读的那一屏（2026-10-14 实测：ACP 丢参数却只显示 completed）。
   */
  const mismatch = (outcome.mismatch ?? []).length === 0
    ? ''
    : `\n⚠️ 请求值 ≠ 实际值（${outcome.mismatch?.length} 条，不得当作「已按请求执行」）：\n`
      + (outcome.mismatch ?? []).map((item) => `  - ${item}`).join('\n')
  return `${head}${facts}\n---\n${body}${mismatch}${diagnostic}`
}

/** 这个目标的模型是怎么被设定的（给人看的说明）。HTTP `/models` 也用它。 */
export function mechanismOf(target: { modelArgs: string[], acpArgs: string[], acpModel: string }): string {
  const parts: string[] = []
  if (target.modelArgs.length > 0) parts.push(`argv ${target.modelArgs.join(' ')}`)
  if (target.acpArgs.length > 0) parts.push('ACP session/set_config_option')
  if (parts.length === 0) parts.push('no model switch (GUI harness picks the model in its own UI)')
  if (target.acpModel.length > 0) parts.push(`default: ${target.acpModel}`)
  return parts.join(' + ')
}

/** 在 CDP 会话里按可见文字点击元素（打开面板 / 点按钮）。返回页面内的自述结果。 */
function clickByTextSnippet(needle: string): string {
  return `(() => {
  const needle = ${JSON.stringify(needle)};
  const visible = [];
  for (const el of document.querySelectorAll('button,a,[role="button"],div,span,li,p')) {
    try {
      const text = (el.innerText || '').trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      visible.push({ el, text, area: r.width * r.height, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略取不到文字的节点 */ }
  }
  const byArea = (a, b) => a.area - b.area;
  const hit = visible.filter(v => v.text === needle).sort(byArea)[0]
    ?? visible.filter(v => v.text.includes(needle)).sort(byArea)[0];
  if (!hit) {
    return { ok: false, reason: 'no visible element matched ' + JSON.stringify(needle), candidates: visible.slice(0, 15).map(v => v.text.slice(0, 40)) };
  }
  hit.el.click();
  return { ok: true, text: hit.text.slice(0, 80), rect: hit.rect };
})()`
}

/**
 * 把 `clickByTextSnippet()` 的页面内返回值归一化成 `ClickOutcome`。
 *
 * 关键：那段页面内 JS **匹配不到元素时不抛异常**，而是 `return { ok: false, reason, candidates }`。
 * 所以「点没点中」必须从返回值里读，不能靠 try/catch —— 这正是 P3 误投递的根因。
 */
function toClickOutcome(raw: unknown): ClickOutcome {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
  const ok = record?.ok === true
  const reason = typeof record?.reason === 'string' ? record.reason : ''
  const clickedText = typeof record?.text === 'string' ? record.text : ''
  const rect = Array.isArray(record?.rect) ? ` at ${(record.rect as unknown[]).join(',')}` : ''
  const candidates = Array.isArray(record?.candidates)
    ? (record.candidates as unknown[]).map(value => String(value)).filter(value => value.length > 0)
    : []
  return {
    ok,
    detail: ok
      ? `clicked "${clickedText}"${rect}`
      : (reason.length > 0 ? reason : 'click did not match any element'),
    ...(candidates.length === 0 ? {} : { candidates }),
  }
}

/**
 * 打开 GUI harness 的模型选择器。两级策略：
 *  1. 结构选择器优先（`[class*=model-selector]` / `[data-testid*=model-selector]` / `aria-label` 含 model|模型）——
 *     这些是应用自己的模型控件。
 *  2. 退回"文字像模型名"的可点元素（必须同时有厂商词 + 版本号，避免点到资源管理器里的 `.claude` 目录这种）。
 */
function openModelPickerSnippet(): string {
  return `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width >= 20 && r.height >= 12 ? r : null; };
  const areaOf = (r) => r.width * r.height;
  // 第一级：结构选择器（含实测到的 hooks：MiMo #model-btn / [data-model-menu]、ZCode [data-testid*=chat-model]）
  const structural = [];
  for (const el of document.querySelectorAll('[class*="model-selector"],[class*="model-list-selector"],[data-testid*="model-selector"],[data-testid*="chat-model"],[data-model-menu],[class*="model-btn"],[class*="model-trigger"],[aria-label*="model" i],[aria-label*="模型"]')) {
    try {
      const r = visible(el); if (r === null) continue;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '').trim()).trim();
      structural.push({ el, label: label.slice(0, 60), area: areaOf(r), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略 */ }
  }
  structural.sort((a, b) => a.area - b.area);
  if (structural.length > 0) {
    const hit = structural[0];
    // Radix DropdownMenu / Popover 不听 el.click()：派发完整鼠标序列（ZCode 实测只认 pointerdown）。
    try {
      const o = { bubbles: true, cancelable: true, view: window, clientX: hit.rect[0] + hit.rect[2] / 2, clientY: hit.rect[1] + hit.rect[3] / 2, button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) hit.el.dispatchEvent(new MouseEvent(type, o));
    } catch { /* 退化为 click */ }
    hit.el.click();
    return { ok: true, via: 'selector', trigger: hit.label, rect: hit.rect };
  }
  // 第二级：文字像模型名（厂商词 + 版本号），且不是文件树条目
  const MODELISH = /(gpt|claude|gemini|qwen|mimo|deepseek|glm|kimi|minimax|grok|opus|sonnet|llama)[-\\s]?v?\\d/i;
  const cands = [];
  for (const el of document.querySelectorAll('button,[role="button"],[aria-haspopup],div,span')) {
    try {
      const r = visible(el); if (r === null) continue;
      if (el.querySelectorAll('*').length > 3) continue;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.innerText || '').trim()).trim();
      if (label.length === 0 || label.length > 60) continue;
      if (!MODELISH.test(label)) continue;
      const cls = String(el.className || '');
      if (/monaco|explorer|file-tree|tree-item|label-name/i.test(cls)) continue;
      cands.push({ el, label, area: areaOf(r), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略 */ }
  }
  cands.sort((a, b) => a.area - b.area);
  if (cands.length === 0) return { ok: false, reason: 'no model-like trigger found' };
  cands[0].el.click();
  return { ok: true, via: 'text', trigger: cands[0].label, rect: cands[0].rect };
})()`
}

/** 在弹出的选择器里按模型名点选一项（容忍换行/空格/大小写与"名称+倍率"拼接）。 */
function pickModelOptionSnippet(model: string): string {
  return `(() => {
  const norm = (s) => s.toLowerCase().replace(/[\\s_()（）-]+/g, '');
  const want = norm(${JSON.stringify(model)});
  // 家族名：去掉档位词后的前缀（Antigravity 把 High/Medium/Low 作为行内子标签）
  const family = norm(${JSON.stringify(model)}.replace(/\\b(high|medium|low|minimal|fast|thinking)\\b/gi, ''));
  const level = (${JSON.stringify(model)}.match(/\\b(high|medium|low|minimal)\\b/i) || [])[1] || '';
  const sel = '[role="option"],[role="menuitem"],[role="listitem"],.select2-option,[class*="option"],[class*="model-item"],[data-testid*="model"]';
  const seen = [];
  const exact = [];
  const familyHits = [];
  // select2 这类组件不听 el.click()（它们挂在 mousedown/mouseup 上），必须派发完整鼠标事件序列。
  const fire = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, opts));
      }
      el.click();
      return true;
    } catch { return false; }
  };
  for (const el of document.querySelectorAll(sel)) {
    try {
      const text = (el.innerText || el.textContent || '').trim();
      if (text.length === 0 || text.length > 160) continue;
      seen.push(text.replace(/\\n/g, ' ').slice(0, 48));
      const n = norm(text);
      const r = el.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      if (n.includes(want)) exact.push({ el, text: text.replace(/\\n/g, ' ').slice(0, 60), area });
      else if (family.length > 0 && n.includes(family)) familyHits.push({ el, text: text.replace(/\\n/g, ' ').slice(0, 60), area });
    } catch { /* 忽略 */ }
  }
  const click = (hit, via) => { fire(hit.el); return { ok: true, picked: hit.text, via, options: seen.slice(0, 24) } };
  if (exact.length > 0) { exact.sort((a, b) => a.area - b.area); return click(exact[0], 'exact'); }
  if (familyHits.length > 0) {
    familyHits.sort((a, b) => a.area - b.area);
    const hit = familyHits[0];
    // 行内找档位子标签（元素自身没有子元素且文字等于档位词）
    if (level.length > 0) {
      for (const node of hit.el.querySelectorAll('*')) {
        try {
          if (node.children.length > 0) continue;
          if ((node.textContent || '').trim().toLowerCase() === level.toLowerCase()) { node.click(); return { ok: true, picked: hit.text + ' [' + level + ']', via: 'family+level', options: seen.slice(0, 24) }; }
        } catch { /* 忽略 */ }
      }
    }
    return click(hit, 'family');
  }
  return { ok: false, reason: 'no option matched ' + JSON.stringify(${JSON.stringify(model)}), options: seen.slice(0, 24) };
})()`
}

/**
 * 数一数当前可见的模型选项（用于判断选择器是否已经打开，避免把已打开的菜单点关掉）。
 *
 * 选择器必须**收紧**：通用 `[role=menuitem]` 会把 IDE 菜单栏项（文件/编辑/…）也数进来，
 * 于是误判成"已打开"、跳过打开步骤 → 真选项根本没进 DOM（Qoder CN 就栽在这）。
 */
function countModelOptionsSnippet(): string {
  return `(() => {
  const sel = '[role="option"], .select2-option, [data-testid*="model-selector"] [role="menuitem"], [class*="model-list"] [role="menuitem"], [class*="model-selector"] [role="menuitem"]';
  let count = 0;
  const sample = [];
  for (const el of document.querySelectorAll(sel)) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) continue;
      const text = (el.innerText || '').trim();
      if (text.length === 0) continue;
      count += 1;
      if (sample.length < 6) sample.push(text.replace(/\\n/g, ' ').slice(0, 30));
    } catch { /* 忽略 */ }
  }
  return { count, sample };
})()`
}

/** 点家族行展开出来的档位/速度芯片（Antigravity：High/Medium/Low × Fast/Thinking）。 */
function clickChipSnippet(word: string): string {
  return `(() => {
  const want = ${JSON.stringify(word)}.toLowerCase();
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    try {
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (text.length === 0 || text.length > 24) continue;
      if (text.toLowerCase() !== want) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      hits.push({ el, text, area: r.width * r.height, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    } catch { /* 忽略 */ }
  }
  if (hits.length === 0) return { ok: false, reason: 'chip ' + JSON.stringify(${JSON.stringify(word)}) + ' not found' };
  hits.sort((a, b) => a.area - b.area);
  hits[0].el.click();
  return { ok: true, chip: hits[0].text, rect: hits[0].rect };
})()`
}

// ─────────────────── 用真实鼠标换模型（合成事件在 ZCode 上点不开也卡死） ───────────────────

/** 换模型只用到会话的这两件事：页面求值 + 真实鼠标（`mouse` 只有 CDP 会话有）。 */
export interface ModelSwitchSession {
  evaluate(expression: string): Promise<unknown>
  mouse?(action: 'click' | 'move', x: number, y: number): Promise<void>
}

export interface ModelSwitchReport {
  readonly ok: boolean
  readonly before: string
  readonly picked: string
  readonly after: string
  readonly via: string
  readonly detail?: string
}

interface ModelTrigger {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly label: string
  readonly selector: string
}

interface ModelState {
  readonly current: string
  readonly currentFrom: string
  readonly aria: string
  readonly menuOpen: boolean
  readonly menuItems: number
  readonly trigger?: ModelTrigger
}

interface ModelCandidate {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly text: string
  readonly model: string
  readonly testid: string
  readonly value: string
  readonly providerKey: string
  readonly popup: string
  readonly role: string
  readonly label: string
}

/** 子菜单探测预算：父行最多 12 行 / 最多 10s。 */
const MODEL_PARENT_ROWS = 12
const MODEL_SUBMENU_BUDGET_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 模型名的比较形态：忽略大小写、空白、括号与 `- _ : /` 分隔符。 */
function normModel(value: string): string {
  return value.toLowerCase().replace(/[\s_()（）\-:/\\]+/g, '')
}

/** 触发按钮上读到的值是否就是想要的那个模型（ZCode 的值形如 `custom:<provider>:<model>`）。 */
function modelMatches(have: string, want: string): boolean {
  const target = normModel(want)
  if (target.length === 0) return false
  const current = normModel(have)
  return current === target || current.includes(target)
}

/**
 * 候选行打分：0 = 不匹配，1 = 子串，2 = 前缀/后缀，3 = 完全相等。
 * 4 个字段都看：data-model（MiMo）、data-testid（ZCode 的
 * `chat-model-select-item-custom:<provider>:<model>`）、data-value 与可见文字。
 */
function scoreModelCandidate(candidate: ModelCandidate, want: string): number {
  const target = normModel(want)
  if (target.length === 0) return 0
  let best = 0
  for (const field of [candidate.model, candidate.testid, candidate.value, candidate.text]) {
    const haystack = normModel(field)
    if (haystack.length === 0) continue
    if (haystack === target) {
      best = Math.max(best, 3)
      continue
    }
    if (haystack.endsWith(target) || haystack.startsWith(target)) {
      best = Math.max(best, 2)
      continue
    }
    if (haystack.includes(target)) best = Math.max(best, 1)
  }
  return best
}

/** 同分取面积最小的那一行（菜单里常有「外层容器 + 内层行」两份）。 */
function bestModelCandidate(candidates: readonly ModelCandidate[], want: string): ModelCandidate | undefined {
  let best: ModelCandidate | undefined
  let bestScore = 0
  for (const candidate of candidates) {
    const score = scoreModelCandidate(candidate, want)
    if (score === 0) continue
    if (best === undefined || score > bestScore || (score === bestScore && candidate.w * candidate.h < best.w * best.h)) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

function toCandidate(value: unknown): ModelCandidate | undefined {
  const raw = asRecord(value)
  if (raw === undefined) return undefined
  const w = asNumber(raw.w)
  const h = asNumber(raw.h)
  if (w < 4 || h < 4) return undefined
  return {
    x: asNumber(raw.x),
    y: asNumber(raw.y),
    w,
    h,
    text: asText(raw.text),
    model: asText(raw.model),
    testid: asText(raw.testid),
    value: asText(raw.value),
    providerKey: asText(raw.key),
    popup: asText(raw.popup),
    role: asText(raw.role),
    label: asText(raw.label),
  }
}

/**
 * 一次求值读全：触发按钮的屏幕矩形 + 当前模型 + 菜单是否已经开着。
 *
 * ZCode 的触发按钮 innerText 是**过期的动画胶片帧**（`管理模型 step/step-5-preview` 里混着上一帧），
 * 所以值只从属性读：隐藏载体 `span[data-testid="v4-model-config"]` 的 `data-provider`/`data-model`，
 * 其次是 `data-model-current-value`；只有拿不到任何属性源时才退回标签元素 / innerText。
 */
function readModelStateSnippet(): string {
  return `(() => {
  const SELECTORS = ['#model-btn', '[data-testid="chat-model-select-trigger"]', '[class*="model-selector"]', '[class*="model-list-selector"]'];
  const rect = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
  const text = (el) => String(el === null || el === undefined ? '' : (el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();
  const attr = (el, name) => el === null || el === undefined ? '' : String(el.getAttribute(name) || '').trim();
  const visible = (el) => { const r = el === null ? null : rect(el); return r !== null && r.width >= 12 && r.height >= 8 ? r : null; };
  let trigger = null;
  let triggerRect = null;
  let matchedBy = '';
  for (const selector of SELECTORS) {
    let found = null;
    try { found = document.querySelector(selector); } catch (e) { found = null; }
    const r = visible(found);
    if (r !== null) { trigger = found; triggerRect = r; matchedBy = selector; break; }
  }
  let carrier = null;
  try { carrier = document.querySelector('span[data-testid="v4-model-config"]'); } catch (e) { carrier = null; }
  const labelEl = trigger === null ? null : trigger.querySelector('.model-label');
  const aria = attr(trigger, 'aria-label');
  const dataCurrent = attr(trigger, 'data-model-current-value');
  const dataModel = attr(trigger, 'data-model');
  const carrierModel = attr(carrier, 'data-model');
  const carrierProvider = attr(carrier, 'data-provider');
  let current = '';
  let currentFrom = 'none';
  if (carrierModel.length > 0) { current = carrierModel; currentFrom = 'v4-model-config[data-model]'; }
  else if (dataCurrent.length > 0) { current = dataCurrent; currentFrom = 'trigger[data-model-current-value]'; }
  else if (dataModel.length > 0) { current = dataModel; currentFrom = 'trigger[data-model]'; }
  else if (labelEl !== null && text(labelEl).length > 0) { current = text(labelEl); currentFrom = '.model-label'; }
  else if (trigger !== null && carrier === null && text(trigger).length > 0) { current = text(trigger).slice(0, 80); currentFrom = 'innerText'; }
  else if (aria.length > 0) { current = aria; currentFrom = 'aria-label'; }
  let menuItems = 0;
  for (const menu of document.querySelectorAll('[role="menu"]')) {
    const r = rect(menu);
    if (r === null || r.width < 20 || r.height < 20) continue;
    menuItems += menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]').length;
  }
  return {
    current: current,
    currentFrom: currentFrom,
    aria: aria,
    menuOpen: menuItems > 0,
    menuItems: menuItems,
    trigger: triggerRect === null ? null : {
      x: Math.round(triggerRect.x), y: Math.round(triggerRect.y),
      w: Math.round(triggerRect.width), h: Math.round(triggerRect.height),
      label: current.length > 0 ? current : aria,
      selector: matchedBy
    }
  };
})()`
}

/**
 * 列出当前可见的候选行（选项 + 能展开子菜单的父行）。**只读，不派发任何事件**：
 * 从页面里 dispatchEvent 会把 ZCode 的求值卡死。
 */
function listModelOptionsSnippet(): string {
  return `(() => {
  const rect = (el) => { try { return el.getBoundingClientRect(); } catch (e) { return null; } };
  const text = (el) => String(el === null || el === undefined ? '' : (el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();
  const row = (el) => {
    const r = rect(el);
    if (r === null || r.width < 12 || r.height < 8) return null;
    return {
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      text: text(el).slice(0, 120),
      model: String(el.getAttribute('data-model') || ''),
      testid: String(el.getAttribute('data-testid') || ''),
      value: String(el.getAttribute('data-value') || ''),
      key: String(el.getAttribute('data-model-provider-key') || ''),
      popup: String(el.getAttribute('aria-haspopup') || ''),
      role: String(el.getAttribute('role') || '')
    };
  };
  const CANDIDATES = '[role="option"],[role="menuitem"],[role="menuitemradio"],.select2-option,[data-model],[class*="model-item"]';
  const seen = [];
  const candidates = [];
  for (const el of document.querySelectorAll(CANDIDATES)) {
    if (seen.indexOf(el) >= 0) continue;
    seen.push(el);
    const info = row(el);
    if (info !== null) candidates.push(info);
  }
  // 父行：能展开子菜单的那些（ZCode 用 data-model-provider-key / aria-haspopup="menu"；
  // 另有一条弱规则兜住 data-slot="dropdown-menu-content" 里带 caret 的 menuitem）。
  const subRoots = [];
  for (const el of document.querySelectorAll('[data-slot="dropdown-menu-sub-content"]')) subRoots.push(el);
  const parents = [];
  for (const menu of document.querySelectorAll('[role="menu"]')) {
    const rm = rect(menu);
    if (rm === null || rm.width < 20 || rm.height < 20) continue;
    if (subRoots.indexOf(menu) >= 0) continue;
    const slot = String(menu.getAttribute('data-slot') || '');
    for (const el of menu.querySelectorAll('[data-model-provider-key],[aria-haspopup="menu"],[role="menuitem"]')) {
      const info = row(el);
      if (info === null) continue;
      const strong = info.key.length > 0 || info.popup === 'menu';
      const weak = slot === 'dropdown-menu-content' && info.role === 'menuitem'
        && el.querySelector('svg') !== null && info.text.length > 0 && info.text.length <= 40;
      if (!strong && !weak) continue;
      info.label = info.text.length > 0 ? info.text : info.testid;
      parents.push(info);
    }
  }
  return { candidates: candidates, parents: parents };
})()`
}

async function readModelState(session: ModelSwitchSession): Promise<ModelState> {
  const raw = asRecord(await session.evaluate(readModelStateSnippet()))
  const triggerRaw = raw === undefined ? undefined : asRecord(raw.trigger)
  const trigger: ModelTrigger | undefined = triggerRaw === undefined
    ? undefined
    : {
      x: asNumber(triggerRaw.x),
      y: asNumber(triggerRaw.y),
      w: asNumber(triggerRaw.w),
      h: asNumber(triggerRaw.h),
      label: asText(triggerRaw.label),
      selector: asText(triggerRaw.selector),
    }
  return {
    current: asText(raw?.current),
    currentFrom: asText(raw?.currentFrom),
    aria: asText(raw?.aria),
    menuOpen: raw?.menuOpen === true,
    menuItems: asNumber(raw?.menuItems),
    ...(trigger === undefined || trigger.w < 4 ? {} : { trigger }),
  }
}

/**
 * 只读地读出会话当前选中的模型（CDP 会话走 DOM 触发器）。
 * 非 CDP 会话没有页面求值，调用方应先判断 `session.evaluate`。
 */
export async function currentModelOf(session: { evaluate(expression: string): Promise<unknown> }): Promise<string> {
  return (await readModelState(session)).current
}

async function listModelOptions(session: ModelSwitchSession): Promise<{ candidates: ModelCandidate[], parents: ModelCandidate[] }> {
  const raw = asRecord(await session.evaluate(listModelOptionsSnippet()))
  const toList = (value: unknown): ModelCandidate[] =>
    (Array.isArray(value) ? value : []).map(toCandidate).filter((entry): entry is ModelCandidate => entry !== undefined)
  return { candidates: toList(raw?.candidates), parents: toList(raw?.parents) }
}

/**
 * 换模型：真实鼠标点开选择器 → 直接找目标项 → 找不到就逐个父行 hover 出子菜单再找 → 点中 → 读回。
 * 全过程不往页面里派发任何合成事件（那会把 ZCode 的求值卡死）。
 */
export async function switchModel(session: ModelSwitchSession, wanted: string): Promise<ModelSwitchReport> {
  const state = await readModelState(session)
  const before = state.current
  if (session.mouse === undefined) {
    return { ok: false, before, picked: '', after: before, via: 'none', detail: 'this session cannot dispatch real mouse input (not a CDP session)' }
  }
  // 注意：必须用 `session.mouse(...)` 这种属性调用形式，方法内部要用 `this.connection`
  // （把方法摘出来当裸函数调用会丢 this）。
  const mouse = async (action: 'click' | 'move', x: number, y: number): Promise<void> => await session.mouse!(action, x, y)
  if (modelMatches(before, wanted)) {
    return { ok: true, before, picked: before, after: before, via: 'already' }
  }
  if (state.trigger === undefined) {
    return {
      ok: false, before, picked: '', after: before, via: 'none',
      detail: 'no model trigger is visible (looked for #model-btn, [data-testid="chat-model-select-trigger"], [class*=model-selector], [class*=model-list-selector])',
    }
  }
  const clickTrigger = async (): Promise<void> => {
    const trigger = state.trigger!
    await mouse('click', trigger.x + trigger.w / 2, trigger.y + trigger.h / 2)
  }
  let openedByUs = false
  if (!state.menuOpen) {
    await clickTrigger()
    openedByUs = true
    await sleep(900)
  }
  let listed = await listModelOptions(session)
  let hit = bestModelCandidate(listed.candidates, wanted)
  let via = 'direct'
  if (hit === undefined && !openedByUs) {
    // 菜单其实没开着：补一次打开再找
    await clickTrigger()
    await sleep(900)
    listed = await listModelOptions(session)
    hit = bestModelCandidate(listed.candidates, wanted)
  }
  const tried: string[] = []
  if (hit === undefined) {
    const deadline = Date.now() + MODEL_SUBMENU_BUDGET_MS
    for (const parent of listed.parents.slice(0, MODEL_PARENT_ROWS)) {
      if (Date.now() >= deadline) break
      const label = parent.label.length > 0 ? parent.label : `row@${parent.x},${parent.y}`
      tried.push(label)
      await mouse('move', parent.x, parent.y)
      await sleep(700)
      const opened = await listModelOptions(session)
      const found = bestModelCandidate(opened.candidates, wanted)
      if (found !== undefined) {
        hit = found
        via = `submenu:${label}`
        break
      }
    }
  }
  if (hit === undefined) {
    const sample = listed.candidates.slice(0, 12).map(entry => entry.text || entry.model || entry.testid).filter(entry => entry.length > 0)
    return {
      ok: false, before, picked: '', after: before, via: 'none',
      detail: `no visible option matched "${wanted}" (saw ${listed.candidates.length} option(s)${sample.length > 0 ? `: ${sample.join(' | ')}` : ''}; `
        + `submenu rows tried: ${tried.length > 0 ? tried.join(' | ') : 'none'})`,
    }
  }
  const picked = hit.text.length > 0 ? hit.text : (hit.model.length > 0 ? hit.model : hit.testid)
  await mouse('click', hit.x, hit.y)
  await sleep(600)
  const after = (await readModelState(session)).current
  const ok = modelMatches(after, wanted)
  return {
    ok,
    before,
    picked,
    after,
    via,
    ...(ok ? {} : { detail: `clicked "${picked}" (${via}) but the trigger now reads "${after}"` }),
  }
}

/** 页面内换模型的成败与说明（`ok` 供调用方 fail-closed 判定）。 */
export interface InPageModelSwitchReport {
  readonly ok: boolean
  readonly note: string
  /**
   * **切换后从页面回读到的实际模型**（读不到就是 `''`）。
   *
   * 为什么必须有：这条路径以前只信页面自述的 `ok` —— 页面说点中了就算成功，
   * 而「点中的那一个是不是请求的那个」从未被独立核验（需求 ⑧：请求值 ≠ 实际值要提示、未知即未知）。
   */
  readonly after?: string
  /** `after` 是否与请求一致（读不到时为 `false`，并且 note 里写明「读不到，无法确认」）。 */
  readonly matches?: boolean
}

/** 没有真实鼠标的会话（理论上只剩非 CDP 通道）：保留原来的页面内合成事件路径。 */
export async function switchModelInPage(session: { evaluate(expression: string): Promise<unknown> }, wanted: string): Promise<InPageModelSwitchReport> {
  const notes: string[] = ['model switch via=evaluate (this session has no real CDP mouse)']
  const before = await session.evaluate(countModelOptionsSnippet())
  const alreadyOpen = Number((before as { count?: number }).count ?? 0) > 0
  if (alreadyOpen) {
    notes.push(`model picker already open (${(before as { count?: number }).count} options)`)
  } else {
    const opened = await session.evaluate(openModelPickerSnippet())
    notes.push(`model picker: ${JSON.stringify(opened).slice(0, 200)}`)
    await sleep(800)
  }
  const picked = await session.evaluate(pickModelOptionSnippet(wanted))
  notes.push(`model select "${wanted}": ${JSON.stringify(picked).slice(0, 400)}`)
  // 页面内 JS 用 `ok` 字段自述成败（与 clickByTextSnippet 同一约定）——不能只看有没有抛异常。
  let ok = (picked as { ok?: boolean }).ok === true
  await sleep(600)
  // 家族行被点开后，档位/速度芯片是后续渲染出来的：再补一次精确点击。
  if ((picked as { via?: string }).via === 'family') {
    const level = (wanted.match(/\b(high|medium|low|minimal)\b/i) ?? [])[1]
    const speed = (wanted.match(/\b(fast|thinking)\b/i) ?? [])[1]
    for (const word of [level, speed]) {
      if (word === undefined) continue
      await sleep(500)
      const chip = await session.evaluate(clickChipSnippet(word))
      if ((chip as { ok?: boolean }).ok !== true) ok = false
      notes.push(`chip "${word}": ${JSON.stringify(chip).slice(0, 160)}`)
    }
    await sleep(500)
  }
  /**
   * **回读实际值**（这一步以前没有 ⇒ 「页面说 ok」就等于成功）。
   *
   * 三个结局都要如实报，**不许**把「读不到」当成一致：
   *   · 读到且与请求一致 ⇒ `matches: true`；
   *   · 读到但与请求不同 ⇒ `ok: false` + `matches: false`（页面点中了别的行/档位）；
   *   · 读不到 ⇒ `matches: false` + note 写明「无法确认」（未知即未知）。
   */
  let after = ''
  try {
    const state = await session.evaluate(readModelStateSnippet())
    after = String((state as { current?: unknown }).current ?? '')
  } catch (error: unknown) {
    notes.push(`read-back failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const matches = after.length > 0 && modelMatches(after, wanted)
  if (after.length === 0) {
    ok = false
    notes.push('read-back: 读不到当前模型（无法确认切换是否真的生效 —— 不把「读不到」当成成功）')
  } else if (!matches) {
    ok = false
    notes.push(`read-back: 实际模型是 ${JSON.stringify(after)}，与请求的 ${JSON.stringify(wanted)} **不一致**`)
  } else {
    notes.push(`read-back: 实际模型 ${JSON.stringify(after)} 与请求一致`)
  }
  return { ok, note: notes.join(' | '), after, matches }
}

export function registerTools(ctx: any, deps: ToolDeps): void {
  const { config, registry, subagents } = deps
  const register = (definition: unknown, label: string): void => {
    // 幂等：同一个包可能被两条 loader 行加载（profile bundles 行 + 注入行），
    // 第二次注册同名工具会抛错并让 fiber 失败 —— 已存在就跳过。
    const toolName = (definition as { name?: string }).name ?? ''
    if (toolName.length > 0 && typeof ctx.tools?.get === 'function' && ctx.tools.get(toolName) !== undefined) {
      return
    }
    ctx.effect(() => ctx.tools.register(definition), `@dsh-external/dsh-harness-pilot: ${label}`)
  }

  register(defineTool({
    name: 'harness_list',
    description:
      'List the external agent harnesses (OpenCode, Antigravity agy, Claude Code, Codex, Cursor, Qoder, ZCode, MiMo, …) '
      + 'this plugin can drive, with the transports each one supports. Pass probe=true to also test which transport is '
      + 'currently usable on this machine (slower: it touches windows / ports).',
    parameters: {
      target: { type: 'string', description: 'Only inspect this harness name; omit for all' },
      probe: { type: 'boolean', description: 'Run per-transport availability probes as well (default false)' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: any): Promise<{ text: string }> {
      const wanted = typeof args.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : undefined
      const targets = wanted === undefined
        ? config.resolvedTargets
        : config.resolvedTargets.filter(entry => entry.name.toLowerCase() === wanted.toLowerCase())
      if (targets.length === 0) {
        return textOutput(`unknown harness "${String(wanted)}"; known: ${config.resolvedTargets.map(entry => entry.name).join(', ')}`)
      }
      const lines: string[] = [`harness targets (default: ${config.defaultTarget}) — ${targets.length} shown`]
      for (const target of targets) {
        const probe = target.command.length > 0 ? probeCommand(target.command) : { available: false, error: 'no command configured (GUI-only harness)' }
        lines.push(
          `\n## ${target.name}\n`
          + `  transport: ${target.transport}\n`
          + `  support: acp=${target.acpArgs.join(' ') || '-'} headless=${target.args.join(' ') || '-'} window=${target.window.process || target.window.title || '-'}\n`
          // 持久原生会话能力（P2）：声明了协议能力的目标才能用 harness_task_start 的
          // persistent/session_id 参数（逻辑会话 + 原生 ID 精确恢复）。
          + `  native-session: ${target.nativeCli === undefined ? 'no（一次性派发）' : `yes（protocol=${target.nativeCli.protocol}；harness_task_start 支持 persistent/session_id，CLI 进程可在轮次后退出再精确恢复）`}\n`
          + `  command: ${target.command.length > 0 ? `${target.command} → ${probe.available ? probe.path : `NOT FOUND (${probe.error})`}` : '(none)'}\n`
          + `  ${target.description}`,
        )
        if (args.probe === true) {
          const order: TransportKind[] = (target.order.length > 0 ? target.order : ['acp', 'headless', 'pty', 'cdp', 'window'])
            .filter((kind): kind is TransportKind => ['acp', 'headless', 'pty', 'cdp', 'window'].includes(kind))
          for (const kind of order) {
            const check = await registry.preflight(kind, target)
            lines.push(`  probe ${kind}: ${check.available ? 'OK' : 'no'} — ${check.detail}`)
          }
        }
      }
      lines.push(
        '\nUse harness_dispatch to hand a one-shot task to one of them, harness_agent to delegate through the '
        + 'registered subagent provider, and harness_open + harness_send to drive a GUI harness interactively.',
      )
      return textOutput(lines.join('\n'))
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_list${args.target ? ` ${String(args.target)}` : ''}`, kind: 'read' as const }
    },
  }), 'harness_list')

  register(defineTool({
    name: 'harness_models',
    description:
      'List which models a harness can run: the provider routes/models configured in this DSH profile, plus the models each '
      + 'harness advertises itself (asked directly from its CLI, cached for a few minutes). Use the returned ids with '
      + 'harness_dispatch(model=…) or harness_agent(model=…).',
    parameters: {
      target: { type: 'string', description: 'Only this harness; omit to query every harness that advertises a model list' },
      refresh: { type: 'boolean', description: 'Ignore the cache and re-query the harness CLIs (default false)' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: any): Promise<{ text: string }> {
      if (args.refresh === true) registry.clearModelCache()
      const overview = await registry.overview({ models: false })
      const lines: string[] = [`DSH profile providers (${overview.dsh.providers.length}) — what this DSH install itself can route to:`]
      if (overview.dsh.providers.length === 0) {
        lines.push('  (ctx.llm reported no providers)')
      } else {
        for (const provider of overview.dsh.providers) {
          const sample = provider.models.slice(0, 3).join(', ')
          lines.push(`  - ${provider.id} (${provider.name}): ${provider.models.length} model(s)${sample.length > 0 ? ` — e.g. ${sample}` : ''}`)
        }
      }

      const wanted = typeof args.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : undefined
      if (wanted !== undefined) {
        const target = registry.target(wanted)
        const found = await registry.targetModels(target)
        const entries = found.entries ?? modelEntriesFor({})
        const counts = countByKind(entries)
        const provider = providerIdFor(classifyTarget({ name: target.name }))
        lines.push(`\n## ${target.name}`)
        lines.push(`  provider（原生模型选择器里的分组）: ${provider}`)
        lines.push(`  model mechanism: ${mechanismOf(target)}`)
        lines.push(`  四态: ${found.state === undefined ? '未测量' : `${found.state.label} — ${found.state.evidence}`}`)
        lines.push(`  query: ${found.note}`)
        if (entries.length === 0) {
          lines.push('  (这条 harness 现在报不出任何模型 —— 未安装/未登录/没有列举能力/没有配置供应商，见上面的四态)')
        } else {
          lines.push(`  四类：可选择 ${counts.selectable} / 别名 ${counts.alias} / 仅展示 ${counts['display-only']} / 当前默认 ${counts['current-default']}`)
          // 只有「能作为 CLI 模型参数」的条目可传给 model（校验会照这份清单比）。
          const usable = entries.filter((entry) => entry.selectable)
          lines.push(`  可传给 model=（${usable.length} 个，纯 id 或 \`${provider}/<model>\` 两种写法等价）：`)
          for (const entry of usable.slice(0, 80)) {
            const meta = entry.meta
            const extra = meta === undefined
              ? ''
              : `${meta.name === undefined ? '' : ` ${meta.name}`}${meta.vendor === undefined ? '' : ` vendor=${meta.vendor}`}`
                + `${meta.maxOutputTokens === undefined ? '' : ` 输出上限=${meta.maxOutputTokens}`}`
            lines.push(`    ${entry.id}   [${MODEL_KIND_LABEL[entry.kind]} · ${entry.source}]${extra}`)
          }
          if (usable.length > 80) lines.push(`    …（还有 ${usable.length - 80} 个；完整清单见 设置 → 外部 harness 管理）`)
          const displayOnly = entries.filter((entry) => entry.kind === 'display-only')
          if (displayOnly.length > 0) {
            lines.push(`  ⚠️ 另有 ${displayOnly.length} 个**仅展示**的条目（厂商名册/原生目录里有、但 CLI 不接受为 --model）：`
              + `${displayOnly.slice(0, 10).map((entry) => `${entry.id}${entry.meta?.maxOutputTokens === undefined ? '' : `(${Math.round(entry.meta.maxOutputTokens / 1000)}k)`}`).join(', ')}${displayOnly.length > 10 ? ' …' : ''}`)
          }
          const defaults = entries.filter((entry) => entry.kind === 'current-default')
          if (defaults.length > 0) {
            lines.push(`  厂商默认模型（product config 的 isDefault）：${defaults.map((entry) => entry.id).join(', ')}`
              + `（⚠️ 有默认 ≠ 可作为 --model：看它是不是在「可传给 model」那一栏里）`)
          }
          /**
           * **厂商角色映射（别名 → 底层模型）**。
           *
           * `meta.relatedModels` 是厂商 product config 里的 `{角色: 模型 id}`（实测角色有
           * `lite` / `reasoning` / `builtin-lite`）。多数条目指向**自己**（没有信息量），
           * 所以这里只列**指向别的 id** 的那些 —— 那才是真正的「别名/底层模型」关系
           * （实测例：国内 `builtin-lite=wb-lite`；国际 `default-model` 的 `lite=default-model-lite`）。
           * 需求 ② 要求区分「模型别名」——这一段就是它的**有据**呈现，不是猜的。
           */
          const aliasRows: string[] = []
          for (const entry of entries) {
            const related = entry.meta?.relatedModels
            if (related === undefined) continue
            const foreign = Object.entries(related).filter(([, target]) => target !== entry.id)
            if (foreign.length === 0) continue
            aliasRows.push(`    ${entry.id} → ${foreign.map(([role, target]) => `${role}=${target}`).join(', ')}`)
          }
          if (aliasRows.length > 0) {
            lines.push(`  厂商角色映射（**别名 → 别的模型 id**，来自 product config 的 relatedModels；`
              + `指向自己的条目已省略，共 ${aliasRows.length} 条）：`)
            for (const row of aliasRows.slice(0, 12)) lines.push(row)
            if (aliasRows.length > 12) lines.push(`    …（还有 ${aliasRows.length - 12} 条）`)
            lines.push('    ⚠️ 这些底层 id **不一定**能作为 --model 传（要看它是否在「可传给 model」那一栏）。')
          }
          lines.push(`  保留值：${CLI_DEFAULT_MODEL_ID}（不下发 --model，用该 CLI 自己的默认档）`)
        }
        return textOutput(lines.join('\n'))
      }

      const queried = config.resolvedTargets.filter(entry => entry.modelsCommand.length > 0 || entry.modelsFixed.length > 0 || entry.modelsFile.length > 0)
      const results = await Promise.all(queried.map(async entry => ({ target: entry, ...(await registry.targetModels(entry)) })))
      for (const entry of results) {
        lines.push(`\n## ${entry.target.name}  [${mechanismOf(entry.target)}]`)
        lines.push(`  query: ${entry.note}`)
        if (entry.models.length === 0) lines.push('  (no models listed)')
        else {
          lines.push(`  models (${entry.models.length}):`)
          for (const model of entry.models.slice(0, 40)) lines.push(`    ${model}`)
        }
      }
      lines.push('\nharnesses with no model source (modelsCommand / modelsFixed / modelsFile) were skipped; pass target=<name> to inspect one explicitly (GUI-only harnesses select the model inside their own UI).')
      return textOutput(lines.join('\n'))
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_models${args.target ? ` ${String(args.target)}` : ''}`, kind: 'read' as const }
    },
  }), 'harness_models')

  register(defineTool({
    name: 'harness_dispatch',
    description:
      'Hand one self-contained task to another agent harness and return its reply text. The transport is chosen '
      + 'automatically (ACP → CLI headless → interactive pty → Chromium CDP → window control), so GUI-only harnesses '
      + 'work too. Use this when you want a different product/model to do the work rather than a DSH subagent.',
    parameters: {
      target: { type: 'string', description: 'Harness name from harness_list (e.g. opencode, agy, zcode). Omit to use this session\'s binding (会话页所选 Harness), else the default target' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for that harness' },
      cwd: { type: 'string', description: 'Working directory; defaults to this session workspace' },
      transport: { type: 'string', enum: ['auto', 'acp', 'headless', 'pty', 'cdp', 'window'], description: 'Force one transport (default auto)' },
      model: { type: 'string', description: 'Model id for this run; omit to use this session\'s binding. See harness_models for what each harness offers' },
      extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra argv appended after the target defaults, e.g. ["--model","opencode-go/deepseek-v4.1-flash"]' },
      timeout_ms: { type: 'integer', description: 'Hard deadline in ms (default: target default)' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const picked = resolveTargetAndModel(deps, exec, args.target, args.model)
      const target = registry.target(picked.wanted)
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (agentCwd(exec?.agent) ?? process.cwd())
      const extraArgs = Array.isArray(args.extra_args) ? args.extra_args.map((value: unknown) => String(value)) : undefined
      // 模型引用先**校验**（三种形态 + 可选清单核对）——拒绝时绝不派发。
      const ref = await validateModelRef(registry, target, picked.model, extraArgs !== undefined)
      if (!ref.ok) return textOutput(modelRefRefusal(ref))
      const model = ref.model
      const outcome = await registry.dispatch({
        target,
        prompt: String(args.prompt),
        cwd,
        signal: exec?.signal ?? new AbortController().signal,
        timeoutMs: Number(args.timeout_ms ?? target.timeoutMs),
        ...(extraArgs === undefined ? {} : { extraArgs }),
        ...(model === undefined ? {} : { model }),
      }, typeof args.transport === 'string' ? { transport: args.transport } : {})
      // 用了会话绑定补出来的值就要**说明来源**，否则调用方无从分辨是自己指定的还是继承的。
      const via = picked.fromBinding.length > 0 ? `\n[via 会话绑定] ${picked.fromBinding.join(' + ')} ← 会话页所选 Harness/模型\n` : ''
      // 模型引用的形态与是否核对过清单，一起回报（未知即未知）。
      const refNote = `\n[model-ref] form=${ref.form} verified=${String(ref.verified)} — ${ref.note}`
      return textOutput(formatOutcome(outcome, target.name) + via + refNote)
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_dispatch → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_dispatch')

  register(defineTool({
    name: 'harness_agent',
    description:
      'Delegate a task to another harness AS a DSH subagent run (through the registered SubagentProvider), so it '
      + 'participates in the normal subagent lifecycle: stable run id, stop reason, partial output and diagnostics. '
      + 'The returned runId is also recorded in the plugin run ledger, so harness_task_status / harness_task_list can '
      + 'report its state later (kind=subagent) — a run that hangs shows status=stalled instead of failing silently. '
      + 'Use harness_dispatch when you only need the text back.',
    parameters: {
      target: { type: 'string', required: true, description: 'Harness name from harness_list' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for that harness' },
      description: { type: 'string', description: 'Short 3-5 word label for display and logs' },
      model: { type: 'string', description: 'Optional model id for this run. It is carried to the registered SubagentProvider as the per-child `agentOptions` (the provider declares that capability) and really lands on the CLI command line (e.g. `-m Qwen3.8-Flash`); a target without `modelArgs` is refused instead of silently ignoring it. Reasoning effort / max tokens are NOT supported on this path (refused explicitly). Can be combined with accountId.' },
      accountId: { type: 'string', description: 'Account profile id (e.g. qoder-cn-a) to run this subagent as. Routes through that account\'s registered alias provider (harness-<target>-acct-<id>), which already carries the account recipe. An unknown/removed account is refused — there is no fallback to another account or to the plain provider. May be combined with model.' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const picked = resolveTargetAndModel(deps, exec, args.target, args.model)
      const target = registry.target(picked.wanted)
      if (subagents === undefined) {
        throw new Error('ctx.subagents is not available in this composition, so harness_agent cannot run — use harness_dispatch instead')
      }
      if (exec?.agent === undefined) {
        throw new Error('harness_agent requires a calling agent (exec.agent was undefined)')
      }
      // ── 账号档案：**点名别名 provider**，而不是把账号参数再叠进 target ──
      // 别名在注册时就已经把该档案的启动配方合并进去了（`planAccountAliases`），
      // 所以这里**绝不能**再 `withAccount(target, …)` 一次 —— 那会注入两遍 `--config-dir`，
      // 而重复的 `--config-dir` 谁生效取决于 CLI（＝「看起来换了账号、其实没有」）。
      const accountId = typeof args.accountId === 'string' && args.accountId.trim().length > 0
        ? args.accountId.trim()
        : undefined
      // 模型同样遵循「显式 > 会话绑定」，并且**先校验**：三种引用形态 + 与当前可选清单核对。
      // 事件：不校验时一个笔误会被 provider 原样带进 CLI，报出一个与该 CLI 相关的错，很难归因。
      const ref = await validateModelRef(registry, target, picked.model, false)
      if (!ref.ok) return textOutput(modelRefRefusal(ref))
      const model = ref.model
      /**
       * 本次要真正生效的模型：作为 **per-child `agentOptions`** 交给 provider。
       *
       * 为什么不再走「直接派发」：那会绕过子代理 provider ⇒ 没有 runId、没有账本、没有身份行，
       * 而「外部 harness 作为 DSH 子代理」的全部生命周期价值正在这里。宿主契约允许这条路：
       * `subagents.start(name, {agentOptions})` 在 provider 声明 `capabilities.agentOptions` 后原样透传
       * （rc.2 `dsh-subagent/lib/types/index.js:457-470` 的 gate + `types/typert.host.js:242/778`），
       * 而 `HarnessProvider.start()` 现在真的把它落到 CLI 命令行（见 `childAgentOptionsDecision`）。
       */
      const agentOptions = model === undefined ? undefined : { provider: ROUTE, model }
      let providerName: string
      let shownProvider: string
      if (accountId !== undefined) {
        const redactedName = redactedAccountAliasName(target, accountId)
        if (deps.accountSeeds === undefined) {
          throw new Error(
            `harness_agent: 指定了 accountId，但本组合没有挂载账号档案解析器（accountSeeds 缺失），`
            + '因此无法判定该账号**现在**是否可用（判不出「注册过但已被删除」）。'
            + '\n本次是**显式拒绝**：不猜、不回退到不带账号的 provider。',
          )
        }
        // 判据用 provider.ts 那**唯一**一份实现（与别名 provider 自己拒绝新任务时同一套理由）。
        const refusal = accountAliasRefusal(target, accountId, { accounts: deps.accountSeeds })
        if (refusal !== undefined) throw new Error(`harness_agent: ${refusal}`)
        // 「已注册」是**另一件事**：账号活着但没配出别名（例如该档案的 targetName 与这个目标配不上、
        // 或配方解析失败）时，provider 名根本不存在。不核对就会把一个内部报错当成用户错误。
        const known = subagents.list?.()
        if (known !== undefined && !known.includes(accountAliasNameFor(target, accountId))) {
          throw new Error(
            `harness_agent: 别名 provider「${redactedName}」**没有注册**，本次不执行。`
            + '\n可能原因：该账号档案不属于目标 "' + target.name + '"（配对规则是 seed.targetName === target 名），'
            + '或它的启动配方解析失败（注册期会以 onSkip 记一条可读原因）。'
            + `\n· 当前已注册的 provider（${known.length} 个）：${known.join(', ')}`
            + '\n本次是**显式拒绝**：不回退到不带账号的「' + providerNameFor(target) + '」—— 那等于换一个身份执行。',
          )
        }
        providerName = accountAliasNameFor(target, accountId)
        // 输出里用**脱敏**别名（原始档案 id 是内部标识，不出现在工具输出里）。
        shownProvider = redactedName
      } else {
        providerName = providerNameFor(target)
        shownProvider = providerName
      }
      // 账号与模型**可以同选**：账号在 provider 名里（注册期固化），模型经 `agentOptions`（本次透传）。
      // 两条路都不再需要「二选一」——那条限制是 provider 不能承载 per-call 模型时代的产物。
      const run = await subagents.start(providerName, {
        label: String(args.description ?? `harness ${target.name}`),
        prompt: [{ type: 'text', text: String(args.prompt) }] as ContentBlock[],
        parent: exec.agent,
        signal: exec.signal,
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      const result = await run.result
      let disposalError: string | undefined
      try {
        await run.dispose()
      } catch (error: unknown) {
        disposalError = error instanceof Error ? error.message : String(error)
      }
      const body = result.output
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      const lines = [
        `subagent provider=${shownProvider} runId=${run.id} stop=${result.stopReason}`
        + (model === undefined ? '' : ` model=${model}（经 per-child agentOptions 透传；是否真落到命令行以 provider diagnostic / CLI 自记 argv 为准）`),
        `(recorded in the run ledger — query it later with harness_task_status task_id=${run.id})`,
        '---',
        body.trim().length > 0 ? body.trim() : '(no text returned)',
      ]
      if (result.diagnostic !== undefined) lines.push(`diagnostic: ${result.diagnostic}`)
      if (disposalError !== undefined) lines.push(`dispose failed: ${disposalError}`)
      return textOutput(lines.join('\n'))
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_agent → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_agent')

  register(defineTool({
    name: 'harness_open',
    description:
      'Open (or attach to) an interactive session with a harness and return a session id plus its current screen text. '
      + 'GUI harnesses attach over Chromium CDP when a debugging port is available; otherwise the real window is used '
      + '(focus + keyboard + accessibility/console text, no OCR). Keep the session id for harness_send. '
      + 'If the target is a single-instance GUI app already running WITHOUT a debugging port, the error contains a '
      + 'ready-to-run remedy with the exact port (and a generated script path); pass kill_first=true to have the plugin '
      + 'close and relaunch it itself.',
    parameters: {
      target: { type: 'string', required: true, description: 'Harness name from harness_list' },
      cwd: { type: 'string', description: 'Working directory for a launched harness; defaults to this session workspace' },
      launch: { type: 'boolean', description: 'Allow launching the harness if it is not running (default true)' },
      transport: { type: 'string', enum: ['acp', 'pty', 'cdp', 'window'], description: 'Force one session transport instead of walking the ladder. Use transport=window when cdp is blocked by a single-instance app you do not want to restart.' },
      kill_first: { type: 'boolean', description: 'Destructive, default false. When the target is already running WITHOUT a debugging port (Electron single-instance, where relaunching would only focus the old window), terminate it and relaunch with the flag. Only this target\'s process image is touched, graceful close comes first, and it refuses if new pids appeared since the check.' },
      kill_force: { type: 'boolean', description: 'Override kill_first\'s pid-drift guard (default false). Only when you are sure the newly appeared process is the same app.' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const target = registry.target(args.target)
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (agentCwd(exec?.agent) ?? process.cwd())
      const session = await registry.open(target, {
        cwd,
        launch: args.launch !== false,
        killFirst: args.kill_first === true,
        killForce: args.kill_force === true,
        ...(typeof args.transport === 'string' && args.transport.length > 0 ? { transport: String(args.transport) } : {}),
      })
      let initial = ''
      try {
        const read = await session.read({ limit: config.maxScreenChars })
        initial = read.text
      } catch (error: unknown) {
        initial = `(initial read failed: ${error instanceof Error ? error.message : String(error)})`
      }
      return textOutput(
        `session=${session.id} harness=${target.name} transport=${session.transport} ${session.detail}\n`
        // 通道降级必须显式说出来（以前是静默降级：用户以为在用 cdp，其实跑的是 window）。
        + (session.warning === undefined ? '' : `${session.warning}\n`)
        + '--- current screen ---\n'
        + (initial.trim().length > 0 ? initial : '(empty screen text)'),
      )
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_open → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_open')

  register(defineTool({
    name: 'harness_launch',
    description:
      'Non-destructive FIRST LAUNCH of a desktop (GUI/CDP) harness with its Chromium debugging port: if the app is not '
      + 'running, the plugin starts it with --remote-debugging-port=<assigned port> so dispatch can attach without ever '
      + 'killing anything. If the endpoint is already up this is a no-op. If the app is ALREADY RUNNING WITHOUT a port '
      + '(single-instance Electron), this REFUSES to act — killing it is kill_first\'s destructive job, and nothing can '
      + 'add a port to a running instance. Use it right after boot / before dispatching to desktop targets.',
    parameters: {
      target: { type: 'string', required: true, description: 'Harness name from harness_list (must be a desktop/CDP target, e.g. workbuddy-desktop)' },
      cwd: { type: 'string', description: 'Working directory for the launched app; defaults to the target config' },
    },
    output: OUTPUT,
    async execute(args: any): Promise<{ text: string }> {
      const target = registry.target(args.target)
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? String(args.cwd) : undefined
      const result = await registry.launchDesktop(target, cwd === undefined ? {} : { cwd })
      const header = `harness_launch target=${result.target} status=${result.status}${result.port === undefined ? '' : ` port=${result.port}`}${result.pid === undefined ? '' : ` pid=${result.pid}`}${result.pids === undefined ? '' : ` pids=${result.pids.join(',')}`}`
      // 终态语义显式写出：launched/already-attachable 才是「可派发」，其余两种都不是成功。
      const verdict = result.status === 'launched' || result.status === 'already-attachable' ? 'READY' : 'NOT READY'
      return textOutput(`${header} — ${verdict}\n${result.detail}`)
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_launch → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_launch')

  register(defineTool({
    name: 'harness_send',
    description:
      'Send text (and submit) into an open harness session, then return the resulting screen text. Call it with no text '
      + 'to simply re-read the current screen. This is the direct equivalent of typing into the harness yourself.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id from harness_open' },
      text: { type: 'string', description: 'Text to insert (omit to only read the screen)' },
      submit: { type: 'boolean', description: 'Submit after typing (Enter / the harness send control); default true' },
      click: { type: 'string', description: 'CDP sessions only: click the visible element whose text matches this string (open a chat panel, press a button) before typing. If it matches nothing, NOTHING is typed or submitted (fail-closed) — see send_anyway_on_click_fail.' },
      send_anyway_on_click_fail: { type: 'boolean', description: 'Type and submit even when click= matched no element (default false). Only set this when the click was genuinely optional: otherwise the text lands wherever focus happens to be and gets submitted — a mis-delivery.' },
      model: { type: 'string', description: 'CDP sessions only: switch this GUI harness to the given model first (opens its model picker and clicks the matching option). Use harness_models/qoder-cn to see the offered names.' },
      send_anyway_on_model_fail: { type: 'boolean', description: 'Type and submit even when the model switch failed (default false), so you cannot silently send a task under the wrong model.' },
      wait_ms: { type: 'integer', description: 'How long to wait before reading back (default 1500)' },
    },
    output: OUTPUT,
    async execute(args: any): Promise<{ text: string }> {
      const session = registry.get(String(args.session_id))
      if (session === undefined) {
        // ⚠️ 2026-10-16（P-3）：「unknown session」必须可解释。最常见的真实原因是会话已被
        // 空闲回收/插件重载关闭 —— 墓碑里查得到谁、何时、被什么关的；查不到才是「从未存在」。
        const closed = registry.explainMissing(String(args.session_id))
        const known = registry.list().map(entry => entry.id).join(', ')
        throw new Error(`unknown session "${String(args.session_id)}"${closed !== undefined ? ` — ${closed}` : ''}${known.length > 0 ? `; live sessions: ${known}` : ''}`)
      }
      const notes: string[] = []
      // GUI harness 换模型：优先真实鼠标（ZCode 只认真实 pointerdown，合成事件还会卡死求值），
      // 没有 mouse 的会话退回页面内合成事件的老路径。
      if (typeof args.model === 'string' && args.model.trim().length > 0) {
        const wanted = String(args.model).trim()
        const evaluate = session.evaluate
        if (evaluate === undefined) {
          throw new Error(`session ${session.id} uses the ${session.transport} transport, which cannot switch models; GUI harnesses need the cdp transport (harness_open with launch=true)`)
        }
        const mouse = session.mouse
        // 模型切换失败也 fail-closed：否则会在「你以为已经切好了」的情况下把任务发出去。
        const modelFailed = (detail: string): never => {
          throw new Error(
            `model switch to ${JSON.stringify(wanted)} FAILED, so NOTHING was typed or submitted (${detail}). `
            + 'Fix the model first, or pass send_anyway_on_model_fail=true to send under whatever model is currently selected.',
          )
        }
        if (mouse === undefined) {
          const inPage = await switchModelInPage({ evaluate: async (expression: string) => await evaluate(expression) }, wanted)
          notes.push(inPage.note)
          // 页面内路径同样要把「请求 vs 实际」写清楚（`after` 是**回读**来的，不是请求值）。
          notes.push(`[model-ref] via=evaluate requested=${JSON.stringify(wanted)} `
            + `after=${JSON.stringify(inPage.after ?? '')} matches=${String(inPage.matches ?? false)}`)
          if (!inPage.ok && args.send_anyway_on_model_fail !== true) modelFailed(inPage.note)
        } else {
          const report = await switchModel({
            evaluate: async (expression: string) => await evaluate(expression),
            mouse: async (action: 'click' | 'move', x: number, y: number) => await mouse(action, x, y),
          }, wanted)
          const summary = `model switch: ${report.ok ? 'ok' : 'FAILED'} before=${JSON.stringify(report.before)} via=${report.via} `
            + `picked=${JSON.stringify(report.picked)} after=${JSON.stringify(report.after)}`
            + (report.detail === undefined ? '' : ` detail=${report.detail}`)
          notes.push(summary)
          if (!report.ok && args.send_anyway_on_model_fail !== true) modelFailed(summary)
        }
      }
      // 先按名字/文字点一下（打开面板 / 点按钮）：CDP 走 DOM，窗口走 UIA。
      if (typeof args.click === 'string' && args.click.length > 0) {
        const needle = String(args.click)
        let outcome: ClickOutcome
        if (session.evaluate !== undefined) {
          let clicked: unknown
          try {
            clicked = await session.evaluate(clickByTextSnippet(needle))
          } catch (error: unknown) {
            throw new Error(`click("${needle}") failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          // 页面内 JS 匹配不到元素时**不抛异常**，只返回 { ok:false } —— 必须显式读出来，
          // 不能靠 try/catch（P3 误投递的根因）。
          outcome = toClickOutcome(clicked)
        } else if (session.clickElement !== undefined) {
          outcome = await session.clickElement(needle)
        } else {
          throw new Error(`session ${session.id} uses the ${session.transport} transport, which cannot click UI elements; use harness_open with the cdp or window transport`)
        }
        notes.push(`click(${JSON.stringify(needle)}) -> ${outcome.detail}`)
        if (!outcome.ok) {
          // fail-closed：点不中就**绝不**输入。否则文本会落到当时的焦点位置并被回车提交。
          if (args.send_anyway_on_click_fail !== true) {
            throw new Error(
              `click(${JSON.stringify(needle)}) matched no element, so NOTHING was typed or submitted`
              + (outcome.candidates !== undefined && outcome.candidates.length > 0
                ? `; near misses: ${outcome.candidates.join(' | ')}`
                : '')
              + '. Retry with a more exact string, or pass send_anyway_on_click_fail=true if the click was optional.',
            )
          }
          notes.push('send_anyway_on_click_fail=true: typing despite the failed click')
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(600, Number(args.wait_ms ?? 1500) / 2)))
      }
      const hasText = typeof args.text === 'string' && args.text.length > 0
      const note = hasText
        ? (await session.send({ text: String(args.text), submit: args.submit !== false })).note
        : 'read-only'
      notes.push(note)
      const waitMs = Math.max(0, Number(args.wait_ms ?? (hasText ? 1500 : 0)))
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
      const read = await session.read({ limit: config.maxScreenChars })
      return textOutput(
        `session=${session.id} harness=${session.target.name} transport=${session.transport} action=${notes.join(' | ')}\n`
        + `screen source=${read.source}\n---\n`
        + (read.text.trim().length > 0 ? read.text : '(empty screen text)')
        + (read.diagnostic !== undefined ? `\ndiagnostic: ${read.diagnostic}` : ''),
      )
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_send ${String(args.session_id ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_send')

  register(defineTool({
    name: 'harness_sessions',
    description:
      'List live harness sessions, or close one by id (action="close"). '
      + 'action="persistent" lists durable LOGICAL sessions (ns-…) with their native session ids and resumability — '
      + 'these survive CLI process exit and are resumed precisely by passing session_id to harness_task_start. '
      + 'action="release" confirms a logical session holds no running turn and reports it as resumable (process released, record kept) — it does NOT delete the mapping.',
    parameters: {
      action: { type: 'string', enum: ['list', 'close', 'persistent', 'release'], description: 'list (default) / close / persistent (logical sessions) / release (confirm resumable idle for a logical session)' },
      session_id: { type: 'string', description: 'Required for action=close (live session id) and action=release (logical ns-… id)' },
      include_closed: { type: 'boolean', description: 'action=persistent only: also list closed logical sessions (default false)' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args: any): Promise<{ text: string }> {
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'close') {
        if (typeof args.session_id !== 'string' || args.session_id.length === 0) {
          throw new Error('action=close requires session_id')
        }
        const closed = await registry.close(args.session_id)
        return textOutput(closed ? `closed session ${args.session_id}` : `no such session ${args.session_id}`)
      }
      // ── 持久逻辑会话（P1/P3/P5）──
      if (action === 'persistent' || action === 'release') {
        const native = deps.nativeSessions
        if (native === undefined) {
          throw new Error('persistent native sessions are not wired in this composition (no session store mounted)')
        }
        if (action === 'release') {
          if (typeof args.session_id !== 'string' || args.session_id.trim().length === 0) {
            throw new Error('action=release requires a logical session_id (ns-…)')
          }
          const record = native.store.get(args.session_id.trim())
          if (record === undefined) throw new Error(`unknown logical session "${args.session_id.trim()}"（不猜、不静默新建；用 action=persistent 列出）`)
          const busy = native.mutex.isBusy(record.logicalId)
          // 释放核对（审查次要项修正）：「本插件没有在飞轮次」≠「进程已确认退出」。
          // headless CLI 在轮次结束自然退出，但插件**不做进程级核实**——延迟退出、
          // 厂商常驻子进程、以及插件重启前遗留的 running 记录都必须如实区分，不宣称「已释放」。
          const staleRunning = record.status === 'running' && !busy
          const accountLabel = record.accountId === undefined ? undefined : redactAccountId(record.accountId)
          const lines = [
            `logical=${record.logicalId} target=${record.target}${accountLabel === undefined ? '' : ` account=${accountLabel}`}`,
            `nativeSession=${record.nativeSessionId ?? '(尚未回报)'} resume=${record.resumeKind} status=${record.status}`,
            busy
              ? '⚠️ 该会话有在飞轮次（互斥表非空）—— 现在不能释放进程；等待任务终态后再试。'
              : staleRunning
                ? '⚠️ 账本仍有 running 记录且本进程没有在飞轮次：该记录很可能来自插件重启前的进程，**其进程状态未核实** —— 不能报告「已释放」。请用任务账本/系统进程清单核对后再处理。'
                : '本插件当前没有该会话的在飞轮次。CLI 进程按设计为一次性运行（轮次结束自然退出），但本次**未做进程级核实**（不排除延迟退出或厂商常驻子进程）；会话记录与原生恢复能力保留 —— idle=可恢复，不是丢失。',
          ]
          return textOutput(lines.join('\n'))
        }
        const rows = native.store.list({ includeClosed: args.include_closed === true })
        if (rows.length === 0) return textOutput('no persistent logical sessions recorded')
        return textOutput(rows.map(record => {
          const accountLabel = record.accountId === undefined ? undefined : redactAccountId(record.accountId)
          return `${record.logicalId}  target=${record.target}`
            + `${accountLabel === undefined ? '' : ' account=' + accountLabel}`
            + ` native=${record.nativeSessionId ?? '(none)'}`
            + ` resume=${record.resumeKind} status=${record.status}`
            + ` runs=${record.runCount}`
            + (record.lastRecoveryError === undefined ? '' : ` lastRecoveryError=${record.lastRecoveryError.slice(0, 120)}`)
        }).join('\n')
          + '\n（追问：harness_task_start session_id=<logicalId>；释放核对：harness_sessions action=release session_id=<logicalId>）')
      }
      const sessions = registry.list()
      if (sessions.length === 0) return textOutput('no live harness sessions')
      return textOutput(sessions
        .map(session => `${session.id}  harness=${session.target} transport=${session.transport} ${session.detail}`)
        .join('\n'))
    },
    presentCall() {
      return { card: 'generic' as const, title: 'harness_sessions', kind: 'read' as const }
    },
  }), 'harness_sessions')

  // ────────────────────────────────────────────────────────────────────────────
  // harness_spawn_teammate —— **产品**团队入口（非探针）
  //
  // 它与 `spawn_teammate`（宿主原生工具，schema 只有 name/description/prompt/context，
  // provider 由 team 配置的 `freshProvider`/`forkProvider` 决定，**不接受** Harness/账号/模型）
  // 的关系是**补充而不是替代**：名字不同 ⇒ 共存，Lead 可以按需选哪一个。
  //
  // 位置纪律（这条工具的全部价值所在）：**身份在真实的 spawnTeammate 之前冻结**。
  // 冻结产物由 `TeamRoutingTable` 按 **(Lead 会话, 成员名)** 存成意图，再由团队日志事件
  // `team/member`（它带 `member.id`，且发生在成员首个 prompt 投递之前）解析成按
  // **childSessionId** 索引的绑定。于是成员的**第一轮**就已经走外部 CLI，
  // 而不是「先按原生跑一轮、事后补写一个绑定」。
  // ────────────────────────────────────────────────────────────────────────────
  register(defineTool({
    name: 'harness_spawn_teammate',
    description:
      'Create one named, durable Team teammate whose own turns are produced by an external agent harness '
      + '(OpenCode / Antigravity / Claude Code / Codex / Qoder / ZCode / MiMo / …) instead of the host provider. '
      + 'Use this instead of spawn_teammate when the teammate must run on a specific harness, account profile, '
      + 'or model: identity is validated and FROZEN before the member is spawned, so the very first turn already '
      + 'goes to that CLI — there is no "native first turn, bind later" window. Requires a calling Team Lead '
      + '(same rule as spawn_teammate). Both account and model may be given together. '
      + 'The member keeps the native Team lifecycle: list_agents / send_message / interrupt_agent / task board / cancel.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name (unique within this Team).' },
      prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
      target: { type: 'string', required: true, description: 'Harness name from harness_list; must be a dispatchable (transport=auto) target — the member\'s every turn is handed to this CLI.' },
      description: { type: 'string', description: 'Short description of the delegated responsibility (defaults to "harness <target>").' },
      accountId: { type: 'string', description: 'Account profile id (e.g. qoder-cn-a) the member runs as. Validated against the CURRENT account profiles: a disabled/removed profile is refused outright (no fallback to another account, and no fallback to the unbound harness). May be combined with model.' },
      model: { type: 'string', description: 'Model id for this member\'s every turn. May be combined with accountId. If omitted, the model is NOT chosen by this plugin — the request is dispatched without a model override and the CLI decides (see the returned spec for exactly what was applied).' },
      context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const routing = deps.teamRouting
      if (routing === undefined) {
        throw new Error(
          'harness_spawn_teammate: 本组合没有挂载团队路由（teamRouting 缺失），因此无法在成员创建**之前**冻结身份。'
          + '\n本次是**显式拒绝**：没有创建任何成员。'
          + '\n· 只想要原生成员（不带 Harness/账号/模型）请用宿主的 spawn_teammate；'
          + '\n· 一次性派发请用 harness_dispatch / harness_agent。',
        )
      }
      const teams = deps.agentTeams
      if (teams === undefined) {
        throw new Error(
          'harness_spawn_teammate: 本组合没有 agentTeams 服务（is the agent-team bundle mounted?），无法创建团队。'
          + '\n本次是**显式拒绝**：没有创建任何成员。',
        )
      }
      const lead = exec?.agent
      if (lead === undefined) {
        throw new Error('harness_spawn_teammate requires a calling agent (exec.agent was undefined)')
      }
      // 团队身份的读法与宿主 `roster.tryMembership()` 同一处事实：成员的父会话是 Lead 自己。
      const leadSessionId = readAgentSessionId(lead)
      if (leadSessionId === undefined) {
        throw new Error(
          'harness_spawn_teammate: 无法从调用方读出会话 id（agent.session.header.id），因此无法确定团队身份。'
          + '\n本次是**显式拒绝**：不按成员名去猜团队。',
        )
      }
      const parentSessionId = readAgentParentSessionId(lead)
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name.length === 0) throw new Error('harness_spawn_teammate: name is required')
      const promptText = typeof args.prompt === 'string' ? args.prompt : ''
      if (promptText.trim().length === 0) throw new Error('harness_spawn_teammate: prompt is required')
      const targetName = typeof args.target === 'string' ? args.target.trim() : ''
      if (targetName.length === 0) throw new Error('harness_spawn_teammate: target is required')

      const accountId = typeof args.accountId === 'string' && args.accountId.trim().length > 0
        ? args.accountId.trim()
        : undefined
      const model = typeof args.model === 'string' && args.model.trim().length > 0
        ? args.model.trim()
        : undefined
      const context: 'fresh' | 'fork' = args.context === 'fork' ? 'fork' : 'fresh'

      // ① **先冻结身份**（任何副作用之前）。拒绝就到此为止 —— 一个成员都不会被创建。
      //    `await`：模型清单校验要读该 CLI 自己报出的清单（唯一能判「它认不认这个模型」的依据）。
      const prepared = await routing.prepare({
        leadSessionId,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        memberName: name,
        description: typeof args.description === 'string' ? args.description : undefined,
        context,
        provider: deps.teamFreshProvider ?? 'spawn',
        target: targetName,
        ...(accountId === undefined ? {} : { accountId }),
        ...(model === undefined ? {} : { model }),
      })
      if (!prepared.ok) {
        throw new Error(
          `harness_spawn_teammate: 身份被拒绝（${prepared.code}），本次**没有创建任何成员**。\n${prepared.reason}`,
        )
      }

      // ② 再真的建成员。prompt 抬头必须与宿主 `spawn_teammate` **逐字一致**
      //    （`tool-agent-team/lib/index.js:276-288`）：成员据此认出自己的名字与 Lead，
      //    也保证「按 prompt 反查成员名」这条兜底接缝对两条入口都成立。
      const signal = exec?.signal ?? new AbortController().signal
      let started: Awaited<ReturnType<AgentTeamsSpawnLike['spawnTeammate']>>
      try {
        started = await teams.spawnTeammate(lead, {
          name,
          description: prepared.intent.description,
          prompt: [
            { type: 'text', text: '<system-reminder>\nYou are teammate "' + name + '".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
            { type: 'text', text: promptText },
          ] as ContentBlock[],
          context,
          provider: prepared.intent.provider,
          signal,
        })
      } catch (error: unknown) {
        // 失败必须撤销意图：留着它会在下一次同名创建时变成「重复意图」，
        // 而那个成员从来没存在过。
        routing.abortIntent(leadSessionId, name, error instanceof Error ? error.message : String(error))
        throw error
      }
      const member = started?.member
      // 绑定由 `team/member` 事件在 spawn **期间**写好了；这里只核对它确实写上了，
      // 并把「没写上」当成要如实报出来的异常，而不是当成成功。
      return textOutput([
        `teammate=${member?.name ?? name} session=${member?.id ?? '(未回报)'} status=${member?.status ?? '(未回报)'}`,
        `harness=${prepared.spec.target} account=${prepared.spec.account ?? '(未绑定账号)'} model=${prepared.spec.model ?? '(未指定 —— 由该 CLI 自己决定，本插件不改写)'}`,
        `spec: accountApplied=${String(prepared.spec.accountApplied)} modelApplied=${String(prepared.spec.modelApplied)}`
        + ' (两个参数都进产物；本插件不静默丢弃 model，也不回退账号)',
        `leadSession=${leadSessionId} provider=${prepared.intent.provider}`,
        'identity frozen BEFORE spawn: 该成员的第一轮模型请求就已改道到上述 Harness。',
        '(名单/投递/中断用宿主原生 list_agents / send_message / interrupt_agent —— 团队生命周期未改变。)',
      ].join('\n'))
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_spawn_teammate → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_spawn_teammate')
}

/** 从活 Agent 上读会话 id（宿主 Agent 形状：`agent.id` 与 `agent.session.header.id` 同值）。 */
export function readAgentSessionId(agent: unknown): string | undefined {
  const direct = (agent as { id?: unknown } | undefined)?.id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const header = (agent as { session?: { header?: { id?: unknown } } } | undefined)?.session?.header
  return typeof header?.id === 'string' && header.id.length > 0 ? header.id : undefined
}

/**
 * 读调用方的**父会话**（＝它属于哪个团队）。
 *
 * `undefined` = 这个 Agent 是顶层（它自己就是 Lead/root）。**不要**把 `undefined`
 * 当成「没有团队」而拒绝 —— 顶层 Agent 正是 Lead 的正常形态。
 */
export function readAgentParentSessionId(agent: unknown): string | undefined {
  const header = (agent as { session?: { header?: { parentSession?: unknown } } } | undefined)?.session?.header
  return typeof header?.parentSession === 'string' && header.parentSession.length > 0 ? header.parentSession : undefined
}
