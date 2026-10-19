/**
 * 会话级绑定（P5b）：把「这个会话用哪个 Harness / 账号 / 供应商 / 模型」固定下来。
 *
 * ## 作用范围必须说清楚（这是本模块存在的理由）
 * 绑定有**两重作用**，范围不同，**绝不允许**混成「已经切换了会话引擎」一句话：
 *   ① 决定**从该会话发起的外部派发**的默认目标（`harness_dispatch` / `harness_agent` /
 *      后台任务：没显式给 target/model 时取绑定的值）；
 *   ② 决定**本会话自己的对话轮次由谁产生** —— 经本插件自有 LLM 路由 `pilot-cli`
 *      （`src/llm-adapter.ts`），在**请求层 `agent/request` 瀑布**上把该轮的 provider/model 改写掉。
 *
 * ⚠️ ② 的机制名是「**请求层 `agent/request` 改写**」，**不是**「`llm/stream` 改道」。
 * 响应层那一版已于 2026-10-13 22:24 移除：会话日志的 `request/header`（`dsh-agent-loop:1205-1218`）
 * 与 assistant 消息的 `source`（`:1136-1143`）都在响应层**之前**就写好了，在响应层改道必然把
 * 外部 CLI 的产出记成宿主路由（归因不实）。完整理由见 `src/llm-adapter.ts` 文件头「改道在哪一层」。
 *
 * ## 复核实测（2026-10-13 20:58）—— 结论在本轮内**翻转过一次**，如实留档
 * 这正是本模块存在的理由：**滞后于事实与提前声称同样是不实**。
 *   · **20:54 实测：改道尚未落地。** `lib/llm-adapter.js` 不存在、`lib/index.js` 里
 *     `pilot-cli` 匹配数为 **0**、`GET /harness-pilot/api/llm-adapter` → **404**、
 *     `/api/overview` 与 `/api/registry` 正文都没有 `pilot-cli`。当时
 *     「**本会话自己的对话轮次仍由 DSH 执行**」是**真的**，所以**没有**改写成
 *     「由所选 CLI 产生」—— 那是提前声称未实现的能力。
 *   · **20:57 再测：改道已生效。** 另一处改动把 `src/index.ts` 接上了 `llm-adapter.ts`
 *     （import + `registerPilotCli`），构建并热重载后判据全部转正：
 *     `/api/llm-adapter` → **200**，`registration.ok=true`、`listener.installed=true`、
 *     `catalog.pilotCliVisible=true`（选择器读的 `ctx.sessionController.modelCatalog()`
 *     里出现 `pilot-cli` 组，22 个模型目标）；`diag/loaded` 的 `anyStale=false`。
 *   · **于是本文件的说明必须同步改写**：20:54 那句现在会变成滞后。
 *
 * ⚠️ 「改道是否生效」是**两件事**，混起来就会把「注册成功」当成「改道真的发生」：
 *   · **路由可选** = `pilot-cli` 已注册（`/api/llm-adapter` 的 `registration.registered`、
 *     `catalog.pilotCliVisible`）。**注册成功本身不是改道证据。**
 *   · **改道真的发生** = `requestLayer.installed === true`（`layer === 'agent/request'`、
 *     `prepend === true`）**且**真实轮次的会话日志里出现 `pilot-cli` 的 `request/header`，
 *     其后的 `assistant/message.source` 与它同 provider/model
 *     （`probe/verify-llm-adapter-attribution.mjs`）。`rewrites` / `restores` / `heldPicks` 只是佐证。
 * `diag/loaded` 的 `anyStale` 只比对 `SELF_MODULES`（现已含 `llm-adapter.js`），
 * 它说 `false` **不等于**改道可用；反过来 `true` 也不代表改道失效。别拿它当开关。
 *
 * ## 改道生效后，`scopeNoteFor` 必须同时给出**范围**与**固有代价**
 * 未绑定 / 原生 ⇒ 轮次仍由 DSH 执行；绑定到**可派发**外部 Harness ⇒ 模型请求由所选 CLI 产生，
 * 且那些轮次里 **DSH 自身的工具链完全惰性**（见 `llm-adapter.ts` 的 `COST_DISCLOSURE`）。
 * 代价与范围都必须写出来，不许只说「切过去了」。
 * 辅助调用（`purpose` = `compaction` / `session-title`）必须写**两段**，缺一段就是误导：
 * 本插件**不**改写它们；但宿主按「会话最后一次 `request/header` 的路由」解析它们，
 * 所以**改道过的会话里它们会跟着跑到外部 CLI**（2026-10-13 实测，
 * 见 `probe/verify-llm-adapter-aux-scope.mjs`）。
 *
 * ## 与「不串号」的关系
 * 绑定在**创建时固化**；改绑定只影响**之后新建**的派发，已经在跑的任务继续用它创建时的值。
 */
import { existsSync } from 'node:fs';
import type { RequestedIdentity } from '../types.js';
/** 一个会话的绑定。值在写入时固化。 */
export interface SessionBinding extends RequestedIdentity {
    readonly isolatedAccountHome?: string;
    readonly sessionId: string;
    /** `native` = 本会话继续由 DSH 自己执行（也是默认）。 */
    readonly harnessKind: 'native' | 'external';
    readonly setAt: string;
    /** 写入时的说明，界面上原样显示。 */
    readonly scopeNote: string;
}
export interface BindingStateFile {
    readonly version: 1;
    readonly bindings: Readonly<Record<string, SessionBinding>>;
    readonly updatedAt: string;
}
export declare function loadBindingState(file: string): BindingStateFile;
export declare function saveBindingState(file: string, state: BindingStateFile): void;
/** 作用范围说明：按选择如实生成，**不做任何「已切换引擎」的暗示**。 */
export declare function scopeNoteFor(harnessKind: 'native' | 'external', harnessId: string | undefined): string;
export interface SetBindingInput {
    readonly isolatedAccountHome?: string;
    readonly sessionId: string;
    readonly harnessId?: string;
    readonly accountId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly permissionMode?: string;
}
/** 归一化 + 固化。空串一律当未设置，避免把 `''` 当成一个「模型」。 */
export declare function makeBinding(input: SetBindingInput, at?: string): SessionBinding;
export declare function applyBinding(state: BindingStateFile, binding: SessionBinding): BindingStateFile;
/**
 * 给派发解析默认值。
 *
 * 优先级：**调用方显式给出 > 会话绑定 > 目标目录默认**。
 * 这条顺序是「不串号」的关键：显式参数永远赢，绑定只补空缺。
 */
export declare function resolveDispatchDefaults(binding: SessionBinding | undefined, explicit: {
    target?: string;
    model?: string;
}): {
    target?: string;
    model?: string;
    fromBinding: string[];
};
export { existsSync };
