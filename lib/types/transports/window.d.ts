/**
 * window 通道：把任务「像人一样」打进另一个 harness 的窗口，再把可见文本读回来。
 *
 * 适用对象：没有 CLI 一次性模式、也没有 CDP 调试端口的 GUI / TUI harness
 * （ZCode、MiMo、Cursor 之类）。这一档是最后兜底，代价也最明确：
 *
 *   * 输入是「真键盘」——定位窗口 → 聚焦 → 逐行 pyautogui 打字 / 贴剪贴板 → 按提交键；
 *   * 输出是「屏幕快照文本」——UIA 无障碍树或控制台缓冲区，**不是解析过的回答**；
 *   * 判完成只能靠「屏幕不再变化」，所以静止阈值 `window.settleMs` 是这一档的核心参数。
 *
 * 三条铁律：
 *   1. 读不到文本就报错，绝不编造输出（hp_helper 读空时会带 note，原样回传）；
 *   2. 文本次级一律走 `helper.type()`（ASCII 直接打、非 ASCII 走剪贴板），
 *      绝不拿 `key` 拼字符串——那是给按键名用的；
 *   3. `dispatchWindow` 永不 reject，异常折进 stopReason（与 headless 通道一致）。
 *
 * 本文件只依赖 `helper.ts` 的客户端接口与 `types.ts` 的类型，不 import 任何运行时值，
 * 因此可以被独立编译 / 单独测试。
 */
import type { WindowHelper } from '../helper.js';
import type { DispatchOutcome, DispatchSpec, ReadResult, TargetConfig } from '../types.js';
/** 一次窗口会话：attach 到的目标以及 attach 瞬间的屏幕基线。 */
export interface WindowSession {
    /** 目标注册名（`TargetConfig.name`）。 */
    readonly target: string;
    readonly hwnd: number;
    readonly pid: number;
    readonly title: string;
    readonly process: string;
    /** attach 瞬间读到的屏幕文本（空串表示「窗口暂时没输出」，不代表读失败）。 */
    readonly initialText?: string;
    /** attach 瞬间文本来源：`uia` / `console` / `none`。 */
    readonly initialSource?: string;
    /** attach 备注：窗口是我们启动的还是复用现成的、focus 是否被系统拒绝、初始读取是否失败。 */
    readonly attachNote?: string;
    /**
     * 这个窗口是不是本插件启动的。
     * 只有 `true` 时 `closeWindow` 才会真的关闭窗口 —— 附着到用户已经开着的 harness 时，
     * 关会话只应该「脱手」，绝不能把用户的窗口关掉（Electron 应用常会顺手缩到托盘）。
     */
    readonly owned?: boolean;
}
/**
 * attach 到（必要时启动）harness 窗口。
 *
 * 顺序：先在现有窗口里找（前台优先 → 面积最大）→ 找不到且 `options.launch === true`
 * 且目标配了 `window.launch` → 由 helper 拉起一个独立终端窗口再等它出现 → 仍找不到就抛错。
 * attach 成功后立即 focus，并读一次屏幕文本作为基线（供 dispatch 做 diff）。
 */
export declare function openWindow(helper: WindowHelper, target: TargetConfig, options: {
    cwd?: string;
    launch?: boolean;
    timeoutMs?: number;
}): Promise<WindowSession>;
/** 读一屏可见文本；source 原样透传（uia / console / none），helper 的 note 作为 diagnostic。 */
export declare function readWindow(helper: WindowHelper, session: WindowSession, options: {
    limit: number;
    mode?: 'auto' | 'uia' | 'console';
}): Promise<ReadResult>;
/**
 * 把一段 prompt 打进窗口：先聚焦，然后逐行 `helper.type()`，
 * 换行用 `window.newlineKeys`（很多 TUI 里回车 = 提交，所以换行要另配键），
 * 最后按 `window.submitKeys` 提交。返回一句给模型看的人话备注。
 *
 * 注意：聚焦失败会直接抛错（见 ensureForeground）——盲打进前台窗口比失败危险得多。
 */
export declare function sendToWindow(helper: WindowHelper, target: TargetConfig, session: WindowSession, input: {
    text?: string;
    submit?: boolean;
}): Promise<{
    note: string;
}>;
/** 关窗：helper 只是 PostMessage(WM_CLOSE)；窗口早已消失不算失败。 */
export declare function closeWindow(helper: WindowHelper, session: WindowSession): Promise<void>;
/**
 * 一次性窗口派发：打字 → 轮询读屏 → 「文本相对基线变了，且此后 byte-identical 持续 settleMs」即认为答完。
 *
 * 返回的 text 是**完整的最终屏幕文本**（窗口通道没有「解析后的回答」这回事），
 * diagnostic 会明确说明这一点。永不 reject。
 */
export declare function dispatchWindow(helper: WindowHelper, spec: DispatchSpec, options: {
    session?: WindowSession;
    launch?: boolean;
}): Promise<DispatchOutcome>;
