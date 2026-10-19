import type { HarnessSeed } from './catalog.js';
import type { ModelRecord, ProviderInventory, ProviderRecord } from './types.js';
import type { TargetConfig } from '../types.js';
import { type NativeCatalogEntry } from '../native-model-catalog.js';
/** 一次**真实完成**的模型请求证据（来自插件自己的任务账本，不是推断）。 */
export interface UsableEvidence {
    readonly runId: string;
    readonly target: string;
    /** 账本里记录的实际模型；null = 当时用的是该 harness 的默认模型。 */
    readonly model: string | null;
    readonly at: string;
    readonly transport: string;
    readonly outputChars: number;
    readonly excerpt: string;
}
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
export declare function usableEvidenceRejection(record: {
    readonly stopReason?: unknown;
    readonly diagnostic?: unknown;
    readonly text?: unknown;
}): string | undefined;
/** 读任务账本，挑出「真的完成了、并且真的回了内容」的记录。 */
export declare function readUsableEvidence(taskDir: string, limit?: number): UsableEvidence[];
/** 一次解析的**形状**（给探针/审计用：证明表头与供应商列是在哪一步被排除的）。 */
export interface ModelListShape {
    readonly shape: 'json' | 'table' | 'lines' | 'empty';
    /** 表头行原文；没有表头 = null。 */
    readonly headerLine: string | null;
    /** 被判为**供应商列**的取值（同一个词在第一列反复出现 ≥2 次）。 */
    readonly providerColumns: readonly string[];
    /** 参与判定的非空数据行数（表头不计）。 */
    readonly dataLines: number;
    /** 表格形状下按「供应商列 + 模型列」处理的行数。 */
    readonly tableRows: number;
}
/**
 * 解析模型清单输出。依次尝试：JSON → 空白对齐表格 → 逐行文本。
 * 解析不出来就返回空数组 —— **宁可空也不要编**。
 *
 * ⚠️ 这是本插件**唯一**的「harness 自己列了哪些模型」解析器：`/providers`、`/models`、
 * overview 三处必须都走它，否则同一次真实发现会在不同出口给出不同答案（实测缺陷）。
 */
export declare function parseModelListOutput(raw: string): ModelRecord[];
/** 上面那次解析的**形状**（表头行、供应商列、行数）—— 只读、纯函数，供探针取证。 */
export declare function modelListShape(raw: string): ModelListShape;
/**
 * 从该 Harness 的原生配置文件里读出「已配置」的供应商/模型**名字**。
 *
 * 只提取**名字**，绝不读值 —— 配置文件里紧挨着名字的往往是密钥，本模块不碰。
 * 同时拒绝任何像令牌的字符串（长度大且含 base64/JWT 特征），避免误把凭据当模型名。
 */
export declare function readConfiguredNames(file: string): ModelRecord[];
export interface ListCommandResult {
    readonly argv: readonly string[];
    readonly ok: boolean;
    readonly stdoutChars: number;
    readonly models: readonly ModelRecord[];
    /** 非空 = 命令失败或被认为受认证阻塞，此时**不得**把结果当已认证。 */
    readonly error?: string;
    readonly authBlocked: boolean;
}
/**
 * 输出里是否出现**认证相关字样**（与列表命令同一份判据，导出给 `models.ts` 复用）。
 *
 * ⚠️ 只看**短文本**：stderr 全部 + stdout 前 2KB。全量扫描会把 605KB JSON 里任何一处
 * `not authenticated`/`401`（可能是某个未用供应商的元数据）误判成整批模型认证受阻。
 */
export declare function authBlockedInOutput(stdout: string, stderr: string): boolean;
export declare function runModelListCommand(entry: string, argv: readonly string[], childEnv: Record<string, string>, timeoutMs: number, wrapping?: string): Promise<ListCommandResult>;
export interface InventoryOptions {
    readonly target?: TargetConfig;
    readonly harnessId: string;
    readonly accountId: string;
    readonly seed?: HarnessSeed;
    /** 目标名（账本里用的名字），用于把 usable 证据对上。 */
    readonly targetName?: string;
    /** 已解析的真实入口；为空则不做命令发现。 */
    readonly entry?: string | null;
    readonly env?: Readonly<Record<string, string>>;
    readonly measure?: boolean;
    readonly timeoutMs?: number;
    readonly usable?: readonly UsableEvidence[];
    /** DSH 本 profile 的供应商 —— 单独一栏，**绝不**并入 native。 */
    readonly dshNative?: readonly ProviderRecord[];
}
export interface InventoryResult extends ProviderInventory {
    readonly catalog?: readonly NativeCatalogEntry[];
    readonly dshNative: readonly ProviderRecord[];
    readonly declared: {
        readonly listCommand: readonly string[];
        readonly configFiles: readonly string[];
        readonly authBlocked: boolean;
    };
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
export declare function collectProviderInventory(options: InventoryOptions): Promise<InventoryResult>;
