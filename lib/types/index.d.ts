/**
 * @dsh-external/dsh-harness-pilot — 把其他 harness 接入 DeepSeek Harness。
 *
 * 两条使用路径（同一套通道）：
 *   1. 子代理派发：每个 harness 注册成 `ctx.subagents` 上的 `harness-<name>` provider，
 *      `harness_agent` / 标准 subagent 工具都能以子代理语义把任务交给它。
 *   2. 直接操控：`harness_dispatch` 一次性派发；`harness_open` + `harness_send`
 *      则以窗口/CDP/PTY 的方式交互操控（不依赖截图 OCR）。
 *
 * 三条对外面：
 *   - 工具（tools.ts）：DSH 内的模型调用面。
 *   - HTTP（本文件的 `/harness-pilot/api`）：设置页与**外部 agent**（如 Codex）的调用面，
 *     不需要在 DSH 里就能派任务 / 查模型 / 换模型。
 *   - 客户端（client/client.js）：设置页只读渲染。
 *
 * 通道梯子（自动选，选不到就如实报错，不会悄悄降级重复执行）：
 *   acp      → ACP 协议（opencode 等支持 ACP 的 harness，流式文本，最稳）
 *   headless → CLI 一次性打印模式（opencode run / agy --print / claude -p / codex exec）
 *   pty      → 宿主 ConPTY（ctx.subprocess.spawnTerminal），用于只有全屏 TUI 的 harness
 *   cdp      → Chromium DevTools 协议（Electron harness：读 DOM、写输入框、点发送）
 *   window   → 真实窗口（定位/聚焦/注入键盘 + 无障碍树或控制台缓冲区读文本；截图仅兜底）
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Config, type ResolvedConfig } from './config.js';
import { SessionRegistry } from './sessions.js';
import { type RuntimeSettings } from './settings.js';
import { TaskManager } from './tasks.js';
export declare const name = "@dsh-external/dsh-harness-pilot";
/**
 * 只声明**激活必需且注册顺序有保证**的核心服务（dsh-base 提供，先于本插件就位）。
 * subagents / webServer / 唤醒链服务不在这里：它们由子 fiber（等到再注册）或
 * 惰性解析处理 —— 见 apply() 里的「服务时序纪律」注释。
 */
export declare const inject: string[];
export { Config };
interface LoggerLike {
    info?(message: string): void;
    warn?(message: string): void;
}
/** 一条要注册进宿主 webServer 的路由。 */
interface WebServerRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** 宿主 webServer 的最小面：注册一条 HTTP 路由，并（仅供自愈）看到内部路由表。 */
interface WebServerLike {
    register(route: WebServerRoute): () => void;
    /** 运行期就是 Service 实例上的三张 Map（编译期是私有字段，所以这里是可选 + unknown）。 */
    exact?: unknown;
    prefixes?: unknown;
    upgrades?: unknown;
}
/**
 * 清掉 webserver 路由表里以 `path` 开头的残留条目 —— 与超级模组的 `dev_clear_routes`
 * 同一套做法：直接操作 Service 实例上的 `exact` / `prefixes` / `upgrades` 三张 Map。
 *
 * 为什么需要：热重载被打断（旧 fiber 的 disposer 没跑完）时，路由表里会留下同路径的
 * 旧条目，`register()` 于是抛 `duplicate prefix route`，而插件重启又不会自己清 —— 结果
 * 就是接口静默 404。这里先清残留再重试一次，把「一次被打断的重载」变成自愈。
 *
 * 已知残留风险：若旧 fiber 的 disposer 在**我们重新注册之后**才迟到执行，它按路径
 * `table.delete(path)` 会把我们新注册的这条一起删掉（表按 path 索引，分不清世代）。
 * 这种迟到 disposer 无法从外部拦截；届时网页端会再一次 404，重新加载插件即可恢复。
 *
 * 导出仅为 probe/verify-route-heal.mjs 能直接驱动它（插件入口的其余导出同理）。
 */
export declare function clearStaleRoutes(webServer: WebServerLike, path: string): string[];
/**
 * 注册 `/harness-pilot/api` 前缀路由，失败时自愈：
 *   1. `register` 抛错（多半是中断重载留下的同路径残留）→ 清掉残留；
 *   2. 再试一次；
 *   3. 还是失败 → 用 warn 把两次的原始错误都打出来（不吞）。
 *
 * @returns 注册成功时为该路由的 disposer，否则 undefined。
 */
export declare function registerApiRoute(webServer: WebServerLike, handler: WebServerRoute['handler'], logger: LoggerLike | undefined): (() => void) | undefined;
/**
 * 建 `/harness-pilot/api` 的 handler。它复用**同一个** SessionRegistry（不再造第二个），
 * 所以 HTTP 与工具看到的是同一批会话。
 *
 * 鉴权：Config.apiToken 非空时，所有请求都要带 `x-harness-pilot-token` 且完全一致，
 * 否则 401；为空则放行 —— webServer 默认只监听 127.0.0.1，本机进程本来就能直连
 * localhost，令牌只用于「不想让任意本机进程/浏览器页面随便使唤 harness」的场景。
 *
 * 端点：
 *   GET  /overview            （?models=1 会去问每个 harness 的模型，慢）
 *   GET  /probe?target=…      通道梯子可用性
 *   POST /models              { target?, refresh? }              → { target, models, note, mechanism }
 *   POST /dispatch            { target, prompt, model?, transport?, timeout_ms?, cwd? }
 *                             → { target, transport, stopReason, text, diagnostic?, facts? }
 *   POST /send                打开/复用会话：{ target, model?, cwd?, launch? } → { sessionId, transport, currentModel }
 *                             向已有会话写入：{ sessionId, text?, submit?, wait_ms? } → { sessionId, …, text, source }
 *
 * 导出仅为 probe/verify-api-handler.mjs 能用假 registry / 假 req-res 离线驱动它。
 */
/** createApiHandler 的可选扩展面：异步任务 + 运行时设置（离线探针可不传）。 */
export interface ApiExtras {
    tasks?: TaskManager;
    settings?: () => RuntimeSettings;
    applySettings?: (raw: unknown) => RuntimeSettings;
}
export declare function createApiHandler(registry: SessionRegistry, config: ResolvedConfig, extras?: ApiExtras): WebServerRoute['handler'];
export declare function apply(ctx: Context, rawConfig: unknown): void;
