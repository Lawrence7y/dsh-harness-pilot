export interface ModelVisibilityDoc {
    readonly version: 1;
    readonly updatedAt: string;
    /** 每条 harness（provider id）在会话选择器里最多显示多少个模型；0 = 不限。**缺键 = 用默认值**。 */
    readonly groupLimit: Readonly<Record<string, number>>;
    /** 整组隐藏：该 harness 连「CLI 默认模型」一起不出现在会话选择器。 */
    readonly hiddenGroups: readonly string[];
    /** 组内隐藏：这些模型 id 不进选择器（已选中的会话不受影响，仍执行）。 */
    readonly hiddenModels: Readonly<Record<string, readonly string[]>>;
}
/** 每组默认显示上限（不含「CLI 默认模型」那条）。10 是「常用 CLI 的全集 ≈ pi/agy 之外」的量级；可逐组改。 */
export declare const DEFAULT_PICKER_LIMIT = 10;
export declare const PICKER_LIMIT_MAX = 500;
/** 「CLI 默认模型」的保留 id —— 隐藏它等价于「这条 harness 我不想在会话里手选」。 */
export declare const CLI_DEFAULT_VISIBLE_ID = "cli-default";
/** 一条 provider 在某一刻的**生效**可见性（解析默认值之后的形状）。 */
export interface PickerVisibilitySpec {
    readonly groupHidden: boolean;
    /** 生效上限（0 = 不限）。 */
    readonly limit: number;
    readonly hidden: readonly string[];
}
export declare const EMPTY_VISIBILITY_SPEC: PickerVisibilitySpec;
/** 把文档解析成某条 provider 的生效值（纯函数；未知 provider ⇒ 全默认 + 不隐藏）。 */
export declare function pickerVisibilityFor(doc: ModelVisibilityDoc, providerId: string): PickerVisibilitySpec;
/**
 * 按生效值裁剪一组模型行（**保序**：裁剪只删不排，同 id 多次出现也只按位置处理 —— 上游 `mergeHarnessModels` 已去重）。
 * `hidden` 里的 id 直接删；`limit > 0` 时再取前 `limit` 条。返回**同一批对象的引用**，不复制不改写。
 */
export declare function filterPickerModels<T extends {
    readonly id: string;
}>(models: readonly T[], hidden: ReadonlySet<string>, limit: number): readonly T[];
export declare function modelVisibilityPath(): string;
/** 任意输入收敛成一份完整、合法的文档（缺字段补默认，类型错当缺省；**不抛**）。 */
export declare function normalizeModelVisibility(raw: unknown): ModelVisibilityDoc;
/** 读盘；文件不存在/损坏都回「全默认」（不抛 —— 可见性配置坏了不该打挂模型目录）。 */
export declare function loadModelVisibility(): ModelVisibilityDoc;
/**
 * 原子写回（tmp + rename）；**写之前把上一份留成 `*.prev.json`**（单层撤销，与子代理白名单的
 * 写前快照同一纪律）。返回最终落盘的文档（updatedAt 已补）。
 */
export declare function saveModelVisibility(next: ModelVisibilityDoc): ModelVisibilityDoc;
/** 一次可见性变更（全部字段可选；`reset` 优先级最高，把这条 provider 恢复成全默认）。 */
export interface VisibilityPatch {
    readonly providerId: string;
    readonly groupHidden?: boolean;
    /** 生效上限；0 = 不限。缺省 = 不动。 */
    readonly limit?: number;
    readonly hideModels?: readonly string[];
    readonly showModels?: readonly string[];
    readonly reset?: boolean;
}
export type VisibilityPatchResult = {
    readonly ok: true;
    readonly next: ModelVisibilityDoc;
    readonly note: string;
} | {
    readonly ok: false;
    readonly reason: string;
};
export declare function applyVisibilityPatch(doc: ModelVisibilityDoc, patch: VisibilityPatch): VisibilityPatchResult;
/**
 * 给 HTTP 层用的门面（与 `SubagentModelsFacade` 同一模式：宿主服务只在装配期拿得到，
 * 路由处理器拿不到 `ctx`）。由 `index.ts` 在挂载期构造一次；离线探针不挂 ⇒ 路由 503。
 */
export interface ModelVisibilityFacade {
    /** 读当前配置（运行期生效值）。 */
    readonly read: () => ModelVisibilityDoc;
    /** 应用一次变更并落盘；成功返回「上一份 + 新文档 + 可读变更说明」。 */
    readonly write: (patch: VisibilityPatch) => {
        readonly ok: true;
        readonly doc: ModelVisibilityDoc;
        readonly previous: ModelVisibilityDoc;
        readonly note: string;
    } | {
        readonly ok: false;
        readonly reason: string;
    };
    /**
     * 每条 harness 分组的**当前合并清单**（与 `listModels` 同一份 `mergeHarnessModels` 实现，
     * 只是**不过滤** —— UI 要展示全量才好勾选）。只读同步缓存；未预热的目标就是空/短，如实。
     */
    readonly providers: () => readonly {
        readonly providerId: string;
        readonly label: string;
        readonly groupId: string;
        readonly models: readonly string[];
    }[];
}
/** GET 出口的**单 provider 摘要**：UI 首屏与断言共用一份（不另写第二份合并逻辑）。 */
export interface PickerProviderSummary {
    readonly providerId: string;
    readonly groupHidden: boolean;
    readonly limit: number;
    /** 当前该组合并后的全部模型数（不含 cli-default）。 */
    readonly total: number;
    /** 应用可见性后会出现在选择器里的模型数（不含 cli-default；整组隐藏时为 0）。 */
    readonly visible: number;
    readonly hiddenCount: number;
    /** 合并清单 ∪ 已配置隐藏项：UI 勾选清单就画这一份（`known:false` = 该 CLI 当前已不再报它）。 */
    readonly models: readonly {
        id: string;
        visible: boolean;
        known: boolean;
    }[];
}
export declare function pickerProviderSummary(doc: ModelVisibilityDoc, providerId: string, modelIds: readonly string[]): PickerProviderSummary;
