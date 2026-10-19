/**
 * 运行期宿主包的**环境声明（ambient shims）**。
 *
 * ## 为什么需要
 * 运行中的 0.2.0-rc.2 宿主发布产物在 `app.asar` 里**不含任何 `.d.ts`**：
 * 每个包的 `package.json` 都声明了 `exports["."].types = ./lib/types/index.d.ts`，
 * 但该文件在 asar 中并不存在（实测：连 `@types/node` 也只剩 3 个非 `.d.ts` 文件；
 * `lib/types/*.js` 是**真的运行期 JS**，不是声明文件）。因此 tsc 无法从运行版本取类型。
 *
 * ## 之前是怎么做的（以及为什么改掉）
 * 原 `scripts/build.mjs` 让 tsc 去读一个**旧 checkout** 的 `.d.ts`
 * （`D:\Project\deepseek-harness-master` = 0.1.0-rc.8，或 `C:\dsh` = 0.2.0-rc.1）。
 * 那正是「把旧源码当成运行版本」的类型版：编译期按 rc.1/rc.8 的签名通过，
 * 运行期却跑在 rc.2 上。**本文件把那层假象去掉了**：这些模块在编译期显式按
 * `any` 处理，宁可少检查，也不假装类型是对的。
 *
 * ## 取舍（如实记录）
 * - **运行期模块实例 = 真正的 rc.2**：`node_modules/@deepseek-ai/*` 是 junction，
 *   指向从运行中 asar 抽出的 rc.2 模块树（实测 dsh-subagent/dsh-tools/dsh-llm/
 *   dsh-session/dsh-agent = 0.2.0-rc.2，cordis = 4.0.4，schemastery = 3.18.4）。
 * - **编译期类型 = `any`**：因此**编译期发现不了宿主 API 的签名漂移**。
 *   这类漂移只能靠运行期自检与行为验收捕获（见
 *   `docs/00-verified-status-report.md` 的「运行时一致性横幅」与 §6 验收）。
 * - 正确做法是**从运行中的宿主生成声明**，或让上游随包发布 `.d.ts`，
 *   而不是指向另一个版本。这是一条受上游产物限制、需显式声明的缺口。
 *
 * 下方只声明本仓库**实际用到**的名字（由 `src/` 的 import 扫描得出），
 * 不做无边界通配。
 */

/** schemastery 的 `z` 既是值（`z.object`/`z.string`…）又是泛型类型（`z<Config>`）。 */
declare module '@deepseek-ai/schemastery' {
  interface z<T = any> {
    (value: any): any
  }
  const z: z & Record<string, any>
  export default z
}

/** cordis 的 `Context`：仅作为类型使用。 */
declare module '@deepseek-ai/cordis' {
  export type Context = any
  export type Fiber = any
  export type Plugin = any
}

declare module '@deepseek-ai/dsh-tools' {
  export const defineTool: any
}

declare module '@deepseek-ai/dsh-llm' {
  export type ContentBlock = any
  export const createUserMessage: any
  export const resolveRetryPolicy: any
  export const resolveImageAttachmentAccess: any
}

declare module '@deepseek-ai/dsh-subagent' {
  export type SubagentProvider = any
  export type SubagentRun = any
  export type SubagentStartRequest = any
  export type SubagentResult = any
  export const NO_START_CAPABILITIES: any
  export const resolveChildCwd: any
  export const settleRunResult: any
  export const subprocessRunHandle: any
}

declare module '@agentclientprotocol/sdk' {
  export type ActiveSession = any
  export type ClientApp = any
  export type ClientContext = any
  export type InitializeResponse = any
  export type StopReason = any
  export const client: any
  export const ndJsonStream: any
  export const PROTOCOL_VERSION: any
}

/** 仅 pty 通道动态使用；宿主产物同样无 .d.ts。 */
declare module 'node-pty' {
  const x: any
  export default x
}

declare module '@xterm/headless' {
  export const Terminal: any
}
