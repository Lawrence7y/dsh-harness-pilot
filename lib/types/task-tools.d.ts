import type { ResolvedConfig } from './config.js';
import type { TaskManager, TaskView } from './tasks.js';
import type { RuntimeSettings } from './settings.js';
import type { SessionRegistry } from './sessions.js';
import type { TargetConfig } from './types.js';
export interface TaskToolDeps {
    readonly config: ResolvedConfig;
    readonly registry: SessionRegistry;
    readonly tasks: TaskManager;
    readonly settings: () => RuntimeSettings;
    /**
     * 把账号档案合并进目标（由 index.ts 注入，**与 `/dispatch`、`/task/start` 共用同一实现**）。
     * 三个入口共用一处实现，避免「同一能力在不同入口行为不一致」——那个坑本项目踩过两次。
     */
    readonly withAccount?: (target: TargetConfig, accountId: string) => {
        readonly ok: true;
        readonly target: TargetConfig;
        readonly note: string;
    } | {
        readonly ok: false;
        readonly reason: string;
    };
    /** 账号池的默认账号（未显式指定时用）。 */
    readonly poolDefaultAccountId?: () => string;
    /**
     * **按目标分域**的池默认账号（首选）。返回 `accountId: ''` + `ignoredReason` 表示
     * 「池里的默认账号不属于这条目标的 harness」⇒ 不套用它，但要说明原因。
     */
    readonly poolDefaultAccountFor?: (targetName: string) => {
        readonly accountId: string;
        readonly ignoredReason: string | null;
    };
    /**
     * 子代理模型白名单的**只读快照**（2026-10-16 新增，供 harness_route_check 用）。
     * 未挂载 ⇒ 该工具显式说明不可用（不假装读到了空表）。
     */
    readonly routeCheck?: () => {
        readonly available: boolean;
        readonly reason: string;
        readonly enabled: boolean | null;
        readonly revision: number | null;
        readonly routes: readonly {
            readonly provider: string;
            readonly model: string;
        }[];
        readonly candidates: readonly {
            readonly provider: string;
            readonly model: string;
            readonly name: string;
            readonly enabled: boolean;
        }[];
    };
}
/**
 * 把一个账号 id 换成脱敏形式（复用账号池/切换账本同一套 `redactAccount`）。
 * `acct:…<尾 2 位><长度 36 进制>` 不可反推，但同一账号的多次输出**稳定相同**，便于对照。
 */
export declare function redactAccountId(accountId: string | undefined): string | undefined;
/**
 * 文本级兜底脱敏：把**任何已知账号档案 id** 在原样出现的位置替换成脱敏形式。
 *
 * 为什么需要它（而不是只管我们自己拼的字段）：`withAccount` 的 note 由 index.ts 生成，
 * 形状是 `account=<原始 id> configDir=…`。本文件把它原样打印就是泄漏 —— 实测过。
 * 与其依赖上游改文案（那要动 index.ts，且下次又可能漂移），不如在**唯一出口**上兜住。
 *
 * ⚠️ **必须按「整词」替换，不能做子串替换**：本机实测存在真实的名字冲突 ——
 * 目标名 `qoder-cn-acct-a` / `qoder-cn-acct-b` / `qoder-cn-app` **以某个账号档案 id 为前缀**。
 * 子串替换会把目标名改成 `acct:…cct-a` 这种四不像，等于**篡改执行身份**，
 * 比不脱敏更糟。所以这里要求 id 两侧都不是「id 允许的字符」（字母/数字/`_`/`.`/`-`）：
 *   `account=<id> configDir=…` ✅ 命中；`…\harness-accounts\<id>\` ✅ 命中；
 *   `qoder-cn-acct-a` ❌ 不命中（后面还跟着 `cct-a`）。
 * 一次性用合并正则替换，避免后一轮又去扫前一轮插进去的脱敏串。
 */
export declare function redactAccountIdsInText(text: string): string;
/**
 * 请求值 vs 实际回报的**结构化对照**（纯函数；UI、回执、工具面共用**这一份**实现）。
 *
 * 三种结局必须分得开，且**不许**把「没回报」当成「一致」：
 *   · `differences` 非空 ⇒ 请求值 ≠ 实际值（不得当作成功）；
 *   · `missing` 非空 ⇒ 那些字段实际未回报 ⇒ 无法比较；
 *   · 两者都空且 `compared` 非空 ⇒ 只有这些字段两侧都有证据且一致（**不代表整体身份已确认**）。
 */
export interface IdentityComparison {
    readonly evaluated: boolean;
    readonly compared: readonly string[];
    readonly differences: readonly string[];
    readonly missing: readonly string[];
    /** 已有的不一致记录（来自通道/别名派发，原样带出）。 */
    readonly recorded: readonly string[];
}
export declare function compareIdentity(view: TaskView): IdentityComparison;
/**
 * 一行**结论**（给回执/界面用：读一行就知道该不该信）。
 *
 * 顺序即优先级：**已记录的不一致 > 比出来的不一致 > 未完整回报 > 部分一致**。
 */
export declare function identityVerdictLine(comparison: IdentityComparison): string;
/** 实际身份一行。
 *
 * `view.actual` 是**通道/CLI 真实回报**的身份（`sessions.foldOutcomeIdentity` 的出口），
 * 与请求值（`target` / `model` / 账号参数）分开呈现 —— 否则「请求了什么」会被当成「用了什么」。
 */
export declare function actualIdentityLines(view: TaskView): string[];
/** Compare only fields for which both request and native receipt are available. */
export declare function mismatchLines(view: TaskView): string[];
/**
 * 回执行：把**为什么送不到**如实写出来。
 *
 * 最重要的一条是宿主边界：发起会话由**子代理路由**拥有时，宿主的 `resolveAgent` 会明确拒绝
 * 唤醒（实测原话 `session "<id>" is owned by subagent routing`）。这类 `failed` 不是插件故障、
 * 也不是网络抖动，任务结果本身完好 —— 所以必须给出「去哪读结果」，而不是只留一句失败。
 */
export declare function receiptLines(view: TaskView): string[];
/** R9：迟到结算证据行的渲染（发现即可见；原文/事实已在保存时脱敏）。 */
export declare function lateSettlementLines(view: TaskView): string[];
/** 持久逻辑会话行的渲染（可选字段缺失如实显示；账号只出脱敏标签）。 */
export declare function sessionLines(view: TaskView): string[];
export declare function describe(view: TaskView): string;
export declare function registerTaskTools(ctx: any, deps: TaskToolDeps): void;
