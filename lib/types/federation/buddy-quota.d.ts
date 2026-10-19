export type BuddyQuotaState = 'available' | 'exhausted' | 'unknown';
export interface BuddyQuotaAccount {
    /** 与 HTTP 通道同一套句柄公式，便于两条路径指向同一个账号。 */
    readonly handle: string;
    /** 厂商服务区域：`cn` = 国内版，`ai` = 国际版（WorkBuddy AI）。管理员里叫 `global`。 */
    readonly region: 'cn' | 'ai' | 'unknown';
    /** 脱敏昵称（掩码后）。可能为空 —— 昵称为令牌形状时被丢弃。 */
    readonly label: string;
    readonly credits: number | null;
    /** 临期积分（7 天内到期）。管理器给不出时为 null。 */
    readonly expiring: number | null;
    /** 这份积分的**采集时间**（ISO）；管理员没给则为 null。 */
    readonly refreshedAt: string | null;
    /** 管理器自己标记的停用位（不等于额度耗尽）。 */
    readonly disabled: boolean;
    /** 管理器熔断到期时间（ISO）；未熔断为 null。 */
    readonly breakerUntil: string | null;
    readonly state: BuddyQuotaState;
    /** 判定依据（必须能说清「你凭什么这么说」）。 */
    readonly reason: string;
}
export interface BuddyQuotaSnapshot {
    /** 快照**是否可用**（文件在、能解析、且整体未过期）。 */
    readonly available: boolean;
    readonly file: string;
    readonly savedAt: string | null;
    readonly accounts: readonly BuddyQuotaAccount[];
    /** 不可用时说明原因；可用时为空串。 */
    readonly reason: string;
    /** 界面必须原样显示的边界说明。 */
    readonly note: string;
}
/** 默认新鲜度上限：超过这个时长的积分快照不参与任何判定。 */
export declare const BUDDY_QUOTA_MAX_AGE_MS: number;
/** 昵称脱敏：邮箱留前两位 + 域名，其它留前 2 字；命中令牌形状直接丢弃。
 *
 * 掩码用 `…`（与项目里既有的 `acct:…-aa` 同一风格）而**不是 `***`**：
 * 星号会在「界面上不得出现字面 `**`」的冒烟断言里被当成 markdown 泄漏，造成假阳性。 */
export declare function maskNickname(value: string): string;
/** 与 `account-managers.handleFor` 同一套公式：同一个账号在两条路径上得到同一个句柄。 */
export declare function buddyHandle(region: string, id: string): string;
/** `state.json` 的 `realm` → 管理器区域的 `variant` 取值。 */
export declare function buddyRegionOf(realm: string): 'cn' | 'ai' | 'unknown';
/** 默认快照路径；允许用环境变量覆盖（测试与多机场景）。 */
export declare function buddyStateFile(): string;
/**
 * 读一次积分快照。**永不抛错**：任何异常都折成 `available:false` + 原因。
 * 这是刻意的 —— 一个额度读取失败不该让整个账号池接口挂掉。
 */
export declare function readBuddyQuota(options?: {
    file?: string;
    now?: number;
    maxAgeMs?: number;
}): BuddyQuotaSnapshot;
