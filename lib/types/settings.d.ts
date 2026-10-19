export interface RuntimeSettings {
    /** 任务完成后主动把交付内容送回发起会话并唤醒它继续任务（回执）。 */
    notifyOnComplete: boolean;
    /** 回执里附带 harness 的交付内容正文（截断到 maxResultChars）。 */
    deliverResult: boolean;
    /** 交付内容正文的截断长度（字符）。 */
    maxResultChars: number;
    /** 同时运行的异步任务上限；0 表示不限数量。 */
    maxConcurrent: number;
    /** 异步任务默认硬超时（毫秒）。 */
    defaultTaskTimeoutMs: number;
    /** 回执里附加的续办提示（空 = 用内置提示语）。 */
    resumeInstruction: string;
    /**
     * **会话模型菜单**里每个 harness 最多列多少个模型（0 = 不限）。
     *
     * ⚠️ **2026-10-14 起这个旋钮不再生效**（保留字段只为兼容旧设置文件，改它没有任何效果）：
     * 模型目录已改成「**一个 harness 一个 provider 分组**」，宿主原生菜单是
     * 「供应商列表 → 钻进该供应商看它的全部模型」的两级形态 ⇒ 每组内部**不再截断**
     * （用户明确要求「点开折叠后才是该 harness 的全部模型」，也不允许「任意截断」）。
     * 当时引入这个旋钮是为了压住「单 provider 734 条扁平条目」，而那正是分组要解决的问题本身。
     */
    sessionModelLimit: number;
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
