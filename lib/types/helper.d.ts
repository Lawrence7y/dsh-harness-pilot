export interface HelperWindow {
    hwnd: number;
    pid: number;
    title: string;
    class: string;
    process: string;
    exe: string;
    rect: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
    minimized: boolean;
    visible: boolean;
    foreground: boolean;
}
interface HelperReply {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
}
export declare class WindowHelper {
    private readonly pythonPath;
    private child;
    private sequence;
    private readonly waiting;
    private startPromise;
    private hello;
    private lastError;
    constructor(pythonPath: string);
    info(): HelperReply | null;
    private start;
    ensure(): Promise<HelperReply>;
    /** 已启动则为 true；用于能力探测而不触发启动副作用。 */
    get running(): boolean;
    call(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<HelperReply>;
    windows(includeInvisible?: boolean): Promise<HelperWindow[]>;
    find(match: {
        title?: string;
        process?: string;
        pid?: number;
    }, timeoutMs?: number): Promise<HelperWindow[]>;
    /** 轮询等待窗口出现（带面积门槛，避免抓到 0x0 的隐藏窗口）。 */
    waitForWindow(match: {
        title?: string;
        process?: string;
        pid?: number;
    }, timeoutMs?: number): Promise<HelperWindow | undefined>;
    focus(hwnd: number): Promise<{
        focused: boolean;
    }>;
    text(hwnd: number, options?: {
        pid?: number;
        mode?: 'auto' | 'uia' | 'console';
        limit?: number;
    }): Promise<{
        text: string;
        source: string;
        note?: string;
    }>;
    shot(path: string, options?: {
        hwnd?: number;
        region?: [number, number, number, number];
        maxWidth?: number;
    }): Promise<{
        path: string;
        width: number;
        height: number;
        region: unknown;
    }>;
    type(text: string): Promise<void>;
    key(keys: string | string[], repeats?: number): Promise<void>;
    click(x: number, y: number, options?: {
        button?: string;
        clicks?: number;
    }): Promise<void>;
    launch(spec: {
        command: string;
        mode?: 'terminal' | 'gui';
        title?: string;
        cwd?: string;
        waitMs?: number;
    }): Promise<{
        pid: number;
        host: string;
        window: HelperWindow | null;
    }>;
    close(hwnd: number): Promise<void>;
    /** 定位并点中窗口里的输入框；找不到返回 found:false（不算错误，调用方退化到直接打字）。 */
    focusInput(hwnd: number, options?: {
        name?: string;
        settleMs?: number;
    }): Promise<{
        found: boolean;
        element?: {
            ct: string;
            name: string;
            aid: string;
            rect: number[];
        };
        clicked?: {
            x: number;
            y: number;
        };
        reason?: string;
    }>;
    /** 按可见名字点击窗口内元素（UIA）：打开面板、点「新建任务」这类按钮。 */
    clickByName(hwnd: number, name: string, options?: {
        kind?: string;
        settleMs?: number;
    }): Promise<{
        found: boolean;
        element?: {
            ct: string;
            name: string;
            rect: number[];
        };
        clicked?: {
            x: number;
            y: number;
        };
        reason?: string;
        alternatives?: string[];
    }>;
    /** 列出窗口内的可交互元素（诊断用；失败不抛错）。 */
    elements(hwnd: number, options?: {
        kind?: 'all' | 'input' | 'interactive';
        limit?: number;
    }): Promise<unknown[]>;
    dispose(): void;
}
export {};
