import type { SpawnObserverHost } from '../processpool.js';
import type { DispatchOutcome, DispatchSpec } from '../types.js';
/** 整棵进程树终止（Windows 用 taskkill /T，POSIX 用进程组）。 */
export declare function killTree(pid: number | undefined): void;
/**
 * Windows 命令行长度上限（`CreateProcess` 的 `lpCommandLine`）。
 *
 * **实测**（`probe/_stdin-capability.mjs` T5，二分；零模型额度）：整条命令行
 * **32,763 字符仍成功**、**32,773 字符报 `spawn ENAMETOOLONG`** —— 与文档值 32,767 一致。
 * 门槛取 32,768：**低于它的输入今天本来就能跑**（这次改动不许把它们拒掉），
 * 高于它的输入今天**必然**失败。
 *
 * 量度就是 `argv.join(' ').length`（与 T5 同一定义）。注意它是**真实命令行的下界**：
 * 带空格/引号的参数会被 Node 再包一层引号 ⇒ 真命令行更长。取下界是为了**宁可漏判、不可误拒**
 * —— 漏判只是退回今天的行为（`spawn ENAMETOOLONG`），误拒则是把本来能跑的轮次挡掉。
 * POSIX 没有这条限制（`ARGV_LINE_LIMIT = 0` ⇒ 不启用该检查）。
 */
export declare const HEADLESS_ARGV_LINE_LIMIT: number;
/** 一次 headless 调用的 argv / stdin 计划（含「prompt 到底走了哪条路」的如实记录）。 */
/**
 * 识别厂商 CLI「**模型被拒**」的签名（供 headless 的终止性质判定使用）。
 *
 * 实测原文（WorkBuddy CN/INTL，2026-10-14 直测该 CLI）：
 * ```
 * 400 model [gpt-6-astra] service info not found (01a13af4…/01a13af4-…)
 * Currently supported models for your account:
 *   - fast-model
 *   - balanced-model
 *   - primary-model
 *   - deep-model
 * Please use --model <model_id> to specify a valid model.
 * ```
 * ⚠️ 这条判据的必要性：该 CLI 在**模型被拒**时**仍以 0 退出** —— 只看退出码会把假成功报成 completed。
 * @returns 命中的摘录与该账号支持清单（无命中返回 undefined；**绝不猜**）。
 */
export declare function modelRejectionOf(output: string): {
    headline: string;
    supported: string[];
} | undefined;
export interface HeadlessPlan {
    argv: string[];
    stdinText?: string;
    resolved: string;
    verbatim: boolean;
    /** `stdin` = prompt 不进命令行；`argv` = prompt 拼在命令行末尾。 */
    promptDelivery: 'stdin' | 'argv';
    /** prompt 字符数（**从不截断**，如实计数）。 */
    promptChars: number;
    /** 即将交给 spawn 的整条命令行字符数（`argv.join(' ').length`，下界）。 */
    argvChars: number;
}
/** 拼接一次 headless 调用的完整 argv（prompt 走内联旗标 / 末尾参数或 stdin）。 */
export declare function headlessArgv(spec: DispatchSpec): HeadlessPlan;
/**
 * 跑一次 headless 派发；永不 reject（异常折叠成 stopReason）。
 *
 * `spec.onSpawn` 是**可选**挂钩：给了就在 `spawn()` 成功那一刻把「真实拉起的 pid +
 * 启动时刻」回报出去（这是进程池能登记"我拥有的进程"的唯一来源），并拿回一个
 * 结束回报回调（何时结束 / 退出码 / 信号 / 是否被取消）。没给也能照常跑 ——
 * 只是那时池只能等派发结果里的 facts，属于**未登记启动时刻**，会被如实标注。
 */
export declare function dispatchHeadless(spec: DispatchSpec & SpawnObserverHost): Promise<DispatchOutcome>;
