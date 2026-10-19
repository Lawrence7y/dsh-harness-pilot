/**
 * `pilot-cli` LLM 适配器 + 「选择本路由不得写入部署默认模型」闸门。
 *
 * ## 这个文件解决什么
 * 宿主 DSH 的会话轮次此前**只能**由宿主自己的供应商产生（`opencode-go` / `deepseek`）。
 * 本文件向 `ctx.llm` 注册一条**自有路由** `pilot-cli`，让「选它」的会话轮次真的由
 * 外部 CLI 产生（经过本插件既有的 launcher / headless 通道，与 `harness_dispatch` 同一条路径）。
 *
 * ## 契约依据（全部指到运行版 0.2.0-rc.2 的 file:line，见 docs/verified/llm-adapter-contract.md）
 * - `ctx.llm.registerAdapter(providers, adapter)`：`dsh-llm/lib/index.js:1833`；
 *   返回「可调用 disposer + `.replace()`」，随 fiber 自动销毁（`ctx.effect`，`:1843`）。
 * - `LlmAdapter` 只有 `stream` 是必填；其余 6 个方法有默认实现（`:1670-1740`）。
 * - **`listModels` 必须实现**：返回 `[]` 的路由会被 `buildModelCatalog` 丢掉
 *   （`dsh-api-session-controller/lib/index.js:541` 的 `filter(group => group.models.length > 0)`），
 *   选择器里**完全不可见** —— 这是 Path A 生效的硬前提。
 * - chunk 只有 7 种，**没有独立的 error/end chunk**：错误与中止是 `finish` 的 reason
 *   （`dsh-llm/lib/typert.host.js:308,504`）。缺 `finish` 会退化为 `{kind:'stop'}`（`:1100-1103`）。
 * - 严格语法校验器 `dsh-llm/invariant` 在**当前 profile 未挂载**（实测 profile 里 grep 无 invariant）——
 *   所以现在是宽容行为兜底。**本文件不依赖那份宽容**：chunk 序列按严格语法闭合。
 * - 路由名撞名会**响亮失败**（`DUPLICATE_ADAPTER`，`:1863`）；本文件把它变成可读错误。
 *
 * ## ⚠️ 固有代价（必须让用户看见，绝不允许让人以为「切过去以后工具照常可用」）
 * 外部 CLI **不走 DSH 的工具协议**：适配器只产出 `text` 块，从不产出 `tool-call` 块；
 * 而 DSH 的工具执行由「装配好的 assistant 消息里**存在 tool-call 块**」触发
 * （`dsh-agent-loop/lib/index.js:1151-1155`）⇒ 这些轮次里 `executeToolCalls` **从不被调用**，
 * **DSH 自己的工具全部惰性**。CLI 自己的工具照常工作，但跑在 CLI 自己的沙箱里，
 * DSH 的审批 / fs 沙箱 / spill / 保留策略**看不到它们**。
 * 另外：`options.tools` / `options.toolHistory` 对本适配器只是**输入**（会被渲染进 CLI 的
 * prompt 里当说明文字），下游没有任何东西强制它们。
 * 这条文字同时出现在 `/harness-pilot/api/llm-adapter` 的 `costDisclosure` 字段里。
 *
 * ## 改道在哪一层（**本轮的关键修正：归因必须诚实**）
 * 绑定驱动的改道**曾经**挂在 `llm/stream` 上短路（自己产 chunk）。那能拿到内容，却**改不了请求**：
 * 会话日志的 `request/header` 取自 `prepareRequest` 解析出的 config（`dsh-agent-loop:1179-1218`），
 * assistant 消息的 `source` 就是 `{provider: request.provider, model: request.model}`（`:1136-1143`）
 * ⇒ 在响应层改道，日志必然把外部 CLI 的产出记成**宿主路由**（`opencode-go` / `deepseek`）= 归因不实。
 * 现在改在 **`agent/request` 瀑布**上改写 config（`{prepend:true, global:true}`，且**永远先 `await next()`**）：
 * 请求本身就带真实来源，`request/header` 与 `assistant/message.source` 随之诚实。
 * 三条附带规则（都在离线探针里固化，理由见 `requestRouteDecisionFor`）：
 * ① **改道必须丢掉 `reasoningEffort`**（适配器没声明 reasoning，带着会被 `dsh-llm:2177-2178` 判
 * `UNSUPPORTED_REASONING_EFFORT`，整轮直接失败）；
 * ② **绑定之后**用户又在选择器里显式选过模型 ⇒ 让路（否则宿主的 `[model changed: …]` 通知会
 * 每一轮追加一次且内容为假，而那次选择永远消费不掉）；
 * ②b **子代理会话（`header.origin === 'subagent'`）显式委托的路由** ⇒ **保持**：调用方是用宿主
 * `subagent` 工具的 `provider`/`model`（或 profile 的 `agentOptions`）**点名**外部 harness 的，
 * 那不是本插件的残留。⚠️ 实测缺陷（2026-10-14，本条就是修它）：旧判定只认「无绑定 + 无显式选择」，
 * 而委托**不写** `model/selection` 事件 ⇒ 子代理的路由被改回部署默认（子会话
 * `request/header.config` 实测为 `opencode-go/deepseek-v4.1-flash`）—— 外部 harness 一行都没跑，
 * 界面上却是一轮正常回复。**静默替换是最坏的一类不实**，所以这条判据必须排在残留恢复之前；
 * ③ 路由停在 `pilot-cli` 但**已无外部绑定**、且会话日志里**没有**「显式选过本路由」的记录 ⇒
 * 判定为本插件改道留下的残留，**恢复成部署默认模型**（否则「解除绑定」后会话会永远留在外部 CLI 上，
 * 与界面文案「未绑定、或绑定为原生 DSH 的会话，对话轮次仍由 DSH 自己的供应商执行」矛盾）。
 * ⚠️ ③ 的适用范围**只**是「本插件改写过的普通会话」—— 已由 ②b 把子代理会话排除在外。
 *
 * ## 闸门（用户设定的硬性前提）：选 `pilot-cli` 不得写入**部署默认模型**
 * 背景（VERIFIED）：选择器选任何模型都会 `selectModel` → `agentDefaultModel.saveSelection`
 * → `configEditor.edit(...)` 改写 `profiles\desktop\cordis.yml` 里的 `agent-default-model`
 * 条目（`dsh-api-session-controller/lib/index.js:736` → `dsh-agent-default-model/lib/index.js:53-66`
 * → `dsh-config-editor/lib/index.js:69-135`）。
 *
 * **拦截点是怎么选的（如实交代）**：
 * - 「cordis 的 config 写入事件」**不存在**：运行中宿主的**完整** Event 目录里，
 *   与配置写入最接近的只有 `app-boot/config-reload`（写完之后才发）与 `settings/document-updated`（事后），
 *   没有任何可否决写入的事件。
 * - 因此唯一的否决点是**方法级**：`agentDefaultModel.saveSelection` 是公开服务契约
 *   （Inspect 可读、有 description），且是全宿主**唯一**的部署默认模型写入点
 *   （全树只有 2 个调用点：`selectModel` 与 `initializeDefaultModel`）。
 * - 本文件的做法：在该服务的**原始实例**上加一个自有属性覆盖 `saveSelection`
 *   （只在我们自己的路由上短路，其余原样转发给**真原方法**），disposer 里 `delete` 还原。
 *   ⇒ 这是**方法级替换**，不是事件钩子。这一点在报告与 `/api/llm-adapter` 的
 *   `gate.mechanism` 字段里**明写**，不包装成「有官方钩子」。
 * - **装不上就不注册路由**：若需要闸门却装不上（找不到 `saveSelection`、宿主 API 漂移），
 *   本文件**不注册** `pilot-cli`，并把原因如实回报（用户的授权是**有条件的**：
 *   没有这个闸门就不做 Path A）。
 *
 * ## 未确定 / 未验证（不得当成已确证）
 * - 是否有**其它**路径能把 `pilot-cli` 写进部署默认值（例如设置页某个「设为默认」按钮）：
 *   **未查**。闸门只覆盖 `agentDefaultModel.saveSelection` 这一条（已确证它是选择器那条路径）。
 * - 本机 profile 之外的 profile（headless / web）是否挂了 `dsh-llm/invariant`：**未查**；
 *   本文件按严格语法写，正是为了不依赖「没挂」这件事。
 * - 若另一个插件也替换同一个方法，谁赢取决于顺序：**未验证**（已用 `Symbol.for` 标记做幂等，
 *   但跨插件无法协调）。
 * - 请求层改道依赖两条**没有写进契约**的宿主面：`agent/request` 的 `payload.agent.id`，以及
 *   `ctx.sessions.get(id)` 上的 `seq` / `eventAt(seq)`（只读会话日志，用来区分「用户显式选过
 *   `pilot-cli`」与「本插件改道残留」）。宿主实现若变，判定退化成「读不到 ⇒ 保持不动」
 *   （fail-safe：不会误改请求，但「选择器让路」与「残留恢复」会失效）。可见于
 *   `/llm-adapter` 的 `requestLayer.picks.readable === false`。
 * - **live 证据覆盖三条分支**（2026-10-13 22:43–22:45，本轮补第三条）：
 *   ① 「绑定 → 宿主路由 → 改道」与 ② 「解除绑定 → 残留恢复」用真实轮次 + 宿主落盘转录取证；
 *   ③ 「绑定之后用户又显式选过模型 ⇒ 让路」也做了 live 实测：绑定 `opencode`，再走**真实**
 *   `ctx.sessionController.selectModel` 选 `pilot-cli/qoderclicn`，然后开一轮 ——
 *   `requestLayer.heldPicks` 0→1、`rewrites` 不变，会话日志落到 `pilot-cli/qoderclicn`
 *   （**不是**绑定目标 `opencode`）。判据与命令见 `probe/verify-llm-adapter-request-layer.mjs`。
 * - **UI 仍未在浏览器里确认**：`client/client.js` 的新文案只做过离线渲染断言，没有截图证据。
 * - **界面/说明文案的机制名已同步**（2026-10-13 22:5x，本轮）：`client/client.js` 的选择器座位句
 *   与 `src/federation/binding.ts` 的 `scopeNoteFor` 原来写着「绑定驱动的 `llm/stream` 改道已生效」——
 *   改道搬到请求层之后那句就是**假话**，两处都已改写为「请求层 `agent/request` 改写」。
 * - **`purpose` 辅助调用：旧版本会被跟着带进外部 CLI，本轮已加护栏修掉**（实测，不是推断）：
 *   宿主按「会话最后一次 `request/header` 的路由」解析辅助调用的目标
 *   （`dsh-session-title:344/424`、`dsh-compaction-basic:293`），而那条路由已被本插件改写成
 *   `pilot-cli` ⇒ 加护栏之前，**改道过的会话里会话标题 / 压缩会跟着跑到外部 CLI 并消耗它的额度**。
 *   现在的两道护栏见下面「purpose guard」一节（`installAuxScopeGuard`）：会话标题在
 *   `sessionTitle.startProvider` 漏斗处就把 route 换成 `ctx.agentDefaultModel` 的当前原生默认选择；
 *   压缩这类直接 `ctx.llm.stream` 的辅助调用在 `llm/stream` 上被**就地改写**（只改 options、只 `next()` 一次）。
 *   证据：`probe/verify-llm-adapter-aux-scope.mjs`（读宿主落盘转录 + 本适配器自己的派发条数）。
 *   ⚠️ 会话标题那道护栏是 `sessionTitle.startProvider` 的**方法级替换**（内部方法，不在 Inspect 契约里），
 *   装不上时如实报 `auxScope().sessionTitle.status === 'failed'`，**行为退回加护栏之前**。
 *
 * ## 回滚（两步，见报告）
 * 1. 禁用本插件（路由随 fiber 销毁，选择器分组下一轮 `llm/adapters-updated` 后消失）；
 * 2. 确认部署默认模型**不是** `pilot-cli`（否则新会话每轮 `NO_ADAPTER`）。
 */
/** 本适配器拥有的路由名。**全宿主唯一**，撞名会在注册时抛 `DUPLICATE_ADAPTER`。 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { filterPickerModels, } from './model-visibility.js';
import { CLI_DEFAULT_MODEL_ID, mergeHarnessModels, providerSpecFor, } from './harness-llm.js';
export const ROUTE = 'pilot-cli';
/**
 * **首建目录**等待模型发现的**总预算**（毫秒，全局一个截止时刻）。
 *
 * 语义：`listModels` 会等 `awaitModelsFor` 那条**整轮预热**；超过这个时间就退回同步缓存清单，
 * 绝不让一次目录构建被某条卡住的 CLI 拖死。
 * ⚠️ 它必须由提供方（`src/index.ts`）统一把握：宿主逐 provider 建目录，
 * 若每个 provider 各自竞速，第一个被建的会先超时（实测 `harness-antigravity` 只剩 1 个模型）。
 */
export const MODEL_AWAIT_BUDGET_MS = 20_000;
/**
 * 当前生效的「自有路由」集合（`pilot-cli` + 每个 harness 一条 provider）。
 *
 * ⚠️ 2026-10-14 起不再只有 `pilot-cli`：为了让**宿主的 provider 分组**就等价于
 * 「按 harness 折叠」（宿主没有任何组级折叠原语，见 `src/harness-llm.ts` 文件头），
 * 每个 harness 分组各注册一条 provider（`harness-qoder-cn` / `harness-claude-code` …）。
 *
 * 这个集合必须**动态**：三处判据都以它为准 ——
 *   ① 闸门：不许把**任何**自有路由写进用户的部署默认模型（用户明确要求不得改它）；
 *   ② purpose guard：辅助调用（会话标题/压缩）不得跑进外部 CLI；
 *   ③ 请求层判定：认得出「本来就在自有路由上」（不许当成宿主路由去改道/恢复）。
 * 注册时由 `registerPilotCli` 依据 deps 写入**一次**；未注册时退回只含 `ROUTE`。
 */
let activeOwnedRoutes = [ROUTE];
/** 读取当前生效的自有路由集合。 */
export function ownedRoutes() {
    return activeOwnedRoutes;
}
/** 这个 provider 是不是本插件的自有路由。 */
export function isOwnedRoute(provider) {
    return typeof provider === 'string' && activeOwnedRoutes.includes(provider);
}
/** 写入当前生效集合（**唯一**写入点）。 */
export function setOwnedRoutes(routes) {
    const unique = [...new Set(routes.filter((route) => route.length > 0))];
    activeOwnedRoutes = unique.length > 0 ? unique : [ROUTE];
}
/** 历史常量：**基础**自有路由。新代码请用 `ownedRoutes()` / `isOwnedRoute()`。 */
export const OWNED_ROUTES = [ROUTE];
/** `Symbol.for` 是**注册表全局**符号：跨模块实例也相等（cordis:36-38 用的就是 `Symbol.for`）。 */
const GATE_MARK = Symbol.for('dsh.harness-pilot.pilot-cli-default-model-gate');
/** 一次性标记：本插件**已经**把这个 options 改写过了（防「改写后的对象又回到本监听器」）。 */
const AUX_MARK = Symbol.for('dsh.harness-pilot.aux-scope-rewritten');
/** `sessionTitle.startProvider` 方法级替换的幂等标记（与闸门同一套做法）。 */
const TITLE_MARK = Symbol.for('dsh.harness-pilot.session-title-aux-route');
/** 单块 / 整体的字符上限（保护 CLI，不静默丢弃 —— 截断会留下明确标记）。 */
const MAX_BLOCK_CHARS = 40_000;
const MAX_TOTAL_CHARS = 400_000;
/** 这条文案必须与用户可见的界面文案一致（见报告里的 handoff 项）。 */
export const COST_DISCLOSURE = '经 pilot-cli 路由产生的轮次里，**DSH 自己的工具完全不会执行**：适配器只产出 text 块、从不产出 tool-call 块，'
    + '而 DSH 的工具执行由「assistant 消息里出现 tool-call 块」触发（dsh-agent-loop/lib/index.js:1151-1155）'
    + '⇒ executeToolCalls 从不被调用。外部 CLI 自己的工具照常工作，但跑在 CLI 自己的沙箱里，'
    + 'DSH 的审批 / fs 沙箱 / spill / 保留策略看不到它们。**不要把「切过去」理解成「工具照常可用」。**'
    + '另外 DSH 的工具 schema 只是被渲染进 CLI 的 prompt 当说明文字，下游没有任何东西强制它们。';
// ── 选择槽的组合 id（模型选择的最小实现）──────────────────────────────
//
// 两条路由形态并存（2026-10-14 起）：
//   · **`pilot-cli`（历史/内部）**：model 槽 = **目标名**，或 `目标名::模型`。绑定驱动改道、
//     团队成员冻结配方、以及既有 profile 的 `allowedModels` 都还用它。
//   · **`harness-<key>[-<region>]`（新，面向上用户）**：model 槽 = **该 harness 自己的模型 id**
//     （或保留值 `cli-default`）。一个 harness 一条 provider ⇒ 宿主原生菜单里就是
//     「一个 harness 一个分组」，展开即是它的**全部**模型（`src/harness-llm.ts`）。
// 旧注释里「为什么用组合 id 而不是多 provider」的取舍，本轮按用户要求反转：宿主的折叠粒度只能是
// provider，`OWNED_ROUTES`/闸门/purpose guard 已全部改成**动态集合**（见上）。
export const MODEL_CHOICE_SEP = '::';
/** 会话模型菜单里每目标的默认上限（`sessionModelLimit` 未提供时用它）。 */
export const SESSION_MODEL_LIMIT_FALLBACK = 10;
/** 每个目标最多向选择器宣传多少个真实模型（扁平列表的可读性上限；不影响实际可用模型）。 */
/** Native picker supports search. Never truncate a CLI's selectable catalog. */
export const MAX_MODELS_PER_TARGET = SESSION_MODEL_LIMIT_FALLBACK;
/** 把选择槽解析成（目标名，模型 | undefined）。不校验存在性 —— 校验在 stream，那里才能给可读错误。 */
export function splitModelChoice(id) {
    const at = id.indexOf(MODEL_CHOICE_SEP);
    return at < 0
        ? { target: id, model: undefined }
        : { target: id.slice(0, at), model: id.slice(at + MODEL_CHOICE_SEP.length) };
}
/** 逆向：目标名 + 模型 ⇒ 选择槽 id。 */
export function composeModelChoice(target, model) {
    return target + MODEL_CHOICE_SEP + model;
}
function asText(value) {
    return typeof value === 'string' ? value : '';
}
function clip(text, limit) {
    if (text.length <= limit)
        return text;
    return `${text.slice(0, limit)}\n[…pilot-cli 适配器截断了 ${text.length - limit} 个字符；原文更长]`;
}
/** 把一条消息的一个 content block 渲染成纯文本。未知块**如实写出类型**，不静默吞掉。 */
function renderBlock(block) {
    if (typeof block === 'string')
        return block;
    if (block === null || typeof block !== 'object')
        return '';
    const record = block;
    switch (record.type) {
        case 'text':
            return asText(record.text);
        case 'image': {
            const attachment = record.attachment;
            return `[图片：${asText(attachment?.name) || asText(attachment?.mediaType) || '未命名'}；本适配器不传图，图片内容对 CLI 不可见]`;
        }
        case 'file': {
            const attachment = record.attachment;
            return `[文件：${asText(attachment?.name) || '未命名'}（${String(attachment?.bytes ?? '?')} 字节）；本适配器不传文件内容]`;
        }
        case 'tool-call':
            return `<tool-call name="${asText(record.name)}" arguments="${clip(asText(record.arguments), 2_000)}"/>`;
        case 'tool-addition':
            return `[工具新增：${asText(record.toolName)}]`;
        case 'tool-removal':
            return `[工具移除：${asText(record.toolName)}]`;
        case 'reasoning':
            // 历史推理对本轮无因果作用；不计入 prompt（避免把 CLI 的上下文吃满）。
            return '';
        default:
            return `[不支持的块类型：${String(record.type)}]`;
    }
}
/**
 * 把 DSH 的 `GenerateOptions` 渲染成**一次 CLI 调用的 prompt**。
 *
 * 这是适配器自己的渲染（契约允许：`messages`/`system`/`tools` 对适配器只是输入，
 * 见 llm-adapter-contract.md §4.4）。渲染是**显式**的：工具 schema 会被列出来当说明，
 * 并明写「DSH 不会执行它们」。
 */
export function renderPrompt(options) {
    const parts = [];
    const system = asText(options.system);
    if (system.trim().length > 0) {
        parts.push('# 系统提示（DSH 提供，原样转达）\n' + system);
    }
    const messages = Array.isArray(options.messages) ? options.messages : [];
    const turns = [];
    for (const raw of messages) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const message = raw;
        const role = asText(message.role) || 'unknown';
        const content = message.content;
        const blocks = Array.isArray(content) ? content : [content];
        const body = blocks.map(renderBlock).filter((piece) => piece.length > 0).join('\n');
        if (body.trim().length === 0)
            continue;
        const toolCallId = asText(message.toolCallId);
        const isError = message.isError === true;
        const header = role === 'tool'
            ? `## tool${toolCallId.length > 0 ? ` (call ${toolCallId})` : ''}${isError ? ' [error]' : ''}`
            : `## ${role}`;
        turns.push(`${header}\n${role === 'tool' ? `<tool-result>\n${body}\n</tool-result>` : body}`);
    }
    if (turns.length > 0)
        parts.push('# 对话\n' + turns.join('\n\n'));
    const tools = Array.isArray(options.tools) ? options.tools : [];
    if (tools.length > 0) {
        const list = tools.map((raw) => {
            const tool = (raw ?? {});
            const name = asText(tool.name);
            const description = asText(tool.description).replace(/\s+/g, ' ').slice(0, 300);
            return `- ${name}: ${description}`;
        }).join('\n');
        parts.push('# 调用方环境里存在的工具（**仅供你了解上下文，调用它们不会有任何效果**）\n'
            + list
            + '\n\n⚠️ 本通道**没有 DSH 的工具协议**：上面列出的**是 DSH 自己的工具**，DSH 不会执行上述任何工具，你也不要把它们当作可调用的函数。'
            + '请只用自然语言回答；需要动手时，明确请操作者在本机执行。'
            + '\n（**例外**：如果你这个进程另外被注入了 MCP server 的工具 —— 例如启动参数里有 `--mcp-config`，'
            + '工具名形如 `mcp__<server>__<tool>` —— 那是**另一条真实通道**：那些工具**可以正常调用**，'
            + '调用**有真实效果**，结果由该 MCP server 返回。桥接注入的就是这一类。）');
    }
    if (asText(options.purpose).length > 0) {
        parts.push(`# 本次调用用途：${asText(options.purpose)}（辅助调用，不是用户的一轮对话）`);
    }
    const full = parts.join('\n\n---\n\n');
    return clip(full, MAX_TOTAL_CHARS);
}
export class PilotCliError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = 'PilotCliError';
        this.code = code;
    }
}
/**
 * 一次派发结果 → **严格闭合**的 chunk 序列。
 *
 * 纪律（为什么这样写）：
 * - `block-start` 先于任何 delta（严格语法要求同类型的开块存在）；
 * - 只产出 text 块 ⇒ **绝不触发 DSH 的工具执行**（这是固有代价，不是 bug）；
 * - **不产出 usage**：外部 CLI 的真实 token 数我们不知道，**不许编**；
 * - 终止恰好一个 `finish`；错误/中止走 reason，不走「异常 chunk」（协议里没有那种东西）；
 * - 空回复**不算成功**：`stopReason=completed` 但正文为空 ⇒ 报 `PILOT_CLI_EMPTY` 错误。
 *   （「退出码 0 / 界面显示完成」都不等于拿到了回复 —— 本项目反复栽在这上面。）
 */
export function buildChunks(input) {
    const chunks = [];
    const text = input.text;
    if (text.length > 0) {
        chunks.push({ type: 'block-start', index: 0, blockType: 'text' });
        chunks.push({ type: 'text-delta', index: 0, text });
        chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } });
    }
    const diagnostic = (input.diagnostic ?? '').trim();
    const suffix = diagnostic.length > 0 ? ` — ${diagnostic}` : '';
    const failureOf = (code, message) => ({ kind: 'error', failure: { message, code } });
    if (input.stopReason === 'aborted') {
        chunks.push({
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: `pilot-cli: ${input.target} 被调用方取消${suffix}`, code: 'ABORTED' } },
        });
        return chunks;
    }
    if (input.stopReason === 'timeout') {
        chunks.push({ type: 'finish', reason: failureOf('PILOT_CLI_TIMEOUT', `pilot-cli: ${input.target} 超时${suffix}`) });
        return chunks;
    }
    if (input.stopReason !== 'completed') {
        chunks.push({ type: 'finish', reason: failureOf('PILOT_CLI_TRANSPORT', `pilot-cli: ${input.target} 派发失败（stopReason=${input.stopReason}）${suffix}`) });
        return chunks;
    }
    if (text.trim().length === 0) {
        chunks.push({
            type: 'finish',
            reason: failureOf('PILOT_CLI_EMPTY', `pilot-cli: ${input.target} 报 completed，但**回复为空** —— 按失败处理（退出码 0 / 界面显示完成都不等于拿到了回复）${suffix}`),
        });
        return chunks;
    }
    chunks.push({ type: 'finish', reason: { kind: 'stop' } });
    return chunks;
}
/**
 * 闸门判定：**只**拦本插件自己的路由。
 *
 * 纯函数，便于离线断言与线上自检共用同一份判定；未知形状一律**转发**（fail-open 到原实现，
 * 因为被挡住的写入是宿主自己的合法行为，而我们对未知形状一无所知 —— 宁可不动）。
 */
export function gateDecisionFor(provider, owned = ownedRoutes()) {
    return typeof provider === 'string' && owned.includes(provider) ? 'block' : 'delegate';
}
/**
 * 改道判定（第 3 步的规则集；**现在只被请求层复用**，见 `requestRouteDecisionFor`）。
 *
 * ⚠️ 它原来服务的是 `llm/stream` 上的响应层短路监听器 —— **那个监听器已移除**
 * （响应层的产出无法被诚实归因）。`purpose` 这一条保留下来，是因为请求层的判定里
 * `purpose` 恒为 `undefined`（agent loop 的一轮从不带 purpose），需要它把「辅助调用不进改道」
 * 这件事在离线判据里固定住。
 *
 * 规则（每条都有理由）：
 * - `options.provider === ROUTE` ⇒ `next`：本来就是我们自己的路由，**不**改道（否则会自己套自己）。
 * - `options.purpose !== undefined` ⇒ `next`：压缩 / 会话标题这类辅助调用**不由本插件改写**
 *   （它们不走 `agent/request`）。⚠️ 但这**不等于**它们落在宿主供应商上：宿主按会话最后一次
 *   `request/header` 的路由解析它们，而那条路由可能已被改道成 `pilot-cli` —— 实测见
 *   `probe/verify-llm-adapter-aux-scope.mjs`。
 * - 没有 `sessionId` 或没有绑定 ⇒ `next`。
 * - 绑定必须是 `harnessKind === 'external'`（`dsh` / 空 = native = 明确要求留在 DSH）。
 * - 绑定目标必须在**可宣传**集合里（否则会拿一个 CDP/窗口级目标去做一次性 headless 派发）。
 */
export function routeDecisionFor(input) {
    // 本来就在**本插件的任何一条**路由上（`pilot-cli` 或某个 `harness-*`）⇒ 不改道。
    // 2026-10-14 起是动态集合：多 provider 之后只认字面量 `pilot-cli` 会把用户显式选的
    // harness 路由当成宿主路由，进而被绑定改道覆盖（那是「选了没用」）。
    if (isOwnedRoute(input.provider))
        return { action: 'next', reason: 'already-own-route' };
    if (input.purpose !== undefined)
        return { action: 'next', reason: 'auxiliary-call-purpose-stays-on-host' };
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0)
        return { action: 'next', reason: 'no-session-id' };
    const binding = input.binding;
    if (binding === undefined)
        return { action: 'next', reason: 'no-binding' };
    if (binding.harnessKind !== 'external')
        return { action: 'next', reason: 'binding-is-native' };
    const target = typeof binding.harnessId === 'string' ? binding.harnessId : '';
    if (target.length === 0)
        return { action: 'next', reason: 'binding-has-no-harness' };
    if (!input.advertised.includes(target))
        return { action: 'next', reason: `bound-target-not-advertised:${target}` };
    return { action: 'route', reason: 'binding-external', target };
}
/**
 * 折叠 `model/selection` 事件（纯函数）。
 *
 * 这是**唯一**能区分「用户显式选了 pilot-cli」与「本插件改道留下的路由」的持久记录：
 * - `session.requestHeader()` 只记最后用过的路由，两种情况一模一样；
 * - `sessionProjections` 的 `modelSelection` 视图把已消费的选择并进 `lastUsed`，同样分不出来
 *   （`dsh-api-session-controller/lib/index.js:2072-2088`）。
 * `model/selection` 只由 `selectForNextRequest` 追加（= 选择器那条路，`:319-322`）。
 */
export function foldExplicitPicks(events, from) {
    let pick = from.pick;
    let seq = from.seq;
    for (const event of events) {
        seq += 1;
        if (event === null || typeof event !== 'object' || event.type !== 'model/selection')
            continue;
        const data = event.data;
        const provider = data?.provider;
        const model = data?.model;
        if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0)
            continue;
        pick = { provider, model, time: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0 };
    }
    return { seq, pick };
}
/** 绑定是否指向一个**外部** Harness（有名字且不是原生 dsh）。 */
function isExternalBinding(binding) {
    return binding !== undefined
        && binding.harnessKind === 'external'
        && typeof binding.harnessId === 'string'
        && binding.harnessId.length > 0;
}
/**
 * 请求层改道判定（纯函数，运行期**同一份**实现）。
 *
 * 与响应层的 `routeDecisionFor` 共用「绑定 → 可宣传目标」那几条规则，另外加了三条请求层独有的：
 * 选择器优先、`reasoningEffort` 必须丢、无绑定时的残留恢复。
 */
export function requestRouteDecisionFor(input) {
    const provider = input.resolved?.provider;
    const model = input.resolved?.model;
    const advertised = input.advertised;
    const external = isExternalBinding(input.binding);
    const target = typeof input.binding?.harnessId === 'string' ? input.binding.harnessId : '';
    const targetAdvertised = external && advertised.includes(target);
    const pick = input.lastPick ?? null;
    const setAtRaw = typeof input.binding?.setAt === 'string' ? Date.parse(input.binding.setAt) : Number.NaN;
    // 绑定没有可解析的时间戳时按 0 处理 ⇒ 任何一次显式选择都算「更新」⇒ 听选择器的。
    const bindingTime = Number.isFinite(setAtRaw) ? setAtRaw : 0;
    // ① 绑定之后用户又显式选过模型 ⇒ 选择器说了算（不改道；也不恢复残留）。
    if (pick !== null && pick.time > bindingTime) {
        return { action: 'next', reason: `picker-picked-after-binding:${pick.provider}/${pick.model}` };
    }
    // ② 请求已经在本插件的**任意一条**路由上（`pilot-cli` 或某个 `harness-*`）。
    if (isOwnedRoute(provider)) {
        // ⚠️ 绑定驱动改道**只**对历史路由 `pilot-cli` 生效：那条路由是**本插件自己**改写出来的，
        // 绑定变了要跟着改目标。`harness-*` 是**用户在原生选择器里点出来的**，改它就是「选了没用」。
        if (provider === ROUTE && targetAdvertised) {
            if (model === target)
                return { action: 'next', reason: 'own-route-binding-active' };
            return {
                action: 'rewrite',
                reason: 'own-route-binding-target-changed',
                target,
                selection: { provider: ROUTE, model: target },
            };
        }
        // 显式选择过本路由（且就是当前这个模型）⇒ 这是 Path A，保持。
        if (pick !== null && pick.provider === provider && pick.model === model) {
            return { action: 'next', reason: 'own-route-explicit-pick' };
        }
        // ①c **子代理会话里显式委托的路由**：调用方点名的，不是我们的残留 ⇒ 保持。
        //     位置纪律：这一条**必须**在下面的「残留恢复」之前 —— 否则子代理会把外部 harness
        //     换成部署默认模型（2026-10-14 实测缺陷；证据与判据见 `RequestDecisionInput.sessionOrigin`）。
        //     为什么不用「有显式选择」代替：委托走的是 `agentOptions`，**不写** `model/selection`
        //     事件；会话归属（origin）是这里唯一可读的持久证据。
        if (input.sessionOrigin === 'subagent') {
            return { action: 'next', reason: 'own-route-subagent-delegation-kept' };
        }
        // ⚠️ 「残留恢复」**只**适用于 `pilot-cli`：那条历史路由可能被我们改写后又被解除绑定而残留。
        // `harness-*` 只可能来自用户/选择器的显式点名，永远不是残留 ⇒ 保持（否则会把用户选的
        // 外部 harness 静默换回宿主模型）。
        if (provider !== ROUTE)
            return { action: 'next', reason: 'own-harness-provider-kept' };
        // 读不到会话日志 ⇒ 绝不恢复（分不清「显式选择」与「我们的残留」，宁可留着）。
        if (input.picksReadable !== true)
            return { action: 'next', reason: 'own-route-keep-picks-unreadable' };
        // 绑定了外部目标、但它当前不可派发 ⇒ 也**不**恢复：让适配器响亮报错，
        // 而不是「界面说绑定、实际跑宿主模型」（那种沉默替换正是不实）。
        if (external)
            return { action: 'next', reason: `own-route-bound-target-not-advertised:${target}` };
        const fallback = input.defaultSelection;
        if (typeof fallback?.provider === 'string' && fallback.provider.length > 0 && fallback.provider !== ROUTE
            && typeof fallback.model === 'string' && fallback.model.length > 0) {
            return {
                action: 'restore',
                reason: 'own-route-residue-restore',
                selection: {
                    provider: fallback.provider,
                    model: fallback.model,
                    ...(typeof fallback.reasoningEffort === 'string' && fallback.reasoningEffort.length > 0
                        ? { reasoningEffort: fallback.reasoningEffort }
                        : {}),
                },
            };
        }
        return { action: 'next', reason: 'own-route-keep-no-default' };
    }
    // ③ 宿主路由 + 绑定生效 ⇒ 改写成本插件路由（**请求本身**从此带真实来源）。
    const bindingDecision = routeDecisionFor({
        provider,
        // 请求层：agent loop 的一轮**从不带 purpose**（purpose 只出现在压缩 / 会话标题这类直接
        // `llm.stream` 调用上，它们不经过 agent/request）。
        purpose: undefined,
        sessionId: input.sessionId,
        binding: input.binding,
        advertised,
    });
    if (bindingDecision.action === 'route' && bindingDecision.target !== undefined) {
        return {
            action: 'rewrite',
            reason: bindingDecision.reason,
            target: bindingDecision.target,
            selection: { provider: ROUTE, model: bindingDecision.target },
        };
    }
    return { action: 'next', reason: bindingDecision.reason };
}
/**
 * 把判定结果落到 config 上（纯函数）。
 *
 * `dropReasoningEffort` 只在改道时开：外部 CLI 的推理档位不是 DSH 的 effort，
 * 且适配器没声明 reasoning ⇒ 留着会被 `dsh-llm` 判成 `UNSUPPORTED_REASONING_EFFORT`。
 */
export function applyRequestSelection(resolved, selection, dropReasoningEffort) {
    const base = (resolved !== null && typeof resolved === 'object' ? { ...resolved } : {});
    base.provider = selection.provider;
    base.model = selection.model;
    if (dropReasoningEffort)
        delete base.reasoningEffort;
    else if (selection.reasoningEffort !== undefined)
        base.reasoningEffort = selection.reasoningEffort;
    return base;
}
/**
 * 从 `ctx.agentDefaultModel.currentSelection()` 的返回值里取出可用路由。
 *
 * 三条拒绝规则（都要计数，不许静默）：
 * - 不是 `{provider, model}` 形状（服务没挂 / API 漂移 / 读到 `undefined`）⇒ 读不到；
 * - provider 或 model 是空串 ⇒ 读不到；
 * - provider ∈ 本插件自有路由 ⇒ **不许把自己指给自己**（闸门保证部署默认模型不会被写成
 *   `pilot-cli`，但真出现时这里必须拒绝，否则就是把辅助调用从一条死路换到另一条死路）。
 */
export function nativeSelectionOf(value) {
    const record = (value ?? {});
    const provider = record.provider;
    const model = record.model;
    if (typeof provider !== 'string' || provider.length === 0)
        return undefined;
    if (typeof model !== 'string' || model.length === 0)
        return undefined;
    if (isOwnedRoute(provider))
        return undefined;
    return { provider, model };
}
/**
 * `llm/stream` 辅助调用判定（纯函数，运行期**同一份**实现）。
 *
 * 规则顺序即优先级，每条都有理由：
 * 1. `purpose === undefined` ⇒ `next`：**用户的轮次一律不碰**（主会话选择不变，1.3 不受影响）；
 * 2. `marked` ⇒ `next`：本插件已改写过的对象又回到这里（＝发生了我们没设计过的重入）；计数并放行。
 *    这一条必须排在 provider 判定**之前** —— 我们改写后的对象 provider 已经不再是本插件路由，
 *    排在后面就永远不可达（那会让「重入观测」变成一个恒为 0 的假计数器）；
 * 3. `provider !== ROUTE` ⇒ `next`：本来就不在本插件路由上，**不是我们的污染，我们不接手**；
 * 4. 原生默认选择读不到 / 就是本插件路由 ⇒ `next`：**没有可去的宿主供应商**，宁可保持原样
 *    （改前行为）也不猜一个；
 * 5. `frozen` ⇒ `next`：冻结对象改不了 ⇒ 放行并计数（**不许**抛，也不许复制出一份偷偷派发）；
 * 6. 其余 ⇒ `rewrite`：就地改成原生默认选择。
 */
export function auxScopeDecisionFor(input) {
    if (input.purpose === undefined)
        return { action: 'next', reason: 'main-turn-has-no-purpose' };
    if (input.marked === true)
        return { action: 'next', reason: 'aux-already-marked-rewritten' };
    if (input.provider !== ROUTE)
        return { action: 'next', reason: 'aux-not-on-own-route' };
    const selection = nativeSelectionOf(input.defaultSelection);
    if (selection === undefined)
        return { action: 'next', reason: 'native-default-unreadable-or-own-route' };
    if (input.frozen)
        return { action: 'next', reason: 'aux-options-frozen-cannot-rewrite-in-place' };
    return { action: 'rewrite', reason: 'aux-rewritten-to-native-default', selection };
}
/**
 * `sessionTitle.startProvider` 的 route 判定（纯函数）。
 *
 * 三种情形：route 不是 `{provider, model}` 形状 / provider 不是本插件路由 / 原生默认读不到
 * ⇒ **原样返回**（`changed:false`）；只有「route 正是被本插件改道成 `pilot-cli` 的那条」
 * 才换成原生默认选择。**幂等**：换过之后 provider 不再是 `pilot-cli`，再进来必然不改。
 */
export function auxRouteOverrideFor(route, defaultSelection) {
    const record = (route ?? {});
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') {
        return { changed: false, reason: 'route-absent-or-odd-shape', route };
    }
    if (record.provider !== ROUTE)
        return { changed: false, reason: 'route-not-on-own-route', route };
    const selection = nativeSelectionOf(defaultSelection);
    if (selection === undefined)
        return { changed: false, reason: 'native-default-unreadable-or-own-route', route };
    return { changed: true, reason: 'route-overridden-to-native-default', route: { ...selection }, selection };
}
/**
 * 就地改写一个**未冻结**的 options 对象：换 provider/model、丢掉显式 `reasoningEffort`、
 * 打上一次性标记。
 *
 * - 丢 `reasoningEffort`：与请求层改道同一条理由 —— 辅助调用的 effort 是**为原来那条路由**表达的，
 *   换路由后留着可能被 `dsh-llm` 判 `UNSUPPORTED_REASONING_EFFORT`（`dsh-llm:2177-2178`）；
 *   我们**不替宿主模型声称**任何档位（适配器默认档位由宿主自己materialize）。
 * - 标记用 `defineProperty` 且 `enumerable:false`：不会被展开/序列化带走，只服务于「重入观测」。
 *
 * @returns 实际发生的动作（便于计数与取证）。
 */
export function applyAuxSelectionInPlace(options, selection) {
    if (options === null || typeof options !== 'object')
        return { ok: false, droppedReasoningEffort: false, error: 'options-is-not-an-object' };
    try {
        const record = options;
        record.provider = selection.provider;
        record.model = selection.model;
        let dropped = false;
        if ('reasoningEffort' in record) {
            delete record.reasoningEffort;
            dropped = true;
        }
        Object.defineProperty(record, AUX_MARK, { value: true, writable: true, enumerable: false, configurable: true });
        return { ok: true, droppedReasoningEffort: dropped };
    }
    catch (error) {
        return { ok: false, droppedReasoningEffort: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/** 一个已改写对象是否带着本插件的一次性标记。 */
function auxMarked(options) {
    if (options === null || typeof options !== 'object')
        return false;
    try {
        return options[AUX_MARK] === true;
    }
    catch {
        return false;
    }
}
/** 哈希一个文件（读不到返回 `null`）；只用于「profile 有没有被改写」的证据，**不返回内容**。 */
export function hashFileOrNull(file) {
    try {
        return createHash('sha256').update(readFileSync(file)).digest('hex');
    }
    catch {
        return null;
    }
}
/**
 * 前后两次观测的对比。哈希**与** mtime 都要一致才算没被改写 ——
 * 只看哈希会漏掉「内容相同但文件被重写」（writeFileAtomic 走 rename，mtime 一定变）。
 */
export function compareProfileSnapshots(before, after) {
    const rows = before.map((file, index) => {
        const next = after[index];
        const comparable = file.hash !== null && next !== undefined && next.hash !== null;
        return {
            role: file.role,
            path: file.path,
            hashBefore: file.hash,
            hashAfter: next?.hash ?? null,
            mtimeBefore: file.mtime,
            mtimeAfter: next?.mtime ?? null,
            comparable,
            changed: comparable ? file.hash !== next?.hash || file.mtime !== next?.mtime : null,
        };
    });
    const comparableRows = rows.filter((row) => row.comparable === true);
    return { rows, unchanged: comparableRows.length > 0 && comparableRows.every((row) => row.changed === false) };
}
/** 文件 mtime（毫秒字符串）；读不到返回 `null`。哈希+mtimes 一起看，识别「内容相同但被重写」。 */
export function mtimeOrNull(file) {
    try {
        return String(statSync(file).mtimeMs);
    }
    catch {
        return null;
    }
}
/** 沿原型链找属性描述符（不 import cordis 的 `getPropertyDescriptor`，保持零依赖）。 */
function prototypeMethodOf(target, name) {
    let cursor = target;
    while (cursor !== null) {
        const descriptor = Reflect.getOwnPropertyDescriptor(cursor, name);
        if (descriptor !== undefined) {
            return typeof descriptor.value === 'function' ? descriptor.value : undefined;
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    return undefined;
}
/**
 * 装闸门。**返回 `status !== 'armed'` 时调用方必须据此决定是否注册路由。**
 *
 * 两种「不需要闸门」的情形（此时该状态是**结论**，不是偷懒）：
 * - `ctx.agentDefaultModel` 未挂载 ⇒ 没有这个服务，选择器那条路径根本不存在；
 * - `ctx.configEditor` 未挂载 ⇒ `saveSelection` 第二行就 `return`，**不可能**有任何 profile 写入。
 */
export function installDefaultModelGate(ctx, logger) {
    const state = {
        status: 'failed',
        reason: '未开始',
        baseIsPrototypeMethod: false,
        baseIdentity: '(unknown)',
        blocked: 0,
        delegated: 0,
        lastBlocked: null,
        lastDelegated: null,
        installedAt: null,
    };
    const snapshot = (profilePath) => ({
        status: state.status,
        reason: state.reason,
        mechanism: '方法级替换：在 ctx.agentDefaultModel 的**原始实例**上定义自有属性 saveSelection，仅当 provider ∈ 本插件自有路由时短路（不进入 configEditor.edit），其余原样转发给原型链上的真原方法；随 fiber 销毁 delete 还原',
        service: 'agentDefaultModel',
        method: 'saveSelection',
        ownedRoutes: ownedRoutes(),
        baseIsPrototypeMethod: state.baseIsPrototypeMethod,
        baseIdentity: state.baseIdentity,
        profilePath,
        blocked: state.blocked,
        delegated: state.delegated,
        lastBlocked: state.lastBlocked,
        lastDelegated: state.lastDelegated,
        installedAt: state.installedAt,
    });
    const configEditor = ctx.get?.('configEditor');
    const profilePath = typeof configEditor?.documentPath === 'string' ? configEditor.documentPath : null;
    if (configEditor === undefined) {
        state.status = 'not-needed';
        state.reason = 'ctx.configEditor 未挂载 ⇒ agentDefaultModel.saveSelection 在第 2 行就返回，**不可能**有任何 profile 写入';
        return { snapshot: () => snapshot(null), dispose: () => { } };
    }
    const service = ctx.get?.('agentDefaultModel');
    if (service === undefined) {
        state.status = 'not-needed';
        state.reason = 'ctx.agentDefaultModel 未挂载 ⇒ 该路径不存在，选择器不会写部署默认值';
        return { snapshot: () => snapshot(profilePath), dispose: () => { } };
    }
    // cordis 的服务访问返回 traceable **代理**；`Symbol.for('cordis.original')` 是它暴露原始实例的
    // 全局符号钩子（cordis:38,127）。拿不到就退化成直接在拿到的对象上定义（代理的 defineProperty
    // 陷阱不存在，会转发到原始实例，所以两种情形都落在**原始实例**上）。
    const ORIGINAL = Symbol.for('cordis.original');
    const raw = (service[ORIGINAL] ?? service);
    const marked = raw[GATE_MARK];
    const prototypeMethod = prototypeMethodOf(raw, 'saveSelection');
    const base = marked?.base ?? prototypeMethod;
    if (typeof base !== 'function') {
        state.status = 'failed';
        state.reason = '在 agentDefaultModel 上找不到 saveSelection 方法（宿主公开 API 可能已变）—— 需要闸门却装不上，**不注册路由**';
        return { snapshot: () => snapshot(profilePath), dispose: () => { } };
    }
    state.baseIsPrototypeMethod = prototypeMethod === base;
    state.baseIdentity = state.baseIsPrototypeMethod
        ? '与 Object.getPrototypeOf(agentDefaultModel).saveSelection 是同一个函数对象（非自有 provider 走真原实现）'
        : '当前方法已是别的包装（沿用其 base；可能是上一次 HMR 的包装尚未还原）';
    const wrapper = async function gatedSaveSelection(next) {
        const provider = next !== null && typeof next === 'object' ? next.provider : undefined;
        const model = next !== null && typeof next === 'object' ? next.model : undefined;
        if (gateDecisionFor(provider) === 'block') {
            state.blocked += 1;
            state.lastBlocked = {
                at: new Date().toISOString(),
                provider: String(provider),
                model: typeof model === 'string' ? model : '',
            };
            logger?.info?.(`harness-pilot: 已拦住把部署默认模型改写成 "${String(provider)}/${String(model)}" —— `
                + '选择本插件自有路由**不写 profile**（理由见 src/llm-adapter.ts 头部与 /harness-pilot/api/llm-adapter）');
            // 必须是 async（返回 Promise）：宿主调用点会 `.catch(...)`，返回 undefined 会 TypeError。
            return;
        }
        state.delegated += 1;
        state.lastDelegated = {
            at: new Date().toISOString(),
            provider: typeof provider === 'string' ? provider : typeof provider,
            model: typeof model === 'string' ? model : '',
        };
        return await base.apply(this, [next]);
    };
    Object.defineProperty(raw, 'saveSelection', {
        value: wrapper,
        writable: true,
        enumerable: false,
        configurable: true,
    });
    raw[GATE_MARK] = { base, wrapper };
    state.status = 'armed';
    state.reason = '已在 agentDefaultModel 上装上方法级闸门；仅拦 provider ∈ ' + JSON.stringify(ownedRoutes());
    state.installedAt = new Date().toISOString();
    const dispose = () => {
        try {
            const current = raw.saveSelection;
            if (current === wrapper)
                delete raw.saveSelection;
            const mark = raw[GATE_MARK];
            if (mark?.wrapper === wrapper)
                delete raw[GATE_MARK];
            state.status = 'failed';
            state.reason = 'disposer 已还原（插件被卸载 / 重载）';
        }
        catch (error) {
            logger?.warn?.(`harness-pilot: 还原 saveSelection 闸门失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    return { snapshot: () => snapshot(profilePath), dispose };
}
/**
 * 装 purpose guard。返回值的 `status` 必须被如实对外报出 ——
 * `sessionTitle.failed` 意味着**会话标题这条护栏没生效**，不得当成「已修」。
 */
export function installAuxScopeGuard(ctx, logger) {
    const ORIGINAL = Symbol.for('cordis.original');
    const streamState = {
        installed: false,
        entries: 0,
        auxEntries: 0,
        rewrites: 0,
        passThrough: 0,
        frozenSkips: 0,
        nextCalls: 0,
        errors: 0,
        maxSyncDepth: 0,
        markedReentries: 0,
        lastDecision: null,
        lastError: null,
    };
    const titleState = {
        status: 'failed',
        reason: '未开始',
        baseIsPrototypeMethod: false,
        baseIdentity: '(unknown)',
        calls: 0,
        overrides: 0,
        lastOverride: null,
        installedAt: null,
    };
    const defaultState = {
        raw: undefined,
        selection: undefined,
        reads: 0,
        failures: 0,
        lastError: null,
    };
    /**
     * 每次都**重新读**当前原生默认选择（用户要求「当前原生默认选择」，不是启动快照）。
     * 读不到（服务未挂 / API 漂移 / 抛错 / 形状不对）时 `selection === undefined` ⇒ 两道护栏都放行，
     * 但**一律计数并留原因**（静默失败会让「护栏没生效」看起来像「没有辅助调用」）。
     */
    const readNativeDefault = () => {
        defaultState.reads += 1;
        try {
            const service = ctx.get?.('agentDefaultModel');
            const raw = service?.currentSelection?.();
            defaultState.raw = raw;
            defaultState.selection = nativeSelectionOf(raw);
            if (defaultState.selection === undefined) {
                defaultState.failures += 1;
                defaultState.lastError =
                    `currentSelection() 返回的形状不可用：${raw === undefined ? 'undefined（服务未挂载或方法缺失）' : JSON.stringify(raw)}`;
            }
            else {
                defaultState.lastError = null;
            }
        }
        catch (error) {
            defaultState.raw = undefined;
            defaultState.selection = undefined;
            defaultState.failures += 1;
            defaultState.lastError = `currentSelection() 抛错：${error instanceof Error ? error.message : String(error)}`;
        }
        return defaultState.selection;
    };
    const recordOf = (entry, action, reason, purpose, from, to) => ({ at: new Date().toISOString(), entry, action, reason, purpose, from, to });
    // ── 护栏 ②：`llm/stream` 上的**改写式**监听器（只改 options，绝不产 chunk、绝不重新派发）──
    let syncDepth = 0;
    if (typeof ctx.on === 'function') {
        const listener = (options, next) => {
            streamState.entries += 1;
            syncDepth += 1;
            if (syncDepth > streamState.maxSyncDepth)
                streamState.maxSyncDepth = syncDepth;
            try {
                // ⚠️ 判定的 try/catch **只包判定**：它绝不能把 `next()` 也包进去 ——
                // 否则 `next()` 自己抛错时会被这里重试，变成**两次**派发。放行只有下面那一个点。
                try {
                    const record = (options ?? {});
                    const purpose = typeof record.purpose === 'string' ? record.purpose : null;
                    if (record.purpose !== undefined)
                        streamState.auxEntries += 1;
                    const decision = auxScopeDecisionFor({
                        provider: record.provider,
                        purpose: record.purpose,
                        frozen: options !== null && typeof options === 'object' ? Object.isFrozen(options) : false,
                        marked: auxMarked(options),
                        defaultSelection: readNativeDefault(),
                    });
                    const from = { provider: String(record.provider ?? ''), model: String(record.model ?? '') };
                    if (decision.action === 'rewrite' && decision.selection !== undefined) {
                        const applied = applyAuxSelectionInPlace(options, decision.selection);
                        if (applied.ok) {
                            streamState.rewrites += 1;
                            streamState.lastDecision = recordOf('llm/stream', 'rewrite', decision.reason, purpose, from, { ...decision.selection });
                            logger?.info?.(`harness-pilot: 辅助调用（purpose=${purpose ?? '(none)'}）原本会跑到 ${ROUTE}，已就地改写到`
                                + `宿主原生默认 ${decision.selection.provider}/${decision.selection.model}`
                                + `${applied.droppedReasoningEffort ? '（并丢掉显式 reasoningEffort）' : ''}；派发仍只有一次。`);
                        }
                        else {
                            streamState.errors += 1;
                            streamState.lastError = `${new Date().toISOString()} 就地改写失败：${applied.error ?? '(no reason)'}`;
                            logger?.warn?.(`harness-pilot: 辅助调用就地改写失败，已按原样放行：${streamState.lastError}`);
                        }
                    }
                    else {
                        streamState.passThrough += 1;
                        if (decision.reason === 'aux-options-frozen-cannot-rewrite-in-place')
                            streamState.frozenSkips += 1;
                        if (decision.reason === 'aux-already-marked-rewritten')
                            streamState.markedReentries += 1;
                        streamState.lastDecision = recordOf('llm/stream', 'next', decision.reason, purpose, from, null);
                    }
                }
                catch (error) {
                    // 判定自身出错时**原样放行**：绝不因为我们自己的 bug 改掉别人的请求。
                    streamState.errors += 1;
                    streamState.lastError = `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`;
                    logger?.warn?.(`harness-pilot: purpose guard 判定失败，已原样放行：${streamState.lastError}`);
                }
                // **唯一**的放行点：所有分支都恰好到这里一次 ⇒ 结构上不可能吞掉下游流。
                // ⚠️ `next()` 留在 `syncDepth` 的作用域**之内**：下游监听器若同步重新派发
                // （＝唯一可能的递归形状），下一次进入本监听器时深度会变成 2 —— 这正是那个计数器的牙。
                streamState.nextCalls += 1;
                return next();
            }
            finally {
                syncDepth -= 1;
            }
        };
        try {
            ctx.on('llm/stream', listener, { prepend: true, global: true });
            streamState.installed = true;
        }
        catch (error) {
            streamState.installed = false;
            streamState.lastError = `注册 llm/stream 监听器失败：${error instanceof Error ? error.message : String(error)}`;
            logger?.warn?.(`harness-pilot: ${streamState.lastError}`);
        }
    }
    else {
        streamState.lastError = 'ctx.on 不可用 ⇒ 无法装 llm/stream 护栏';
    }
    // ── 护栏 ①：`sessionTitle.startProvider` 的方法级替换（辅助调用**诞生时**就落在宿主路由上）──
    const service = ctx.get?.('sessionTitle');
    let titleWrapper;
    let titleRaw;
    let titleBase;
    if (service === undefined) {
        titleState.status = 'not-needed';
        titleState.reason = 'ctx.sessionTitle 未挂载 ⇒ 这个 composition 里没有「模型生成会话标题」这条辅助调用，无事可做';
    }
    else {
        titleRaw = (service[ORIGINAL] ?? service);
        const marked = titleRaw[TITLE_MARK];
        const prototypeMethod = prototypeMethodOf(titleRaw, 'startProvider');
        titleBase = marked?.base ?? prototypeMethod;
        if (typeof titleBase !== 'function') {
            titleState.status = 'failed';
            titleState.reason = '在 sessionTitle 上找不到 startProvider 方法（宿主内部结构可能已变）—— 需要这道护栏却装不上，'
                + '**会话标题会继续跑到外部 CLI**（如实记为未修，不假装通过）';
        }
        else {
            titleState.baseIsPrototypeMethod = prototypeMethod === titleBase;
            titleState.baseIdentity = titleState.baseIsPrototypeMethod
                ? '与 Object.getPrototypeOf(sessionTitle).startProvider 是同一个函数对象（改写只是前置，宿主实现原样执行）'
                : '当前方法已是别的包装（沿用其 base；可能是上一次 HMR 的包装尚未还原）';
            const base = titleBase;
            titleWrapper = function guardedStartProvider(session, work, route) {
                titleState.calls += 1;
                let nextRoute = route;
                try {
                    const decision = auxRouteOverrideFor(route, readNativeDefault());
                    if (decision.changed && decision.selection !== undefined) {
                        nextRoute = decision.route;
                        titleState.overrides += 1;
                        const from = (route ?? {});
                        titleState.lastOverride = recordOf('sessionTitle.startProvider', 'rewrite', decision.reason, 'session-title', { provider: String(from.provider ?? ''), model: String(from.model ?? '') }, { ...decision.selection });
                        logger?.info?.(`harness-pilot: 会话标题的辅助调用原本会跑到 ${ROUTE}，已在交给标题提供方**之前**改用宿主原生默认`
                            + ` ${decision.selection.provider}/${decision.selection.model}`
                            + '（title-llm-request 事件、实际派发、session/title 三处同时诚实）。');
                    }
                }
                catch (error) {
                    nextRoute = route;
                    titleState.reason = `route 改写判定抛错，已用原 route 转发：${error instanceof Error ? error.message : String(error)}`;
                }
                return base.apply(this, [session, work, nextRoute]);
            };
            Object.defineProperty(titleRaw, 'startProvider', {
                value: titleWrapper,
                writable: true,
                enumerable: false,
                configurable: true,
            });
            titleRaw[TITLE_MARK] = { base, wrapper: titleWrapper };
            titleState.status = 'armed';
            titleState.reason = '已在 sessionTitle.startProvider 上装上前置 route 改写（只拦 route.provider ∈ '
                + JSON.stringify(ownedRoutes()) + '，其余原样转发给真原方法）';
            titleState.installedAt = new Date().toISOString();
        }
    }
    const snapshot = () => ({
        installed: streamState.installed || titleState.status === 'armed',
        note: '两道护栏（`llm/stream` 改写式监听器 + `sessionTitle.startProvider` 前置 route 改写）都把**辅助调用**'
            + '（`options.purpose !== undefined` / 会话标题那条 route）从本插件路由换到 `ctx.agentDefaultModel` 的'
            + '**当前原生默认选择**上，且**都不重新派发**（派发仍只有宿主自己那一次）。'
            + '主轮（`purpose === undefined`）一律不碰 ⇒ 主会话选择、归因、解绑恢复三条既有行为不变。',
        nativeDefault: {
            readable: defaultState.selection !== undefined,
            provider: defaultState.selection?.provider ?? null,
            model: defaultState.selection?.model ?? null,
            reads: defaultState.reads,
            failures: defaultState.failures,
            lastError: defaultState.lastError,
        },
        stream: {
            installed: streamState.installed,
            layer: 'llm/stream',
            prepend: true,
            global: true,
            entries: streamState.entries,
            auxEntries: streamState.auxEntries,
            rewrites: streamState.rewrites,
            passThrough: streamState.passThrough,
            frozenSkips: streamState.frozenSkips,
            nextCalls: streamState.nextCalls,
            errors: streamState.errors,
            lastDecision: streamState.lastDecision,
            lastError: streamState.lastError,
        },
        sessionTitle: {
            status: titleState.status,
            reason: titleState.reason,
            service: 'sessionTitle',
            method: 'startProvider',
            baseIsPrototypeMethod: titleState.baseIsPrototypeMethod,
            baseIdentity: titleState.baseIdentity,
            calls: titleState.calls,
            overrides: titleState.overrides,
            lastOverride: titleState.lastOverride,
            installedAt: titleState.installedAt,
        },
        recursion: {
            mechanism: '**结构上不重入**：两道护栏都不调用 `ctx.llm.stream`/`llm.stream`（那是唯一能再次进入本监听器的入口）——'
                + '护栏①在 `ctx.llm.stream` **之前**换 route，护栏②只就地改写调用方手里的 options 然后 `return next()`。'
                + '因此每次辅助调用只产生**一次** `llm/stream` 进入、**一次**派发。',
            entries: streamState.entries,
            nextCalls: streamState.nextCalls,
            maxSyncDepth: streamState.maxSyncDepth,
            markedReentries: streamState.markedReentries,
            note: '判据：`maxSyncDepth` 恒为 1（同步重入会抬到 ≥2）、`entries === nextCalls`（绝不吞流）、'
                + '`markedReentries` 恒为 0（改写过的对象没有回到本监听器）。「派发只有一次」的旁证在适配器记录里：'
                + '辅助调用不再新增任何 `records`（而加护栏前它会产生一条 `kind:"route"` 的真实派发记录）。',
        },
        lastDecision: streamState.lastDecision ?? titleState.lastOverride,
        lastError: streamState.lastError,
    });
    const dispose = () => {
        // 监听器随 fiber 自动销毁（`ctx.on` 内部就是 `ctx.fiber.effect`）；这里只负责把
        // **方法级替换**还原掉 —— 否则插件被卸载 / 重载后，宿主服务上会留着一个指向旧状态的包装。
        try {
            if (titleRaw !== undefined && titleWrapper !== undefined && titleRaw.startProvider === titleWrapper) {
                delete titleRaw.startProvider;
            }
            if (titleRaw !== undefined) {
                const mark = titleRaw[TITLE_MARK];
                if (mark?.wrapper === titleWrapper)
                    delete titleRaw[TITLE_MARK];
            }
            if (titleState.status === 'armed') {
                titleState.status = 'failed';
                titleState.reason = 'disposer 已还原（插件被卸载 / 重载）';
            }
            streamState.installed = false;
        }
        catch (error) {
            logger?.warn?.(`harness-pilot: 还原 purpose guard 失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    return { snapshot, dispose };
}
/**
 * 适配器：把 DSH 的一轮请求交给外部 CLI。
 *
 * **不继承宿主的 `LlmAdapter` 类**（刻意的）：本插件 `node_modules/@deepseek-ai/dsh-llm` 是
 * 从 asar 抽出的**另一份模块实例**，`class extends` 会引入「两份同类」的隐性风险；
 * 而 `registerAdapter` 只做鸭子类型校验（`providerInfo` 的 id/name，`dsh-llm:1864-1865`）。
 * 这里把 7 个方法**显式全部实现**，不依赖任何默认实现。
 */
export class PilotCliAdapter {
    deps;
    record;
    constructor(deps, record) {
        this.deps = deps;
        this.record = record;
    }
    providerInfo(provider) {
        // 每个 harness 一条 provider：名字就是原生选择器里的分组标题（如「外部 CLI · Qoder（国内）」）。
        const spec = providerSpecFor(this.deps.harnessProviders?.() ?? [], provider);
        if (spec !== undefined)
            return { id: provider, name: spec.name };
        return { id: provider, name: '外部 CLI（pilot-cli）' };
    }
    /** 不声明重试策略 ⇒ 用宿主默认（重试一次外部 CLI 是安全的：每次调用都是独立的一次性进程）。 */
    providerRetryPolicy(_provider) {
        return undefined;
    }
    /** 图片计价：外部 CLI 这条链路不传图（渲染时如实标注「图片内容对 CLI 不可见」），故无价可报。 */
    imageRequestPricing(_provider, _model) {
        return undefined;
    }
    /**
     * **必须实现**：返回空数组的路由会被 `buildModelCatalog` 丢掉，选择器里完全不可见
     * （`dsh-api-session-controller/lib/index.js:541`）。
     *
     * ## 2026-10-14 起：一个 harness = 一个 provider（分组即折叠）
     * 宿主只按 provider 分组，且没有组级折叠原语（见 `src/harness-llm.ts` 文件头）。
     * 所以这里对**每条 `harness-*` 路由**返回**该 harness 的全部模型**（`cli-default` 之外逐条列出，
     * **不截断**：用户明确要求「点开折叠后才是该 harness 的全部模型」，`sessionModelLimit` 不再作用于这里）。
     *
     * ## 选择器可见性与子智能体独立
     * 宿主子智能体设置同样读取本目录，故不能在这里按会话显示设置删模型。
     * 分组/逐模型/数量配置由 client/grouped-models.js 的会话菜单消费；原生子代理保留全量。
     *
     * ## 历史路由 `pilot-cli` 为什么返回空
     * 它仍然**注册着**（绑定驱动改道、团队成员冻结配方、既有 profile 的 `allowedModels` 都还引用它），
     * 但不再往目录里塞扁平条目 —— 否则同一份模型会在选择器里出现两遍（用户明确反对重复）。
     * 空组会被 `buildModelCatalog` 丢掉 ⇒ 菜单里根本不显示这一组；而显式点名它的请求照常派发
     * （`resolveModel` 原样返回，目录成员资格不控制路由：`dsh-llm/lib/types/index.js:585`）。
     */
    async listModels(provider) {
        const spec = providerSpecFor(this.deps.harnessProviders?.() ?? [], provider);
        if (spec === undefined)
            return [];
        // The native Subagent settings page shares this catalog. Filter only in the conversation UI.
        const out = [];
        {
            out.push({
                provider: spec.id,
                id: CLI_DEFAULT_MODEL_ID,
                name: '（CLI 默认模型）',
                description: `${spec.name}：不下发 \`--model\`，用这条 CLI 自己的默认档；由「${spec.primaryTarget}」执行`,
            });
        }
        /**
         * **首建目录就等模型**（而不是等下一次刷新）。
         *
         * ⚠️ 预算必须由**提供方**统一把握（`awaitModelsFor` 内部那一个全局截止时刻），
         * 不能在这里按 provider 各自竞速：宿主逐 provider 建目录，各自竞速时
         * **第一个被建的 provider** 会在总预热还没跑完时就超时 —— 实测 `harness-antigravity`
         * 因此只剩「CLI 默认模型」一条（agy 要 7.3s，而它排在第一批）。
         * 每个目标独立 try/catch：一条坏目标不能把整组清零。
         */
        const resolved = new Map();
        if (this.deps.awaitModelsFor !== undefined) {
            await Promise.all(spec.targets.map(async (name) => {
                try {
                    const waited = await this.deps.awaitModelsFor(name);
                    if (waited !== undefined)
                        resolved.set(name, waited);
                }
                catch {
                    // 单目标失败 ⇒ 该目标回退同步清单；错误另有 `/llm-adapter` 的逐步诊断回报。
                }
            }));
        }
        const models = mergeHarnessModels(spec, (name) => resolved.get(name) ?? this.deps.modelsFor?.(name));
        // **会话选择器可见性**（2026-10-15 用户要求逐模型/逐组显隐）：只裁宣传面，不影响执行。
        //   · 整组隐藏 ⇒ 返回空（宿主 buildModelCatalog 丢弃空组 = 选择器里整组不见，连「CLI 默认模型」一起）；
        //   · 组内隐藏 + 每组上限 ⇒ filterPickerModels（保序裁剪）。
        // 执行校验（streamForProvider 的 known 清单）与子代理候选**不过这里** —— 隐藏 ≠ 不可用。
        // （2026-10-15 午后一度被改回「listModels 全量、只过滤会话 UI」——那样「选择器显示」面板
        //   就是不生效的摆设，与用户验收口径冲突，按用户要求恢复过滤。）
        const visibility = this.deps.pickerVisibility?.(spec.id);
        if (visibility?.groupHidden === true)
            return [];
        const visibleModels = filterPickerModels(models, new Set(visibility?.hidden ?? []), visibility?.limit ?? 0);
        for (const model of visibleModels) {
            out.push({ provider: spec.id, id: model.id, name: model.name, description: model.description });
        }
        // 缓存仍未命中 ⇒ 继续排后台预热（下次目录刷新可见）。
        for (const targetName of spec.targets)
            this.deps.warmModelsFor?.(targetName);
        return out;
    }
    /**
     * 对 `listModels` 宣传过的任何模型**都不得抛错**（否则整组会从目录里消失，
     * 且选择时报 `session/model-unavailable`）。这里不校验存在性 —— 校验放在 `stream`，
     * 那时才能给出「有哪些可用」的可读错误。
     *
     * `contextWindow` **不声明**：外部 CLI 的真实上下文窗口我们不知道，编一个数字比不写更糟。
     */
    async resolveModel(provider, model, _signal) {
        // **会话「推理等级」**（2026-10-15 用户要求全部模型可选并按模型定制）：按该 harness
        // 主目标的 `thinking` 声明产出宿主 reasoning 元数据；不声明的目标（如 GUI 档位）如实缺省 ——
        // 宿主对该模型就不渲染推理等级子菜单，绝不编造词表。
        const spec = providerSpecFor(this.deps.harnessProviders?.() ?? [], provider);
        const thinking = spec === undefined
            ? undefined
            : this.deps.targets().find((entry) => entry.name === spec.primaryTarget)?.thinking;
        if (thinking === undefined)
            return { provider, id: model, name: model };
        return {
            provider, id: model, name: model,
            reasoning: {
                efforts: thinking.levels.map((level) => ({ id: level.id, name: level.name })),
                defaultEffort: thinking.default,
            },
        };
    }
    async prepareCall(provider, model, signal) {
        const resolved = await this.resolveModel(provider, model, signal);
        // ⚠️ provider 必须**闭包带进去**：`stream(options)` 只拿得到 options，而请求的 provider
        // 在 `prepareCall` 的形参上（宿主契约）。多 provider 之后这是「这条模型该谁跑」的唯一来源。
        return { model: resolved, stream: (options) => this.streamForProvider(provider, options) };
    }
    /** 契约要求的唯一必填方法。 */
    stream(options) {
        // 兜底路径（没有走 `prepareCall`）时，从 options 里读 provider；读不到按历史路由处理。
        const provider = typeof options?.provider === 'string'
            ? String(options.provider)
            : ROUTE;
        return this.streamForProvider(provider, options);
    }
    /**
     * 按 **provider + model** 决定「这次到底跑哪条目标、带什么模型」。
     *
     * 两条路由形态：
     *   · `pilot-cli`（历史/内部）：model = 目标名 或 `目标名::模型`；
     *   · `harness-<key>[-<region>]`（新，面向用户）：model = 该 harness 的模型 id，
     *     或保留值 `cli-default`（用它自己的默认档）。**过期/未知的模型 id 显式拒绝**
     *     （不静默换一个模型跑 —— 那正是「一选就报错」里最难查的一类）。
     */
    streamForProvider(provider, options) {
        options = { ...(options ?? {}), provider };
        const record = (options ?? {});
        const rawModel = typeof record.model === 'string' ? record.model : '';
        if (provider === ROUTE || !this.deps.harnessProviders) {
            const choice = typeof record.model === 'string' ? splitModelChoice(record.model) : { target: '', model: undefined };
            return this.streamFor(options, {
                target: choice.target,
                ...(choice.model === undefined ? {} : { model: choice.model }),
                origin: 'route',
            });
        }
        const spec = providerSpecFor(this.deps.harnessProviders(), provider);
        if (spec === undefined) {
            return this.streamFor(options, { target: '', model: undefined, origin: 'route' });
        }
        if (rawModel.length === 0 || rawModel === CLI_DEFAULT_MODEL_ID) {
            // 「CLI 默认档」：目标跑它自己的默认模型（不带 `-m`）。
            return this.streamFor(options, { target: spec.primaryTarget, origin: 'route' });
        }
        const known = mergeHarnessModels(spec, (name) => this.deps.modelsFor?.(name));
        const hit = known.find((entry) => entry.id === rawModel);
        if (hit === undefined && known.length > 0) {
            // 清单拿到了、但没有这个 id ⇒ **显式拒绝**（过期 id / 别的 harness 的模型）。
            const available = known.slice(0, 12).map((entry) => entry.id).join(', ');
            return this.streamFor(options, {
                target: '',
                model: undefined,
                origin: 'route',
                refusal: `${provider}: 模型「${rawModel}」不在该 harness 当前报出的清单里`
                    + `（共 ${known.length} 个）。可用示例：${available}${known.length > 12 ? ' …' : ''}`
                    + '\n本次**不派发**：绝不换一个模型替你跑（那会让「选了 A 实际跑了 B」无法察觉）。'
                    + '请刷新模型目录后重选，或先核对这条 CLI 是否真的支持该 id。',
            });
        }
        return this.streamFor(options, {
            target: hit === undefined ? spec.primaryTarget : hit.target,
            model: hit?.executionModel ?? rawModel,
            origin: 'route',
        });
    }
    /**
     * 真正的实现。`stream()`（路由直达）与 `llm/stream` 监听器（绑定改道）都走这里，
     * 保证两条入口的 chunk 序列与错误语义**完全一致**。
     */
    async *streamFor(options, selection) {
        const started = Date.now();
        const request = (options ?? {});
        const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined;
        // 会话选择的推理等级（宿主已按 resolveModel 声明的词表校验；未选择 = undefined）。
        const reasoningEffort = typeof request.reasoningEffort === 'string' && request.reasoningEffort.trim().length > 0
            ? request.reasoningEffort.trim()
            : undefined;
        if (typeof selection.refusal === 'string' && selection.refusal.length > 0) {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: selection.refusal, code: 'PILOT_CLI_MODEL_REFUSED' } } };
            this.record({
                at: new Date().toISOString(), kind: selection.origin, target: selection.target,
                ...(sessionId === undefined ? {} : { sessionId }),
                stopReason: 'error', chars: 0, ms: Date.now() - started, error: 'PILOT_CLI_MODEL_REFUSED',
            });
            return;
        }
        const advertised = this.deps.targets();
        const target = advertised.find((entry) => entry.name === selection.target);
        if (target === undefined) {
            const names = advertised.map((entry) => entry.name);
            const message = selection.target.length === 0
                ? `pilot-cli: 本次请求没有 model（路由 ${ROUTE} 下 model 必须是外部 CLI 目标名，或「目标名::模型」）`
                : `pilot-cli: "${selection.target}" 不是一个可用的外部 CLI 目标。可用：${names.length > 0 ? names.join(', ') : '(无：所有目标都被停用或不可解析)'}`;
            yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PILOT_CLI_UNKNOWN_TARGET' } } };
            this.record({ at: new Date().toISOString(), kind: selection.origin, target: selection.target, sessionId, stopReason: 'error', chars: 0, ms: Date.now() - started, error: 'PILOT_CLI_UNKNOWN_TARGET' });
            return;
        }
        const signal = request.signal ?? new AbortController().signal;
        const prompt = renderPrompt(request);
        // 团队路由的**冻结账户配方**优先：成员建好那一刻的配置目录与参数就是它这一轮要用的东西，
        // 不能在这里按「档案现在长什么样」重算（那会让改名/删除账号悄悄改变一位已存在的成员）。
        // ⚠️ 它必须在**外层**解出来：下面的 `record()` 要用同一个 accountId，
        // 在 try 块里声明会让成功路径读不到（那里原本读的就是外层那个）。
        const frozen = this.deps.frozenAccountFor?.(sessionId ?? '');
        // ⚠️ 2026-10-14 修：账号池默认账号是**全局一个**，必须**按目标所属 Harness 分域**再决定用不用。
        // 历史行为：池里设了 `workbuddy-a` 之后，向 `agy`/`qoder` 路由发一条消息会走进跨 Harness 拒绝分支
        // ⇒ 整轮失败（实测 400）。现在由 `defaultAccountForTarget()`（`src/account-target.ts` 唯一实现）
        // 解析：不属于本目标 ⇒ **不套用**并把原因写进这次派发的备注，请求照常跑。
        const scopedDefault = this.deps.defaultAccountFor?.(target.name);
        const accountId = frozen?.accountId
            ?? selection.accountId
            ?? (this.deps.bindingFor?.(sessionId ?? '')?.harnessId === target.name ? this.deps.bindingFor?.(sessionId ?? '')?.accountId : undefined)
            ?? (scopedDefault?.accountId !== undefined && scopedDefault.accountId.length > 0 ? scopedDefault.accountId : undefined);
        const defaultAccountNote = scopedDefault?.ignoredReason ?? '';
        // ── 模型：`binding.model` 必须真的送到 CLI，否则就是**静默丢弃** ──────────────
        // ⚠️ 这一格此前是空的，本轮核对时抓到的**真缺口**：改道决策（`routeDecisionFor` /
        // `requestRouteDecisionFor`）产出的 `selection.model` 是**目标名**（`pilot-cli` 路由下
        // model 就是外部 CLI 目标名，见文件头），所以 `binding.model` 从来没有被读进这次派发 ——
        // 于是「绑定里存了模型」并不等于「CLI 真的用了那个模型」。
        // 现在按**显式优先**取一次：`selection.model`（＝路由⇒本次目标是目标名，不是模型名）
        // 不算模型来源，模型只从**这次会话的冻结/绑定值**来。
        const frozenModel = this.deps.frozenModelFor?.(sessionId ?? '');
        const boundModel = (() => {
            const value = this.deps.bindingFor?.(sessionId ?? '')?.model;
            return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
        })();
        // 优先级（2026-10-14 起，含**显式选择**）：
        //   ① 选择槽里的显式模型（`目标名::模型`）—— 用户在选择器里就是选的它，必须生效；
        //   ② 团队成员的冻结模型；③ 会话绑定模型。
        // ⚠️ ①与②冲突时**显式拒绝**（不静默用其中一个）：冻结配方是成员身份的一部分，
        // 而用户显式选择也不能被静默吞掉 —— 两个都必须被尊重，那就把矛盾**说出来**。
        const pickedModel = selection.model === undefined || selection.model.trim().length === 0
            ? undefined
            : selection.model.trim();
        if (frozenModel !== undefined && pickedModel !== undefined && pickedModel !== frozenModel) {
            const message = `pilot-cli: 本会话是团队成员，模型已在创建时冻结为 "${frozenModel}"；本次选择的 "${pickedModel}" 与之冲突，已明确拒绝（不静默用其中一个）。如需换模型请用任务级操作或重建成员。`;
            yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PILOT_CLI_MODEL_CONFLICT' } } };
            this.record({ at: new Date().toISOString(), kind: selection.origin, target: target.name, sessionId, accountId, stopReason: 'error', chars: 0, ms: Date.now() - started, error: 'PILOT_CLI_MODEL_CONFLICT' });
            return;
        }
        const model = pickedModel ?? frozenModel ?? boundModel;
        let result;
        try {
            result = await this.deps.dispatch({
                target: target.name,
                prompt,
                ...(accountId === undefined || accountId.length === 0 ? {} : { accountId }),
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(frozen === undefined ? {} : { frozenAccount: frozen }),
                ...(model === undefined ? {} : { model }),
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
                transport: 'headless',
                signal,
            });
            // 「跳过了不属于本目标的池默认账号」必须在**本次派发的备注**里说得出来，
            // 否则用户只会看到「跑成功了」但不知道为什么没用那个默认账号。
            if (defaultAccountNote.length > 0) {
                result = {
                    ...result,
                    diagnostic: [result.diagnostic, defaultAccountNote]
                        .filter((piece) => typeof piece === 'string' && piece.length > 0)
                        .join(' · '),
                };
            }
        }
        catch (error) {
            result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (!result.ok) {
            const message = `pilot-cli: 无法把这一轮交给外部 CLI "${target.name}"：${result.reason ?? '未给出原因'}`;
            yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PILOT_CLI_UNAVAILABLE' } } };
            this.record({ at: new Date().toISOString(), kind: selection.origin, target: target.name, sessionId, accountId, stopReason: 'error', chars: 0, ms: Date.now() - started, error: message });
            return;
        }
        // Never persist or echo arbitrary extra_args (they may contain credentials).
        const mismatch = (result.mismatch ?? []).length > 0
            ? ['外部 CLI 未按请求应用模型或参数；请检查所用通道。'] : [];
        const text = (result.text ?? '') + (mismatch.length > 0 && (result.text ?? '').trim().length > 0
            ? '\n\n⚠ 请求值与实际执行存在偏差：\n' + mismatch.join('\n') : '');
        const chunks = buildChunks({
            text,
            stopReason: result.stopReason ?? 'error',
            diagnostic: [result.diagnostic, ...mismatch].filter(Boolean).join('; '),
            target: target.name,
        });
        for (const chunk of chunks)
            yield chunk;
        const finish = chunks[chunks.length - 1];
        const stopReason = finish !== undefined && finish.type === 'finish' ? finish.reason.kind : 'unknown';
        if (sessionId) {
            try {
                const provider = typeof options?.provider === 'string'
                    ? String(options.provider) : ROUTE;
                this.deps.onExecution?.(sessionId, { provider, requestedModel: model ?? '', target: target.name,
                    stopReason, mismatch, at: new Date().toISOString() });
            }
            catch (error) {
                this.deps.logger?.warn?.(`harness-pilot: execution identity persistence failed: ${String(error)}`);
            }
        }
        this.record({
            at: new Date().toISOString(),
            kind: selection.origin,
            target: target.name,
            sessionId,
            accountId,
            stopReason,
            chars: text.length,
            ms: Date.now() - started,
            ...(mismatch.length === 0 ? {} : { mismatch }),
            ...(result.diagnostic === undefined ? {} : { error: result.diagnostic }),
        });
    }
}
export function registerPilotCli(ctx, deps) {
    const logger = deps.logger ?? ctx.logger;
    // ── 先把「自有路由集合」定下来 ──
    // 闸门 / purpose guard / 请求层判定都动态读它；漏一条 = 那条路由可以被写进用户的部署默认模型，
    // 或者它的辅助调用会跑进外部 CLI。所以这一步必须在装闸门之前。
    const harnessSpecs = deps.harnessProviders?.() ?? [];
    const owned = [ROUTE, ...harnessSpecs.map((spec) => spec.id)];
    setOwnedRoutes(owned);
    ctx.effect?.(() => () => setOwnedRoutes([ROUTE]), 'harness-pilot: owned-routes (restore base)');
    const gate = installDefaultModelGate(ctx, logger);
    // 闸门必须**随 fiber 还原**：否则插件被卸载 / 重载后，宿主服务上会留着一个指向旧状态的包装。
    ctx.effect?.(() => () => gate.dispose(), 'harness-pilot: pilot-cli default-model gate');
    // purpose guard：**辅助调用（会话标题 / 压缩）不得再跑进外部 CLI**。
    // 与注册结果**无关**地安装：它的触发条件是「route.provider === ROUTE」，而那条路由只可能来自本插件
    // （或用户显式选择），两条护栏在没有本路由时自然成为空操作。装不上的情形如实报在 `auxScope()` 里。
    const auxScope = installAuxScopeGuard(ctx, logger);
    ctx.effect?.(() => () => auxScope.dispose(), 'harness-pilot: purpose guard (llm/stream + sessionTitle)');
    const registration = {
        current: {
            ok: false,
            route: ROUTE,
            reason: '未注册',
            registered: false,
            handleShape: '(none)',
        },
    };
    const records = [];
    const record = (entry) => {
        records.push(entry);
        if (records.length > 40)
            records.splice(0, records.length - 40);
    };
    const adapter = new PilotCliAdapter(deps, record);
    // ── 闸门优先：需要却装不上 ⇒ **不注册路由**（用户授权是有条件的）──
    if (gate.snapshot().status === 'failed') {
        registration.current = {
            ok: false,
            route: ROUTE,
            reason: `闸门装不上（${gate.snapshot().reason}）⇒ 按用户设定的前提，**不注册** ${ROUTE}`,
            registered: false,
            handleShape: '(none)',
        };
        logger?.warn?.(`harness-pilot: 未注册 LLM 路由 ${ROUTE} —— ${registration.current.reason}`);
    }
    else {
        const llm = ctx.get?.('llm');
        if (llm?.registerAdapter === undefined) {
            registration.current = {
                ok: false,
                route: ROUTE,
                reason: 'ctx.llm.registerAdapter 不可用（宿主 API 漂移？）',
                registered: false,
                handleShape: '(none)',
            };
            logger?.warn?.(`harness-pilot: 未注册 LLM 路由 ${ROUTE} —— ${registration.current.reason}`);
        }
        else {
            try {
                // 多路由注册：`pilot-cli`（历史/内部）+ 每个 harness 一条（面向用户的原生折叠分组）。
                const handle = llm.registerAdapter(owned, adapter);
                const callable = typeof handle === 'function';
                const replaceable = callable && typeof handle.replace === 'function';
                registration.current = {
                    ok: true,
                    route: ROUTE,
                    reason: `已注册（闸门状态 ${gate.snapshot().status}；共 ${owned.length} 条路由 = ${ROUTE} + ${harnessSpecs.length} 个 harness 分组）`,
                    registered: true,
                    handleShape: callable ? (replaceable ? 'disposer + replace' : 'disposer') : 'unknown',
                    routes: owned,
                };
                // 不额外挂 disposer：`registerAdapter` 内部就是 `this.ctx.effect(...)`，而 cordis 的服务方法
                // 以**调用方**的 ctx 运行 ⇒ 该注册已经随本插件的 fiber 自动销毁（重复 dispose 反而有风险）。
                logger?.info?.(`harness-pilot: LLM 路由已注册 ${owned.length} 条`
                    + `（${ROUTE} + ${harnessSpecs.length} 个 harness 分组：${harnessSpecs.map((spec) => spec.id).join(', ')}）`
                    + `，disposer=${callable ? 'yes' : 'no'}，闸门=${gate.snapshot().status}`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                // 路由名撞名（DUPLICATE_ADAPTER：pi-ai 的用户自命名 profile key 可能就叫 pilot-cli）必须**响亮**失败。
                registration.current = {
                    ok: false,
                    route: ROUTE,
                    reason: `注册 ${ROUTE} 失败：${message}。`
                        + (/DUPLICATE_ADAPTER/i.test(message)
                            ? `路由名 "${ROUTE}" 已被别的适配器占用（例如用户在 dsh-llm-pi-ai 里自命名的 profile key 恰好叫这个名字）。`
                                + '请改 profile key，或改本插件的路由名 —— 不要指望静默共存。'
                            : '请核对宿主 llm 适配器契约是否变化。'),
                    registered: false,
                    handleShape: '(none)',
                };
                logger?.warn?.(`harness-pilot: ${registration.current.reason}`);
            }
        }
    }
    // ── 第 4 步：绑定驱动的**请求层**改道（`agent/request`）──
    //
    // 旧实现挂在 `llm/stream` 上短路。它拿得到内容，却改不了**请求**——
    // 而会话日志的 `request/header`（`dsh-agent-loop:1205-1218`）与 assistant 消息的
    // `source`（`:1136-1143`）都取自 `prepareRequest` 解析出来的 config。
    // ⇒ 在那一层改道，日志必然把外部 CLI 的产出记成宿主路由 = **归因不实**。
    // 现在改成在 `agent/request` 瀑布（`:1179-1183`，**在 header 落盘之前**）改写 config：
    // 请求本身就带真实来源，日志与界面随之诚实。
    //
    // ⚠️ 顺序：`{prepend: true}` 保证我们最外层；**先 `await next()`**，拿到的是已被 GUI
    // 选择器（`installModelSelection`，默认 push）改写过的 config。绝不短路下游。
    const requestLayerInstalled = registration.current.registered && typeof ctx.on === 'function';
    const requestLayerState = {
        installed: requestLayerInstalled,
        layer: 'agent/request',
        prepend: true,
        global: true,
        decisions: 0,
        rewrites: 0,
        restores: 0,
        heldPicks: 0,
        subagentKept: 0,
        errors: 0,
        lastDecision: null,
        lastError: null,
        picks: { readable: null, sessionId: null, pick: null },
    };
    const pickFolds = new Map();
    /**
     * 一次会话视图：**同一次** `sessions.get` 同时取
     *   · 显式选择折叠（会话日志里的 `model/selection`；读不到记 `readable:false`）；
     *   · 会话归属（`header.origin`）—— `'subagent'` 表示这次请求来自子代理子会话。
     *
     * 两者必须同源：`origin` 是「这条路由是调用方**显式委托**来的」的唯一持久证据，
     * 而它**独立于**事件折叠（`eventAt` 读不到时 `header.origin` 仍可能读得到）。
     */
    const sessionViewFor = (sessionId) => {
        if (sessionId.length === 0)
            return { readable: false, pick: null, origin: undefined };
        const store = ctx.get?.('sessions');
        const session = store?.get?.(sessionId);
        const originRaw = session?.header?.origin;
        const origin = typeof originRaw === 'string' && originRaw.length > 0 ? originRaw : undefined;
        const seq = session !== undefined && typeof session.seq === 'number' && Number.isSafeInteger(session.seq) ? session.seq : -1;
        if (session === undefined || seq < 0 || typeof session.eventAt !== 'function')
            return { readable: false, pick: null, origin };
        if (pickFolds.size > 512)
            pickFolds.clear();
        let fold = pickFolds.get(sessionId);
        if (fold === undefined || fold.seq > seq)
            fold = { seq: 0, pick: null };
        if (fold.seq < seq) {
            const fresh = [];
            for (let index = fold.seq; index < seq; index += 1) {
                const event = session.eventAt(index);
                if (event !== undefined)
                    fresh.push(event);
            }
            fold = foldExplicitPicks(fresh, fold);
            pickFolds.set(sessionId, fold);
        }
        return { readable: true, pick: fold.pick, origin };
    };
    const explicitPickFor = (sessionId) => {
        const view = sessionViewFor(sessionId);
        return { readable: view.readable, pick: view.pick };
    };
    /** 只读诊断：某会话当前的显式选择（给 `/llm-adapter` 与探针用）。 */
    const picksFor = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            return { readable: requestLayerState.picks.readable === true, pick: requestLayerState.picks.pick };
        }
        return explicitPickFor(sessionId);
    };
    if (requestLayerInstalled) {
        ctx.on?.('agent/request', async (payload, next) => {
            // ① 永远先让下游跑完（GUI 选择器 + seed proposal）。它抛错就原样抛出。
            const resolved = await next();
            try {
                const agent = (payload ?? {});
                const sessionId = typeof agent.agent?.id === 'string' ? agent.agent.id : '';
                const binding = sessionId.length > 0 ? deps.bindingFor?.(sessionId) : undefined;
                const view = sessionViewFor(sessionId);
                const picks = { readable: view.readable, pick: view.pick };
                const decision = requestRouteDecisionFor({
                    resolved: (resolved ?? {}),
                    sessionId,
                    sessionOrigin: view.origin,
                    binding,
                    advertised: deps.targets().map((entry) => entry.name),
                    lastPick: picks.readable ? picks.pick : undefined,
                    picksReadable: picks.readable,
                    defaultSelection: ctx.get?.('agentDefaultModel')?.currentSelection?.(),
                });
                requestLayerState.decisions += 1;
                requestLayerState.picks = { readable: picks.readable, sessionId, pick: picks.pick };
                requestLayerState.lastDecision = {
                    at: new Date().toISOString(),
                    sessionId,
                    sessionOrigin: view.origin ?? null,
                    action: decision.action,
                    reason: decision.reason,
                    target: decision.target ?? null,
                    from: { provider: String(resolved?.provider ?? ''), model: String(resolved?.model ?? '') },
                    to: decision.selection ?? null,
                    binding: binding === undefined ? null : { harnessKind: binding.harnessKind ?? null, harnessId: binding.harnessId ?? null, setAt: binding.setAt ?? null },
                    explicitPick: picks.pick,
                };
                if (decision.action === 'next' || decision.selection === undefined) {
                    if (decision.reason.startsWith('picker-picked-after-binding'))
                        requestLayerState.heldPicks += 1;
                    // 子代理显式委托的路由被**保留**（不是残留）：这是「外部 harness 真的被子代理用了」的
                    // 现场记录 —— 之前这一格会走到下面的 restore 分支（实测缺陷），所以这里必须留痕。
                    if (decision.reason === 'own-route-subagent-delegation-kept') {
                        requestLayerState.subagentKept += 1;
                        logger?.info?.(`harness-pilot: 子代理会话 ${sessionId}（origin=subagent）显式委托的路由 `
                            + `${String(resolved?.provider ?? '')}`
                            + `/${String(resolved?.model ?? '')}`
                            + ' 被**保留**（不当作本插件的改道残留）：外部 harness 由这次委托指定，改回部署默认等于静默替换。');
                    }
                    return resolved;
                }
                const rewritten = applyRequestSelection(resolved, decision.selection, decision.action === 'rewrite');
                if (decision.action === 'rewrite') {
                    requestLayerState.rewrites += 1;
                    logger?.info?.(`harness-pilot: 会话 ${sessionId} 绑定到外部 Harness「${decision.target ?? decision.selection.model}」`
                        + `⇒ 本轮请求本身改写为 ${decision.selection.provider}/${decision.selection.model}`
                        + '（会话日志的 request/header 与 assistant source 记的就是这个真实来源）；'
                        + COST_DISCLOSURE.split('。')[0] + '。');
                    record({
                        at: new Date().toISOString(),
                        kind: 'redirect',
                        target: decision.target ?? decision.selection.model,
                        ...(sessionId.length === 0 ? {} : { sessionId }),
                        ...(typeof binding?.accountId === 'string' && binding.accountId.length > 0 ? { accountId: binding.accountId } : {}),
                        stopReason: 'request-rewritten',
                        chars: 0,
                        ms: 0,
                        error: `agent/request: ${decision.reason}`,
                    });
                }
                else {
                    requestLayerState.restores += 1;
                    logger?.info?.(`harness-pilot: 会话 ${sessionId} 的模型路由停在 ${ROUTE} 但已无外部绑定，且会话日志里没有`
                        + `「显式选择过 ${ROUTE}」的记录 ⇒ 判定为本插件的改道残留，恢复为部署默认 `
                        + `${decision.selection.provider}/${decision.selection.model}（${decision.reason}）`);
                }
                return rewritten;
            }
            catch (error) {
                // 判定出错时**原样放行**：绝不因为我们自己的 bug 改掉别人的请求（宿主供应商照常执行 = 诚实）。
                requestLayerState.errors += 1;
                requestLayerState.lastError = `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`;
                logger?.warn?.(`harness-pilot: agent/request 改道判定失败，已原样放行：${requestLayerState.lastError}`);
                return resolved;
            }
        }, { prepend: true, global: true });
    }
    const llmForProbe = () => ctx.get?.('llm');
    const sessionController = () => ctx.get?.('sessionController');
    const profilePathOf = () => {
        const editor = ctx.get?.('configEditor');
        return typeof editor?.documentPath === 'string' ? editor.documentPath : null;
    };
    /** profile 证据**必须同时覆盖两个文件**：configEditor 真正写的 patch 文档，以及用户点名的组成文件。 */
    const profileFiles = () => {
        const document = profilePathOf();
        if (document === null)
            return [];
        return [
            { role: 'configEditor-document', path: document, hash: hashFileOrNull(document), mtime: mtimeOrNull(document) },
            {
                role: 'composition',
                path: join(dirname(document), 'cordis.yml'),
                hash: hashFileOrNull(join(dirname(document), 'cordis.yml')),
                mtime: mtimeOrNull(join(dirname(document), 'cordis.yml')),
            },
        ];
    };
    const profileEvidence = () => {
        const files = profileFiles();
        const primary = files[0];
        return {
            path: primary?.path ?? null,
            hash: primary?.hash ?? null,
            mtime: primary?.mtime ?? null,
            files,
            note: 'configEditor 的 documentPath 是 **cordis.patch.yml**（`configEditor.edit` 里 `writeFileAtomic(this.documentPath, …)`）；'
                + '`agent-default-model` 的部署默认值在 **cordis.yml 与 cordis.patch.yml 两处都有条目**，所以两个文件都要比 —— 只比一个会漏。',
        };
    };
    return {
        gate: () => gate.snapshot(),
        registration: () => registration.current,
        targets: () => deps.targets().map((entry) => entry.name),
        records: () => [...records],
        listener: () => ({
            installed: false,
            layer: 'llm/stream',
            note: '`installed:false` 指的是**响应层短路改道**（自己产 chunk）那种 `llm/stream` 监听器 —— 它**已移除**：'
                + '在那一层短路能拿到内容，却**改不了请求**，会话日志的 `request/header` 与 assistant 消息的 `source` '
                + '都在它之前就写好了（dsh-agent-loop:1205-1218 / 1136-1143）⇒ 必然把外部 CLI 的产出记成宿主路由（归因不实）。'
                + '改道已上移到请求层：见 `requestLayer`。'
                + '⚠️ 本插件**确实**还有一个 `llm/stream` 监听器（purpose guard），但它**只改写调用方手里的 options、'
                + '绝不自己产 chunk、也绝不重新派发**，主轮（`purpose === undefined`）一律原样放行 —— 见 `auxScope.stream`。'
                + '界面文案（`client/client.js` 的选择器座位句）与 `src/federation/binding.ts` 的 `scopeNoteFor` '
                + '已同步改写为「请求层 `agent/request` 改写」，不再说 `llm/stream` 改道。',
            // ⚠️ 为什么把 purpose guard 的状态**嵌在这里**：`/harness-pilot/api/llm-adapter` 的载荷由
            // `src/index.ts` 决定（本轮不由本文件作者改），而 `listener` 是它已经转发的字段之一。
            // 语义上 `installed` 说的是「短路式改道监听器」，`auxGuard` 说的是「改写式护栏」—— 两者都不是对方。
            auxGuard: auxScope.snapshot(),
        }),
        auxScope: () => auxScope.snapshot(),
        requestLayer: () => ({
            installed: requestLayerState.installed,
            layer: 'agent/request',
            prepend: requestLayerState.prepend,
            global: requestLayerState.global,
            decisions: requestLayerState.decisions,
            rewrites: requestLayerState.rewrites,
            restores: requestLayerState.restores,
            heldPicks: requestLayerState.heldPicks,
            subagentKept: requestLayerState.subagentKept,
            errors: requestLayerState.errors,
            lastDecision: requestLayerState.lastDecision,
            lastError: requestLayerState.lastError,
            picks: requestLayerState.picks,
        }),
        picks: (sessionId) => picksFor(sessionId),
        gateDecision: (provider) => ({
            provider: typeof provider === 'string' ? provider : `(非字符串：${typeof provider})`,
            decision: gateDecisionFor(provider),
        }),
        gateSelfTest: async (action) => {
            const before = profileFiles();
            const service = ctx.get?.('agentDefaultModel');
            let error = null;
            let gateBefore = gate.snapshot();
            if (service?.saveSelection === undefined) {
                error = 'ctx.agentDefaultModel.saveSelection 不可用';
            }
            else if (action === 'blocked') {
                const target = deps.targets()[0]?.name ?? 'unknown';
                try {
                    await service.saveSelection({ provider: ROUTE, model: target });
                }
                catch (thrown) {
                    error = thrown instanceof Error ? thrown.message : String(thrown);
                }
            }
            else {
                // 非自有形状 ⇒ 必须转发给真原方法；原方法在解析 provider 时自己抛错，**早于**任何写文件。
                try {
                    await service.saveSelection(undefined);
                }
                catch (thrown) {
                    error = thrown instanceof Error ? thrown.message : String(thrown);
                }
            }
            const after = profileFiles();
            gateBefore = gate.snapshot();
            const comparison = compareProfileSnapshots(before, after);
            return {
                action,
                profile: {
                    files: comparison.rows,
                    unchanged: comparison.unchanged,
                    note: '哈希**与** mtime 都一致才算没被改写；writeFileAtomic 走 rename，即便内容相同 mtime 也会变。',
                },
                profileUnchanged: comparison.unchanged,
                gate: gateBefore,
                threw: error,
                note: action === 'blocked'
                    ? '这条分支是选择器调用的**同一个服务/同一个方法/同一个形状**（dsh-api-session-controller:736）。被拦住 ⇒ 不进入 configEditor.edit ⇒ 零 profile 写入。'
                    : '这条分支不是本插件自有路由 ⇒ 转发给**原型链上的真原方法**；原方法自己抛错（证明到达了宿主实现），且任何写文件都在其后 ⇒ 同样零写入。',
            };
        },
        streamThroughRoute: async (input) => {
            const llm = llmForProbe();
            if (llm?.stream === undefined)
                return { ok: false, reason: 'ctx.llm.stream 不可用' };
            const started = Date.now();
            const chunks = [];
            let text = '';
            let finish = null;
            let thrown = null;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.max(5_000, input.timeoutMs ?? 180_000));
            try {
                const stream = llm.stream({
                    provider: typeof input.provider === 'string' && input.provider.length > 0 ? input.provider : ROUTE,
                    model: input.model,
                    messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
                    ...(typeof input.sessionId === 'string' && input.sessionId.length > 0 ? { sessionId: input.sessionId } : {}),
                    signal: controller.signal,
                });
                for await (const chunk of stream) {
                    chunks.push(chunk);
                    const record = (chunk ?? {});
                    if (record.type === 'text-delta' && typeof record.text === 'string')
                        text += record.text;
                    if (record.type === 'finish')
                        finish = record.reason ?? null;
                }
            }
            catch (error) {
                thrown = error instanceof Error ? error.message : String(error);
            }
            finally {
                clearTimeout(timer);
            }
            return {
                ok: text.trim().length > 0,
                route: ROUTE,
                model: input.model,
                text,
                chars: text.length,
                finish,
                chunkTypes: chunks.map((chunk) => chunk.type),
                chunks,
                ms: Date.now() - started,
                thrown,
                note: '经真实注册的 ctx.llm.stream 路由（含 llm/stream 瀑布）取得；空文本一律 ok=false —— 退出码 0 / 握手成功都不算验收。',
            };
        },
        modelCatalog: async () => {
            const controller = sessionController();
            if (controller?.modelCatalog === undefined) {
                return { available: false, reason: 'ctx.sessionController.modelCatalog 不可用（宿主服务漂移？）' };
            }
            const catalog = (await controller.modelCatalog());
            const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
            const group = groups.find((entry) => entry.id === ROUTE);
            const models = group !== undefined && Array.isArray(group.models) ? group.models.map((entry) => String(entry.id)) : [];
            return {
                available: true,
                source: 'ctx.sessionController.modelCatalog() —— 与界面选择器读的 ctx.remote.session.modelCatalog() 是**同一个服务端入口**'
                    + '（dsh-api-session-controller/lib/index.js:3002，装饰器 @Remote(\'modelCatalog\')）',
                default: catalog.default,
                routableProviders: catalog.routableProviders,
                groupCount: groups.length,
                groupIds: groups.map((entry) => String(entry.id)),
                pilotCliGroup: group === undefined ? null : { id: String(group.id), name: String(group.name), models },
                /** ← Path A 生效的**唯一硬证据**：这个分组必须存在，且至少 1 个模型。 */
                pilotCliVisible: group !== undefined && models.length > 0,
                failures: catalog.failures,
            };
        },
        profileEvidence,
        listProviders: () => {
            const llm = ctx.get?.('llm');
            const list = llm?.listProviders?.();
            return Array.isArray(list) ? list.map((entry) => String(entry.id)) : [];
        },
        selectModelThroughPicker: async (input) => {
            const controller = sessionController();
            if (controller?.selectModel === undefined || controller.create === undefined) {
                return { ok: false, stage: 'lookup', reason: 'ctx.sessionController 的 create / selectModel 不可用（宿主服务漂移？）' };
            }
            const before = profileEvidence();
            let sessionId = null;
            let created = null;
            try {
                // 传显式 sessionId 时 `create` 是**幂等 adopt**（宿主 `SessionCommandController.create`）——
                // 探针重复跑就不会每次多造一个会话。
                created = await controller.create(typeof input.sessionId === 'string' && input.sessionId.length > 0 ? { sessionId: input.sessionId } : {});
                const value = (created ?? {});
                sessionId = typeof value.sessionId === 'string' ? value.sessionId : null;
            }
            catch (error) {
                return { ok: false, stage: 'create', reason: error instanceof Error ? error.message : String(error) };
            }
            if (sessionId === null)
                return { ok: false, stage: 'create', reason: `create() 未返回 sessionId：${JSON.stringify(created)}` };
            let selected = null;
            let thrown = null;
            try {
                selected = await controller.selectModel({ sessionId, provider: input.provider, model: input.model });
            }
            catch (error) {
                thrown = error instanceof Error ? error.message : String(error);
            }
            const after = profileEvidence();
            const comparison = compareProfileSnapshots(before.files, after.files);
            const unchanged = comparison.unchanged;
            return {
                ok: thrown === null && unchanged,
                stage: 'done',
                sessionId,
                request: { provider: input.provider, model: input.model },
                selected,
                thrown,
                profile: { before, after, unchanged, files: comparison.rows },
                gate: gate.snapshot(),
                note: '这条路径就是选择器的**服务端入口**（@Remote(\'selectModel\')），闸门正是在它内部第 736 行那次 saveSelection 上生效。'
                    + 'profile.unchanged=true ⇒ 选择本路由**没有**把部署默认模型写进 profile。'
                    + '⚠️ 本调用会新建一个空会话（测试用）；它下一次请求会被路由到 ' + input.provider
                    + '，不需要时请删掉该会话，或在它的选择器里改选别的模型。',
            };
        },
    };
}
//# sourceMappingURL=llm-adapter.js.map