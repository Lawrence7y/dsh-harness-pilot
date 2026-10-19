/**
 * 子代理模型白名单（宿主 `subagent-model-selection-settings.allowedModels`）的**读写与差分**。
 *
 * ## 为什么需要它（用户要求原文）
 * 「……另外，该 harness 中的模型，**能够选择哪些在会话和子代理选择中被选择**」。
 *
 * 两条链路的可见性**不是一回事**（0.2.0-rc.2 实测）：
 *   · **会话**选择器：数据源 = `remote.session.modelCatalog()` → `buildModelCatalog()`
 *     （`dsh-api-session-controller/lib/index.js:500-548`）⇒ 只要插件注册了 provider 就有；
 *   · **子代理**：同一份目录**再叠一道精确串白名单** —— `dsh-tool-subagent/lib/index.js:91-98`
 *     （`assertAllowedModelSelection`：`policy.routes.some(route => route.provider===p && route.model===m)`），
 *     不匹配就抛 `child LLM route "P/M" is not allowed for this Session`；发现工具
 *     `list_subagent_models` 也被同一份白名单过滤（`:150-162`）。
 * ⇒ 本插件把模型目录改成「一个 harness 一条 provider」之后，**新路由必须能进这份白名单**，
 *   否则「子代理里选外部模型」这条路是断的（旧的 `pilot-cli/*` 条目在新目录下已不再列出模型）。
 *
 * ## 写入纪律（与闸门同一套）
 *   · 走**宿主自己的设置服务**（`ctx.settings.update(ns, patch, revision)`，`dsh-settings/lib/index.js:470`），
 *     它是 Plugins 页用的同一条路；带 **revision 乐观锁**（`:511` 冲突即抛 `SettingsConflictError`）；
 *   · **只增不删由调用方决定**：本模块只算差分，删哪些由用户显式勾选（绝不偷偷清理别人的条目）；
 *   · 写后**独立回读**（重新 `describe()`）并与请求目标比对，不一致就如实报错 —— 不相信「写下去了」。
 */
import type { HarnessLlmProvider } from './harness-llm.js';
/** 宿主那条例目的 id（profile patch 里的 `id:`）。 */
export declare const SUBAGENT_MODEL_NS = "subagent-model-selection-settings";
export interface AllowedRoute {
    readonly provider: string;
    readonly model: string;
}
export declare function routeKey(route: AllowedRoute): string;
/** 把任意来源的值规整成 route 数组（形状不对的条目**丢弃并计数**，不静默当合法）。 */
export declare function normalizeRoutes(value: unknown): {
    routes: AllowedRoute[];
    dropped: number;
};
/** 一次读取的现场（缺服务时 `available:false` + 可读原因，绝不假装读到空表）。 */
export interface PolicySnapshot {
    readonly available: boolean;
    readonly reason: string;
    readonly revision: number | null;
    readonly enabled: boolean | null;
    readonly allowed: readonly AllowedRoute[];
    readonly dropped: number;
}
/** 宿主设置服务的最小面（`dsh-settings` 的 `describe/update`）。 */
export interface SettingsLike {
    describe?(options?: {
        redactSecrets?: boolean;
    }): {
        ns?: unknown;
        revision?: unknown;
        value?: unknown;
    }[];
    update?(ns: string, patch: unknown, expectedRevision?: number): Promise<unknown>;
}
/** `subagentModelSelection` 服务的最小面（`current()` 返回当前生效值）。 */
export interface SelectionServiceLike {
    current?(): {
        enabled?: unknown;
        allowedModels?: unknown;
    };
}
/**
 * 读当前白名单。
 *
 * 优先用 **服务**（`subagentModelSelection.current()`，它就是运行期生效值），
 * 同时用 **设置文档**（`settings.describe()`）取 `revision` —— 写入要用它做乐观锁。
 * 两者都不在 ⇒ `available:false`（如实说明，不返回空表冒充「没有白名单」）。
 */
export declare function readPolicy(settings: SettingsLike | undefined, selection: SelectionServiceLike | undefined): PolicySnapshot;
/** 白名单变更的**差分**（纯函数）：只算要加/要删/已在/不存在，绝不预设策略。 */
export interface PolicyChangePlan {
    readonly additions: readonly AllowedRoute[];
    readonly removals: readonly AllowedRoute[];
    readonly alreadyPresent: readonly AllowedRoute[];
    readonly missing: readonly AllowedRoute[];
    readonly next: readonly AllowedRoute[];
}
export declare function planPolicyChange(current: readonly AllowedRoute[], add: readonly AllowedRoute[], remove: readonly AllowedRoute[]): PolicyChangePlan;
/** 该 provider 在**当前目录**里的可选模型（给设置页的勾选清单用）。 */
export interface CandidateModel {
    readonly provider: string;
    readonly model: string;
    readonly name: string;
    readonly enabled: boolean;
}
export declare function candidatesFor(providers: readonly HarnessLlmProvider[], modelsOf: (targetName: string) => readonly string[] | undefined, allowed: readonly AllowedRoute[]): CandidateModel[];
/** 写入结果（含**独立回读**的比对结论）。 */
export interface ApplyOutcome {
    readonly ok: boolean;
    readonly reason: string;
    readonly requested: {
        additions: number;
        removals: number;
    };
    readonly readback: PolicySnapshot | null;
    readonly verified: boolean;
    readonly conflict: boolean;
}
/**
 * 给 HTTP 层用的门面（宿主服务只在 `apply()` 的 scope 里拿得到，路由处理器拿不到 `ctx`）。
 * 由 `index.ts` 在装配期构造一次。
 */
export interface SubagentModelsFacade {
    readonly ns: string;
    readonly settingsAvailable: boolean;
    readonly selectionAvailable: boolean;
    /** 读当前白名单（运行期生效值 + revision）。 */
    readonly read: () => PolicySnapshot;
    /** 当前目录里可勾选的候选（**不截断**）。 */
    readonly candidates: () => CandidateModel[];
    /** 应用差分（写 + 独立回读）。 */
    readonly apply: (plan: PolicyChangePlan, expectedRevision: number | null) => Promise<ApplyOutcome>;
}
/**
 * 应用差分：`settings.update(ns, {allowedModels: next}, revision)` + **独立回读**。
 *
 * ⚠️ 只改 `allowedModels` 这一个数组；`enabled` 与其他 profile 内容一律不动
 * （`update` 只合并传入字段，`dsh-settings/lib/index.js:470-472`）。
 */
export declare function applyPolicyChange(settings: SettingsLike | undefined, selection: SelectionServiceLike | undefined, plan: PolicyChangePlan, expectedRevision: number | null): Promise<ApplyOutcome>;
