/**
 * 模型面向的工具面。六个工具，覆盖「发现 harness → 派发任务 → 交互式操控」：
 *
 *   harness_list      列出本机可用的 harness（含通道可用性探测）
 *   harness_dispatch  一次性派发任务（自动选通道，返回 harness 的回答）
 *   harness_agent     以 DSH 子代理语义派发（走注册的 SubagentProvider）
 *   harness_open      打开/附着交互会话（窗口 / CDP / pty）
 *   harness_send      向会话注入文本或按键；不带输入时相当于「读当前屏幕」
 *   harness_sessions  列出或关闭会话
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { probeCommand } from './launcher.js'
import { providerNameFor } from './provider.js'
import type { ResolvedConfig } from './config.js'
import type { SessionRegistry } from './sessions.js'
import type { TransportKind } from './types.js'

/** `ctx.subagents` 的最小面（缺失时 harness_agent 会明确报错）。 */
export interface SubagentStartLike {
  start(name: string, request: {
    label: string
    prompt: ContentBlock[]
    parent: unknown
    signal: AbortSignal
  }): Promise<{
    id: string
    result: Promise<{ output: readonly ContentBlock[]; stopReason: string; diagnostic?: string }>
    dispose(): Promise<void>
  }>
}

export interface ToolDeps {
  readonly config: ResolvedConfig
  readonly registry: SessionRegistry
  readonly subagents?: SubagentStartLike
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

function formatOutcome(outcome: Awaited<ReturnType<SessionRegistry['dispatch']>>, target: string): string {
  const head = `harness=${target} transport=${outcome.transport} stop=${outcome.stopReason}`
  const facts = outcome.facts === undefined
    ? ''
    : ` (${Object.entries(outcome.facts).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${String(value)}`).join(', ')})`
  const body = outcome.text.trim().length > 0 ? outcome.text.trim() : '(no text returned)'
  const diagnostic = outcome.diagnostic === undefined ? '' : `\ndiagnostic: ${outcome.diagnostic}`
  return `${head}${facts}\n---\n${body}${diagnostic}`
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

/** 没有真实鼠标的会话（理论上只剩非 CDP 通道）：保留原来的页面内合成事件路径。 */
export async function switchModelInPage(session: { evaluate(expression: string): Promise<unknown> }, wanted: string): Promise<string> {
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
  await sleep(600)
  // 家族行被点开后，档位/速度芯片是后续渲染出来的：再补一次精确点击。
  if ((picked as { via?: string }).via === 'family') {
    const level = (wanted.match(/\b(high|medium|low|minimal)\b/i) ?? [])[1]
    const speed = (wanted.match(/\b(fast|thinking)\b/i) ?? [])[1]
    for (const word of [level, speed]) {
      if (word === undefined) continue
      await sleep(500)
      const chip = await session.evaluate(clickChipSnippet(word))
      notes.push(`chip "${word}": ${JSON.stringify(chip).slice(0, 160)}`)
    }
    await sleep(500)
  }
  return notes.join(' | ')
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
        lines.push(`\n## ${target.name}`)
        lines.push(`  model mechanism: ${mechanismOf(target)}`)
        lines.push(`  query: ${found.note}`)
        if (found.models.length === 0) lines.push('  (this harness listed no models)')
        else {
          lines.push(`  models (${found.models.length}):`)
          for (const model of found.models.slice(0, 60)) lines.push(`    ${model}`)
        }
        return textOutput(lines.join('\n'))
      }

      const queried = config.resolvedTargets.filter(entry => entry.modelsCommand.length > 0)
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
      lines.push('\nharnesses with no modelsCommand were skipped; pass target=<name> to inspect one explicitly (GUI-only harnesses select the model inside their own UI).')
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
      target: { type: 'string', required: true, description: 'Harness name from harness_list (e.g. opencode, agy, zcode)' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for that harness' },
      cwd: { type: 'string', description: 'Working directory; defaults to this session workspace' },
      transport: { type: 'string', enum: ['auto', 'acp', 'headless', 'pty', 'cdp', 'window'], description: 'Force one transport (default auto)' },
      model: { type: 'string', description: 'Model id for this run (e.g. "opencode-go/deepseek-v4.1-flash"); see harness_models for what each harness offers' },
      extra_args: { type: 'array', items: { type: 'string' }, description: 'Extra argv appended after the target defaults, e.g. ["--model","opencode-go/deepseek-v4.1-flash"]' },
      timeout_ms: { type: 'integer', description: 'Hard deadline in ms (default: target default)' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const target = registry.target(args.target)
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (agentCwd(exec?.agent) ?? process.cwd())
      const extraArgs = Array.isArray(args.extra_args) ? args.extra_args.map((value: unknown) => String(value)) : undefined
      const model = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model.trim() : undefined
      const outcome = await registry.dispatch({
        target,
        prompt: String(args.prompt),
        cwd,
        signal: exec?.signal ?? new AbortController().signal,
        timeoutMs: Number(args.timeout_ms ?? target.timeoutMs),
        ...(extraArgs === undefined ? {} : { extraArgs }),
        ...(model === undefined ? {} : { model }),
      }, typeof args.transport === 'string' ? { transport: args.transport } : {})
      return textOutput(formatOutcome(outcome, target.name))
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
      + 'Use harness_dispatch when you only need the text back.',
    parameters: {
      target: { type: 'string', required: true, description: 'Harness name from harness_list' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for that harness' },
      description: { type: 'string', description: 'Short 3-5 word label for display and logs' },
      model: { type: 'string', description: 'Optional model id for this run; when set the call goes through the direct dispatch path (a provider binds its target at registration, so it cannot carry a per-call model)' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const target = registry.target(args.target)
      if (subagents === undefined) {
        throw new Error('ctx.subagents is not available in this composition, so harness_agent cannot run — use harness_dispatch instead')
      }
      if (exec?.agent === undefined) {
        throw new Error('harness_agent requires a calling agent (exec.agent was undefined)')
      }
      const name = providerNameFor(target)
      const model = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model.trim() : undefined
      if (model !== undefined) {
        // SubagentProvider 的名字在注册时就绑定了目标，无法承载「本次换模型」；
        // 需要换模型时走同一套通道直接派发，并在结果里如实标明。
        const cwd = agentCwd(exec.agent) ?? process.cwd()
        const outcome = await registry.dispatch({
          target,
          prompt: String(args.prompt),
          cwd,
          signal: exec.signal,
          timeoutMs: target.timeoutMs,
          model,
        })
        return textOutput(
          `mode=direct (model=${model}; bypasses the subagent provider because a provider's target is fixed at registration)\n`
          + `harness=${target.name} transport=${outcome.transport} stop=${outcome.stopReason}\n---\n`
          + (outcome.text.trim().length > 0 ? outcome.text.trim() : '(no text returned)')
          + (outcome.diagnostic === undefined ? '' : `\ndiagnostic: ${outcome.diagnostic}`),
        )
      }
      const run = await subagents.start(name, {
        label: String(args.description ?? `harness ${target.name}`),
        prompt: [{ type: 'text', text: String(args.prompt) }] as ContentBlock[],
        parent: exec.agent,
        signal: exec.signal,
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
        `subagent provider=${name} runId=${run.id} stop=${result.stopReason}`,
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
      + '(focus + keyboard + accessibility/console text, no OCR). Keep the session id for harness_send.',
    parameters: {
      target: { type: 'string', required: true, description: 'Harness name from harness_list' },
      cwd: { type: 'string', description: 'Working directory for a launched harness; defaults to this session workspace' },
      launch: { type: 'boolean', description: 'Allow launching the harness if it is not running (default true)' },
    },
    output: OUTPUT,
    async execute(args: any, exec: any): Promise<{ text: string }> {
      const target = registry.target(args.target)
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (agentCwd(exec?.agent) ?? process.cwd())
      const session = await registry.open(target, { cwd, launch: args.launch !== false })
      let initial = ''
      try {
        const read = await session.read({ limit: config.maxScreenChars })
        initial = read.text
      } catch (error: unknown) {
        initial = `(initial read failed: ${error instanceof Error ? error.message : String(error)})`
      }
      return textOutput(
        `session=${session.id} harness=${target.name} transport=${session.transport} ${session.detail}\n`
        + '--- current screen ---\n'
        + (initial.trim().length > 0 ? initial : '(empty screen text)'),
      )
    },
    presentCall(args: any) {
      return { card: 'generic' as const, title: `harness_open → ${String(args.target ?? '?')}`, kind: 'execute' as const }
    },
  }), 'harness_open')

  register(defineTool({
    name: 'harness_send',
    description:
      'Send text (and submit) into an open harness session, then return the resulting screen text. Call it with no text '
      + 'to simply re-read the current screen. This is the direct equivalent of typing into the harness yourself.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id from harness_open' },
      text: { type: 'string', description: 'Text to insert (omit to only read the screen)' },
      submit: { type: 'boolean', description: 'Submit after typing (Enter / the harness send control); default true' },
      click: { type: 'string', description: 'CDP sessions only: click the visible element whose text matches this string (open a chat panel, press a button) before typing' },
      model: { type: 'string', description: 'CDP sessions only: switch this GUI harness to the given model first (opens its model picker and clicks the matching option). Use harness_models/qoder-cn to see the offered names.' },
      wait_ms: { type: 'integer', description: 'How long to wait before reading back (default 1500)' },
    },
    output: OUTPUT,
    async execute(args: any): Promise<{ text: string }> {
      const session = registry.get(String(args.session_id))
      if (session === undefined) {
        const known = registry.list().map(entry => entry.id).join(', ')
        throw new Error(`unknown session "${String(args.session_id)}"${known.length > 0 ? `; live sessions: ${known}` : ''}`)
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
        if (mouse === undefined) {
          notes.push(await switchModelInPage({ evaluate: async (expression: string) => await evaluate(expression) }, wanted))
        } else {
          const report = await switchModel({
            evaluate: async (expression: string) => await evaluate(expression),
            mouse: async (action: 'click' | 'move', x: number, y: number) => await mouse(action, x, y),
          }, wanted)
          notes.push(
            `model switch: ${report.ok ? 'ok' : 'FAILED'} before=${JSON.stringify(report.before)} via=${report.via} `
            + `picked=${JSON.stringify(report.picked)} after=${JSON.stringify(report.after)}`
            + (report.detail === undefined ? '' : ` detail=${report.detail}`),
          )
        }
      }
      // 先按名字/文字点一下（打开面板 / 点按钮）：CDP 走 DOM，窗口走 UIA。
      if (typeof args.click === 'string' && args.click.length > 0) {
        const needle = String(args.click)
        if (session.evaluate !== undefined) {
          let clicked: unknown
          try {
            clicked = await session.evaluate(clickByTextSnippet(needle))
          } catch (error: unknown) {
            throw new Error(`click("${needle}") failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          notes.push(`click(${JSON.stringify(needle)}) -> ${JSON.stringify(clicked).slice(0, 400)}`)
        } else if (session.clickElement !== undefined) {
          const outcome = await session.clickElement(needle)
          notes.push(`click(${JSON.stringify(needle)}) -> ${outcome.detail}`)
        } else {
          throw new Error(`session ${session.id} uses the ${session.transport} transport, which cannot click UI elements; use harness_open with the cdp or window transport`)
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
    description: 'List live harness sessions, or close one by id (action="close").',
    parameters: {
      action: { type: 'string', enum: ['list', 'close'], description: 'list (default) or close' },
      session_id: { type: 'string', description: 'Required for action=close' },
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
}
