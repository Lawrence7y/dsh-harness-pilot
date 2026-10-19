export type ModelRefForm = 'cli-default' | 'provider-model' | 'target-model' | 'plain';
export interface ModelRequestInput {
    /** 本次要跑的目标名（`agy` / `wb-managed-a` / …）。 */
    readonly targetName: string;
    /** 该目标所属 harness 的 provider id（形如 `harness-antigravity`）；用于校验 `provider/model` 形态。 */
    readonly providerId?: string;
    /** 调用方给的模型引用（可空 = 用该 CLI 默认档）。 */
    readonly explicit?: string;
    /** 该目标**当前可选择**的模型 id（来自 `selectableIds(entries)`；不含 `cli-default`）。 */
    readonly selectable: readonly string[];
    /** 这份清单是不是**真的测量过**（true 才会因为「不在清单里」而拒绝）。 */
    readonly measured: boolean;
    /** 该目标有没有模型开关（`modelArgs` 或 `acpArgs` 之一非空）。 */
    readonly modelSwitchable: boolean;
    /** 调用方是否另外给了 `extra_args`（给了就允许在「无模型开关」的目标上自行拼参数）。 */
    readonly hasExtraArgs?: boolean;
}
export type ModelRequestOutcome = {
    readonly ok: true;
    /** 真正要下发到 CLI 的模型 id；`undefined` = 不下发（用 CLI 默认档）。 */
    readonly model: string | undefined;
    readonly form: ModelRefForm;
    /** 是否**核对过**清单（false = 没测量过，只是放行）。 */
    readonly verified: boolean;
    readonly note: string;
} | {
    readonly ok: false;
    readonly reason: string;
    readonly recovery: string;
};
export declare function resolveModelRequest(input: ModelRequestInput): ModelRequestOutcome;
