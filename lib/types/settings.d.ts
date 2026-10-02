export interface RuntimeSettings {
    /** 任务完成后主动把交付内容送回发起会话并唤醒它继续任务（回执）。 */
    notifyOnComplete: boolean;
    /** 回执里附带 harness 的交付内容正文（截断到 maxResultChars）。 */
    deliverResult: boolean;
    /** 交付内容正文的截断长度（字符）。 */
    maxResultChars: number;
    /** 同时运行的异步任务上限。 */
    maxConcurrent: number;
    /** 异步任务默认硬超时（毫秒）。 */
    defaultTaskTimeoutMs: number;
    /** 回执里附加的续办提示（空 = 用内置提示语）。 */
    resumeInstruction: string;
}
export declare const DEFAULT_SETTINGS: RuntimeSettings;
/** 插件数据目录（任务落盘 + 运行时设置）。可用 HARNESS_PILOT_HOME 覆盖。 */
export declare function pluginHome(): string;
export declare function settingsPath(): string;
/** 任意输入收敛成一份完整、合法的设置（缺字段补默认，越界钳位，类型错当缺省）。 */
export declare function normalizeSettings(raw: unknown, base?: RuntimeSettings): RuntimeSettings;
/** 读盘上的设置；文件不存在/损坏时回默认（不抛）。 */
export declare function loadSettings(): RuntimeSettings;
/** 原子写回（tmp + rename），返回最终生效的设置。 */
export declare function saveSettings(raw: unknown, base?: RuntimeSettings): RuntimeSettings;
