import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, resolveConfig } from './config.js';
import { obsoleteSubagentRoutes } from './subagent-cleanup.js';
import { externalSessionIdentity, SessionIdentityStore } from './session-identity.js';
import { WindowHelper } from './helper.js';
import { applyOverride, buildRegistry, loadRegistryState, resolveEntry, saveRegistryState, seedForTarget, } from './federation/registry.js';
import { collectProviderInventory, readUsableEvidence } from './federation/providers.js';
// P4：供应商/模型的**可编辑操作**与**受约束选择**。
// 能力探测决定可编辑范围（宿主/该 CLI 不支持就**显式拒绝**，不做「看起来能改」的界面）；
// actual 一律独立核验，**绝不用请求值顶替**（ACP set_config_option 对不存在的模型也会成功）。
import { adminSubcommandFor, candidatesFromInventory, capabilityReport, declaredAllowlistCapabilities, dshCatalogCapabilities, executeCatalogEdit, harnessCatalogCapabilities, planCatalogEdit, probeServiceShape, readDeclaredModelsFromFile, resolveCatalogSelection, runHarnessAdminHelp, } from './catalog-edit.js';
import { pluginVersion } from './sessions.js';
import { redactOverviewDescription } from './overview-description.js';
// 「一条 harness」的分组索引（CLI/IDE/TUI/账号配方折叠成一条；只有国内/国际拆两条）。
import { buildGroupIndex, classifyTarget } from './harness-groups.js';
// 「一个 harness 一条 LLM provider」的规格（宿主按 provider 分组 ⇒ 分组即折叠）。
import { buildHarnessLlmProviders, mergeHarnessModels, isAccountPinned } from './harness-llm.js';
// 模型来源分级 / 四类归类 / 四态（纯函数；原生目录与设置页共用同一份实现）。
import { countByKind, MODEL_KIND_LABEL, MODEL_SOURCE_LABEL, selectableIds } from './model-sources.js';
import { modelEntriesFor } from './models.js';
// 子代理模型白名单（宿主 `subagent-model-selection-settings.allowedModels`）的读写与差分。
import { applyPolicyChange, candidatesFor, normalizeRoutes, planPolicyChange, readPolicy, SUBAGENT_MODEL_NS, } from './subagent-models.js';
import { AccountManagers } from './account-managers.js';
import { discoverLocalModelCatalog } from './native-model-catalog.js';
import { prepareWorkBuddyHome, activeWorkBuddyHome } from './workbuddy-isolation.js';
import { assertNoSecrets, collectAccounts } from './federation/accounts.js';
import { applyAccountCrud, effectiveSeeds, isolationProfileFor, loadAccountRegistry, planNativeAuth, runNativeAuth, saveAccountRegistry, } from './federation/accounts.js';
import { applyBinding, loadBindingState, makeBinding, saveBindingState, } from './federation/binding.js';
import { appendSwitchEvent, eventsFor, findUnredacted, loadSwitchLog, saveSwitchLog, } from './federation/switchlog.js';
import { isEligibleTarget, loadPoolState, planManualSwitch, redactAccount, savePoolState, updatePoolState, } from './federation/poolconfig.js';
import { ACCOUNT_SEEDS, fingerprintOf, probeIdentity } from './federation/accounts.js';
import { EMPTY_RUNTIME, executeWithAutoSwitch, exitCodeFromDiagnostic, extractFailureSignal, thawAccount, } from './federation/autoswitch.js';
import { DEFAULT_COORDINATION, EMPTY_COORDINATION, acquire, noteSwitch, release, shouldSuppressSwitch, } from './federation/coordination.js';
const COORDINATION_POLICY = DEFAULT_COORDINATION;
import { createMcpBridge } from './mcp-bridge.js';
import { listDshModels } from './models.js';
import { TeamRoutingTable, modelArgsFor, teammateNameFromPrompt as teammateNameFromPromptForRouting, } from './team-routing.js';
// ── 「账号 → 目标」的**唯一来源**（本文件不再自带一份实现）────────────────────
// 历史：本文件曾同时拥有 `withAccountTarget()` / `managedRecipeTupleProblem()` /
// `claimManagedAccountRecipe()` 三个私有实现，而 `/dispatch` 又内联了第四份合并、
// 团队冻结配方两处各写一次 `[...frozen.args, ...found.args]`。同一个能力五处实现，
// 于是「受管账号拼出两个 wrapper」「Qoder 硬绑定目标被误拒」「note 未脱敏」这些
// 不一致各发生在不同入口。现在它们全部收进 `src/account-target.ts`。
// 依赖方向：`index.ts → account-target.ts → provider.ts`（单向，无回路；理由见该模块文件头）。
import { applyAccountToTarget, defaultAccountForTarget, withAccountTarget, } from './account-target.js';
import { managedBootstrapRuntimeGate, registerProviders } from './provider.js';
import { SessionRegistry } from './sessions.js';
// 「设置页 maxConcurrent → 进程池上限」的唯一语义单点（0=不限，>0=上限）。
// `ProcessPool` 只作类型用：进程池实例由 `SessionRegistry.pool()` 惰性给出。
import { applyRuntimeConcurrency } from './processpool.js';
import { loadSettings, pluginHome, saveSettings } from './settings.js';
import { applyVisibilityPatch, DEFAULT_PICKER_LIMIT, loadModelVisibility, pickerProviderSummary, pickerVisibilityFor, saveModelVisibility, } from './model-visibility.js';
import { SEEDED_MODEL_TTL_MS } from './sessions.js';
/**
 * 模型发现**缓存与落盘**的诊断快照（模块级，`/llm-adapter` 只读它）。
 *
 * 为什么要有：这一层出过两次「看起来一样、其实没生效」的故障 ——
 * ① 重载后目录里只剩「CLI 默认模型」；② 落盘回填因**缓存键不一致**读不到（写入按未作用域目标、
 * 读取按 `modelScopedTarget`）。把「落盘多少 / 回填多少 / 内存多少」摆出来，就不必靠猜。
 */
const modelCacheDiag = { file: '', persistedRows: -1, seededOnMount: -1, inMemory: 0 };
import { TaskManager } from './tasks.js';
import { compareIdentity, identityVerdictLine, redactAccountIdsInText, registerTaskTools } from './task-tools.js';
import { currentModelOf, mechanismOf, registerTools, switchModel, switchModelInPage, } from './tools.js';
import { buildReceipt, createSessionWaker } from './wake.js';
// 持久原生会话层（P1）+ 回执 outbox（P4）：实例在本文件接线，任务/工具共用同一份。
import { NativeSessionStore, SessionMutex } from './native-sessions.js';
import { ReceiptOutbox } from './receipt-outbox.js';
import { COST_DISCLOSURE, MODEL_AWAIT_BUDGET_MS, ROUTE as PILOT_CLI_ROUTE, registerPilotCli, } from './llm-adapter.js';
export const name = '@dsh-external/dsh-harness-pilot';
/**
 * 只声明**激活必需且注册顺序有保证**的核心服务（dsh-base 提供，先于本插件就位）。
 * subagents / webServer / 唤醒链服务不在这里：它们由子 fiber（等到再注册）或
 * 惰性解析处理 —— 见 apply() 里的「服务时序纪律」注释。
 */
export const inject = ['tools', 'llm', 'subprocess'];
export { Config };
/** 设置页 / 外部 agent 的数据接口前缀。 */
const API_PATH = '/harness-pilot/api';
/** POST body 上限：这些接口只收小 JSON，超了直接 413，避免被流式 body 拖住。 */
const API_MAX_BODY_BYTES = 64 * 1024;
const API_TRANSPORTS = ['acp', 'headless', 'pty', 'cdp', 'window'];
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 判断「是一个普通对象」——不是 null、不是数组。请求体校验用。 */
function isObjLike(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * **只读**读取一个在线会话的事件日志（`/llm-adapter/redirect-turn` 取证用）。
 *
 * 纪律：读不到就 `available:false` + 原因，**绝不**用本插件自己的记录顶替宿主日志 ——
 * 上一轮的归因缺陷正是因为证据全都取在插件自己的响应层。
 * 用到的宿主面：`ctx.sessions.get(id)`（公开服务）、`session.seq` / `session.eventAt(seq)` /
 * `session.requestHeader()`（`dsh-session` 的 Session 类；`requestHeader()` 是公开方法，
 * `eventAt/seq` 是同类上的只读访问面）。**这两条不是写进契约的公开 API**，所以整条路是可失败的：
 * 失败时如实回报，不假装有日志。
 */
function sessionLogRead(ctxLike, sessionId) {
    const store = ctxLike.get?.('sessions');
    const session = store?.get?.(sessionId);
    if (session === undefined) {
        return { available: false, reason: `ctx.sessions.get("${sessionId}") 拿不到会话（会话不在线，或 id 不存在）` };
    }
    if (typeof session.seq !== 'number' || !Number.isSafeInteger(session.seq) || typeof session.eventAt !== 'function') {
        return { available: false, reason: '会话对象上没有可用的 seq / eventAt —— 读不到事件日志（宿主实现可能已变）' };
    }
    const events = [];
    for (let index = 0; index < session.seq; index += 1) {
        const raw = session.eventAt(index);
        if (raw === null || typeof raw !== 'object')
            continue;
        const event = raw;
        events.push({
            type: typeof event.type === 'string' ? event.type : '(unknown)',
            seq: typeof event.seq === 'number' ? event.seq : index,
            time: typeof event.time === 'number' ? event.time : 0,
            data: event.data,
        });
    }
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
    return { available: true, seq: session.seq, ...(header === undefined ? {} : { header }), events };
}
/** 取一条会话日志里**最后一条** assistant 正文（`/session/probe-turn` 验收用；只读）。 */
function lastAssistantTextOf(log) {
    if (log.available !== true)
        return '';
    const events = Array.isArray(log.events) ? log.events : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== 'assistant/message')
            continue;
        const data = isObjLike(event.data) ? event.data : {};
        const message = isObjLike(data.message) ? data.message : {};
        const content = Array.isArray(message.content) ? message.content : [];
        return content
            .filter((block) => isObjLike(block) && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
    }
    return '';
}
/** 一条会话事件 → **只含结构字段**的摘要（给 `/llm-adapter/redirect-turn` 取证）。
 *
 * ⚠️ 刻意**不返回**会话正文（只给块类型与字符数）：取证要的是「这一轮被记成谁」，
 * 不是把用户会话内容搬到 HTTP 响应里。
 */
function summarizeSessionEvent(event) {
    const base = { type: event.type, seq: event.seq, time: event.time };
    const data = isObjLike(event.data) ? event.data : {};
    if (event.type === 'tool/call') {
        // Tool names are sufficient for acceptance; never expose arguments or prompts here.
        return { ...base, toolName: typeof data.name === 'string' ? data.name : null };
    }
    const asObj = (value) => (isObjLike(value) ? value : {});
    const textChars = (blocks) => {
        if (!Array.isArray(blocks))
            return 0;
        return blocks.reduce((total, block) => total + (isObjLike(block) && typeof block.text === 'string' ? block.text.length : 0), 0);
    };
    if (event.type === 'request/header') {
        const header = asObj(data.header);
        const config = asObj(header.config);
        return {
            ...base,
            reason: data.reason ?? null,
            config: { provider: config.provider ?? null, model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null },
            adapterDefaults: header.adapterDefaults ?? null,
        };
    }
    if (event.type === 'assistant/message') {
        const message = asObj(data.message);
        const source = asObj(message.source);
        const blocks = Array.isArray(message.content) ? message.content : [];
        return {
            ...base,
            source: {
                kind: source.kind ?? null,
                provider: source.provider ?? null,
                model: source.model ?? null,
                hasReplayState: source.replayState !== undefined,
            },
            blockTypes: blocks.map(block => String((isObjLike(block) ? block.type : '') ?? '')),
            textChars: textChars(blocks),
        };
    }
    if (event.type === 'model/selection') {
        return { ...base, selection: { provider: data.provider ?? null, model: data.model ?? null } };
    }
    if (event.type === 'user/message') {
        // 两种形状都兼容：`append('user/message', message)` 与 `append(…, { message })`。
        const source = asObj(asObj(data.message).source ?? data.source);
        return {
            ...base,
            sourceKind: source.kind ?? null,
            form: source.form ?? null,
            summary: source.summary ?? null,
            textChars: textChars(asObj(data.message).content ?? data.content),
        };
    }
    if (event.type === 'assistant/attempt')
        return { ...base, stream: data.stream ?? null };
    if (event.type === 'turn/end')
        return { ...base, status: data.status ?? data.kind ?? null };
    if (event.type === 'request/context') {
        return { ...base, provider: data.provider ?? null, model: data.model ?? null };
    }
    return base;
}
/**
 * 完整进程集合画像：**树内 + 树外**。
 *
 * 起因：§1.15 报的内存数字只覆盖 DSH 根进程树，遗漏了树外的厂商常驻守护进程
 * （实测 `opencode.exe serve --service`，317 MB）。用户要求的正是「按**完整进程集合**实测内存」，
 * 所以那个口径必须补全 —— 不然一个看起来精确的数字反而在误导。
 *
 * 纪律：
 *   · 枚举失败**不抛错**，如实返回 `unknown` + 原因（工具失败不能伪装成 0）；
 *   · 只**报告**树外守护进程，**绝不终结**它们 —— 那是厂商的共享服务，杀它会破坏其语义；
 *   · 一并说明「插件对哪部分负责」。
 */
async function processInventory() {
    const run = (file, args) => new Promise((resolve) => {
        try {
            execFile(file, [...args], { windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 }, (error, stdout) => {
                resolve(error !== null && error !== undefined ? undefined : String(stdout));
            });
        }
        catch {
            resolve(undefined);
        }
    });
    const raw = await run('tasklist', ['/FO', 'CSV', '/NH']);
    if (raw === undefined) {
        return {
            available: false,
            reason: '无法枚举进程（tasklist 不可用或超时）—— 按「未知」处理，**不得**当成 0',
            responsibleFor: '本插件只对自己拉起的进程树负责',
        };
    }
    // CSV: "name","pid","session","session#","memUsage"
    const rows = [];
    for (const line of raw.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)","[^"]*","[^"]*","([\d,]+) K"$/.exec(line.trim());
        if (m === null)
            continue;
        rows.push({ name: m[1] ?? '', pid: Number(m[2]), memKB: Number((m[3] ?? '').replace(/,/g, '')) });
    }
    // 厂商常驻守护进程（已知会脱离父进程长驻，且**不属于**本插件的进程树）。
    const VENDOR_DAEMON = /^(opencode|WorkBuddy|WorkBuddyAI|qodercli|qoderclicn|qodersec|agy|kimi|cursor)\.exe$/i;
    const daemons = rows.filter(r => VENDOR_DAEMON.test(r.name));
    const daemonMB = Math.round(daemons.reduce((s, r) => s + r.memKB, 0) / 1024 * 10) / 10;
    return {
        available: true,
        totalProcesses: rows.length,
        totalMB: Math.round(rows.reduce((s, r) => s + r.memKB, 0) / 1024),
        /** 树外厂商常驻进程：**可能**与本插件有关，也可能是厂商自己拉起的，无法仅凭此处区分。 */
        vendorProcesses: daemons
            .sort((a, b) => b.memKB - a.memKB)
            .slice(0, 20)
            .map(r => ({ name: r.name, pid: r.pid, mb: Math.round(r.memKB / 1024 * 10) / 10 })),
        vendorProcessCount: daemons.length,
        vendorTotalMB: daemonMB,
        responsibleFor: '本插件只对自己拉起的进程树负责（实测任务结束后 0 残留）。'
            + '树外这些是**厂商自己的常驻进程**（例如 opencode 的 `serve --service` 共享守护进程）：'
            + '本插件**不会**终结它们（会破坏其共享语义），但也不会假装它们不存在 —— 统计内存时必须一并计入。',
        caveat: '无法仅凭进程名判断这些树外进程是本次会话造成的还是厂商自行拉起的常驻服务；'
            + '因此这里只报告事实与占用，不做归因。',
    };
}
/** 用户主目录（账号档案目录以它为基准）。 */
function homeDir() {
    return process.env.USERPROFILE ?? process.env.HOME ?? '';
}
// ── 「实际加载的是哪一份代码」自检 ──────────────────────────────────
// 起因：本项目两次栽在 **ESM 模块缓存**上 —— 磁盘上 `lib/*.js` 已是新代码，
// 但运行时加载的是很久以前 import 过的旧模块（HMR 重跑入口模块时复用了缓存）。
// 表现极具迷惑性：改动「写了却没生效」，且看不出任何报错。
// 用户的第一条要求就是「不要把本机旧源码当作正在运行的版本」—— 那就必须**可检查**。
//
// 做法：模块**首次被 import 时**读出自身文件哈希并记在内存；请求时再读一次磁盘哈希。
// 不一致 ⇒ 当前进程跑的是旧代码，改动尚未生效，必须重启/强制重载后再验收。
// `transports/headless.js` / `config.js` 是 S 路发现的**同一类盲区**：`anyStale=false`
// 曾经完全没覆盖它们，于是「磁盘哈希与已加载一致」这句话对这两个文件是**空话**
// （S 路因此只能改做行为取证）。路径形态与 `join(here, name)` 一致：`here` = `lib/`，
// 因此子目录条目写成正斜杠相对路径（`path.join` 在 Windows 上会归一成反斜杠）。
//
// 2026-10-14 扩项（用户点名）：`catalog-edit.js` / `provider.js` / `transports/acp.js` /
// `mcp-bridge.js` 此前**不在清单里** ⇒ 对这四个文件 `anyStale=false` 什么也证明不了
// （探针只能靠行为取证）。现在它们是清单成员，`anyStale=false` 才真的覆盖到。
//
// ⚠️ 2026-10-14 第二次扩项（**穷尽式**，本轮集成）：此前的「按点名逐个补」永远会漏 ——
// 历史上 `federation/**`、`models.js`、`mcp-bridge-proxy.js`、`task-tools.js` 都当过盲区，
// 而盲区里的文件恰恰是最新的（`federation/providers.js` 就是例子）。所以改成一条**可判定的规则**：
//
//     SELF_MODULES = 本插件**服务端运行期**的全部构建产物 = `lib/**/*.js` 去掉浏览器侧 `client.js`。
//
// 于是「清单外还有相关模块」这类缺口在定义上不再存在：只要 `lib/` 里多出一个 `.js`，
// 它就必须出现在这里，否则本注释与清单的一致性可以被机械核对（见下）。
// 机械核对：`Get-ChildItem lib -Recurse -File -Filter *.js | ? Name -ne client.js` 的名称集合
// 与本清单**集合相等**（43 项 —— 本轮加入 `account-managers.js`（Buddy/agy 外部账号
// 管理器接线）；40 项时加入了 `overview-description.js`；39 项时该等式已成立，
// 核对方式与结果见 `docs/verified/team-routing.md`：**逐项**比对「清单里的每个名字在磁盘上
// 存在」+「磁盘上的每个 .js 都在清单里」+「loaded 哈希 == 独立算出的 sha256」，
// 用来排除「条目在、但指向一个不存在的文件」这种**假覆盖**）。
// ⚠️ 加条目的同时必须同步 `src/processpool.ts` 顶部那段**逐字列出清单**的说明，
// 否则那句说明立刻变成新的滞后文案（这正是上一路有意不加的原因）。
const SELF_MODULES = [
    'subagent-cleanup.js',
    // 入口与核心
    'index.js',
    'config.js',
    'settings.js',
    'types.js',
    'helper.js',
    'text.js',
    'launcher.js',
    'remedies.js',
    'wake.js',
    // 本轮新模块（持久原生会话 v2+）：loaded 自检必须覆盖（缺项=新模块跑飞也期望被发现）
    'native-sessions.js',
    'receipt-outbox.js',
    'transports/native-cli.js',
    // v4.1 机械判据补齐：以下 7 个模块此前漏在清单外（loaded 自检覆盖不到）
    'harness-groups.js',
    'harness-llm.js',
    'model-request.js',
    'model-sources.js',
    'model-visibility.js',
    'session-identity.js',
    'subagent-models.js',
    // 任务/会话/工具面
    'tasks.js',
    'task-tools.js',
    'sessions.js',
    'tools.js',
    'llm-adapter.js',
    'processpool.js',
    'provider.js',
    // 外部账号管理器（Buddy Switch 本机服务 / agy-switch）：共享槽租约与切换协调的接线面
    'account-managers.js',
    'workbuddy-isolation.js',
    // 团队路由（**产品**团队成员身份冻结表；`harness_spawn_teammate` 的唯一权威处）
    'team-routing.js',
    // 「账号 → 目标」的**唯一来源**（四个产品入口共用；单独成模块是为了避免
    // `index.ts ↔ team-routing.ts` 的循环 import —— 理由见该文件头）
    'account-target.js',
    // 桥接（含新加的 stdio 代理：它是被 spawn 的子进程脚本，同样是本插件的运行期产物）
    'mcp-bridge.js',
    'mcp-bridge-proxy.js',
    // 模型/目录
    'models.js',
    'native-model-catalog.js',
    'catalog-edit.js',
    // `/overview` 人类 `description` 的**输出端脱敏**纯函数（`targets[].description` 里的
    // 档案 id 一律映射成 `acct:…`；**只作用于人类描述**，机器字段 `name`/`models[]`/
    // `tasks[].target|harnessId` 逐字不变 —— 判据与正负控见 `probe/verify-overview-description-offline.mjs`）
    'overview-description.js',
    // 传输层
    'transports/headless.js',
    'transports/acp.js',
    'transports/cdp.js',
    'transports/pty.js',
    'transports/window.js',
    // 联邦（四态发现 / 账号 / 注册表 / 池 / 自动切换 / 额度 / 切换账本）
    'federation/accounts.js',
    'federation/autoswitch.js',
    'federation/binding.js',
    // Buddy Switch 桌面版落盘的**官方积分快照**只读读取（不含令牌；HTTP 通道只在 webui 构建里存在）
    'federation/buddy-quota.js',
    'federation/catalog.js',
    'federation/coordination.js',
    'federation/pool.js',
    'federation/poolconfig.js',
    'federation/providers.js',
    'federation/quota.js',
    'federation/registry.js',
    'federation/switchlog.js',
    'federation/types.js',
];
function hashFile(file) {
    try {
        return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
    }
    catch {
        return '(unreadable)';
    }
}
/** 首次 import 时快照：本进程**实际加载**的每个模块内容哈希。 */
const LOADED_AT_IMPORT = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = {};
    for (const name of SELF_MODULES)
        out[name] = hashFile(join(here, name));
    return out;
})();
/** 请求时对比：磁盘现在是什么、进程加载的是什么。 */
function loadedCodeReport() {
    const here = dirname(fileURLToPath(import.meta.url));
    const modules = SELF_MODULES.map((name) => {
        const loadedHash = LOADED_AT_IMPORT[name] ?? '(unknown)';
        const diskHash = hashFile(join(here, name));
        return { name, loadedHash, diskHash, stale: loadedHash !== diskHash };
    });
    const anyStale = modules.some(m => m.stale);
    return {
        at: new Date().toISOString(),
        modules,
        anyStale,
        note: anyStale
            ? '⚠️ 有模块的磁盘内容与**本进程实际加载**的内容不一致：当前跑的是旧代码（ESM 模块缓存）。'
                + '受影响的改动尚未生效，请重启 DSH 或强制重新加载插件后再验收 —— 不要拿运行结果当新代码的效果。'
            : '磁盘与已加载内容一致：本进程跑的就是当前源码。',
    };
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
export function clearStaleRoutes(webServer, path) {
    const cleaned = [];
    const holder = webServer;
    for (const tableName of ['exact', 'prefixes', 'upgrades']) {
        const table = holder[tableName];
        if (table === null || table === undefined)
            continue;
        if (typeof table.keys !== 'function' || typeof table.delete !== 'function')
            continue;
        for (const key of [...table.keys()]) {
            if (!String(key).startsWith(path))
                continue;
            table.delete(key);
            cleaned.push(`${tableName}[${String(key)}]`);
        }
    }
    return cleaned;
}
/**
 * 路由世代令牌。必须满足两条（都是本机实测踩出来的）：
 *   1. 放在**模块实例之外** —— HMR 每次重载都新建模块实例，模块级计数器会重置；
 *   2. **不能以 webServer 对象为键** —— `ctx.get('webServer')` 在每个 fiber 里返回
 *      不同的门面对象，按对象身份做键区分不了世代。
 * 所以用 globalThis 上一个与键无关的单调计数器。
 */
const API_ROUTE_STATE_KEY = Symbol.for('dsh-external.dsh-harness-pilot.apiRouteState');
const apiRouteState = (globalThis[API_ROUTE_STATE_KEY] ??= { generation: 0 });
/**
 * 注册 `/harness-pilot/api` 前缀路由，失败时自愈：
 *   1. `register` 抛错（多半是中断重载留下的同路径残留）→ 清掉残留；
 *   2. 再试一次；
 *   3. 还是失败 → 用 warn 把两次的原始错误都打出来（不吞）。
 *
 * 另外做两件宿主 API 不保证的事：
 *   · **世代守卫**：`register()` 返回的 disposer 是按 **path** 删除的（宿主内部表以
 *     path 为键，分不清世代）。插件被重新 apply 时新 fiber 先注册、旧 fiber 的 disposer
 *     迟到执行，会把新注册的这条一起删掉。守卫让陈旧代的 disposer 退化为 no-op。
 *   · **注册后核对**：`register()` 返回 disposer 只说明没抛错，不代表请求能命中；
 *     这里立刻查一次前缀表，不在就给出明确 warn。
 *
 * @returns 注册成功时为该路由的 disposer（带世代守卫），否则 undefined。
 */
export function registerApiRoute(webServer, handler, logger) {
    const route = { kind: 'prefix', path: API_PATH, handler };
    const mine = ++apiRouteState.generation;
    const guard = (dispose) => () => {
        if (apiRouteState.generation !== mine)
            return; // 陈旧代：绝不能删掉现行路由
        dispose();
    };
    const verify = (dispose) => {
        const table = webServer.prefixes;
        if (typeof table?.has === 'function' && table.has(API_PATH) === false) {
            logger?.warn?.(`harness-pilot: route "${API_PATH}" is NOT in the prefix table right after a successful register()`);
        }
        return guard(dispose);
    };
    try {
        return verify(webServer.register(route));
    }
    catch (firstError) {
        const cleaned = clearStaleRoutes(webServer, API_PATH);
        logger?.warn?.(`harness-pilot: register("${API_PATH}") failed (${describe(firstError)}); `
            + `cleared stale route entries: ${cleaned.length > 0 ? cleaned.join(', ') : 'none'}; retrying once`);
        try {
            return verify(webServer.register(route));
        }
        catch (secondError) {
            logger?.warn?.(`harness-pilot: settings + write api route "${API_PATH}" is STILL not registered after cleanup: `
                + `${describe(secondError)} (first error was: ${describe(firstError)}; cleaned: `
                + `${cleaned.length > 0 ? cleaned.join(', ') : 'none'}). The settings page and the HTTP api will 404 until this is fixed; `
                + 'reloading the plugin (or dev_clear_routes with prefix "/harness-pilot") repairs it.');
            return undefined;
        }
    }
}
/** 读 POST body：有上限、JSON 解析失败与非法形状都变成 400（不抛给上层）。 */
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > API_MAX_BODY_BYTES) {
            // 继续把连接读干（客户端可能还在写），但不留数据；真的失控就直接断开。
            overflow = true;
            chunks.length = 0;
            if (size > API_MAX_BODY_BYTES * 8) {
                req.destroy();
                return { ok: false, status: 413, error: `request body exceeds ${API_MAX_BODY_BYTES} bytes` };
            }
            continue;
        }
        chunks.push(buffer);
    }
    if (overflow)
        return { ok: false, status: 413, error: `request body exceeds ${API_MAX_BODY_BYTES} bytes` };
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0)
        return { ok: true, value: {} };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, status: 400, error: `invalid JSON body: ${describe(error)}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, status: 400, error: 'body must be a JSON object' };
    }
    return { ok: true, value: parsed };
}
/** 令牌常量时间比较（长度不同直接判否，避免 timingSafeEqual 抛错）。 */
function tokensMatch(provided, expected) {
    if (provided.length !== expected.length)
        return false;
    let diff = 0;
    for (let index = 0; index < provided.length; index += 1) {
        diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    return diff === 0;
}
export function createApiHandler(registry, config, extras = {}) {
    const sleep = async (ms) => {
        if (ms > 0)
            await new Promise(resolve => { setTimeout(resolve, ms); });
    };
    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = (req.method ?? 'GET').toUpperCase();
        const json = (status, value) => {
            if (res.writableEnded)
                return;
            const body = JSON.stringify(value);
            res.statusCode = status;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(body);
        };
        try {
            // ── 令牌守卫（见函数头注释）──
            const expected = config.apiToken;
            if (expected.length > 0) {
                const raw = req.headers['x-harness-pilot-token'];
                const provided = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
                if (!tokensMatch(provided, expected)) {
                    json(401, { error: 'unauthorized: this harness-pilot api requires a matching x-harness-pilot-token header' });
                    return;
                }
            }
            /** 解析 target（名字或省略=默认目标）；未知目标回 400 并返回 undefined。 */
            const targetOr400 = (raw) => {
                const wanted = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
                try {
                    return registry.target(wanted);
                }
                catch (error) {
                    json(400, { error: describe(error) });
                    return undefined;
                }
            };
            const methodNotAllowed = (allowed) => {
                res.setHeader('allow', allowed);
                json(405, { error: `method ${method} is not allowed on ${url.pathname}; use ${allowed}` });
            };
            // ── GET /overview：目标画像 + 活跃会话 + DSH 供应商模型 ──
            if (url.pathname === `${API_PATH}/overview`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                // ?models=1 会去问每个 harness 的模型列表（起进程，慢），默认只回静态信息。
                const withModels = url.searchParams.get('models') === '1';
                const overview = { ...(await registry.overview({ models: withModels })) };
                if (Array.isArray(overview.targets)) {
                    const seeds = extras.accountSeeds?.() ?? ACCOUNT_SEEDS;
                    overview.targets = overview.targets.map((target) => {
                        if (target === null || typeof target !== 'object')
                            return target;
                        const record = target;
                        return typeof record.description === 'string'
                            ? { ...record, description: redactOverviewDescription(record.description, seeds) }
                            : target;
                    });
                }
                // 设置页要用的运行时设置与最近任务一并带上（缺省省略，老客户端不受影响）。
                if (extras.settings !== undefined)
                    overview.runtimeSettings = extras.settings();
                if (extras.tasks !== undefined) {
                    /**
                     * 任务列表附带**身份对照**（请求值 vs 实际回报）。
                     *
                     * 对照逻辑在 `task-tools.ts` 的 `compareIdentity()`（**唯一实现**，与回执、工具面同一份），
                     * 这里只把结构化结果 + 一行结论带给界面 —— 客户端不重新实现一遍比对。
                     * 目的（需求 ⑧）：请求值 ≠ 实际值时**提示**，未知时**说未知**，别让「请求了什么」冒充「用了什么」。
                     */
                    overview.tasks = extras.tasks.list().slice(0, 30).map((view) => {
                        const comparison = compareIdentity(view);
                        return {
                            ...view,
                            identity: {
                                verdict: identityVerdictLine(comparison),
                                evaluated: comparison.evaluated,
                                compared: comparison.compared,
                                differences: comparison.differences,
                                missing: comparison.missing,
                                recorded: comparison.recorded,
                            },
                        };
                    });
                }
                // ── 「一条 harness」的索引（折叠后的用户可见单位）──
                // 用户要求：CLI / IDE / TUI / 桌面端 / 账号配方折叠成**一条**，只有「国内版 / 国际版」
                // 才拆成两条（`src/harness-groups.ts` 是唯一一份分类实现，离线探针逐条断言）。
                // ⚠️ 这里**只给索引**（哪条 harness 由哪些目标/账号组成、能不能派发），
                // 模型与账号明细仍由既有出口（`/overview?models=1`、`/api/accounts`、`/api/models`）提供 ——
                // 同一能力多出口不一致是本项目栽过四次的老坑，不再复制第二份数据。
                try {
                    const seedsNow = extras.accountSeeds?.() ?? ACCOUNT_SEEDS;
                    const groups = buildGroupIndex(config.resolvedTargets, seedsNow.map((seed) => seed.harnessId), seedsNow.map((seed) => seed.id));
                    /**
                     * 每条 harness 带一份**子代理白名单摘要**（服务端在这里读一次）。
                     *
                     * 为什么要放进概览（而不是只让客户端异步去问）：设置页首屏就要显示
                     * 「该 harness 里有多少模型、其中多少个已被授权给子代理」，异步拉取会让首屏空一截；
                     * 而**明细**（590 个候选的勾选清单）仍走按需的 `/subagent-model-selection` —— 分层而非重复。
                     */
                    const facade = extras.subagentModels;
                    if (facade !== undefined) {
                        const snapshot = facade.read();
                        const known = new Set(snapshot.allowed.map((route) => `${route.provider}\u0000${route.model}`));
                        const candidates = facade.candidates();
                        const perProvider = new Map();
                        for (const candidate of candidates) {
                            const row = perProvider.get(candidate.provider) ?? { candidates: 0, allowed: 0 };
                            row.candidates += 1;
                            if (known.has(`${candidate.provider}\u0000${candidate.model}`))
                                row.allowed += 1;
                            perProvider.set(candidate.provider, row);
                        }
                        for (const group of groups) {
                            const row = perProvider.get(String(group.providerId)) ?? { candidates: 0, allowed: 0 };
                            group.subagent = {
                                available: snapshot.available,
                                writable: facade.settingsAvailable,
                                reason: snapshot.reason,
                                revision: snapshot.revision,
                                enabled: snapshot.enabled,
                                candidateCount: row.candidates,
                                allowedCount: row.allowed,
                            };
                        }
                    }
                    // ── 每条 harness 的**账号与认证边界** ──
                    // 用户要求（④）：「Antigravity 的共享认证槽边界**如实说明**」。
                    // 此前这条边界只挂在**已存在的账号档案**上（`/api/accounts[].isolation`），
                    // 于是「还没有任何账号」的 harness —— 恰好就是 Antigravity 这种**不该也不能**建账号的 —— 
                    // 在设置页看不到任何说明，只会看到「需要登录但还没有账号档案」，容易被读成「去建一个就好」。
                    // 现在按组附带：harnessId 由该组的成员目标经 `seedForTarget()` 推得（与账号模块同一张表）。
                    for (const group of groups) {
                        let profile;
                        let viaTarget = '';
                        for (const name of [...group.dispatchable, ...group.members]) {
                            const seedId = seedForTarget(name)?.id;
                            if (seedId === undefined)
                                continue;
                            profile = isolationProfileFor(seedId);
                            viaTarget = name;
                            break;
                        }
                        // ⚠️ 没有任何成员能推导出 harness 种子（例如 command-code / cursor / gemini / qwen / minimax：
                        // 它们只有目标、没有档案种子）时**不能留空** —— 空白会被读成「这条 harness 没有账号边界」。
                        // 用 `isolationProfileFor(group.key)` 的**兜底对象**：它如实说「没有任何隔离实测记录」+
                        // 「隔离能力未知时默认拒绝新增档案」（默许等于伪造支持）。
                        if (profile === undefined) {
                            profile = isolationProfileFor(group.key);
                            viaTarget = '';
                        }
                        ;
                        group.isolation = {
                            harnessId: profile.harnessId,
                            viaTarget,
                            configDirIsolated: profile.configDirIsolated,
                            authStoreIsolated: profile.authStoreIsolated,
                            mechanism: profile.mechanism,
                            launchKind: profile.launchKind,
                            mayAddAccounts: profile.mayAddAccounts,
                            disclosure: profile.disclosure,
                            ...('refuseReason' in profile && typeof profile.refuseReason === 'string' ? { refuseReason: profile.refuseReason } : {}),
                            evidence: profile.evidence,
                            limits: profile.limits,
                        };
                    }
                    // ── 每条 harness 的**会话选择器可见性摘要**（2026-10-15）──
                    // 行头要显示「选择器显示 M / 共 N」就得在概览里算一次；明细与写操作走
                    // `/api/model-visibility` —— 同一份 `pickerProviderSummary`，客户端不重写第二份。
                    const mvFacade = extras.modelVisibility;
                    if (mvFacade !== undefined) {
                        const mvDoc = mvFacade.read();
                        const perProvider = new Map(mvFacade.providers().map((entry) => [entry.providerId, pickerProviderSummary(mvDoc, entry.providerId, entry.models)]));
                        for (const group of groups) {
                            const summary = perProvider.get(String(group.providerId));
                            if (summary !== undefined) {
                                group.picker = {
                                    groupHidden: summary.groupHidden,
                                    limit: summary.limit,
                                    total: summary.total,
                                    visible: summary.visible,
                                    hiddenCount: summary.hiddenCount,
                                };
                            }
                        }
                    }
                    overview.harnessGroups = groups;
                }
                catch (error) {
                    // 分组只是索引：失败也不能把整个概览打挂（但要说出来，不静默）。
                    overview.harnessGroupsError = `分组索引生成失败：${error instanceof Error ? error.message : String(error)}`;
                }
                json(200, overview);
                return;
            }
            // ── GET /registry[?measure=1]：P1 联邦注册表（真实入口/版本/通道/能力）──
            if (url.pathname === `${API_PATH}/registry`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.registry === undefined) {
                    json(503, { error: 'federation registry is not mounted in this composition' });
                    return;
                }
                // 默认**不** spawn（秒回，版本标为「未测」）；?measure=1 才真去测版本。
                // 之所以默认不测：一次全量版本探测要起十几个进程，不能让设置页首屏卡住。
                const measure = url.searchParams.get('measure') === '1';
                const records = await extras.registry.list(measure);
                json(200, {
                    measure,
                    state: extras.registry.state(),
                    count: records.length,
                    harnesses: records,
                    generatedAt: new Date().toISOString(),
                });
                return;
            }
            // ── GET /diag/processes：完整进程集合画像（树内 + 树外）──
            // 补上 §1.15 遗漏的口径：只报 DSH 树内内存会漏掉厂商常驻守护进程。
            if (url.pathname === `${API_PATH}/diag/processes`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                try {
                    json(200, await processInventory());
                }
                catch (error) {
                    json(500, { available: false, reason: describe(error) });
                }
                return;
            }
            // ── GET /diag/loaded：「现在跑的到底是哪一份代码」自检 ──
            // 磁盘哈希 vs 本进程首次 import 时快照的哈希。不一致 ⇒ 跑的是旧模块（ESM 缓存），
            // 改动尚未生效。直接服务于「不要把本机旧源码当作正在运行的版本」。
            if (url.pathname === `${API_PATH}/diag/loaded`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                json(200, { ...loadedCodeReport(), pluginVersion: pluginVersion() });
                return;
            }
            // ── GET /diag/processpool：并发闸门 / owned 进程 / 取消 / 空闲回收的只读快照 ──
            // 「我拉起了哪些进程、它们何时起止、取消有没有真的终止、空闲回收前后完整进程集合差多少」
            // 都能在这里看到；数据由池自己写（`ProcessPool.describe()`），这里只读、不触发任何动作。
            // `policy.maxConcurrency` 就是「设置页 maxConcurrent → 池上限」这条接线的现场读数。
            if (url.pathname === `${API_PATH}/diag/processpool`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const pool = extras.processPool?.();
                if (pool === undefined) {
                    json(503, { error: 'process pool is not mounted in this composition' });
                    return;
                }
                json(200, { ...pool.describe(), events: pool.eventLog() });
                return;
            }
            // ── Path A：pilot-cli LLM 适配器（目录可见性 / 闸门 / 代价披露 / 真实一轮）──
            // 「选择 pilot-cli 不得写入部署默认模型」是用户设定的**硬性前提**，所以闸门状态、
            // 两条自检、profile 哈希、以及选择器读的那个目录分组都必须能**从外部**取证。
            if (url.pathname === `${API_PATH}/llm-adapter`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const adapter = extras.llmAdapter;
                if (adapter === undefined) {
                    json(503, { error: 'the pilot-cli llm adapter is not mounted in this composition' });
                    return;
                }
                let catalog;
                try {
                    catalog = await adapter.modelCatalog();
                }
                catch (error) {
                    catalog = { available: false, reason: describe(error) };
                }
                json(200, {
                    route: PILOT_CLI_ROUTE,
                    registration: adapter.registration(),
                    registeredProviders: adapter.listProviders(),
                    /**
                     * **每个 harness 一条 provider** 的现场规格 + 逐步诊断。
                     *
                     * 为什么带逐步诊断：`/overview` 的 `dsh.providers` 走宿主的 `listModels`，任一目标解析抛错
                     * 都会被 `listDshModels` 的 per-provider try/catch 折成 `models: []` —— 看起来只是
                     * 「这个 harness 没有模型」，实际可能是某一条目标解析失败。这里逐步 try/catch 并**如实回报**
                     * （哪条目标、什么错），避免把「解析失败」读成「该 CLI 没有模型」。
                     */
                    harnessRoutes: (() => {
                        try {
                            return buildHarnessLlmProviders(config.resolvedTargets, (extras.accountSeeds?.() ?? ACCOUNT_SEEDS).map((seed) => seed.harnessId), (extras.accountSeeds?.() ?? ACCOUNT_SEEDS).map((seed) => seed.id)).map((spec) => ({
                                id: spec.id,
                                name: spec.name,
                                groupId: spec.groupId,
                                // ── 逐目标模型计数 / 状态 / 错误（三者分离，见下）──
                                ...(() => {
                                    const counts = {};
                                    const states = {};
                                    const errs = {};
                                    for (const name of spec.targets) {
                                        try {
                                            const error = extras.modelsErrorFor?.(name);
                                            if (error !== undefined) {
                                                states[name] = 'error';
                                                errs[name] = error;
                                                continue;
                                            }
                                            const models = extras.modelsFor?.(name);
                                            if (Array.isArray(models)) {
                                                counts[name] = models.length;
                                                states[name] = 'synced';
                                            }
                                            // 没同步到 ⇒ **不给数字**（未知即未知；绝不用 -1 之类哨兵值冒充计数）。
                                            else
                                                states[name] = 'unknown';
                                        }
                                        catch (error) {
                                            states[name] = 'error';
                                            errs[name] = describe(error);
                                        }
                                    }
                                    return {
                                        /**
                                         * 逐目标的**模型计数**：只放数字。
                                         *
                                         * ⚠️ 2026-10-15 修正形状缺陷：这里以前是 `number | string`，失败时塞 `ERR <一大段多行文本>`、
                                         * 未测量时塞 `-1`。后果有两个：
                                         *   · 一张**计数表**里混进了可长达数百字的错误正文（WorkBuddy CN 的 `codebuddy` 实测如此），
                                         *     消费者无法区分「计数」与「错误」；
                                         *   · `-1` 是**编造的数字**：没测量过就没有计数，不该有负数冒充。
                                         * 现在：计数只放**真的同步到的**数字；没同步到就**不出现**该键，并在
                                         * `modelStates` 里写 `unknown` / `error`，错误正文单独进 `modelErrors`。
                                         */
                                        modelsPerTarget: counts,
                                        modelStates: states,
                                        ...(Object.keys(errs).length === 0 ? {} : { modelErrors: errs }),
                                    };
                                })(),
                                targets: spec.targets,
                                primaryTarget: spec.primaryTarget,
                                accountPinned: spec.accountPinned,
                            }));
                        }
                        catch (error) {
                            return { error: describe(error) };
                        }
                    })(),
                    gate: adapter.gate(),
                    /**
                     * 模型发现的**缓存与落盘**诊断（只读）。
                     *
                     * 为什么值得单独一格：这一层出过两次「看起来一样、其实没生效」的故障
                     * （重载后只剩 cli-default；落盘回填因**缓存键不一致**读不到）。把
                     * 「落盘多少条 / 回填多少条 / 当前内存多少条」摆出来，就不用靠猜。
                     */
                    modelCache: { ...modelCacheDiag },
                    // `listener` = **响应层**（llm/stream）。本轮它已移除（那一层改道必然归因不实）；
                    // `requestLayer` = 现在真正在做改道的那一层（agent/request），含计数器与最近一次判定。
                    listener: adapter.listener(),
                    requestLayer: adapter.requestLayer(),
                    // `?sessionId=…` 时**现场读一次**该会话日志里的显式选择（只读）。用途：核对
                    // 「用户显式选过 pilot-cli」与「本插件改道残留」的区分依据（决定保持还是恢复）。
                    ...(url.searchParams.get('sessionId') === null
                        ? {}
                        : { picks: adapter.picks(url.searchParams.get('sessionId') ?? '') }),
                    targets: adapter.targets(),
                    catalog,
                    profile: adapter.profileEvidence(),
                    records: adapter.records(),
                    costDisclosure: COST_DISCLOSURE,
                    notVerified: [
                        '是否有**其它**路径能把 pilot-cli 写进部署默认值（例如设置页某个「设为默认」按钮）：未查；闸门只覆盖 agentDefaultModel.saveSelection。',
                        '另一个插件同时替换同一个方法时的胜负：未验证（本插件只做了自身幂等）。',
                        '未在浏览器里确认选择器分组的渲染效果（客户端工件需刷新页面）。',
                        // ⚠️ 本条**曾**写「`client/client.js` 与 `src/federation/binding.ts` 的 `scopeNoteFor`
                        // 里同名说法仍是上一版机制名，需要下一轮改这两处文案」——那句**已经过时**：
                        // 两处本轮都已改完，现在写的都是「请求层 `agent/request` 瀑布改写」。
                        // 机制名只有一个：**请求层 `agent/request` 瀑布改写**，**不是** `llm/stream` 改道
                        // （那一版在响应层短路，而请求落盘早于响应层 ⇒ 归因必然不实，已移除）。
                        '**界面/说明文案的机制名**：`client/client.js` 的模型选择器座位句与 `src/federation/binding.ts`'
                            + '的 `scopeNoteFor` **本轮都已改完**，两处写的都是「请求层 `agent/request` 瀑布改写」'
                            + '（旧的「绑定驱动的 `llm/stream` 改道已生效」已不再出现在这两处）。'
                            + '剩余**未验证**的只是渲染：没有在浏览器里确认刷新页面后看到的就是这段新文案'
                            + '（client 工件需刷新页面才会换）。',
                        '**改道的 live 证据覆盖两条分支**：①「绑定 → 宿主路由 → 改道」与 ②「解除绑定 → 残留恢复」，'
                            + '都用 POST /llm-adapter/redirect-turn 真开了一轮并**独立读宿主落盘转录**取证'
                            + '（probe/verify-llm-adapter-attribution.mjs，9/9 PASS）。'
                            + '**未**做 live 实测的是「绑定之后用户又显式选过模型 ⇒ 让路」这条分支 —— 只有离线判据'
                            + '（probe/verify-llm-adapter-unit.mjs 的请求层 16 例）。',
                        '请求层改道依赖 `agent/request` 瀑布的 payload.agent.id 与 `ctx.sessions.get(id)` 上的'
                            + '`eventAt/seq`（只读会话日志，用来区分「用户显式选过 pilot-cli」与「本插件改道残留」）：'
                            + '两者都不是**写成契约**的公开面，宿主实现若变，判定会退化成「读不到 ⇒ 保持不动」'
                            + '（fail-safe：不会误改请求，但残留恢复与选择器让路会失效）。此时 requestLayer.picks.readable=false 可见。',
                        '旧的会话日志**不追改**：本轮之前由响应层改道产生的轮次，其 source 仍记着宿主路由（历史无法改写）。'
                            + '本轮之后不再产生这类记录。',
                    ],
                });
                return;
            }
            // ── POST /llm-adapter/gate-test：闸门自检（**两条分支都不写 profile**）──
            // blocked   = 用与选择器**同一个服务/方法/形状**的真实调用，应被拦住；
            // delegated = 非自有形状转发到**真原方法**（原方法自己抛错，早于任何写文件）⇒ 证明没把写入路径整条打断。
            if (url.pathname === `${API_PATH}/llm-adapter/gate-test`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const adapter = extras.llmAdapter;
                if (adapter === undefined) {
                    json(503, { error: 'the pilot-cli llm adapter is not mounted in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const action = body.value.action === 'delegated' ? 'delegated' : 'blocked';
                try {
                    json(200, await adapter.gateSelfTest(action));
                }
                catch (error) {
                    json(500, { error: describe(error) });
                }
                return;
            }
            // ── POST /llm-adapter/select-model：走**真实**的选择器服务端入口选本路由 ──
            // 前后比 profile 哈希与 mtime：证明「选择 pilot-cli 之后 profile 未被改写」。
            if (url.pathname === `${API_PATH}/llm-adapter/select-model`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const adapter = extras.llmAdapter;
                if (adapter === undefined) {
                    json(503, { error: 'the pilot-cli llm adapter is not mounted in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const provider = typeof body.value.provider === 'string' && body.value.provider.trim().length > 0
                    ? body.value.provider.trim()
                    : PILOT_CLI_ROUTE;
                const model = typeof body.value.model === 'string' && body.value.model.trim().length > 0
                    ? body.value.model.trim()
                    : (adapter.targets()[0] ?? '');
                if (model.length === 0) {
                    json(400, { error: 'no advertised model to select; pass body.model explicitly' });
                    return;
                }
                try {
                    const testSessionId = typeof body.value.sessionId === 'string' && body.value.sessionId.trim().length > 0
                        ? body.value.sessionId.trim()
                        : undefined;
                    json(200, await adapter.selectModelThroughPicker({
                        provider,
                        model,
                        ...(testSessionId === undefined ? {} : { sessionId: testSessionId }),
                    }));
                }
                catch (error) {
                    json(500, { error: describe(error) });
                }
                return;
            }
            // ── POST /llm-adapter/stream：经**真实注册的路由**跑一轮（会真的调用外部 CLI）──
            // ⚠️ 会消耗额度。空文本一律 ok=false：退出码 0 / 握手成功**都不算**验收。
            if (url.pathname === `${API_PATH}/llm-adapter/stream`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const adapter = extras.llmAdapter;
                if (adapter === undefined) {
                    json(503, { error: 'the pilot-cli llm adapter is not mounted in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const model = typeof body.value.model === 'string' ? body.value.model.trim() : '';
                // `provider` 可选：省略 = 历史 `pilot-cli`；给了 `harness-*` 就走「一个 harness 一条 provider」。
                const provider = typeof body.value.provider === 'string' && body.value.provider.trim().length > 0
                    ? body.value.provider.trim()
                    : undefined;
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (model.length === 0 || prompt.trim().length === 0) {
                    json(400, { error: 'body.model and body.prompt are required (non-empty strings)' });
                    return;
                }
                const sessionId = typeof body.value.sessionId === 'string' && body.value.sessionId.trim().length > 0
                    ? body.value.sessionId.trim()
                    : undefined;
                const timeoutMs = typeof body.value.timeout_ms === 'number' && Number.isFinite(body.value.timeout_ms) && body.value.timeout_ms > 0
                    ? body.value.timeout_ms
                    : undefined;
                try {
                    json(200, await adapter.streamThroughRoute({
                        model,
                        ...(provider === undefined ? {} : { provider }),
                        prompt,
                        ...(sessionId === undefined ? {} : { sessionId }),
                        ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    }));
                }
                catch (error) {
                    json(500, { error: describe(error) });
                }
                return;
            }
            // ── 子代理模型白名单（宿主 `subagent-model-selection-settings.allowedModels`）──
            //
            // 为什么要由本插件管：会话选择器只要注册了 provider 就能看见模型，而**子代理**那条路
            // 还要过宿主的一道**精确串白名单**（`dsh-tool-subagent/lib/index.js:91-98`，不匹配就抛
            // `child LLM route "…" is not allowed for this Session`）。用户要求「该 harness 中的模型，
            // 能够选择哪些在会话和子代理选择中被选择」⇒ 必须能读、能改、且改完能回读核验。
            // 纪律：只动 `allowedModels` 这一个数组；走宿主 `settings.update`（带 revision 乐观锁）；
            //       写前落**回滚快照**；写后**独立回读**；`dryRun` 只算差分不写。
            if (url.pathname === `${API_PATH}/subagent-model-cleanup`) {
                if (method !== 'GET' && method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const facade = extras.subagentModels;
                if (!facade || !extras.nativeModelCatalog) {
                    json(503, { error: 'native model catalog unavailable' });
                    return;
                }
                const catalog = await extras.nativeModelCatalog();
                const before = facade.read();
                const remove = obsoleteSubagentRoutes(before.allowed, catalog);
                const plan = planPolicyChange(before.allowed, [], remove);
                if (method === 'GET') {
                    json(200, { beforeCount: before.allowed.length, afterCount: plan.next.length, removals: remove, failures: catalog.failures ?? [], groups: catalog.groups });
                    return;
                }
                const origin = req.headers.origin;
                if (origin && new URL(String(origin)).host !== req.headers.host) {
                    json(403, { error: 'same-origin required' });
                    return;
                }
                const backupDir = join(pluginHome(), 'subagent-model-backups');
                mkdirSync(backupDir, { recursive: true });
                const backup = join(backupDir, `cleanup-${Date.now()}.json`);
                writeFileSync(backup, JSON.stringify({ revision: before.revision, allowedModels: before.allowed }), 'utf8');
                const outcome = await facade.apply(plan, before.revision);
                json(200, { ok: outcome.ok, verified: outcome.verified, beforeCount: before.allowed.length, afterCount: plan.next.length, removals: remove, backup,
                    note: '仅移除已不在实时目录的授权；列举失败的提供方保留，未逐模型消耗额度验证。' });
                return;
            }
            if (url.pathname === `${API_PATH}/subagent-model-selection`) {
                const facade = extras.subagentModels;
                if (facade === undefined) {
                    json(503, { error: 'subagent model selection is not mounted in this composition' });
                    return;
                }
                if (method === 'GET') {
                    const snapshot = facade.read();
                    const candidates = facade.candidates();
                    const knownProviders = new Set(buildHarnessLlmProviders(config.resolvedTargets, (extras.accountSeeds?.() ?? ACCOUNT_SEEDS).map((seed) => seed.harnessId), (extras.accountSeeds?.() ?? ACCOUNT_SEEDS).map((seed) => seed.id)).map((spec) => spec.id)
                        // 账号型模型（WorkBuddy/Qoder）已拆到 @dsh-external/dsh-model-connect；其白名单条目
                        // 不属于本插件的 knownProviders，由那个插件自己管理（这里只如实报告「外来」）。
                        .concat(['harness-workbuddy-cn', 'harness-workbuddy-intl', 'harness-qoder-cn', 'harness-qoder-intl']));
                    const foreign = snapshot.allowed.filter((route) => !knownProviders.has(route.provider));
                    json(200, {
                        ns: facade.ns,
                        available: snapshot.available,
                        reason: snapshot.reason,
                        revision: snapshot.revision,
                        enabled: snapshot.enabled,
                        allowed: snapshot.allowed,
                        allowedCount: snapshot.allowed.length,
                        dropped: snapshot.dropped,
                        /** 本插件管理的 harness 路由各自的候选模型（**不截断**：每条都列全）。 */
                        candidates,
                        candidateCount: candidates.length,
                        /** 白名单里**不属于本插件**的条目（宿主自己的供应商路由）—— 报告出来，绝不擅自清理。 */
                        foreignCount: foreign.length,
                        foreignProviders: [...new Set(foreign.map((route) => route.provider))].sort(),
                        writable: facade.settingsAvailable,
                        note: '只增删本插件 harness 路由；宿主自己的供应商条目一律不动。'
                            + '会话策略在**会话创建时**记录一次 ⇒ 改动对**新会话**生效（老会话的既有策略不变）。'
                            + (facade.settingsAvailable ? '' : '⚠️ 宿主 `settings` 服务不可用 ⇒ 只能看不能写。'),
                    });
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const add = normalizeRoutes(body.value.add).routes;
                const remove = normalizeRoutes(body.value.remove).routes;
                const snapshot = facade.read();
                const plan = planPolicyChange(snapshot.allowed, add, remove);
                const dryRun = body.value.dryRun === true;
                if (dryRun || !snapshot.available) {
                    json(200, {
                        dryRun: true,
                        changed: plan.additions.length > 0 || plan.removals.length > 0,
                        additions: plan.additions,
                        removals: plan.removals,
                        alreadyPresent: plan.alreadyPresent,
                        missing: plan.missing,
                        before: snapshot.allowed,
                        next: plan.next,
                        reason: snapshot.available ? 'dryRun：只算差分，没有写任何东西' : `没写：${snapshot.reason}`,
                    });
                    return;
                }
                // 写前落回滚快照（用户要求「保留可回滚快照」）。写不进去就不写。
                let snapshotPath = null;
                try {
                    const dir = join(pluginHome(), 'subagent-model-backups');
                    mkdirSync(dir, { recursive: true });
                    snapshotPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
                    writeFileSync(snapshotPath, `${JSON.stringify({ at: new Date().toISOString(), ns: SUBAGENT_MODEL_NS, revision: snapshot.revision, allowedModels: snapshot.allowed }, null, 2)}\n`, 'utf8');
                }
                catch (error) {
                    json(500, { error: `回滚快照写不进去 ⇒ 按纪律不写白名单：${describe(error)}` });
                    return;
                }
                const expected = typeof body.value.expectedRevision === 'number' && Number.isFinite(body.value.expectedRevision)
                    ? body.value.expectedRevision
                    : snapshot.revision;
                const outcome = await facade.apply(plan, expected);
                extras.log?.(`harness-pilot: 子代理模型白名单写入 ok=${outcome.ok} verified=${outcome.verified}`
                    + ` +${outcome.requested.additions}/-${outcome.requested.removals}（${outcome.reason}）`);
                json(200, {
                    dryRun: false,
                    ok: outcome.ok,
                    verified: outcome.verified,
                    conflict: outcome.conflict,
                    reason: outcome.reason,
                    additions: plan.additions,
                    removals: plan.removals,
                    before: snapshot.allowed,
                    readback: outcome.readback?.allowed ?? null,
                    rollback: {
                        snapshotPath,
                        /** 回滚方式：把本次加上去的删掉、把本次删掉的加回来（同一条 API）。 */
                        reverse: { remove: plan.additions, add: plan.removals },
                        note: '快照文件是写前的完整 allowedModels；也可直接用 reverse 走同一条 API 回滚。',
                    },
                });
                return;
            }
            // ── POST /session/probe-turn：在**新会话**里真跑一轮（验收用）──
            //
            // 为什么需要它：宿主的「子代理模型策略」是**每个会话在第一次用到时记录一次**
            // （`dsh-tool-subagent/lib/index.js:588-605` 的 `selectForSession`：只有新会话才读
            // `settings.current()`，之后写进 `subagent/model-selection-policy` 事件）。
            // ⇒ 改完 `allowedModels` 之后，**必须在新建的会话里**才能验证「原生子代理入口能选到新路由」。
            // 本接口只做两件事：建会话 + 发一条消息（**不改路由、不写 profile**）；返回结构字段与正文。
            // ⚠️ 会真的花额度（一轮会话轮次）。
            if (url.pathname === `${API_PATH}/session/probe-turn`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.createSession === undefined || extras.wake === undefined) {
                    json(503, { error: 'sessions/wake plumbing is not available in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (prompt.trim().length === 0) {
                    json(400, { error: 'body.prompt is required (non-empty string)' });
                    return;
                }
                const requestedId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                const sessionId = requestedId.length > 0 ? requestedId : `session-probe-${Date.now().toString(36)}`;
                try {
                    const created = await extras.createSession(sessionId);
                    const wakeNote = await extras.wake(created, prompt);
                    // 等一小会儿让 assistant 消息落盘（与 redirect-turn 同一套做法）。
                    await sleep(1200);
                    const log = extras.sessionLog?.(created);
                    const reply = log?.available === true ? lastAssistantTextOf(log) : '';
                    json(200, {
                        sessionId: created,
                        wakeNote,
                        promptChars: prompt.length,
                        reply,
                        replyChars: reply.length,
                        log: log === undefined
                            ? { available: false, reason: 'sessionLog 未挂载' }
                            : { available: log.available, reason: log.reason ?? null, events: log.events?.length ?? 0 },
                        note: '本接口只建会话 + 发一条消息；不写 profile、不改路由。正文原样返回（验收用）。',
                    });
                }
                catch (error) {
                    json(500, { error: describe(error), sessionId });
                }
                return;
            }
            // ── POST /llm-adapter/redirect-turn：**真开一轮会话轮次**，取证「改道轮次日志里的真实来源」──
            //
            // 为什么必须有这个接口：上一版的归因证据全都取在**响应层**（`/llm-adapter/stream` 直接调
            // `ctx.llm.stream`），而那条路**根本不经过 agent loop** ⇒ 既没有 `request/header`，也没有
            // assistant 消息的 `source`，所以「改道那一轮到底被记成谁」**从来没有被观测过**。
            // 这里补上：走真实的 `agent.followup` 唤醒一轮，然后**只读宿主自己的会话事件日志**，
            // 给出 `request/header` 的 config 与 `assistant/message` 的 source。
            // ⚠️ 会真的花额度（一轮模型调用）。**不返回**会话正文，只返回结构字段与字符数。
            if (url.pathname === `${API_PATH}/llm-adapter/redirect-turn`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const adapter = extras.llmAdapter;
                if (adapter === undefined) {
                    json(503, { error: 'the pilot-cli llm adapter is not mounted in this composition' });
                    return;
                }
                if (extras.wake === undefined || extras.sessionLog === undefined) {
                    json(503, { error: 'sessions/wake plumbing is not available in this composition (ctx.sessions / sessionController missing)' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const prompt = typeof body.value.prompt === 'string' && body.value.prompt.trim().length > 0
                    ? body.value.prompt
                    : 'What is 2+2? Answer with only the number.';
                const harnessId = typeof body.value.harnessId === 'string' ? body.value.harnessId.trim() : '';
                const accountId = typeof body.value.accountId === 'string' ? body.value.accountId.trim() : '';
                const unbind = body.value.unbind === true;
                const restoreBinding = body.value.restore_binding !== false;
                const timeoutMs = typeof body.value.timeout_ms === 'number' && Number.isFinite(body.value.timeout_ms) && body.value.timeout_ms > 0
                    ? Math.min(body.value.timeout_ms, 300_000)
                    : 120_000;
                let sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                const created = sessionId.length === 0;
                if (sessionId.length === 0)
                    sessionId = `session-pilot-cli-redirect-${Date.now().toString(36)}`;
                const notes = [];
                // ① 会话：显式 id 就是**幂等 adopt**（重复跑不会每次多造会话）。
                if (extras.createSession !== undefined) {
                    try {
                        sessionId = await extras.createSession(sessionId);
                    }
                    catch (error) {
                        json(500, { error: `could not create/adopt session: ${describe(error)}` });
                        return;
                    }
                }
                else {
                    notes.push('createSession 不在 extras 里（会话必须已存在）');
                }
                // ② 绑定（可选）：走**会话页同一个** binding store —— 不写 profile 配置。
                const previousBinding = extras.binding?.get(sessionId) ?? null;
                if (extras.binding !== undefined && (harnessId.length > 0 || unbind)) {
                    const updated = extras.binding.set({
                        sessionId,
                        harnessId: unbind ? '' : harnessId,
                        ...(accountId.length === 0 ? {} : { accountId }),
                    });
                    notes.push(`binding set: harnessId=${JSON.stringify(updated.harnessId ?? '')} accountId=${JSON.stringify(updated.accountId ?? '')}`);
                }
                const before = extras.sessionLog(sessionId);
                const beforeSeq = before.available && typeof before.seq === 'number' ? before.seq : 0;
                const requestLayerBefore = adapter.requestLayer();
                let wakeNote = '';
                try {
                    wakeNote = await extras.wake(sessionId, prompt);
                }
                catch (error) {
                    if (extras.binding !== undefined && restoreBinding && (harnessId.length > 0 || unbind)) {
                        extras.binding.set({
                            sessionId,
                            harnessId: previousBinding?.harnessId ?? '',
                            ...(previousBinding?.accountId === undefined ? {} : { accountId: previousBinding.accountId }),
                        });
                    }
                    json(500, { error: `could not wake session: ${describe(error)}`, sessionId });
                    return;
                }
                // ③ 轮询到出现新的「assistant/message」（成功）/「assistant/attempt」（失败）/「turn/end」。
                const started = Date.now();
                let after = extras.sessionLog(sessionId);
                const deadline = started + timeoutMs;
                const settled = (read) => {
                    if (!read.available || read.events === undefined)
                        return false;
                    return read.events.some(event => event.seq >= beforeSeq
                        && (event.type === 'assistant/message' || event.type === 'assistant/attempt'));
                };
                while (Date.now() < deadline && !settled(after)) {
                    await sleep(1_000);
                    after = extras.sessionLog(sessionId);
                }
                const elapsed = Date.now() - started;
                const fresh = (after.events ?? []).filter(event => event.seq >= beforeSeq);
                const headers = fresh.filter(event => event.type === 'request/header').map(summarizeSessionEvent);
                const assistants = fresh.filter(event => event.type === 'assistant/message').map(summarizeSessionEvent);
                const attempts = fresh.filter(event => event.type === 'assistant/attempt');
                const notices = fresh.filter(event => event.type === 'user/message').map(summarizeSessionEvent)
                    .filter(entry => entry.sourceKind === 'model-selection');
                const lastHeader = headers[headers.length - 1] ?? null;
                const lastAssistant = assistants[assistants.length - 1] ?? null;
                const headerConfig = (lastHeader?.config ?? null);
                const sourceOf = (lastAssistant?.source ?? null);
                // ④ 绑定恢复（默认恢复成跑之前的样子；测试残留如实报出来）。
                if (extras.binding !== undefined && restoreBinding && (harnessId.length > 0 || unbind)) {
                    extras.binding.set({
                        sessionId,
                        harnessId: previousBinding?.harnessId ?? '',
                        ...(previousBinding?.accountId === undefined ? {} : { accountId: previousBinding.accountId }),
                    });
                    notes.push(`binding restored to harnessId=${JSON.stringify(previousBinding?.harnessId ?? '')}`);
                }
                json(200, {
                    ok: sourceOf !== null,
                    sessionId,
                    sessionCreated: created,
                    promptChars: prompt.length,
                    ms: elapsed,
                    wakeNote,
                    // ↓ **核心证据**：宿主自己写的日志（不是本插件自报）
                    requestHeader: { count: headers.length, last: lastHeader },
                    assistantSource: { count: assistants.length, last: lastAssistant },
                    assistantAttempts: attempts.length,
                    modelSwitchNotices: notices,
                    eventTypes: fresh.map(event => `${event.type}#${event.seq}`),
                    sessionLogSeq: { before: beforeSeq, after: typeof after.seq === 'number' ? after.seq : null },
                    logAvailable: after.available,
                    ...(after.available ? {} : { logUnavailableReason: after.reason ?? '(no reason)' }),
                    // ↓ 本插件自己在**请求层**的判定留档（只作对照；上面那份才是证据）
                    requestLayer: {
                        before: {
                            decisions: requestLayerBefore.decisions,
                            rewrites: requestLayerBefore.rewrites,
                            restores: requestLayerBefore.restores,
                            heldPicks: requestLayerBefore.heldPicks,
                            errors: requestLayerBefore.errors,
                        },
                        after: (() => {
                            const now = adapter.requestLayer();
                            return {
                                decisions: now.decisions,
                                rewrites: now.rewrites,
                                restores: now.restores,
                                heldPicks: now.heldPicks,
                                errors: now.errors,
                                lastDecision: now.lastDecision,
                            };
                        })(),
                    },
                    picks: adapter.picks(sessionId),
                    bindingNow: extras.binding?.get(sessionId) ?? null,
                    notes,
                    note: '走**真实** agent loop：`agent.followup`（与完成回执同一条唤醒链）→ `prepareRequest` → `agent/request` 瀑布'
                        + ' → `llm.prepareCall` → `request/header` 落盘 → 模型调用 → `assistant/message` 的 `source`。'
                        + '判据是**宿主日志**里的 `assistantSource.last.source.provider`，不是本插件的返回值。'
                        + '⚠️ 本接口会真的跑一轮模型调用（花额度）；只返回结构字段，不返回会话正文。',
                });
                return;
            }
            // ── GET /providers?target=…[&measure=1]：P3 四态供应商/模型发现 ──
            // 回答里 `native`/`discovered` 是**该 harness 自己**的；
            // `dshNative` 是 DSH 本 profile 的，**单独一栏**，绝不许混进前者。
            if (url.pathname === `${API_PATH}/providers`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.providers === undefined) {
                    json(503, { error: 'provider discovery is not mounted in this composition' });
                    return;
                }
                const target = targetOr400(url.searchParams.get('target') ?? '');
                if (target === undefined)
                    return;
                try {
                    const inventory = await extras.providers(target.name, url.searchParams.get('measure') === '1');
                    json(200, inventory);
                }
                catch (error) {
                    json(500, { error: describe(error) });
                }
                return;
            }
            // ── P4 目录能力 / 受约束选择 / 可编辑操作 ──
            // GET  /catalog?target=…[&measure=1]  → 能力判定（**含每一条拒绝的理由**）+ 受约束候选
            // POST /catalog/select { target, model, allowUnlisted? } → 选择判定（纯判定，不派发）
            // POST /catalog/edit   { target, op, … } → 计划；execute=true 才执行，并**独立回读**核验落地
            if (url.pathname === `${API_PATH}/catalog` || url.pathname === `${API_PATH}/catalog/select` || url.pathname === `${API_PATH}/catalog/edit`) {
                if (extras.catalog === undefined) {
                    json(503, { error: 'catalog editing is not mounted in this composition' });
                    return;
                }
                if (url.pathname === `${API_PATH}/catalog`) {
                    if (method !== 'GET') {
                        methodNotAllowed('GET');
                        return;
                    }
                    const target = targetOr400(url.searchParams.get('target') ?? '');
                    if (target === undefined)
                        return;
                    try {
                        const measure = url.searchParams.get('measure') === '1';
                        const report = await extras.catalog.capabilities(target.name, measure);
                        const found = await extras.catalog.candidates(target.name, measure);
                        json(200, {
                            target: target.name,
                            measured: measure,
                            capabilityReport: report,
                            candidates: found.candidates,
                            byAvailability: found.byAvailability,
                            candidatesNote: found.note,
                            note: '`capabilityReport.refused` 里的每一条都带**显式拒绝理由**：能力探测没探到的操作一律不做，'
                                + '也不会给它做一个「看起来能改」的入口。`measured=false` 时外部 CLI 面是「未探测」，不是「不支持」。',
                        });
                    }
                    catch (error) {
                        json(500, { error: describe(error) });
                    }
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const v = body.value;
                const target = targetOr400(typeof v.target === 'string' ? v.target : '');
                if (target === undefined)
                    return;
                if (url.pathname === `${API_PATH}/catalog/select`) {
                    if (typeof v.model !== 'string') {
                        json(400, { error: 'body.model is required' });
                        return;
                    }
                    try {
                        json(200, await extras.catalog.select({
                            target: target.name,
                            model: v.model,
                            ...(v.allowUnlisted === true ? { allowUnlisted: true } : {}),
                            ...(typeof v.minAvailability === 'string' ? { minAvailability: v.minAvailability } : {}),
                        }));
                    }
                    catch (error) {
                        json(500, { error: describe(error) });
                    }
                    return;
                }
                const op = typeof v.op === 'string' ? v.op : '';
                if (op.length === 0) {
                    json(400, { error: 'body.op is required' });
                    return;
                }
                try {
                    const plan = await extras.catalog.plan({
                        target: target.name,
                        op: op,
                        ...(typeof v.accountId === 'string' ? { accountId: v.accountId } : {}),
                        ...(typeof v.providerId === 'string' ? { providerId: v.providerId } : {}),
                        ...(Array.isArray(v.models) ? { models: v.models.map((x) => String(x)) } : {}),
                        ...(typeof v.registryUrl === 'string' ? { registryUrl: v.registryUrl } : {}),
                        ...(v.allowUnlisted === true ? { allowUnlisted: true } : {}),
                        ...(v.confirmWritesUserConfig === true ? { confirmWritesUserConfig: true } : {}),
                    });
                    if (plan.ok !== true || v.execute !== true) {
                        json(200, { executed: false, plan });
                        return;
                    }
                    json(200, { executed: true, plan, result: await extras.catalog.execute(plan, target.name) });
                }
                catch (error) {
                    json(500, { error: describe(error) });
                }
                return;
            }
            // ── GET /accounts[?measure=1]：P2 账号档案（三态分离 + 隔离披露）──
            // 只读身份探测；**绝不**返回任何凭据，身份一律降为不可逆指纹。
            if (url.pathname === `${API_PATH}/accounts`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.accounts === undefined) {
                    json(503, { error: 'account profiles are not mounted in this composition' });
                    return;
                }
                try {
                    const profiles = await extras.accounts(url.searchParams.get('measure') === '1');
                    // 第 3 阶段追加：把**隔离画像**与**可管理性**一并给出 ——
                    // 这样界面可以直接说「这个 harness 能不能加账号、为什么不能」，而不是让用户试了才知道。
                    const isolation = profiles.map((p) => ({
                        accountId: p.id,
                        harnessId: p.harnessId,
                        authStoreIsolated: p.isolation.authStoreIsolated,
                        configDirIsolated: p.isolation.configDirIsolated,
                        sharedWith: p.isolation.sharedWith,
                        disclosure: p.isolation.disclosure,
                        evidence: p.isolation.evidence,
                    }));
                    const extra = extras.accountAdmin === undefined
                        ? {}
                        : {
                            registry: extras.accountAdmin.registry(),
                            isolationProfiles: [...new Set(profiles.map((p) => p.harnessId))]
                                .map((h) => extras.accountAdmin?.isolation(h))
                                .filter((x) => x !== undefined),
                            disclosureNote: '新增账号**只对「隔离开关实测有效」的 harness 开放**（qoder-cn / codex / claude-code / pi）。'
                                + '其余 harness 一律拒绝，并说明差什么证据 —— 不允许用「复制未解密成功的认证文件」之类的做法伪造支持。',
                        };
                    // 出网前再扫一遍令牌形状：宁可少给字段，也不让凭据离开进程。
                    const body = JSON.stringify({ count: profiles.length, accounts: profiles, isolation, ...extra, generatedAt: new Date().toISOString() });
                    const hits = assertNoSecrets(body);
                    if (hits.length > 0) {
                        json(500, { error: `refusing to serve account payload: secret-shaped content detected (${hits.join(', ')})` });
                        return;
                    }
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json; charset=utf-8');
                    res.setHeader('cache-control', 'no-store');
                    res.end(body);
                }
                catch (error) {
                    json(500, { error: describe(error) });
                }
                return;
            }
            // Manager accounts are separate from executable profiles and never rewrite task bindings.
            if (url.pathname === `${API_PATH}/accounts/default`) {
                if (!extras.accountDefaults) {
                    json(503, { error: '账号选择尚未挂载' });
                    return;
                }
                if (method === 'GET') {
                    json(200, extras.accountDefaults.state());
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                try {
                    json(200, extras.accountDefaults.select(String(body.value.accountId ?? '')));
                }
                catch {
                    json(409, { error: '账号档案不存在或不可用于新任务' });
                }
                return;
            }
            if (url.pathname === `${API_PATH}/accounts/managers`) {
                if (extras.accountManagers === undefined) {
                    json(503, { error: 'account managers are not mounted' });
                    return;
                }
                const managers = extras.accountManagers;
                if (method === 'GET') {
                    json(200, managers.state());
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const value = body.value;
                const kind = value.manager === 'agy' ? 'agy' : value.manager === 'buddy' ? 'buddy' : undefined;
                const action = typeof value.action === 'string' ? value.action : '';
                const region = value.region === 'ai' ? 'ai' : value.region === 'cn' || value.region === undefined ? 'cn' : undefined;
                if (action !== 'configure' && kind === undefined) {
                    json(400, { error: '请选择 buddy 或 agy 管理器' });
                    return;
                }
                if (region === undefined) {
                    json(400, { error: '区域必须为 cn 或 ai' });
                    return;
                }
                try {
                    let result;
                    if (action === 'configure')
                        result = managers.configure(isObjLike(value.config) ? value.config : {});
                    else if (action === 'list')
                        result = await managers.list(kind, region);
                    else if (action === 'current')
                        result = await managers.current(kind, region);
                    else if (action === 'switch')
                        result = await managers.switch(kind, String(value.handle ?? ''), { automatic: value.automatic === true, confirmAppImpact: value.confirmAppImpact === true });
                    else if (kind === 'buddy' && action === 'import-local')
                        result = await managers.importLocal(region);
                    else if (kind === 'buddy' && action === 'delete')
                        result = await managers.delete(String(value.handle ?? ''));
                    else if (kind === 'buddy' && action === 'oauth-start')
                        result = await managers.oauthStart(region);
                    else if (kind === 'buddy' && action === 'oauth-status')
                        result = await managers.oauthStatus(String(value.loginHandle ?? ''));
                    else {
                        json(400, { error: '管理器不支持该操作' });
                        return;
                    }
                    json(200, { ok: true, result });
                }
                catch (error) {
                    json(409, { ok: false, error: error instanceof Error ? error.message : '账号管理器操作失败' });
                }
                return;
            }
            // ── /accounts/manage：第 3 阶段账号档案**动态管理**（增 / 改 / 删 / 恢复）──
            // 纯登记：不碰凭据、不复制认证文件、不关闭任何加密保护。
            if (url.pathname === `${API_PATH}/accounts/manage`) {
                if (extras.accountAdmin === undefined) {
                    json(503, { error: 'account management is not mounted in this composition' });
                    return;
                }
                if (method === 'GET') {
                    json(200, {
                        registry: extras.accountAdmin.registry(),
                        note: '这是账号档案的**登记表**（内置 ± 用户增删改）。它不包含任何凭据，也不指向任何凭据内容。',
                    });
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const v = body.value;
                const kind = typeof v.kind === 'string' ? v.kind : '';
                let action;
                if (kind === 'create') {
                    const input = isObjLike(v.input) ? v.input : {};
                    action = {
                        kind: 'create',
                        input: {
                            id: String(input.id ?? ''),
                            harnessId: String(input.harnessId ?? ''),
                            targetName: String(input.targetName ?? ''),
                            displayName: String(input.displayName ?? ''),
                            ...(typeof input.region === 'string' ? { region: input.region } : {}),
                            ...(typeof input.configDirSubdir === 'string' ? { configDirSubdir: input.configDirSubdir } : {}),
                            ...(typeof input.note === 'string' ? { note: input.note } : {}),
                            ...(typeof input.defaultProvider === 'string' ? { defaultProvider: input.defaultProvider } : {}),
                            ...(typeof input.defaultModel === 'string' ? { defaultModel: input.defaultModel } : {}),
                        },
                    };
                }
                else if (kind === 'update') {
                    const patch = isObjLike(v.patch) ? v.patch : {};
                    action = {
                        kind: 'update',
                        id: String(v.id ?? ''),
                        patch: {
                            ...(typeof patch.displayName === 'string' ? { displayName: patch.displayName } : {}),
                            ...(typeof patch.region === 'string' ? { region: patch.region } : {}),
                            ...(patch.defaultProvider === null ? { defaultProvider: null } : typeof patch.defaultProvider === 'string' ? { defaultProvider: patch.defaultProvider } : {}),
                            ...(patch.defaultModel === null ? { defaultModel: null } : typeof patch.defaultModel === 'string' ? { defaultModel: patch.defaultModel } : {}),
                            ...(patch.note === null ? { note: null } : typeof patch.note === 'string' ? { note: patch.note } : {}),
                        },
                    };
                }
                else if (kind === 'delete' || kind === 'restore') {
                    action = { kind, id: String(v.id ?? '') };
                }
                else {
                    json(400, { error: 'body.kind must be one of: create, update, delete, restore' });
                    return;
                }
                const result = extras.accountAdmin.crud(action);
                json(result.ok ? 200 : 400, result);
                return;
            }
            // ── /accounts/native-auth：**调用各 CLI 自己的**登录 / 退出 / 状态流程 ──
            // 本插件**不实现**任何登录协议；它只拼上该档案的配置目录参数，把命令交给 CLI 自己。
            if (url.pathname === `${API_PATH}/accounts/native-auth`) {
                if (extras.accountAdmin === undefined) {
                    json(503, { error: 'account management is not mounted in this composition' });
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const accountId = typeof body.value.accountId === 'string' ? body.value.accountId : '';
                const action = (typeof body.value.action === 'string' ? body.value.action : 'status');
                if (!['login', 'logout', 'status'].includes(action)) {
                    json(400, { error: 'body.action must be one of: login, logout, status' });
                    return;
                }
                const plan = extras.accountAdmin.planNativeAuth(accountId, action);
                // `run: true` 才真的执行；且**只**允许非交互动作（交互式登录一律拒绝管道捕获）。
                if (body.value.run === true) {
                    if (!plan.ok) {
                        json(400, { plan, error: plan.reason, alternative: plan.alternative });
                        return;
                    }
                    const outcome = await extras.accountAdmin.runNativeAuth(accountId, action);
                    json(outcome.ok ? 200 : 409, {
                        plan,
                        executed: true,
                        outcome,
                        note: '执行的是 CLI **自己**的原生命令；输出已做令牌形状脱敏。本插件没有读取、复制或解密任何凭据文件。',
                    });
                    return;
                }
                json(plan.ok ? 200 : 400, {
                    plan,
                    executed: false,
                    note: plan.ok
                        ? (plan.mode === 'terminal'
                            ? '这是**交互式**流程：请让用户在自己的终端里运行上面的命令。本插件不会用管道捕获一个等待输入的进程（那只会得到「跑了但没结果」）。'
                            : '这是非交互动作。加 `"run": true` 可让本插件代为执行（输出脱敏后返回）。')
                        : '该 CLI **没有**这个原生子命令 —— 本插件不会编造一个（也不会用删认证文件来冒充退出）。',
                });
                return;
            }
            // ── /pool：账号池配置（读/改）与手动一键切换 ──
            // 只做配置与**判定 + 记账**：不执行派发、不碰凭据、不自动注册账号。
            if (url.pathname === `${API_PATH}/pool`) {
                if (extras.pool === undefined) {
                    json(503, { error: 'account pool is not mounted in this composition' });
                    return;
                }
                if (method === 'GET') {
                    const state = extras.pool.state();
                    json(200, {
                        ...state,
                        // 界面要显示的：脱敏后的池成员 + 无法查询时的「未知」说明
                        members: Object.entries(state.entries).map(([accountId, entry]) => {
                            const seed = (extras.accountSeeds?.() ?? ACCOUNT_SEEDS).find((s) => s.id === accountId);
                            return {
                                accountId,
                                redacted: redactAccount(accountId),
                                harnessId: seed?.harnessId ?? 'unknown',
                                region: seed?.region ?? 'unknown',
                                enabled: entry.enabled,
                                priority: entry.priority,
                                cooldownMs: entry.cooldownMs,
                                isDefault: state.defaultAccountId === accountId,
                                // 声明清单必须能被读回来：写入口接受它（POST /pool 的 entry.models），
                                // 而**执行侧**（本文件里的 verifyTarget）就是按它判模型兼容的。
                                // 字段名与落盘一致；空数组表示「未声明」（写入路径会把空清单整条丢弃）。
                                models: entry.models ?? [],
                                // 本机实测这些 Harness **没有原生额度接口**，所以这里如实是「未知」。
                                quota: { state: 'unknown', source: 'none', note: '该 Harness 未提供原生额度接口；额度只在出现明确结构化错误时才可能变为 exhausted' },
                            };
                        }),
                        disclaimer: '自动切换默认关闭；账号池默认不启用任何账号。本插件不会自动注册账号或获取新账号，凭据由原生认证与受保护存储管理。',
                    });
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const patch = {};
                if (typeof body.value.autoSwitchEnabled === 'boolean')
                    patch.autoSwitchEnabled = body.value.autoSwitchEnabled;
                if (body.value.defaultAccountId === null)
                    patch.defaultAccountId = null;
                else if (typeof body.value.defaultAccountId === 'string')
                    patch.defaultAccountId = body.value.defaultAccountId;
                if (isObjLike(body.value.entry)) {
                    const e = body.value.entry;
                    if (typeof e.accountId === 'string' && e.accountId.length > 0) {
                        patch.entry = {
                            accountId: e.accountId,
                            ...(typeof e.enabled === 'boolean' ? { enabled: e.enabled } : {}),
                            ...(typeof e.priority === 'number' ? { priority: e.priority } : {}),
                            ...(typeof e.cooldownMs === 'number' ? { cooldownMs: e.cooldownMs } : {}),
                            // 模型清单：自动切换的「模型兼容」判定**只**认用户显式声明的东西。
                            ...(Array.isArray(e.models) ? { models: e.models.map((x) => String(x)) } : {}),
                        };
                    }
                }
                const next = extras.pool.update(patch);
                json(200, { ok: true, state: next, note: '修改默认账号只影响**新建**任务；正在运行的任务继续用它创建时的账号（任务与创建它的账号绑定，不会串号）。'
                        + (next.autoSwitchEnabled
                            ? '自动切换**已启用**：额度被判定为「明确耗尽」时执行侧会真的换账号重跑（见 GET /pool/autoswitch 看冻结/冷却/熔断状态）。'
                            : '自动切换关闭中：不会发生任何自动换账号。') });
                return;
            }
            // ── POST /pool/switch：手动一键切换（判定 + 记账）──
            if (url.pathname === `${API_PATH}/pool/switch`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.pool === undefined) {
                    json(503, { error: 'account pool is not mounted in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const v = body.value;
                if (typeof v.toAccountId !== 'string' || v.toAccountId.length === 0) {
                    json(400, { error: 'body.toAccountId is required' });
                    return;
                }
                const scopeKind = v.scope !== undefined && isObjLike(v.scope) ? String(v.scope.kind ?? 'session') : 'session';
                const scopeId = v.scope !== undefined && isObjLike(v.scope) ? String(v.scope.id ?? '') : '';
                if (scopeId.length === 0) {
                    json(400, { error: 'body.scope.id is required（切换事件按作用域归档，会话/任务/成员详情据此显示）' });
                    return;
                }
                const outcome = await extras.pool.manualSwitch({
                    scope: { kind: (['session', 'task', 'member'].includes(scopeKind) ? scopeKind : 'session'), id: scopeId },
                    harnessId: typeof v.harnessId === 'string' ? v.harnessId : '',
                    fromAccountId: typeof v.fromAccountId === 'string' ? v.fromAccountId : '',
                    toAccountId: v.toAccountId,
                    ...(typeof v.currentModel === 'string' ? { currentModel: v.currentModel } : {}),
                    ...(typeof v.currentProvider === 'string' ? { currentProvider: v.currentProvider } : {}),
                    authOfTarget: (typeof v.authOfTarget === 'string' ? v.authOfTarget : 'unknown'),
                    ...(isObjLike(v.quotaOfTarget) ? { quotaOfTarget: v.quotaOfTarget } : {}),
                    // 显式传的 body.modelsOfTarget 仍然**优先**（调用方可以说得比声明更具体）；
                    // 没传时必须回落到**账号池的声明** —— 那才是执行侧（verifyTarget）用的同一份东西。
                    ...(Array.isArray(v.modelsOfTarget)
                        ? { modelsOfTarget: v.modelsOfTarget.map((x) => String(x)) }
                        : ((extras.pool.state().entries[v.toAccountId]?.models ?? []).length === 0
                            ? {}
                            : { modelsOfTarget: extras.pool.state().entries[v.toAccountId]?.models ?? [] })),
                    nativeSessionResumable: v.nativeSessionResumable === true,
                    ...(Array.isArray(v.uncertainWriteActions) ? { uncertainWriteActions: v.uncertainWriteActions.map((x) => String(x)) } : {}),
                });
                json(200, (() => {
                    // 切换**落地**：成功的手动切换把目标账号设为账号池默认账号，
                    // 于是**之后新建**的派发真的会用新账号 —— 否则切换只是账本上的一行字。
                    //
                    // 边界（必须同时返回给调用方）：
                    //   · 只影响**之后**的派发；已经在跑的任务早已捕获自己的账号，不会被改；
                    //   · 显式传 accountId 的派发仍然优先于这个默认值；
                    //   · 调用方可用 applyToNewTasks=false 只记账、不改默认账号。
                    const applyToNewTasks = v.applyToNewTasks !== false;
                    let applied = false;
                    let defaultAccountNote = '';
                    if (outcome.ok && applyToNewTasks) {
                        extras.pool.update({ defaultAccountId: v.toAccountId });
                        applied = true;
                        defaultAccountNote = `账号池默认账号已设为 ${redactAccount(v.toAccountId)}：**之后新建**的派发会使用它；正在运行的任务不受影响。`;
                    }
                    else if (outcome.ok) {
                        defaultAccountNote = '调用方要求只记账（applyToNewTasks=false），账号池默认账号未改动。';
                    }
                    return {
                        ok: outcome.ok,
                        ...(isObjLike(outcome.result) ? outcome.result : { result: outcome.result }),
                        scope: { kind: scopeKind, id: scopeId },
                        appliedToNewTasks: applied,
                        applyNote: defaultAccountNote,
                        note: '本接口只做**判定 + 记账**（以及按需更新默认账号）：它本身不执行派发。'
                            + '真实的任务级自动切换由执行侧负责 —— 见 GET /pool/autoswitch 的 runtime 与 lastResult。',
                    };
                })());
                return;
            }
            // ── /pool/autoswitch：**自动切换执行侧**的运行时状态 ──
            // 用户明确要求「不能把开关当执行」：这个端点就是「执行侧真的在跑吗」的可查证据。
            if (url.pathname === `${API_PATH}/pool/autoswitch`) {
                if (extras.autoSwitchDispatch === undefined || extras.pool === undefined) {
                    json(503, { error: 'auto-switch execution side is not mounted in this composition' });
                    return;
                }
                if (method === 'GET') {
                    json(200, {
                        enabled: extras.pool.state().autoSwitchEnabled,
                        runtime: extras.pool.autoSwitchRuntime?.() ?? null,
                        lastResult: extras.pool.autoSwitchLastResult?.() ?? null,
                        policy: extras.pool.state().policy,
                        note: 'runtime 里的 frozen/cooldownUntil/breaker 是**真实生效**的状态：被冻结或处于冷却的账号不会被选为切换目标。'
                            + 'lastResult.attempts 里每一次尝试都对应一次**真实派发**。',
                    });
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                // 手动解冻：只解冻指定账号（不给账号就是「全部解冻」），并把这件事如实回报。
                const accountId = typeof body.value.thaw === 'string' ? body.value.thaw : undefined;
                const runtime = extras.pool.autoSwitchReset?.(accountId) ?? null;
                json(200, { ok: true, runtime, note: accountId === undefined ? '已清空全部冻结/冷却/熔断状态。' : '已为该账号解冻。' });
                return;
            }
            // ── /pool/events：切换事件（会话/任务/成员详情页用）──
            if (url.pathname === `${API_PATH}/pool/events`) {
                if (extras.pool === undefined) {
                    json(503, { error: 'account pool is not mounted in this composition' });
                    return;
                }
                const kind = url.searchParams.get('kind') ?? '';
                const id = url.searchParams.get('id') ?? '';
                if (kind.length > 0 && id.length > 0 && ['session', 'task', 'member'].includes(kind)) {
                    json(200, { events: extras.pool.events({ kind: kind, id }) });
                    return;
                }
                json(200, { events: extras.pool.recent(), redactionAudit: extras.pool.auditRedaction() });
                return;
            }
            if (url.pathname === `${API_PATH}/session/identity`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
                if (!sessionId) {
                    json(400, { error: 'sessionId is required' });
                    return;
                }
                const log = extras.sessionLog?.(sessionId);
                const saved = extras.executionIdentity?.(sessionId);
                if (!log?.available && !saved) {
                    json(200, { available: false, sessionId });
                    return;
                }
                const identity = log?.available ? externalSessionIdentity(log) : {
                    ...externalSessionIdentity({ header: { config: { provider: saved.provider,
                                model: saved.provider === 'pilot-cli' ? saved.target + '::' + saved.requestedModel : saved.requestedModel } } }),
                    requestedModel: saved.requestedModel, source: 'external-cli-execution',
                };
                const matchingExecution = saved?.provider === identity.provider && saved?.requestedModel === identity.requestedModel ? saved : undefined;
                json(200, { available: true, sessionId, ...identity,
                    harnessLabel: buildHarnessLlmProviders(config.resolvedTargets).find(spec => spec.id === identity.provider)?.name
                        ?? (identity.provider.startsWith('harness-workbuddy-') || identity.provider.startsWith('harness-qoder-')
                            ? '(账号型模型已拆到 dsh-model-connect 插件)' : identity.harness),
                    ...(matchingExecution === undefined ? {} : { target: matchingExecution.target, stopReason: matchingExecution.stopReason, mismatch: matchingExecution.mismatch,
                        accountId: matchingExecution.accountId, accountLabel: matchingExecution.accountLabel }),
                });
                return;
            }
            if (url.pathname === `${API_PATH}/conversation-model-policy`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                json(200, { mode: 'picker-visibility', installed: true, note: '会话选择器的显示由 /model-visibility 逐模型/逐组/上限驱动（不再一刀切隐藏外部模型）' });
                return;
            }
            // ── /session/binding：会话级 Harness→账号→供应商→模型 绑定 ──
            // 会话页座位写入这里；harness_dispatch / harness_agent 在未显式指定时读它。
            // 作用范围如实写在 scopeNote 里：**本会话自身的对话轮次仍由 DSH 执行**。
            if (url.pathname === `${API_PATH}/session/binding`) {
                if (extras.binding === undefined) {
                    json(503, { error: 'session binding is not mounted in this composition' });
                    return;
                }
                if (method === 'GET') {
                    const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
                    if (sessionId.length === 0) {
                        json(400, { error: 'sessionId is required' });
                        return;
                    }
                    const binding = extras.binding.get(sessionId);
                    json(200, { sessionId, binding: binding ?? null });
                    return;
                }
                if (method !== 'POST') {
                    methodNotAllowed('GET, POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                if (sessionId.length === 0) {
                    json(400, { error: 'body.sessionId is required' });
                    return;
                }
                // 未知的外部 harness 要拒绝，免得在配置里留下永远解析不了的绑定。
                const harnessId = typeof body.value.harnessId === 'string' ? body.value.harnessId.trim() : '';
                if (harnessId.length > 0 && harnessId !== 'dsh') {
                    const target = config.resolvedTargets.find((t) => t.name === harnessId);
                    if (target === undefined) {
                        json(400, { error: `unknown harness "${harnessId}"; known: ${config.resolvedTargets.map((t) => t.name).join(', ')}` });
                        return;
                    }
                }
                const binding = extras.binding.set({
                    sessionId,
                    harnessId,
                    accountId: typeof body.value.accountId === 'string' ? body.value.accountId : undefined,
                    provider: typeof body.value.provider === 'string' ? body.value.provider : undefined,
                    model: typeof body.value.model === 'string' ? body.value.model : undefined,
                    reasoningEffort: typeof body.value.reasoningEffort === 'string' ? body.value.reasoningEffort : undefined,
                    permissionMode: typeof body.value.permissionMode === 'string' ? body.value.permissionMode : undefined,
                });
                json(200, { sessionId, binding });
                return;
            }
            // ── POST /registry/update：启停 / 指定入口路径 / 备注（落盘持久化）──
            if (url.pathname === `${API_PATH}/registry/update`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.registry === undefined) {
                    json(503, { error: 'federation registry is not mounted in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const target = typeof body.value.target === 'string' ? body.value.target.trim() : '';
                if (target.length === 0) {
                    json(400, { error: 'body.target is required (a harness target name)' });
                    return;
                }
                // 未知目标要回 400 而不是让下游 throw 成 500 —— 这是调用方输入错误，不是服务端故障。
                if (targetOr400(target) === undefined)
                    return;
                const patch = {};
                if (typeof body.value.enabled === 'boolean')
                    patch.enabled = body.value.enabled;
                if (typeof body.value.command === 'string')
                    patch.command = body.value.command;
                if (typeof body.value.note === 'string')
                    patch.note = body.value.note;
                const state = extras.registry.update(target, patch);
                json(200, { target, state });
                return;
            }
            // ── GET /probe?target=…：通道梯子逐档预检（不派发任务）──
            if (url.pathname === `${API_PATH}/probe`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const target = targetOr400(url.searchParams.get('target') ?? '');
                if (target === undefined)
                    return;
                const order = (target.order.length > 0 ? target.order : ['acp', 'headless', 'pty', 'cdp', 'window'])
                    .filter((kind) => API_TRANSPORTS.includes(kind));
                const ladder = [];
                for (const kind of order) {
                    const check = await registry.preflight(kind, target);
                    ladder.push({ transport: kind, available: check.available, detail: check.detail });
                }
                json(200, { target: target.name, ladder });
                return;
            }
            // ── POST /models：这个 harness 自己列的模型 + 它是怎么被选中的 ──
            if (url.pathname === `${API_PATH}/models`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                if (body.value.refresh === true)
                    registry.clearModelCache();
                const found = await registry.targetModels(target);
                const entries = found.entries ?? [];
                // 四态 + 分组计数 + 逐条分类：设置页与探针都读这一份（不再各自解释 `note` 字符串）。
                json(200, {
                    target: target.name,
                    models: found.models,
                    note: found.note,
                    mechanism: mechanismOf(target),
                    entries,
                    counts: countByKind(entries),
                    state: found.state ?? null,
                    selectable: entries.filter((entry) => entry.selectable).map((entry) => entry.id),
                    sourceLabels: MODEL_SOURCE_LABEL,
                    kindLabels: MODEL_KIND_LABEL,
                    /** 只读声明：本插件的分类只依据**观测到的来源**，不做任何推断/编造。 */
                    classificationNote: '每条模型都标了**来源**（真实 CLI 查询 / 原生配置 / 官方模型缓存 / 有明确依据的官方别名）'
                        + '与**类别**（可选择 / 仅供展示的底层模型 / 模型别名 / 当前默认模型）。'
                        + '`models` 只含**能作为 CLI 模型参数**的条目；仅展示的底层 ID 不会混进去。',
                });
                return;
            }
            // ── GET/POST /model-visibility：会话模型选择器显示哪些模型（2026-10-15 用户要求）──
            // GET：配置 + 每组摘要（全量清单 ∪ 已配置隐藏项，UI 勾选面就画这一份）。
            // POST：一次一处变更（上限 / 整组显隐 / 模型显隐 / 恢复默认），写前留 `*.prev.json` 撤销档。
            // ⚠️ 2026-10-15 晚间恢复完整语义（用户明确要求「单个模型是否显示进行控制」）：
            // Codex 曾在本轮把 POST 一律 409、GET 强制 visible=0（配合「外部模型仅供子代理」策略）；
            // 该策略已移除，选择器的显示重新由这里的配置驱动（过滤点在 `listModels` 的 pickerVisibility）。
            if (url.pathname === `${API_PATH}/model-visibility`) {
                const facade = extras.modelVisibility;
                if (facade === undefined) {
                    json(503, { error: 'model-visibility facade is not mounted in this composition' });
                    return;
                }
                const providersOf = () => facade.providers().map((entry) => ({
                    ...entry,
                    summary: pickerProviderSummary(facade.read(), entry.providerId, entry.models),
                }));
                if (method === 'GET') {
                    json(200, {
                        config: facade.read(),
                        defaults: { pickerLimit: DEFAULT_PICKER_LIMIT },
                        providers: providersOf(),
                        mode: 'picker-visibility',
                        note: '语义：这里管的是**会话模型选择器**显示多少 —— 每组上限（0=不限，缺省 ' + String(DEFAULT_PICKER_LIMIT)
                            + '）、整组隐藏、组内隐藏。隐藏/超限 ≠ 不可用：已选中该模型的会话照常执行；'
                            + '子代理白名单（/subagent-model-selection）是另一套，不受这里影响。',
                    });
                    return;
                }
                if (method === 'POST') {
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const providerId = typeof body.value.providerId === 'string' ? body.value.providerId.trim() : '';
                    if (providerId.length === 0) {
                        json(400, { error: 'body.providerId is required (a harness provider id, e.g. harness-claude-code)' });
                        return;
                    }
                    const known = facade.providers().find((entry) => entry.providerId === providerId);
                    if (known === undefined) {
                        json(400, { error: `unknown providerId "${providerId}"（以 GET /model-visibility 的 providers[].providerId 为准）` });
                        return;
                    }
                    const patch = { providerId };
                    if (typeof body.value.groupHidden === 'boolean')
                        patch.groupHidden = body.value.groupHidden;
                    if (typeof body.value.limit === 'number')
                        patch.limit = body.value.limit;
                    const stringList = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : undefined;
                    const hideModels = stringList(body.value.hideModels);
                    if (hideModels !== undefined)
                        patch.hideModels = hideModels;
                    const showModels = stringList(body.value.showModels);
                    if (showModels !== undefined)
                        patch.showModels = showModels;
                    if (body.value.reset === true)
                        patch.reset = true;
                    const result = facade.write(patch);
                    if (!result.ok) {
                        json(400, { error: result.reason });
                        return;
                    }
                    json(200, {
                        ok: true,
                        note: result.note,
                        previous: result.previous,
                        config: result.doc,
                        provider: { ...pickerProviderSummary(result.doc, providerId, known.models), label: known.label },
                    });
                    return;
                }
                methodNotAllowed('GET, POST');
                return;
            }
            // ── POST /dispatch：一次性派发（与 harness_dispatch 同一条通道梯子）──
            if (url.pathname === `${API_PATH}/dispatch`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (prompt.trim().length === 0) {
                    json(400, { error: 'body.prompt is required (a non-empty string)' });
                    return;
                }
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                const transport = body.value.transport;
                if (transport !== undefined && transport !== 'auto' && !API_TRANSPORTS.includes(String(transport))) {
                    json(400, { error: `body.transport must be one of: auto, ${API_TRANSPORTS.join(', ')}` });
                    return;
                }
                const model = typeof body.value.model === 'string' && body.value.model.trim().length > 0 ? body.value.model.trim() : undefined;
                const cwd = typeof body.value.cwd === 'string' && body.value.cwd.length > 0 ? body.value.cwd : process.cwd();
                const timeoutMs = typeof body.value.timeout_ms === 'number' && Number.isFinite(body.value.timeout_ms) && body.value.timeout_ms > 0
                    ? body.value.timeout_ms
                    : target.timeoutMs;
                // HTTP 客户端断开 = 取消这次派发（别让 harness 在没人听的时候继续跑）。
                const abort = new AbortController();
                res.on('close', () => {
                    if (!res.writableEnded)
                        abort.abort();
                });
                // ── 账号档案 → 真的改变执行 ──
                // 指定 accountId 时，把该档案的启动参数与环境变量**合并进目标**，
                // 于是这次派发真的用了那个账号的配置目录 —— 而不是只换一个标签。
                let effectiveTarget = target;
                let accountNote = '';
                // 显式 accountId 优先；没给就用账号池里的**默认账号**。
                // 通过 `extras.pool` 读实时状态（而不是闭包变量）—— 账号池是在 createApiHandler
                // **之后**才构造的，用闭包会踩到「声明前使用」。
                //
                // 「默认账号」只在**派发那一刻**读取 —— 所以改默认账号只影响之后的新任务，
                // 正在跑的任务早已捕获了自己的账号，不会被改名影响（这正是「不串号」的落点）。
                //
                // ⚠️ 2026-10-14 修：池默认账号是**全局一个**，必须**按目标所属 Harness 分域**再决定用不用。
                // 历史行为：池里设了 `workbuddy-a` 之后，向 `agy`/`qoder` 派发会走进跨 Harness 拒绝分支
                // ⇒ **整个派发失败**（实测 400）。现在：**显式** accountId 不属于本目标仍然大声拒绝；
                // **默认**账号不属于本目标则**不套用**并在 note 里说明，派发照常。
                const scopedDefault = defaultAccountForTarget({
                    targetName: target.name,
                    candidate: extras.pool?.state().defaultAccountId ?? '',
                    seeds: extras.accountSeeds?.() ?? ACCOUNT_SEEDS,
                });
                const explicitAccount = typeof body.value.accountId === 'string' ? body.value.accountId.trim() : '';
                const usedDefault = explicitAccount.length === 0 && scopedDefault.accountId.length > 0;
                const accountId = explicitAccount.length > 0 ? explicitAccount : scopedDefault.accountId;
                // 池默认账号不属于本目标时的说明：**不覆盖**成功合并的 note，而是拼在后面一起回报。
                const dispatchIgnoredDefaultNote = explicitAccount.length === 0 && scopedDefault.ignoredReason !== null
                    ? scopedDefault.ignoredReason
                    : '';
                if (accountId.length > 0) {
                    // ── **唯一来源**：`src/account-target.ts` 的 `withAccountTarget()` ──
                    // 这一条入口此前是**第二份**实现（受管账号同样拼出「两个 wrapper、两个 id」，
                    // 普通账号则**没有**同 Harness 判定、`account` note **未脱敏**）。
                    // 现在四条分支（受管完整元组认领 / 目标已按真实完整配方带着同一账号时整份复用 /
                    // 带着别人的配置目录时显式拒绝 / 普通前置合并）全部由那一处决定，
                    // `/dispatch` 与 `/task/start` 不再可能给出不一致的答案。
                    const seedsForDispatch = extras.accountSeeds?.() ?? ACCOUNT_SEEDS;
                    const appliedDispatch = withAccountTarget({ target, accountId, seeds: seedsForDispatch, homeDir: homeDir() });
                    if (!appliedDispatch.ok) {
                        json(400, { error: appliedDispatch.reason });
                        return;
                    }
                    effectiveTarget = appliedDispatch.target;
                    accountNote = `${appliedDispatch.note}${usedDefault ? '（来自账号池的默认账号）' : ''}${dispatchIgnoredDefaultNote}`;
                }
                // 没有套用任何账号、但确实**跳过**了一个不属于本目标的池默认账号 ⇒ 也必须说明
                // （否则用户看到「成功了」却不知道为什么没用那个默认账号）。
                if (accountNote.length === 0 && dispatchIgnoredDefaultNote.length > 0)
                    accountNote = dispatchIgnoredDefaultNote;
                // ⚠️ 这里必须与 TaskManager 那条路径**共用同一个执行侧**（autoSwitchDispatch）。
                // 本项目栽过三次「同一能力在不同入口行为不一致」—— 账号相关的两次都在 /dispatch 与
                // /task/start 之间。所以这里是同一个盒子，不是第二套实现。
                //
                // ── MCP 桥接（ACP 通道）：调用方**显式**要 ACP 时自动带上 `mcpServers` ──
                // 修的是这样一条真实缺口：`/dispatch` 走 ACP 时**从不**带 `session/new.mcpServers`，
                // 于是 ACP 目标的桥接注入**永远不会触发**（argv 那条通道对 ACP 目标本来就不适用）。
                // 现在：`transport:"acp"` + 一个**有活 Agent 的** `sessionId` ⇒ 自动开一个
                // `acp-mcp-servers` 入口，把句柄里的 `mcpServers` 放进这次派发（令牌由桥接模块内部
                // 拼进 header，本处拿不到令牌本体，也不写进日志）。
                // 三个「不做」：不给 sessionId 不开（没有作用域就没有入口）；不是 acp 不开
                // （ACP 条目塞进 headless 只会得到一个没人读的字段）；开不出来照常派发（桥接失败
                // **不许**让派发失败），并在响应里如实报 `mcpBridge`。
                let dispatchBridge;
                const bridgeSessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                if (transport === 'acp' && bridgeSessionId.length > 0 && extras.mcpBridge !== undefined) {
                    try {
                        dispatchBridge = await extras.mcpBridge.openForTurn({
                            sessionId: bridgeSessionId,
                            command: effectiveTarget.command,
                            channel: 'acp-mcp-servers',
                            origin: 'api-dispatch-acp',
                            note: { target: target.name, transport: 'acp' },
                        });
                    }
                    catch (error) {
                        // 桥接失败**不许**让派发失败：如实记一条（`extras.log` 由挂载方注入插件 logger），
                        // 然后按「没有桥」继续 —— 响应里的 `mcpBridge` 会是 `none`，不假装注入过。
                        extras.log?.(`mcp-bridge: openForTurn failed for /dispatch ${target.name}: ${describe(error)}`);
                        dispatchBridge = undefined;
                    }
                }
                const dispatchSpec = {
                    target: effectiveTarget,
                    prompt,
                    cwd,
                    signal: abort.signal,
                    timeoutMs,
                    ...(model === undefined ? {} : { model }),
                    ...(dispatchBridge === undefined ? {} : { mcpServers: dispatchBridge.mcpServers }),
                    ...(accountId.length === 0 ? {} : { identity: { harnessId: target.name, accountId, ...(model === undefined ? {} : { model }) } }),
                };
                const dispatchOptions = typeof transport === 'string' && transport.length > 0 ? { transport } : {};
                let outcome;
                try {
                    outcome = extras.autoSwitchDispatch === undefined
                        ? await registry.dispatch(dispatchSpec, dispatchOptions)
                        : await extras.autoSwitchDispatch(dispatchSpec, dispatchOptions);
                }
                finally {
                    // 入口是**逐轮**的：正常结束、抛错、HTTP 客户端断开（abort）都关。
                    dispatchBridge?.close('turn-settled');
                }
                json(200, {
                    target: target.name,
                    transport: outcome.transport,
                    stopReason: outcome.stopReason,
                    text: outcome.text,
                    ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
                    ...(outcome.facts === undefined ? {} : { facts: outcome.facts }),
                    // 请求身份 vs 实际身份 + 偏差说明：调用方必须能看到「配置值 ≠ 实际值」。
                    ...(outcome.identity === undefined ? {} : { identity: outcome.identity }),
                    mismatch: outcome.mismatch ?? [],
                    // 如实报「本轮开过哪个入口」（含通道名）；`none` = 没给 sessionId / 该会话没有活 Agent /
                    // 不是 acp 通道。开过入口 ≠ 注入一定生效 —— 生效与否由桥接入口是否真的收到
                    // `tools/call` 证明（`GET /mcp-bridge` 的 entries/events）。
                    mcpBridge: dispatchBridge === undefined
                        ? 'none'
                        : `${dispatchBridge.id}@127.0.0.1:${String(dispatchBridge.port)} (${dispatchBridge.channel})`,
                    ...(accountNote.length === 0 ? {} : { account: accountNote }),
                });
                return;
            }
            // ── POST /send：{ target, model? } 开会话；{ sessionId, text? } 往里写 ──
            if (url.pathname === `${API_PATH}/send`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                // 写模式：往已有会话里打字（或不打字，只读屏）。
                if (sessionId.length > 0) {
                    const session = registry.get(sessionId);
                    if (session === undefined) {
                        // 2026-10-16（P-3）：404 必须可解释 —— 墓碑（空闲回收/重载关闭）查得到就带上原因与 reopen 指引。
                        const closed = registry.explainMissing(sessionId);
                        json(404, {
                            error: `unknown session "${sessionId}"${closed !== undefined ? ` — ${closed}` : ''}`,
                            sessions: registry.list().map(entry => entry.id),
                        });
                        return;
                    }
                    const text = typeof body.value.text === 'string' ? body.value.text : undefined;
                    const hasText = text !== undefined && text.length > 0;
                    const note = hasText
                        ? (await session.send({ text: text, submit: body.value.submit !== false })).note
                        : 'read-only';
                    const waitMs = typeof body.value.wait_ms === 'number' && Number.isFinite(body.value.wait_ms) && body.value.wait_ms > 0
                        ? body.value.wait_ms
                        : (hasText ? 1500 : 0);
                    await sleep(waitMs);
                    const read = await session.read({ limit: config.maxScreenChars });
                    json(200, {
                        sessionId: session.id,
                        target: session.target.name,
                        transport: session.transport,
                        action: note,
                        text: read.text,
                        source: read.source,
                        ...(read.diagnostic === undefined ? {} : { diagnostic: read.diagnostic }),
                    });
                    return;
                }
                // 开/复用模式：GUI harness 优先 CDP，其次窗口，最后 pty。
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                const existing = registry.list().find(entry => !entry.closed && entry.target === target.name);
                const reused = existing === undefined ? undefined : registry.get(existing.id);
                const session = reused ?? await registry.open(target, {
                    cwd: typeof body.value.cwd === 'string' && body.value.cwd.length > 0 ? body.value.cwd : process.cwd(),
                    launch: body.value.launch !== false,
                });
                const notes = [reused === undefined ? 'opened' : `reused ${session.id}`];
                // 换模型只对 CDP 会话有效：GUI harness 的模型选择器在它自己的界面里，
                // CLI 参数（modelArgs）只在一次性派发时有意义。
                let currentModel = '';
                // 模型切换的成败做成**结构化字段**（而不是只藏在 notes 的字符串里），让调用方直接判定。
                // 注意：HTTP 的开/复用分支**不发送文本**，所以这里没有「切模型失败却照样投递」的风险，
                // 只需要如实报出成败（工具面 harness_send 那条路径才是 fail-closed 的）。
                let modelSwitchOk = null;
                let modelSwitchDetail = '';
                const wanted = typeof body.value.model === 'string' && body.value.model.trim().length > 0 ? body.value.model.trim() : undefined;
                if (wanted !== undefined) {
                    const evaluate = session.evaluate;
                    if (evaluate === undefined) {
                        json(400, {
                            error: `session ${session.id} uses the ${session.transport} transport, which cannot switch models; `
                                + 'GUI harnesses need the cdp transport (open the target with launch=true or start it with a debugging port)',
                        });
                        return;
                    }
                    const mouse = session.mouse;
                    if (mouse === undefined) {
                        const inPage = await switchModelInPage({ evaluate: async (expression) => await evaluate(expression) }, wanted);
                        notes.push(inPage.note);
                        modelSwitchOk = inPage.ok;
                        modelSwitchDetail = inPage.note;
                    }
                    else {
                        const report = await switchModel({
                            evaluate: async (expression) => await evaluate(expression),
                            mouse: async (action, x, y) => await mouse(action, x, y),
                        }, wanted);
                        currentModel = report.after;
                        modelSwitchOk = report.ok;
                        modelSwitchDetail = `before=${JSON.stringify(report.before)} via=${report.via} `
                            + `picked=${JSON.stringify(report.picked)} after=${JSON.stringify(report.after)}`
                            + (report.detail === undefined ? '' : ` detail=${report.detail}`);
                        notes.push(`model switch: ${report.ok ? 'ok' : 'FAILED'} ${modelSwitchDetail}`);
                    }
                }
                // 没让我们换模型时，尽量读一眼当前模型（非 CDP 会话读不到，如实回空串）。
                if (currentModel.length === 0) {
                    const evaluate = session.evaluate;
                    if (evaluate !== undefined) {
                        try {
                            currentModel = await currentModelOf({ evaluate: async (expression) => await evaluate(expression) });
                        }
                        catch (error) {
                            notes.push(`reading the current model failed: ${describe(error)}`);
                        }
                    }
                    else {
                        notes.push(`current model is not readable over the ${session.transport} transport (not a cdp session)`);
                    }
                }
                json(200, {
                    sessionId: session.id,
                    transport: session.transport,
                    currentModel,
                    detail: session.detail,
                    ...(session.warning === undefined ? {} : { warning: session.warning }),
                    ...(modelSwitchOk === null ? {} : { modelSwitch: { ok: modelSwitchOk, detail: modelSwitchDetail } }),
                    notes,
                });
                return;
            }
            // ── GET /settings：运行时设置（设置页表单的数据源）──
            if (url.pathname === `${API_PATH}/settings`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                json(200, {
                    settings: extras.settings?.() ?? null,
                    tasksDir: join(pluginHome(), 'tasks'),
                    settingsFile: join(pluginHome(), 'runtime-settings.json'),
                });
                return;
            }
            // ── POST /settings：保存运行时设置（立即生效）──
            if (url.pathname === `${API_PATH}/settings/save`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                if (extras.applySettings === undefined) {
                    json(500, { error: 'runtime settings are not wired in this composition' });
                    return;
                }
                json(200, { settings: extras.applySettings(body.value) });
                return;
            }
            // ── GET /tasks：最近任务（新→旧）──
            if (url.pathname === `${API_PATH}/tasks`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                json(200, { tasks: extras.tasks.list() });
                return;
            }
            // ── POST /tasks/prune：显式回收任务账本（账本此前只增不减）──
            // 刻意做成**显式**动作而不是后台自动删：自动删有悄悄抹掉用户还要复查的证据的风险。
            // 非终态任务（running / stalled）一律不删，最近 keep 条一律保留。
            if (url.pathname === `${API_PATH}/tasks/prune`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                const rawKeep = body.ok ? body.value.keep : undefined;
                const keep = typeof rawKeep === 'number' && Number.isFinite(rawKeep) && rawKeep >= 0 ? Math.floor(rawKeep) : 200;
                const pruned = extras.tasks.prune(keep);
                json(200, {
                    keep,
                    ...pruned,
                    freedMB: Math.round((pruned.freedBytes / (1024 * 1024)) * 100) / 100,
                    note: '只回收了终态任务；running / stalled 任务与最近 keep 条一律保留。',
                });
                return;
            }
            // ── GET /task?id=…&result=1&log_offset=…：单个任务的状态/进度/结果 ──
            if (url.pathname === `${API_PATH}/task`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const id = (url.searchParams.get('id') ?? '').trim();
                if (!/^[0-9a-f-]{36}$/.test(id)) {
                    json(400, { error: 'query id must be a task uuid' });
                    return;
                }
                const offset = Math.max(0, Number(url.searchParams.get('log_offset') ?? 0) || 0);
                const wantResult = url.searchParams.get('result') !== '0';
                try {
                    const progress = extras.tasks.progress(id, offset, 20000);
                    const body = { ...progress };
                    if (wantResult && ['completed', 'error', 'timeout', 'aborted', 'interrupted'].includes(progress.status)) {
                        body.result = extras.tasks.result(id).result;
                    }
                    json(200, body);
                }
                catch (error) {
                    json(404, { error: describe(error) });
                }
                return;
            }
            // ── POST /task/start：后台派发（外部调用方可自带 session_id 要回执唤醒）──
            if (url.pathname === `${API_PATH}/task/start`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.tasks === undefined || extras.settings === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (prompt.trim().length === 0) {
                    json(400, { error: 'body.prompt is required (a non-empty string)' });
                    return;
                }
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                // 账号档案同样要在这里生效 —— 与 `/dispatch` **共用同一实现**
                // （`src/account-target.ts` 的 `withAccountTarget()`）。先前只接在 /dispatch 上，
                // 导致 /task/start 传 accountId 被完全忽略。
                let taskTarget = target;
                let taskAccountNote = '';
                // 与 `/dispatch` **同一处**分域解析（`defaultAccountForTarget`）：池默认账号不属于本目标
                // 就不套用（并写进 note），**不让整次任务失败**。
                const taskScopedDefault = defaultAccountForTarget({
                    targetName: target.name,
                    candidate: extras.pool?.state().defaultAccountId ?? '',
                    seeds: extras.accountSeeds?.() ?? ACCOUNT_SEEDS,
                });
                const taskExplicit = typeof body.value.accountId === 'string' ? body.value.accountId.trim() : '';
                const taskUsedDefault = taskExplicit.length === 0 && taskScopedDefault.accountId.length > 0;
                const taskAccountId = taskExplicit.length > 0 ? taskExplicit : taskScopedDefault.accountId;
                const taskIgnoredDefaultNote = taskExplicit.length === 0 && taskScopedDefault.ignoredReason !== null
                    ? taskScopedDefault.ignoredReason
                    : '';
                if (taskAccountId.length > 0) {
                    const applied = withAccountTarget({
                        target,
                        accountId: taskAccountId,
                        seeds: extras.accountSeeds?.() ?? ACCOUNT_SEEDS,
                        homeDir: homeDir(),
                    });
                    if (!applied.ok) {
                        json(400, { error: applied.reason });
                        return;
                    }
                    taskTarget = applied.target;
                    taskAccountNote = `${applied.note}${taskUsedDefault ? '（来自账号池的默认账号）' : ''}${taskIgnoredDefaultNote}`;
                }
                if (taskAccountNote.length === 0 && taskIgnoredDefaultNote.length > 0)
                    taskAccountNote = taskIgnoredDefaultNote;
                const transport = body.value.transport;
                if (transport !== undefined && transport !== 'auto' && !API_TRANSPORTS.includes(String(transport))) {
                    json(400, { error: `body.transport must be one of: auto, ${API_TRANSPORTS.join(', ')}` });
                    return;
                }
                const model = typeof body.value.model === 'string' && body.value.model.trim().length > 0 ? body.value.model.trim() : undefined;
                const cwd = typeof body.value.cwd === 'string' && body.value.cwd.length > 0 ? body.value.cwd : process.cwd();
                const runtime = extras.settings();
                const timeoutMs = typeof body.value.timeout_ms === 'number' && Number.isFinite(body.value.timeout_ms) && body.value.timeout_ms > 0
                    ? body.value.timeout_ms
                    : runtime.defaultTaskTimeoutMs;
                try {
                    const view = extras.tasks.start({
                        target: taskTarget,
                        prompt,
                        cwd,
                        timeoutMs,
                        ...(model === undefined ? {} : { model }),
                        // 请求身份：让任务账本记下「实际用了哪个账号」。
                        ...(taskAccountId.length === 0 ? {} : { identity: { harnessId: target.name, accountId: taskAccountId, ...(model === undefined ? {} : { model }) } }),
                        ...(transport === undefined || transport === 'auto' ? {} : { transport: transport }),
                        callback: {
                            notify: body.value.notify !== false,
                            sessionId: typeof body.value.session_id === 'string' ? body.value.session_id.trim() : '',
                            instruction: typeof body.value.instruction === 'string' ? body.value.instruction : '',
                        },
                    });
                    json(200, { task: view, ...(taskAccountNote.length === 0 ? {} : { account: taskAccountNote }) });
                }
                catch (error) {
                    json(400, { error: describe(error) });
                }
                return;
            }
            // ── POST /task/cancel：{ task_id } ──
            if (url.pathname === `${API_PATH}/task/cancel`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const id = typeof body.value.task_id === 'string' ? body.value.task_id.trim() : '';
                if (!/^[0-9a-f-]{36}$/.test(id)) {
                    json(400, { error: 'body.task_id must be a task uuid' });
                    return;
                }
                try {
                    json(200, extras.tasks.cancel(id));
                }
                catch (error) {
                    json(404, { error: describe(error) });
                }
                return;
            }
            // ── MCP 桥接：入口清单 / 事件 / 探针动作 ──
            // 读出去的一律是**脱敏视图**（`tokenFingerprint` 而不是令牌；`extraArgs` 里只有
            // 配置文件**路径**，路径本身不含令牌）。503 而不是假装有数据。
            if (url.pathname === `${API_PATH}/mcp-bridge` || url.pathname.startsWith(`${API_PATH}/mcp-bridge/`)) {
                const bridge = extras.mcpBridge;
                if (bridge === undefined) {
                    json(503, { error: 'mcp bridge is not wired in this composition' });
                    return;
                }
                if (url.pathname === `${API_PATH}/mcp-bridge`) {
                    if (method !== 'GET') {
                        methodNotAllowed('GET');
                        return;
                    }
                    const raw = Number.parseInt(url.searchParams.get('events') ?? '200', 10);
                    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 4000) : 200;
                    json(200, { paths: bridge.paths, entries: bridge.list(), events: bridge.events(limit) });
                    return;
                }
                const leaf = url.pathname.slice(`${API_PATH}/mcp-bridge/`.length);
                if (leaf === 'open') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const sessionId = body.value.sessionId;
                    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
                        json(400, { error: 'body.sessionId must be a non-empty string' });
                        return;
                    }
                    const rawTtl = Number(body.value.ttlMs);
                    const ttlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : undefined;
                    const handle = await bridge.openForTurn({
                        sessionId: sessionId.trim(),
                        origin: 'api-probe',
                        ...(ttlMs === undefined ? {} : { ttlMs }),
                    });
                    if (handle === undefined) {
                        json(409, {
                            error: 'no entry was opened (no live Agent for that session id, or the target CLI has no verified --mcp-config injection)',
                            entries: bridge.list(),
                        });
                        return;
                    }
                    json(200, { entry: handle.view(), extraArgs: handle.extraArgs });
                    return;
                }
                if (leaf === 'close') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    // ① 按入口 id 精确关一个（探针做反例时只关自己开的那个，别动别人正在用的）。
                    const onlyId = typeof body.value.id === 'string' && body.value.id.trim().length > 0 ? body.value.id.trim() : undefined;
                    if (onlyId !== undefined) {
                        const closed = bridge.closeOne(onlyId, 'api-probe:id');
                        json(closed ? 200 : 404, { closed: closed ? [onlyId] : [], entries: bridge.list() });
                        return;
                    }
                    // ② 按会话关；③ 不给就全关。
                    const sessionId = typeof body.value.sessionId === 'string' && body.value.sessionId.trim().length > 0
                        ? body.value.sessionId.trim()
                        : undefined;
                    const before = bridge.list();
                    const targets = sessionId === undefined ? before : before.filter((entry) => entry.sessionId === sessionId);
                    bridge.closeAll(sessionId === undefined ? 'api-probe' : `api-probe:${sessionId}`, sessionId);
                    json(200, { closed: targets.map((entry) => entry.id), entries: bridge.list() });
                    return;
                }
                json(404, { error: `unknown mcp-bridge action "${leaf}" (open | close)` });
                return;
            }
            // ── 团队子会话绑定取证探针（U1）──
            // 没有这些路由，`createTeamMemberProbe` 就只是一个**装了观察者却没有驱动器**的脚手架：
            // 观察日志会照写，但没人能 configure / spawn / 读回结论。503 而不是假装有数据。
            if (url.pathname.startsWith(`${API_PATH}/probe/team/`)) {
                const probe = extras.teamProbe;
                if (probe === undefined) {
                    json(503, { error: 'team probe is not wired in this composition (no agentTeams / sessionController?)' });
                    return;
                }
                const leaf = url.pathname.slice(`${API_PATH}/probe/team/`.length);
                if (leaf === 'status') {
                    if (method !== 'GET') {
                        methodNotAllowed('GET');
                        return;
                    }
                    json(200, probe.status());
                    return;
                }
                if (leaf === 'logs') {
                    if (method !== 'GET') {
                        methodNotAllowed('GET');
                        return;
                    }
                    const raw = Number.parseInt(url.searchParams.get('limit') ?? '400', 10);
                    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 400;
                    json(200, { logPath: probe.status().logPath, entries: probe.logs(limit) });
                    return;
                }
                if (leaf === 'configure') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const targets = body.value.targets;
                    if (!Array.isArray(targets) || targets.length === 0) {
                        json(400, { error: 'body.targets must be a non-empty array of { name, target, accountId?, model? }' });
                        return;
                    }
                    const parsed = [];
                    for (const item of targets) {
                        const row = (item ?? {});
                        if (typeof row.name !== 'string' || row.name.trim().length === 0) {
                            json(400, { error: 'each target needs a non-empty name' });
                            return;
                        }
                        if (typeof row.target !== 'string' || row.target.trim().length === 0) {
                            json(400, { error: 'each target needs a non-empty target' });
                            return;
                        }
                        parsed.push({
                            name: row.name.trim(),
                            target: row.target.trim(),
                            ...(typeof row.accountId === 'string' && row.accountId.trim().length > 0 ? { accountId: row.accountId.trim() } : {}),
                            ...(typeof row.model === 'string' && row.model.trim().length > 0 ? { model: row.model.trim() } : {}),
                        });
                    }
                    json(200, probe.configure(parsed));
                    return;
                }
                if (leaf === 'spawn') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const specs = body.value.teammates;
                    if (!Array.isArray(specs) || specs.length === 0) {
                        json(400, { error: 'body.teammates must be a non-empty array of { name, context?, prompt? }' });
                        return;
                    }
                    const parsed = [];
                    for (const item of specs) {
                        const row = (item ?? {});
                        if (typeof row.name !== 'string' || row.name.trim().length === 0) {
                            json(400, { error: 'each teammate needs a non-empty name' });
                            return;
                        }
                        parsed.push({
                            name: row.name.trim(),
                            ...(row.context === 'fresh' || row.context === 'fork' ? { context: row.context } : {}),
                            ...(typeof row.prompt === 'string' ? { prompt: row.prompt } : {}),
                        });
                    }
                    try {
                        json(200, await probe.spawn(parsed, { ...(body.value.freshLead === true ? { freshLead: true } : {}) }));
                    }
                    catch (error) {
                        json(500, { error: describe(error) });
                    }
                    return;
                }
                if (leaf === 'clear') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    json(200, probe.clear());
                    return;
                }
                if (leaf === 'members') {
                    if (method !== 'GET') {
                        methodNotAllowed('GET');
                        return;
                    }
                    try {
                        json(200, await probe.members());
                    }
                    catch (error) {
                        json(503, { error: describe(error) });
                    }
                    return;
                }
                if (leaf === 'send') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const to = typeof body.value.to === 'string' ? body.value.to.trim() : '';
                    const message = typeof body.value.message === 'string' ? body.value.message : '';
                    const delivery = body.value.delivery === 'wakeup' ? 'wakeup' : 'quiet';
                    // 可选：显式 caller。**不传就完全走原路**（探针全局 Lead）—— 这是加法，不是改语义。
                    const leadSessionId = typeof body.value.leadSessionId === 'string' ? body.value.leadSessionId.trim() : '';
                    if (to.length === 0 || message.length === 0) {
                        json(400, { error: 'body.to and body.message must be non-empty strings' });
                        return;
                    }
                    try {
                        // 回显**实际使用的** caller 会话 id：让调用方能 fail-closed 地核对「我驱动的是哪个 Lead」，
                        // 而不是靠推断。（`result` 字段的形状不变 —— 既有探针读的是 `body.result`。）
                        json(200, { leadSessionId: leadSessionId.length > 0 ? leadSessionId : null, result: await probe.send(to, message, delivery, leadSessionId) });
                    }
                    catch (error) {
                        json(500, { error: describe(error), leadSessionId: leadSessionId.length > 0 ? leadSessionId : null });
                    }
                    return;
                }
                if (leaf === 'interrupt') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const target = typeof body.value.target === 'string' ? body.value.target.trim() : '';
                    const leadSessionId = typeof body.value.leadSessionId === 'string' ? body.value.leadSessionId.trim() : '';
                    if (target.length === 0) {
                        json(400, { error: 'body.target must be a non-empty teammate name' });
                        return;
                    }
                    try {
                        json(200, { leadSessionId: leadSessionId.length > 0 ? leadSessionId : null, result: await probe.interrupt(target, leadSessionId) });
                    }
                    catch (error) {
                        json(500, { error: describe(error), leadSessionId: leadSessionId.length > 0 ? leadSessionId : null });
                    }
                    return;
                }
                if (leaf === 'unbind') {
                    if (method !== 'POST') {
                        methodNotAllowed('POST');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (!body.ok) {
                        json(body.status, { error: body.error });
                        return;
                    }
                    const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                    if (sessionId.length === 0) {
                        json(400, { error: 'body.sessionId must be a non-empty string' });
                        return;
                    }
                    json(200, probe.unbind(sessionId));
                    return;
                }
                // ── 读**宿主自己写**的会话日志（探针取证用；不改任何东西）──
                // 为什么必须能读：U1 / 2.2 的判据里好几条只能从宿主落盘的转录里取
                // （该轮被记成谁、assistant 消息的 `source`、有没有真的产生这一轮）。
                // `text=1` 才会返回正文——默认只给结构（块类型 / 字符数），
                // 与 `/llm-adapter/redirect-turn` 的口径一致；正文只用于**探针自己造的成员会话**。
                if (leaf === 'session') {
                    if (method !== 'GET') {
                        methodNotAllowed('GET');
                        return;
                    }
                    const id = (url.searchParams.get('id') ?? '').trim();
                    if (id.length === 0) {
                        json(400, { error: 'query id=<sessionId> is required' });
                        return;
                    }
                    if (extras.sessionLog === undefined) {
                        json(503, { error: 'sessionLog is not wired in this composition' });
                        return;
                    }
                    const wantText = url.searchParams.get('text') === '1';
                    const read = extras.sessionLog(id);
                    const events = (read.events ?? []).map((event) => {
                        const summary = summarizeSessionEvent(event);
                        if (!wantText)
                            return summary;
                        const data = isObjLike(event.data) ? event.data : {};
                        const textOf = (blocks) => Array.isArray(blocks)
                            ? blocks.filter(isObjLike).map((block) => (typeof block.text === 'string' ? block.text : '')).join('')
                            : '';
                        if (event.type === 'assistant/message') {
                            return { ...summary, text: textOf(data.message?.content) };
                        }
                        if (event.type === 'user/message') {
                            return { ...summary, text: textOf(data.message?.content ?? data.content) };
                        }
                        return summary;
                    });
                    json(200, {
                        sessionId: id,
                        available: read.available,
                        ...(read.reason === undefined ? {} : { reason: read.reason }),
                        seq: read.seq ?? null,
                        header: read.header ?? null,
                        eventCount: events.length,
                        events,
                    });
                    return;
                }
                json(404, { error: `unknown team probe endpoint: ${method} ${url.pathname} (status|logs|configure|spawn|clear|session|members|send|interrupt|unbind)` });
                return;
            }
            // ── **产品**团队路由（`/team/*`）──
            // 与上面 `/probe/team/*` 的分工必须说清，否则读的人会把两者混成一套：
            //   · `/probe/team/*` 是**取证**面：它的意图表按**成员名**索引、只有探针能 configure，
            //     并且它自己 spawn 成员（`provider: 'spawn'` 固定）—— 它**不是**产品功能。
            //   · `/team/*` 是**产品**面：身份来自 `harness_spawn_teammate` 的「先冻结、后 spawn」，
            //     隔离键是 (Lead 会话, 成员名) 与 childSessionId，本接口**只读**（除 dispatch 的
            //     执行侧），并且**不** spawn 任何东西 —— 列表为空就是空，不假装有数据。
            if (url.pathname === `${API_PATH}/team/routing` || url.pathname === `${API_PATH}/team/pending`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const routing = extras.teamRouting;
                if (routing === undefined) {
                    json(503, { error: 'team routing is not wired in this composition (src/team-routing.ts not mounted)' });
                    return;
                }
                const routes = routing.routes();
                json(200, {
                    isolationKey: 'intent=(leadSessionId, memberName) · resolution=childSessionId（**不含**「全局成员名」这一单独成键）',
                    count: routes.length,
                    routes: routes.map((route) => ({
                        childSessionId: route.childSessionId,
                        leadSessionId: route.leadSessionId,
                        memberName: route.memberName,
                        target: route.target,
                        // 账号只出脱敏标签：`accountId` 是内部标识，不进面向人的输出。
                        account: route.accountLabel ?? null,
                        model: route.model ?? null,
                        via: route.via,
                        setAt: route.binding.setAt,
                        resolvedAt: route.resolvedAt,
                    })),
                    pending: url.pathname.endsWith('/pending') ? routing.pending() : undefined,
                });
                return;
            }
            if (url.pathname === `${API_PATH}/team/events`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const routing = extras.teamRouting;
                if (routing === undefined) {
                    json(503, { error: 'team routing is not wired in this composition' });
                    return;
                }
                const raw = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
                const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 200;
                json(200, { events: routing.events(limit) });
                return;
            }
            if (url.pathname === `${API_PATH}/team/dispatch`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const routing = extras.teamRouting;
                if (routing === undefined) {
                    json(503, { error: 'team routing is not wired in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const target = typeof body.value.target === 'string' ? body.value.target.trim() : '';
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (target.length === 0 || prompt.trim().length === 0) {
                    json(400, { error: 'body.target and body.prompt must be non-empty strings' });
                    return;
                }
                const sessionId = typeof body.value.sessionId === 'string' && body.value.sessionId.trim().length > 0
                    ? body.value.sessionId.trim()
                    : undefined;
                // 带 sessionId 时，账号**必须**取自该成员冻结的绑定 —— 否则「用 A 账号建的成员
                // 在某次补充派发里悄悄跑成 B 账号」这条路径就成立了。没有绑定 ⇒ 不猜，直接 400。
                let accountId = typeof body.value.accountId === 'string' && body.value.accountId.trim().length > 0
                    ? body.value.accountId.trim()
                    : undefined;
                if (sessionId !== undefined) {
                    const known = routing.routes().find((route) => route.childSessionId === sessionId);
                    if (known === undefined) {
                        json(400, { error: `sessionId ${sessionId} is not in the team routing table — refusing to dispatch an unbounded identity` });
                        return;
                    }
                    // ⚠️ 这里**不**用列表项当权威：列表是给界面看的**投影**，派发要读的是
                    // **冻结配方本体**（`TeamRoute.frozen`）。两者在旧记录上可能不一致
                    // （缺 `frozen` ⇒ 投影在册、配方没有），此时必须把「这条记录对派发不可用」
                    // 如实说出来，而不是退回去按**当下**的账号档案重算 —— 那就是静默换号。
                    const recipe = routing.recipeOf(sessionId);
                    if (recipe === undefined) {
                        json(409, {
                            error: `sessionId ${sessionId} is listed in the team routing table but carries no frozen recipe — refusing to re-derive the account at dispatch time (that would silently change the member's identity).`,
                            hint: '该记录是旧版本插件写下的（只有 binding、没有 frozen 配方）；请用产品工具重新创建成员，或删除 team-routing.json 里那一条。',
                        });
                        return;
                    }
                    if (accountId !== undefined && known.accountId !== accountId) {
                        json(400, { error: 'body.accountId conflicts with the account frozen for this member — refusing (no silent account switch)' });
                        return;
                    }
                    accountId = known.accountId;
                }
                const abort = new AbortController();
                res.on('close', () => { if (!res.writableEnded)
                    abort.abort(); });
                const outcome = await routing.dispatch({
                    target,
                    prompt,
                    cwd: process.cwd(),
                    signal: abort.signal,
                    ...(sessionId === undefined ? {} : { sessionId }),
                    ...(accountId === undefined ? {} : { accountId }),
                });
                if (!outcome.ok) {
                    json(502, { error: outcome.reason });
                    return;
                }
                json(200, {
                    target,
                    transport: outcome.transport,
                    stopReason: outcome.stopReason,
                    // 账号在输出里也只出脱敏形式。
                    account: accountId === undefined ? null : redactAccount(accountId),
                    // **独立证据**：子进程实际收到的 argv / cwd / pid（来自传输层，不是本插件的请求值）。
                    // 「模型有没有真的进命令行」这一格只能靠它判 —— 请求值自报不算数。
                    // ⚠️ 这一份是**活的** argv：`--config-dir` 会带出账号的档案目录名（＝接口数据，
                    // 与 `/task` 的 `facts` 同一口径）；令牌不在其中（桥接条目只走 env）。
                    facts: outcome.facts ?? null,
                    text: outcome.text,
                });
                return;
            }
            json(404, { error: `unknown harness-pilot endpoint: ${method} ${url.pathname}` });
        }
        catch (error) {
            json(500, { error: describe(error) });
        }
    };
}
// ══════════════════════════════════════════════════════════════════════════
// 团队子会话绑定取证探针（U1）—— 见 `TeamMemberProbeExtras` 的文档注释。
// 与 `createApiHandler` 一样导出，好让 `probe/**` 能在**离线**假 ctx 上驱动它，
// 而不是只能靠「跑一次真的」来验。
// ══════════════════════════════════════════════════════════════════════════
/** `spawn_teammate` 往成员 prompt 里塞的固定抬头（`dsh-experimental-tool-agent-team/lib/index.js:276-278`）。 */
const TEAMMATE_PROMPT_HEAD = '<system-reminder>\nYou are teammate "';
/**
 * 一个值的**深度受限结构摘要**（只留键名与类型，不取值、不递归进对象）。
 *
 * 存在的理由：探针会把宿主对象（活 Agent、membership）记进日志，而那些对象是**带环**的，
 * `JSON.stringify` 会直接抛。摘要是「序列化失败时的降级」，不是常规输出。
 */
function shapeOf(value, depth) {
    if (value === null)
        return null;
    if (value === undefined)
        return 'undefined';
    if (typeof value !== 'object')
        return typeof value;
    if (depth >= 2)
        return Array.isArray(value) ? `array(${value.length})` : 'object';
    if (Array.isArray(value))
        return `array(${value.length})`;
    const out = {};
    for (const key of Object.keys(value)) {
        let item;
        try {
            item = value[key];
        }
        catch {
            out[key] = '[unreadable]';
            continue;
        }
        out[key] = item === null ? null : typeof item === 'object' ? shapeOf(item, depth + 1) : typeof item;
    }
    return out;
}
/** 从成员 prompt 里读出成员名 —— 这是**唯一**能从「插件外生成」的子会话反查身份的信息。 */
export function teammateNameFromPrompt(prompt) {
    if (!Array.isArray(prompt))
        return undefined;
    for (const block of prompt) {
        if (block === null || typeof block !== 'object')
            continue;
        const text = block.text;
        if (typeof text !== 'string' || !text.startsWith(TEAMMATE_PROMPT_HEAD))
            continue;
        const rest = text.slice(TEAMMATE_PROMPT_HEAD.length);
        const end = rest.indexOf('"');
        if (end > 0)
            return rest.slice(0, end);
    }
    return undefined;
}
/**
 * **只读**一个会话的事件日志 —— 用**运行中宿主真正有**的那对访问器：`seq` + `eventAt(i)`。
 *
 * ⚠️ 这是本轮实测纠正的一个**脚手架 bug**：探针原先写的是 `session.events`，
 * 那个 accessor 只存在于源码 checkout（`packages/core/session`），**运行中的 rc.2 打包版没有**
 * （`probe/out/_live-dsh-session-types.js`：`log` 字段 / `eventAt(seq)` / `get seq()` 三样，
 * 没有 `events`）。用它会让两个读取路径**永远返回 undefined**，看起来像「宿主没给数据」。
 * 本插件自己的 `sessionLogRead`（`src/index.ts:165-190`）用的是对的那一对，这里对齐它。
 */
function readSessionEventsLite(ctxAny, sessionId) {
    const store = ctxAny.get?.('sessions');
    const session = store?.get?.(sessionId);
    if (session === undefined)
        return undefined;
    if (typeof session.seq !== 'number' || !Number.isSafeInteger(session.seq) || typeof session.eventAt !== 'function')
        return undefined;
    const out = [];
    for (let index = 0; index < session.seq; index += 1) {
        const raw = session.eventAt(index);
        if (raw === null || typeof raw !== 'object')
            continue;
        const event = raw;
        out.push({ type: event.type, data: event.data });
    }
    return out;
}
/**
 * 从 **Lead 的会话日志**里读出某个新生子会话对应的成员名。
 *
 * 为什么这是首选接缝（而 prompt 文本不是）：`agent-team` 的 `TeamRoster.spawnAdmitted`
 * 先 `journal.appendAndFlush(root, 'team/member', {member})`（`roster.js:240-249`，
 * `member.id === childId`），**之后**才 `subagents.startContinuable(...)`（`:252`）。
 * 因此子代理 `agent/created` 触发时，这条 `team/member` 事件**一定**已经在 Lead 的
 * 会话日志里（`journal.js:53-55` 的 `session.append` 是同步的）。
 *
 * 反过来，子会话自己的日志在那一刻**只有** `subagent/descriptor` 一条
 * （`descriptor-seed.js:20-21`：`Session.create(childId, seed)` + `append('subagent/descriptor')`），
 * 初始 prompt 要等 `startContinuable` 返回后才由 `submitMaterialized` 投进 inbox
 * （`continuation.js:200-209`）—— 所以「读子会话的 prompt」在 `agent/created` 时**必然读不到**。
 */
export function teammateFromLeadJournal(ctxAny, leadId, childId) {
    const events = readSessionEventsLite(ctxAny, leadId);
    if (events === undefined)
        return undefined;
    let name;
    for (const event of events) {
        if (event.type !== 'team/member')
            continue;
        const member = event.data?.member;
        if (member?.id === childId && typeof member.name === 'string' && member.name.length > 0)
            name = member.name;
    }
    return name;
}
/** 一个会话日志里的**事件类型序列**（只读，给 U2 的触发时机取证用）。 */
export function sessionEventTypes(ctxAny, sessionId) {
    const events = readSessionEventsLite(ctxAny, sessionId);
    if (events === undefined)
        return null;
    return events.map((event) => (typeof event.type === 'string' ? event.type : '?'));
}
/** 探针的落地位置（`probe/out/` 是既有约定：所有取证文件都在这里）。 */
export function teamProbePaths(root) {
    return {
        logPath: join(root, 'probe', 'out', 'team-member-binding.jsonl'),
        bindingsPath: join(root, 'probe', 'out', 'team-member-bindings.json'),
    };
}
/**
 * 建探针。`ctx` 是**插件自己的 ctx**（无 scope tag ⇒ `agent/created` 监听器全局被接纳，
 * 见 `dsh-scope/lib/index.js:327-338` 的 `tag === void 0 → true`）。
 *
 * `bindingSink` 是**可选**的落盘出口：传了就把绑定写进正式绑定表（与
 * `POST /session/binding` 同一条链）；不传则只记在探针内存里。这个开关让探针既能证明
 * 「绑定真的会被路由读到」，也能在离线自检里不碰任何文件。
 */
export function createTeamMemberProbe(ctx, root, config, bindingSink) {
    const ctxAny = ctx;
    const { logPath, bindingsPath } = teamProbePaths(root);
    const boundPath = join(pluginHome(), 'session-bindings.json');
    let seq = 0;
    let observationInstalled = false;
    const teammateBindings = new Map();
    const desired = new Map();
    /** 每个会话已发生的模型请求数（`llm/stream` 观测用；U1 的判据是「第 1 次时绑定在不在」）。 */
    const requestCounts = new Map();
    /**
     * 追加一条观测记录。**同步**写：判定依据是日志先后，异步落盘会让「先后」变成猜测。
     *
     * ⚠️ 序列化必须**防循环**：实测踩过 —— `membership` 里含 `root`（活的 Agent 对象），
     * `JSON.stringify` 抛 `Converting circular structure to JSON`，被下面的 catch 吞掉，
     * 结果是「`seq` 号被消耗掉、日志里却没有这一条」（U1 首轮就丢了一条 `probe.lead`）。
     * 现在先试普通序列化，失败就退回**深度受限的结构摘要**，一条都不许静默丢。
     */
    const log = (event, fields) => {
        const entry = { time: new Date().toISOString(), seq: ++seq, event, ...fields };
        let line;
        try {
            line = JSON.stringify(entry);
        }
        catch {
            line = JSON.stringify({ ...entry, detail: { unserializable: true, detailShape: shapeOf(entry.detail, 0) } });
        }
        try {
            mkdirSync(join(root, 'probe', 'out'), { recursive: true });
            appendFileSync(logPath, `${line}\n`, 'utf8');
        }
        catch { /* 取证日志写不进去不能反过来打断宿主生命周期 */ }
        return entry;
    };
    /** 该会话此刻的绑定画像（日志里只记**脱敏后**的账号，原始 id 留给路由）。 */
    const bindingViewOf = (sessionId) => {
        const current = sessionId === undefined ? undefined : readBindings()[sessionId];
        return current === undefined
            ? { present: false }
            : { present: true, harnessKind: current.harnessKind, harnessId: current.harnessId, account: redactAccount(current.accountId ?? ''), setAt: current.setAt };
    };
    const readBindings = () => {
        try {
            return { ...loadBindingState(boundPath).bindings };
        }
        catch {
            return {};
        }
    };
    // ── 观测 ①：新生子会话。这是「插件外生成的子会话 id」唯一能被接住的时刻。 ──
    if (typeof ctxAny.on === 'function') {
        observationInstalled = true;
        ctxAny.on('agent/created', (payload) => {
            // ⚠️ **payload 的形状是宿主事实，不是猜的**。运行中的 rc.2 打包版是
            //   `await this.ctx.serial(carrier, 'agent/created', { agent, source, signal? })`
            // （`probe/out/_live-dsh-agent-types.js:332-336`，从运行中的 `app.asar` 里取出）。
            // 注意两点：① 是 **serial**（监听器被 await，不是 fire-and-forget）；
            // ② 源码 checkout 里那一份写的是 `{agent}` + `emit`，**与运行版不同** ——
            // 所以「从 checkout 推断 payload」这一步本身就是错的，必须读运行版。
            // 原来的脚手架写的是 `payload.id` / `payload.session`（= 把 payload 当 Agent），
            // 于是**永远拿不到 id**，看起来像「宿主没给会话 id」。
            const outer = (payload ?? {});
            const agent = (outer.agent ?? {});
            const id = typeof agent.id === 'string' ? agent.id : undefined;
            const header = agent.session?.header;
            const parentId = typeof header?.parentSession === 'string' ? header.parentSession : undefined;
            log('agent/created', {
                ...(id === undefined ? {} : { sessionId: id }),
                ...(parentId === undefined ? {} : { parentId }),
                detail: {
                    payloadKeys: payload !== null && typeof payload === 'object' ? Object.keys(payload) : null,
                    hasAgent: outer.agent !== undefined,
                    agentIdType: typeof agent.id,
                    headerKeys: header === undefined ? null : Object.keys(header),
                    origin: header?.origin ?? null,
                    delegationDepth: header?.delegationDepth ?? null,
                    idFromHeader: header?.id ?? null,
                    idMatchesHeader: id !== undefined && header?.id === id,
                    // 触发时机：这一刻**已经**在册的事件类型序列（用来说明「prompt 还没到」）。
                    childEvents: id === undefined ? null : sessionEventTypes(ctxAny, id),
                },
            });
            if (id === undefined || parentId === undefined)
                return;
            const byJournal = teammateFromLeadJournal(ctxAny, parentId, id);
            const prompt = readSessionPrompt(ctxAny, id);
            const byPrompt = teammateNameFromPrompt(prompt);
            const teammate = byJournal ?? byPrompt;
            const identifiedBy = byJournal !== undefined
                ? 'lead-journal:team/member'
                : (byPrompt !== undefined ? 'child-prompt' : 'none');
            const want = teammate === undefined ? undefined : desired.get(teammate);
            if (teammate === undefined || want === undefined) {
                log('bind.skipped', {
                    sessionId: id,
                    ...(teammate === undefined ? {} : { teammate }),
                    detail: {
                        reason: teammate === undefined ? 'not-a-team-member-session' : `no configured target for teammate "${teammate}"`,
                        identifiedBy,
                        promptBlocks: Array.isArray(prompt) ? prompt.length : null,
                    },
                });
                return;
            }
            try {
                // **幂等**：`agent/created` 会对**同一个子会话**再触发一次 —— 成员被冷恢复
                // （`ownerCtx.agents.resume`）时会重新 publish，于是又发一次 `agent/created`
                // （实测：v2 的观测日志 seq 34/35 与 56/57，第二次的 `childEvents` 里已经带着上一轮的
                // 完整历史 `agent/inbox/spliced … turn/end`）。此时绑定**必须原样保留**：
                // 重写它只会把 `setAt` 推后，让「绑定有没有被盲目重放」这类判据失真，而值本来就一样。
                const current = readBindings()[id];
                if (current !== undefined && current.harnessId === want.target && (current.accountId ?? '') === (want.accountId ?? '')) {
                    const kept = log('bind.kept', { sessionId: id, teammate, detail: { harnessId: current.harnessId, setAt: current.setAt, mechanism: 'cold-resume re-announce: same target already bound', identifiedBy } });
                    teammateBindings.set(id, { teammate, harnessId: want.target, ...(want.accountId === undefined ? {} : { accountId: want.accountId }), seq: kept.seq, writtenAt: current.setAt });
                    return;
                }
                const binding = makeBinding({ sessionId: id, harnessId: want.target, ...(want.accountId === undefined ? {} : { accountId: want.accountId }), ...(want.model === undefined ? {} : { model: want.model }) });
                if (bindingSink !== undefined)
                    bindingSink(binding);
                const written = log('bind.written', {
                    sessionId: id,
                    teammate,
                    detail: { harnessId: want.target, account: redactAccount(want.accountId ?? ''), model: want.model ?? null, sink: bindingSink === undefined ? 'probe-memory' : 'session-bindings', via: 'agent/created', identifiedBy },
                });
                teammateBindings.set(id, { teammate, harnessId: want.target, ...(want.accountId === undefined ? {} : { accountId: want.accountId }), seq: written.seq, writtenAt: written.time });
            }
            catch (error) {
                log('bind.failed', { sessionId: id, teammate, detail: { error: describe(error) } });
            }
        });
        // ── 观测 ②：每一次模型请求。它是「第一次请求时绑定在不在」的**当场证据**。 ──
        ctxAny.on('llm/stream', (options, next) => {
            const request = (options ?? {});
            const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined;
            if (sessionId !== undefined)
                requestCounts.set(sessionId, (requestCounts.get(sessionId) ?? 0) + 1);
            log('llm/stream', {
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(sessionId !== undefined && teammateBindings.has(sessionId) ? { teammate: teammateBindings.get(sessionId)?.teammate } : {}),
                detail: {
                    provider: request.provider ?? null,
                    model: request.model ?? null,
                    purpose: request.purpose ?? null,
                    // 这是**第几次**该会话的模型请求 —— U1 的判据就是「第 1 次时绑定在不在」。
                    requestIndex: sessionId === undefined ? null : (requestCounts.get(sessionId) ?? 0),
                    bindingAtRequest: bindingViewOf(sessionId),
                    isTeamChild: sessionId !== undefined && teammateBindings.has(sessionId),
                },
            });
            // llm/stream is a waterfall, not a notification: observation must forward
            // the downstream AsyncIterable unchanged or every model turn is truncated.
            return next();
        });
    }
    const status = () => {
        const missingTargets = [...new Set([...desired.values()].map((item) => item.target))]
            .filter((name) => !config.resolvedTargets.some((target) => target.name === name && target.transport === 'auto'));
        return {
            bindings: [...teammateBindings.entries()].map(([sessionId, value]) => ({
                sessionId,
                teammate: value.teammate,
                harnessId: value.harnessId,
                accountId: value.accountId === undefined ? null : redactAccount(value.accountId),
                seq: value.seq,
            })),
            logPath,
            bindingsPath: boundPath,
            observationInstalled,
            missingTargets,
        };
    };
    /**
     * 解析（必要时创建）这个探针用的 **Team Lead** 会话，并证明它真的被 agent-team 认成 Team。
     *
     * 为什么把「认成 Team」也当成判据：`spawnTeammate` 在 caller 不是 Lead 时抛
     * `TEAM_LEAD_REQUIRED`（`roster.js:223-224`）—— 那说明的是**一条完全不同的**失败原因，
     * 不能和 U1 的结论混在一起。
     */
    const ensureLead = async (options = {}) => {
        const controller = ctxAny.get?.('sessionController');
        if (controller?.create === undefined || controller.resolveAgent === undefined)
            throw new Error('sessionController service is not available in this composition');
        if (options.fresh === true)
            delete globalThis.__hpLeadSession;
        // **显式 caller**（`options.leadSessionId`）：用**这个会话的真实 Agent** 当 caller，
        // 并且**既不读也不写** `globalThis.__hpLeadSession`。
        //
        // 为什么必须能显式指定：那个全局是**探针自己**的 Lead（`session-hp-teamlead-*`）。
        // 拿它去驱动「**产品** Lead 的团队」是**错域** —— `sendMessage(caller, {target})` 在
        // caller 自己的花名册里按**成员名**解析目标（`resolveActiveMember`，
        // `dsh-experimental-agent-team/lib/index.js:350-357`），产品成员名不在探针 Lead 的花名册里，
        // 于是抛 `active teammate "…" not found`。本轮之前那条「成员跨轮」验收正是栽在这里：
        // 它收到了 Lead A/B 的 id，却把三个 `/probe/team/send` 全发给了这个全局探针 Lead，
        // 于是三条投递全 500、取消那条拿到 `{threw:…}` 却被只看 HTTP 状态的判据记成 PASS。
        //
        // ⚠️ 无参（`leadSessionId` 缺省/空串）时行为与本改动**前完全一致**：读全局 → 没有就建一条并记回全局。
        const explicitLead = typeof options.leadSessionId === 'string' ? options.leadSessionId.trim() : '';
        let leadSessionId = explicitLead.length > 0
            ? explicitLead
            : (typeof globalThis.__hpLeadSession === 'string' ? String(globalThis.__hpLeadSession) : '');
        if (leadSessionId.length === 0) {
            const created = await controller.create({ sessionId: `session-hp-teamlead-${randomUUID()}`, cwd: process.cwd() });
            const value = (created ?? {});
            if (typeof value.sessionId !== 'string' || value.sessionId.length === 0)
                throw new Error(`sessionController.create returned no sessionId: ${JSON.stringify(created)}`);
            leadSessionId = value.sessionId;
            globalThis.__hpLeadSession = leadSessionId;
        }
        const resolved = await controller.resolveAgent(leadSessionId);
        const lead = resolved?.agent;
        if (lead === undefined)
            throw new Error(`could not resolve a live Lead agent for session ${leadSessionId}`);
        const teamsSvc = ctxAny.get?.('agentTeams');
        let membership;
        try {
            membership = teamsSvc?.tryMembership(lead);
        }
        catch (error) {
            membership = { threw: describe(error) };
        }
        // 只记**摘要**：membership 里含 `root`（活的 Agent），整个序列化会抛循环引用
        // （见 `log()` 的注释）。
        const membershipView = membership === undefined || membership === null
            ? null
            : (() => {
                const row = membership;
                return row.threw !== undefined
                    ? { threw: row.threw }
                    : { role: row.role ?? null, name: row.name ?? null, id: row.id ?? null, rootId: row.root?.id ?? null };
            })();
        log('probe.lead', { sessionId: leadSessionId, detail: { membership: membershipView } });
        return { leadSessionId, lead };
    };
    /**
     * 取 `agentTeams` 服务，并把**每个方法名都核对一遍**。
     *
     * 探针调用的这些方法与工具调用的是**同一个服务方法**（`send_message` →
     * `agentTeams.sendMessage`、`list_agents` → `agentTeams.listMembers`、
     * `interrupt_agent` → `agentTeams.interrupt`；见 `tool-agent-team/lib/index.js:305-328`），
     * 唯一差别是「谁被当作 caller 授权凭据」—— 工具传 `exec.agent`，探针传 Lead。
     * 因此探针能证明的是**服务语义**，不是「模型的工具调用被桥接了」（那是另一件事，见 2.3）。
     */
    const teamsService = () => {
        const svc = ctxAny.get?.('agentTeams');
        if (svc === undefined)
            throw new Error('agentTeams service is not available in this composition (is the agent-team bundle mounted?)');
        return svc;
    };
    return {
        status,
        configure: (targets) => {
            for (const item of targets)
                desired.set(item.name, item);
            log('probe.configured', { detail: { targets: targets.map((item) => ({ name: item.name, target: item.target, account: redactAccount(item.accountId ?? ''), model: item.model ?? null })) } });
            return status();
        },
        spawn: async (specs, options) => {
            const teams = teamsService();
            const { leadSessionId, lead } = await ensureLead({ ...(options?.freshLead === true ? { fresh: true } : {}) });
            const members = [];
            // 宿主契约：`spawnTeammate` 的 request 必须带一个**真的 AbortSignal**
            // （`roster.js:226` 的 `AbortSignal.any([request.signal, this.lifecycle.signal])`
            // 会拒绝 `undefined`；工具路径由 `tool-agent-team/lib/index.js:284` 传 `exec.signal`）。
            // 探针自己持有一个不 abort 的 controller：成员的生命周期由 Team 运行时管，不由探针管。
            const probeSignal = new AbortController().signal;
            for (const spec of specs) {
                // 没有配置目标的成员**故意不绑**：它从诞生起就是原生（host 供应商），
                // 用作 A/B 对照的**正**样本 —— 「同一句 prompt，一个从没被改道」。
                // 这比「先绑再解绑」干净：解绑后能否回到原生取决于请求层的残留恢复分支，
                // 而那是一个**独立变量**，不该混进工具通道的判定里。
                const want = desired.get(spec.name);
                const before = seq;
                const started = await teams.spawnTeammate(lead, {
                    name: spec.name,
                    description: `harness-pilot U1 probe teammate ${spec.name}`,
                    prompt: [
                        { type: 'text', text: '<system-reminder>\nYou are teammate "' + spec.name + '".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
                        { type: 'text', text: spec.prompt ?? 'Reply with exactly: PROBE-OK' },
                    ],
                    context: spec.context ?? 'fresh',
                    provider: 'spawn',
                    signal: probeSignal,
                });
                const member = started.member;
                // 子会话 id 由 roster 在插件外生成 ⇒ 只能在 spawn 返回后才知道，所以绑定是
                // 「成对」写进绑定的：谁排在他后面，谁就拿不到（必须在 spawn 前 configure）。
                if (want === undefined) {
                    log('bind.intent', { ...(member?.id === undefined ? {} : { sessionId: member.id }), teammate: spec.name, detail: { intent: 'none', reason: 'no configured target — this member is deliberately left native (A/B control)' } });
                }
                else if (member?.id !== undefined && member.id.length > 0 && !teammateBindings.has(member.id)) {
                    const binding = makeBinding({ sessionId: member.id, harnessId: want.target, ...(want.accountId === undefined ? {} : { accountId: want.accountId }), ...(want.model === undefined ? {} : { model: want.model }) });
                    if (bindingSink !== undefined)
                        bindingSink(binding);
                    const written = log('bind.written', { sessionId: member.id, teammate: spec.name, detail: { harnessId: want.target, account: redactAccount(want.accountId ?? ''), sink: bindingSink === undefined ? 'probe-memory' : 'session-bindings', via: 'post-spawn-fallback', droppedWithinSpawn: seq - before } });
                    teammateBindings.set(member.id, { teammate: spec.name, harnessId: want.target, ...(want.accountId === undefined ? {} : { accountId: want.accountId }), seq: written.seq, writtenAt: written.time });
                }
                members.push(member);
            }
            return { leadSessionId, members, status: status() };
        },
        /** 名单（`agentTeams.listMembers(lead)` —— 与 `list_agents` 工具同一个服务方法）。 */
        members: async () => {
            const svc = teamsService();
            const { leadSessionId, lead } = await ensureLead();
            if (svc.listMembers === undefined)
                throw new Error('agentTeams.listMembers is not available in this composition');
            const rows = svc.listMembers(lead);
            log('probe.members', { sessionId: leadSessionId, detail: { members: rows } });
            return { leadSessionId, members: rows };
        },
        /**
         * 投递一条消息（`agentTeams.sendMessage(lead, …)` —— 与 `send_message` 工具同一个服务方法，
         * 同一个 `delivery` 语义）。这是「Lead → 成员」这条方向能不能真的把内容送到并驱动一轮的判据。
         */
        send: async (to, message, delivery, leadSessionId) => {
            const svc = teamsService();
            const { leadSessionId: callerLead, lead } = await ensureLead(leadSessionId === undefined || leadSessionId.length === 0 ? {} : { leadSessionId });
            if (svc.sendMessage === undefined)
                throw new Error('agentTeams.sendMessage is not available in this composition');
            const result = await svc.sendMessage(lead, {
                target: to,
                content: [{ type: 'text', text: message }],
                delivery: delivery ?? 'quiet',
                signal: new AbortController().signal,
            });
            log('probe.send', { sessionId: callerLead, teammate: to, detail: { delivery: delivery ?? 'quiet', chars: message.length, recipientSessionId: result?.sessionId ?? null } });
            return result ?? null;
        },
        /** 中断某个成员当轮（`agentTeams.interrupt(lead, name)` —— 与 `interrupt_agent` 工具同一个服务方法）。 */
        interrupt: async (targetName, leadSessionId) => {
            const svc = teamsService();
            const { leadSessionId: callerLead, lead } = await ensureLead(leadSessionId === undefined || leadSessionId.length === 0 ? {} : { leadSessionId });
            if (svc.interrupt === undefined)
                throw new Error('agentTeams.interrupt is not available in this composition');
            let result;
            try {
                result = svc.interrupt(lead, targetName);
            }
            catch (error) {
                result = { threw: describe(error) };
            }
            log('probe.interrupt', { sessionId: callerLead, teammate: targetName, detail: { result: result === undefined ? null : result } });
            return result ?? null;
        },
        /**
         * 把某个会话**解绑成原生**（走 `bindingSink` = 与 `POST /session/binding` 同一条链）。
         *
         * 用途：做 A/B 对照 —— 同一个成员、同一句 prompt，**只在改道 / 原生之间切换这一个变量**，
         * 用来区分「工具不通」是**这条路由**的问题，还是这个成员本身的问题。
         */
        unbind: (sessionId) => {
            const binding = makeBinding({ sessionId });
            if (bindingSink !== undefined)
                bindingSink(binding);
            teammateBindings.delete(sessionId);
            const written = log('bind.cleared', { sessionId, detail: { harnessKind: binding.harnessKind, sink: bindingSink === undefined ? 'probe-memory' : 'session-bindings' } });
            return { sessionId, harnessKind: binding.harnessKind, seq: written.seq };
        },
        logs: (limit) => {
            let entries = [];
            try {
                entries = readFileSync(logPath, 'utf8')
                    .split('\n')
                    .filter((line) => line.trim().length > 0)
                    .map((line) => JSON.parse(line));
            }
            catch { /* 还没写过日志 */ }
            return entries.sort((a, b) => a.seq - b.seq).slice(-Math.max(1, limit));
        },
        clear: () => {
            let removed = 0;
            try {
                removed = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
            }
            catch { /* 文件不存在 */ }
            try {
                mkdirSync(join(root, 'probe', 'out'), { recursive: true });
                writeFileSync(logPath, '', 'utf8');
                writeFileSync(bindingsPath, `${JSON.stringify({ version: 1, targets: Object.fromEntries([...desired.entries()]), bindings: Object.fromEntries([...teammateBindings.entries()]) }, null, 2)}\n`, 'utf8');
            }
            catch { /* 尽力而为 */ }
            teammateBindings.clear();
            requestCounts.clear();
            seq = 0;
            return { removed, logPath };
        },
    };
}
/**
 * 读一个会话的**初始 prompt 内容块**（次选接缝；首选是 `teammateFromLeadJournal`）。
 *
 * 为什么读日志而不是读内存：`agent/created` 触发时子代理的初始 prompt **还没有**投进它的
 * inbox（`roster.js` 的 `submitMaterialized` 在 `startContinuable` 返回后才发生）。拿不到就
 * 返回 undefined —— 读不到是一件要如实记录的事，不能拿空数组冒充「prompt 是空的」。
 *
 * ⚠️ 实测（U1 首轮）：子会话在那一刻的日志里**只有** `subagent/descriptor` 一条
 * （`descriptor-seed.js:20-21`），`user/message` 要等 `submitMaterialized` 才有 ——
 * 所以这个接缝**在 `agent/created` 时刻按设计就拿不到东西**，它只是保留作为对照。
 */
function readSessionPrompt(ctxAny, sessionId) {
    const events = readSessionEventsLite(ctxAny, sessionId);
    if (events === undefined)
        return undefined;
    for (const event of events) {
        if (event.type !== 'user/message')
            continue;
        const content = event.data?.message?.content;
        if (Array.isArray(content))
            return content;
    }
    return undefined;
}
export function apply(ctx, rawConfig) {
    const legacyConfig = resolveConfig(rawConfig);
    // Retire CLI execution for these products; desktop apps remain solely login sources.
    // 例外（最小改造执行计划 P2）：声明了 nativeCli 结构化协议能力的**五路产品入口**
    // （workbuddy-native / workbuddy-ai-native / qoder-cn-native / qoder-cn-ide / antigravity-native）
    // 是本轮明确批准恢复的持久原生会话路线 —— 带精确原生恢复、受管门禁与诚实边界；
    // 其余同名旧条目维持退休（不恢复旧的一次性裸 CLI 行为）。
    const NATIVE_SESSION_PRODUCT_ENTRIES = new Set(['workbuddy-native', 'workbuddy-ai-native', 'qoder-cn-native', 'qoder-cn-ide', 'antigravity-native']);
    const config = { ...legacyConfig, resolvedTargets: legacyConfig.resolvedTargets.filter(target => NATIVE_SESSION_PRODUCT_ENTRIES.has(target.name)
            || target.nativeCli !== undefined
            || !['workbuddy', 'qoder', 'antigravity'].includes(classifyTarget(target).key)) };
    const logger = ctx.logger;
    const ctxAny = ctx;
    const helper = new WindowHelper(config.pythonPath);
    // 宿主 subprocess 服务：提供 ConPTY（无原生依赖的 pty 通道）。inject 声明保证已就位。
    const subprocess = ctxAny.get?.('subprocess');
    const spawnTerminalImpl = subprocess?.spawnTerminal;
    const spawnTerminal = spawnTerminalImpl === undefined
        ? undefined
        : async (spec) => await spawnTerminalImpl.call(subprocess, spec);
    // 宿主 llm 服务：读出「本 profile 已配置的供应商模型」，供 harness_models 与设置页使用。
    const llm = ctxAny.get?.('llm');
    // 注册表在 federationState 之前构造，而停用判定要读它 —— 用一个惰性盒子，
    // 保证「停用」在**派发那一刻**生效（而不是构造那一刻的快照）。
    const registryStateBox = {};
    /**
     * 第 4 阶段：自动切换**执行侧**的惰性盒子。
     *
     * 为什么是盒子：`TaskManager` 在账号池 / 切换账本**之前**构造，
     * 而执行侧要读它们。用闭包变量会踩「声明前使用」；用盒子则在**派发那一刻**取值，
     * 于是「用户刚在设置页打开自动切换」对下一个任务立即生效。
     */
    const autoSwitchBox = {};
    // ── 进程池（并发上限 / 空闲回收）的初值 ──────────────────────
    // ⚠️ 位置纪律：必须在 `SessionRegistry` **之前** —— 下面给了 `pool` / `poolStateFile`
    // 两个依赖，注册表在**构造时**就会建池（`SessionRegistry` 构造器：`if (deps.pool !== undefined
    // || deps.poolStateFile !== undefined) void this.pool()`），
    // 所以运行时设置必须先读出来，否则池的初值只能拿到默认值。
    // 原来那处 `let runtimeSettings = loadSettings()` 位于 TaskManager 之前（更靠后），
    // 已由本行取代（同一作用域不能重复声明）。
    // 提前是**安全的**：`loadSettings()` 只依赖 `pluginHome()`（`HARNESS_PILOT_HOME` 或
    // `~/.dsh/plugins/harness-pilot`）与磁盘上的 `runtime-settings.json`，
    // 不读本函数里任何后声明的变量（见 `src/settings.ts`：读不到/损坏即回默认，不抛）。
    let runtimeSettings = loadSettings();
    let processPool;
    const applyPoolPolicy = () => {
        if (processPool === undefined)
            return;
        // 语义只在一处定义（`applyRuntimeConcurrency`）：0=不限；>0=上限；
        // 第 2 个参数是超限行为开关（'reject' 显式拒绝 / 'wait' 显式排队）。
        processPool.setPolicy(applyRuntimeConcurrency(runtimeSettings.maxConcurrent, 'reject'));
    };
    const accountManagers = new AccountManagers({ file: join(pluginHome(), 'account-managers.json') });
    // ── 五路产品入口（nativeCli）的受管 WorkBuddy 绑定 ──
    // 账号 id 烘焙在目标 argv 里（wrapper 的第 2 个参数）；隔离档案容器为固定路径。
    // 与旧账号种子登记表（已迁 dsh-model-connect，本轮不动）**无关**：
    // 门禁复用同一实现（适配器 sha256 + 厂商 CLI --version 实测），冻结 HOME 复用
    // prepareWorkBuddyHome 同一实现（指纹/keyblob 校验都在里面）。
    const NATIVE_MANAGED_WORKBUDDY = {
        'workbuddy-a': { vendorExecutable: 'D:/workbuddy/WorkBuddy.exe' },
        'workbuddy-ai-b': { vendorExecutable: 'D:/workbuddy ai/WorkBuddyAI/WorkBuddyAI.exe' },
    };
    const registry = new SessionRegistry({
        prepareAccountTarget: (target, accountId) => {
            const wrapper = target.args.findIndex(arg => /(?:^|[\\/])workbuddy-managed\.cjs$/i.test(arg));
            if (wrapper < 0)
                return target;
            const id = accountId ?? target.args[wrapper + 1];
            const seed = seedsNow().find(entry => entry.id === id);
            if (seed !== undefined && seed.launch.mode === 'managed-bootstrap')
                return prepareWorkBuddyHome(target, seed.configDir, homeDir());
            // nativeCli 产品入口：按 argv 烘焙的账号 id 准备冻结 HOME（不经过种子登记表）。
            if (typeof id === 'string' && NATIVE_MANAGED_WORKBUDDY[id] !== undefined) {
                return prepareWorkBuddyHome(target, join(homeDir(), 'harness-accounts', id), homeDir());
            }
            throw new Error('WorkBuddy 隔离账号档案不存在');
        },
        accountManagers,
        config,
        helper,
        ...(spawnTerminal === undefined ? {} : { spawnTerminal }),
        ...(llm === undefined ? {} : { llm }),
        // 用户停用的目标必须显式拒绝派发。
        // ── 受管账号（WorkBuddy 的 `managed-bootstrap`）的**执行前门禁** ──
        // 真实测量：随包适配器 sha256 + 厂商 CLI `--version` 实测（不是读配方字符串）。
        // 接线在这里的理由：`registry.dispatch` 是 HTTP `/dispatch`、`/task/start` 与
        // `harness_task_start` 三条入口的**唯一收口**，而它们都不过子代理 provider 那条别名路径 ——
        // 只在 provider 里接线，门禁就只对一半入口成立。
        // 惰性求值：闭包体在**派发时**才跑（此时 `seedsNow` 已完成初始化）。
        // 非受管账号直接放行：普通账号没有「厂商内部协议」这层依赖，加门禁只会制造无理由的失败。
        accountRuntimeGate: async (accountId, targetName) => {
            // ── nativeCli 产品入口（受管 WorkBuddy）的执行前门禁 ──
            // 与旧种子路径同一实现：适配器 sha256 + 厂商 CLI --version 实测（fail closed）。
            if (NATIVE_MANAGED_WORKBUDDY[accountId] !== undefined) {
                const gateSeed = {
                    id: accountId,
                    launch: {
                        mode: 'managed-bootstrap',
                        bootstrap: { vendorExecutable: NATIVE_MANAGED_WORKBUDDY[accountId].vendorExecutable, requiresVendorVersionPrefix: '2.156.0' },
                    },
                };
                return await managedBootstrapRuntimeGate(gateSeed, targetName);
            }
            const seed = seedsNow().find((s) => s.id === accountId);
            // 未知档案不在这里判：「账号还在不在」由别名 provider / withAccountTarget 各自的判活负责，
            // 本门禁只回答「受管前提现在是否仍成立」，不越界冒充判活。
            if (seed === undefined)
                return undefined;
            return await managedBootstrapRuntimeGate(seed, targetName);
        },
        isTargetDisabled: (targetName) => registryStateBox.current?.overrides[targetName]?.enabled === false,
        // 并发上限 / 空闲窗口的初值：先用**当前设置**（`maxConcurrent` 与下面的
        // `applyPoolPolicy()` 同源，不是两处各写一份默认值）；`idleReapMs` 与
        // `DEFAULT_POOL_POLICY` 一致，只是显式写出这条接线。
        // ⚠️ 这个 30s 只作用于「已结束 run 的进程核对」。**长期交互会话**（harness_open 的
        // pty/cdp/window）的空闲回收走 `idleSessionReapMs`（默认 30 分钟）——2026-10-16 现场
        // 实测 30s 会把「开完隔一轮再投」的正常节奏当成废弃（4 个桌面会话全灭）。
        pool: { maxConcurrency: runtimeSettings.maxConcurrent, queueMode: 'reject', idleReapMs: 30_000 },
        poolStateFile: join(pluginHome(), 'run', 'processpool-state.json'),
        log: (level, message) => {
            if (level === 'warn')
                logger?.warn?.(message);
            else
                logger?.info?.(message);
        },
    });
    // ── 服务时序纪律 ──────────────────────────────────────────────
    // cordis 只保证 `inject` 声明的服务在 apply 前就位；subagents / webServer /
    // 唤醒链（agents / sessionController / sessions）的注册顺序**不保证**，
    // 主 fiber 里 ctx.get 可能拿到 undefined（实测：bundle 启动时 webServer 抢跑失败，
    // 路由静默丢失）。因此：
    //   · subagents / webServer → 子 fiber（inject 声明，服务到了才注册，永不抢跑）；
    //   · 唤醒链服务 → 投递回执时惰性解析。
    const subagentsFacade = {
        registerProvider: (provider) => {
            const real = ctxAny.get?.('subagents');
            if (real === undefined)
                throw new Error('ctx.subagents is not available in this composition');
            return real.registerProvider(provider);
        },
        list: () => ctxAny.get?.('subagents')?.list?.() ?? [],
        start: async (name, request) => {
            const real = ctxAny.get?.('subagents');
            if (real === undefined)
                throw new Error('ctx.subagents is not available in this composition');
            return await real.start(name, request);
        },
    };
    // ── 运行时设置 + 异步任务 + 完成回执（设置页可编辑；任务完成唤醒会话）──
    // `runtimeSettings` **不在这里**读：它已在 `SessionRegistry` 之前 `loadSettings()` 出来
    // （池的初值必须先拿到设置）。此处若再声明一次，同一作用域重复声明会直接编译失败。
    // 唤醒链（对齐 dsh-schedule）：sessionController.resolveAgent（不在线自动 resume =
    // 会话重新启动）→ agent.followup（排队新 turn 并唤醒）→ sessions.flush（落盘确认）。
    const waker = createSessionWaker({
        resolve: () => ({
            ...(ctxAny.get?.('sessionController') === undefined
                ? {}
                : { sessionController: ctxAny.get?.('sessionController') }),
            ...(ctxAny.get?.('agents') === undefined
                ? {}
                : { agents: ctxAny.get?.('agents') }),
            ...(ctxAny.get?.('sessions') === undefined
                ? {}
                : { sessions: ctxAny.get?.('sessions') }),
        }),
    });
    // ── 持久原生会话层（P1）与回执 outbox（P4）的实例 ──
    // 各只有一份：任务账本（TaskManager）、工具面（harness_sessions）、重启补投共用。
    // 状态文件都落在插件自己的数据目录；写路径是原子（tmp+rename）。
    const nativeSessions = {
        store: new NativeSessionStore(join(pluginHome(), 'native-sessions.json')),
        mutex: new SessionMutex(),
    };
    const receiptOutbox = new ReceiptOutbox(join(pluginHome(), 'receipt-outbox.json'));
    const tasks = new TaskManager({
        directory: join(pluginHome(), 'tasks'),
        // ⚠️ 两条派发路径都必须过同一个执行侧：
        //   · `TaskManager` 的 dispatch 依赖 → 覆盖 `/task/start`、子代理 provider、团队子会话；
        //   · `/dispatch` 处理器 → 覆盖同步 HTTP 派发。
        // 本项目栽过三次「同一能力在不同入口行为不一致」，所以这里先收敛成一个盒子，
        // 再由盒子把两条路径都接到 `executeWithAutoSwitch`（未挂载时原样直通）。
        dispatch: async (spec, options) => autoSwitchBox.current === undefined
            ? await registry.dispatch(spec, options ?? {})
            : await autoSwitchBox.current.dispatch(spec, options ?? {}),
        maxConcurrent: runtimeSettings.maxConcurrent,
        onComplete: async (view, callback, result) => {
            // 交付内容 + 续办提示一起打包，唤醒（必要时先重新启动）发起会话。
            const receipt = buildReceipt(view, callback, result, runtimeSettings);
            return await waker.wake(callback.sessionId, receipt);
        },
        // 全局回执开关 = 设置页的「完成后唤醒会话」（`notifyOnComplete`）。
        // 此前这个字段只被定义/渲染/落盘/读回，**没有任何代码读它做判定** ——
        // 于是用户关掉开关，任务完成照样唤醒会话（实测 callback.status 仍走到 failed/delivered，
        // 见 probe/verify-notify-live.mjs）。这里按**投递时**读当前值接线：
        // 箭头函数在每次投递时求值，所以设置页改完对在跑的任务也立即生效（与其它设置一致）。
        notifyEnabled: () => runtimeSettings.notifyOnComplete,
        // 持久原生会话层（P1）：TaskManager 用它做单会话互斥与原生 ID 回填。
        nativeSessions,
        // 回执 outbox（P4）：终态回执先落盘再投递；稳定回执 ID 进唤醒文本供收件端去重。
        outbox: receiptOutbox,
        log: message => logger?.warn?.(message),
    });
    // ── 重启补投（P4；R3/R5 按 Codex 审查重做）──
    // ① 先把磁盘上的 `sending`（进程死在 claim 与 settle 之间）显式改判 `uncertain`
    //    —— 它们有「已尝试发送」的证据，**绝不**再进补投队列。
    // ② 只补 `queued && attempts===0`（发送前崩溃边界），同一 ID、至少一次。
    // ③ 发送前经 `skipIf` 与**任务账本**协调：callback.notify=false / 目的会话不一致 /
    //    全局唤醒总闸关闭 / 任务非终态 ⇒ 记账 skipped，不发送。
    // 挂载时唤醒链服务不可见 ⇒ 全部留队（下次挂载再补），不把 queued 误标 failed。
    try {
        receiptOutbox.recoverInterrupted();
    }
    catch { /* 降级文件：留待人工恢复；drain 也会拒绝 */ }
    const wakeServiceVisible = ctxAny.get?.('sessionController') !== undefined || ctxAny.get?.('agents') !== undefined;
    if (wakeServiceVisible) {
        void receiptOutbox.drain(async (record) => {
            const view = tasks.status(record.taskId);
            const receipt = buildReceipt(view, {
                notify: true,
                sessionId: record.sessionId,
                instruction: '',
                status: 'sending',
                receiptId: record.receiptId,
            }, tasks.result(record.taskId).result, runtimeSettings);
            const note = await waker.wake(record.sessionId, receipt);
            logger?.info?.(`harness-pilot: receipt ${record.receiptId} redelivered after restart: ${note}`);
        }, {
            // R3：程序级协调检查（在 claim 之前执行）。文本里的去重 ID 只是提示，
            // 不投递的保证来自这里的检查 + claim/settle 状态机。
            skipIf: (record) => {
                try {
                    const view = tasks.status(record.taskId);
                    if (view.callback?.notify !== true)
                        return 'task callback has notify=false; not redelivering';
                    if (view.callback.sessionId !== record.sessionId)
                        return `task callback session (${view.callback.sessionId || 'empty'}) differs from receipt target; not redelivering`;
                    if (runtimeSettings.notifyOnComplete === false)
                        return 'notifyOnComplete is false in runtime settings; not redelivering';
                    if (!['completed', 'error', 'timeout', 'aborted', 'interrupted'].includes(view.status))
                        return 'task is not terminal; not redelivering';
                    return null;
                }
                catch (error) {
                    return `task ledger unreadable: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        }).then((summary) => {
            if (summary.sent + summary.failed + summary.skipped > 0) {
                logger?.info?.(`harness-pilot: receipt outbox restart drain: sent=${summary.sent} skipped=${summary.skipped} failed=${summary.failed}`);
            }
        }).catch((error) => {
            logger?.warn?.(`harness-pilot: receipt outbox drain failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    else if (receiptOutbox.pendingNeverAttempted().length > 0) {
        logger?.info?.(`harness-pilot: ${receiptOutbox.pendingNeverAttempted().length} queued receipt(s) held back at mount (wake services not visible yet); they will be redelivered on a later mount`);
    }
    // `SessionRegistry.pool()` 是惰性单例：注册表构造时已按初值建池，这里取同一实例
    // （不会再建第二个池），并把策略按当前设置推一次 —— 于是「池里跑的」与
    // 「`runtimeSettings.maxConcurrent` 说的」从启动第一刻起就是同一个数，
    // 而不是两处默认值恰好都为 4 的巧合。
    processPool = registry.pool();
    applyPoolPolicy();
    const applySettings = (raw) => {
        runtimeSettings = saveSettings(raw, runtimeSettings);
        tasks.setMaxConcurrent(runtimeSettings.maxConcurrent);
        applyPoolPolicy(); // 设置页改 maxConcurrent → 立刻作用于直连派发的并发闸门
        logger?.info?.(`harness-pilot: runtime settings applied: ${JSON.stringify(runtimeSettings)}`);
        return runtimeSettings;
    };
    // ── P1 联邦注册表：启停/自定义入口落盘在插件 home 下，与运行时设置同级 ──
    const registryStateFile = join(pluginHome(), 'harness-registry.json');
    let federationState = loadRegistryState(registryStateFile);
    registryStateBox.current = federationState;
    const federationExtras = {
        list: async (measure) => await buildRegistry({
            targets: config.resolvedTargets,
            overrides: federationState.overrides,
            measure,
        }),
        state: () => federationState,
        update: (target, patch) => {
            // 只接受已知目标：否则界面一个错字就能在配置里留下幽灵条目。
            if (!config.resolvedTargets.some((t) => t.name === target)) {
                throw new Error(`unknown harness target "${target}"`);
            }
            federationState = applyOverride(federationState, target, patch);
            registryStateBox.current = federationState;
            saveRegistryState(registryStateFile, federationState);
            logger?.info?.(`harness-pilot: registry override for "${target}" saved to ${registryStateFile}`);
            return federationState;
        },
    };
    // ── P5b 会话级绑定 ──
    // 作用范围如实写在 scopeNote 里：它改变的是**从该会话发起的外部派发**的默认目标与模型；
    // **本会话自身的对话轮次仍由 DSH 执行**（把会话引擎整体转交外部 CLI 需要 LLM 适配器，未实现）。
    const bindingStateFile = join(pluginHome(), 'session-bindings.json');
    let bindingState = loadBindingState(bindingStateFile);
    const bindingExtras = {
        get: (sessionId) => bindingState.bindings[sessionId],
        set: (input) => {
            const binding = makeBinding(input);
            bindingState = applyBinding(bindingState, binding);
            saveBindingState(bindingStateFile, bindingState);
            logger?.info?.(`harness-pilot: session binding for ${binding.sessionId} -> ${binding.harnessKind}/${binding.harnessId ?? 'dsh'} model=${binding.model ?? '(none)'}`);
            return binding;
        },
    };
    // ── **产品化团队路由**（`src/team-routing.ts`）──────────────────────────────
    // 与下面那个**取证探针**（`createTeamMemberProbe`）的分工必须一眼看出区别，
    // 否则读的人会把两者当成一套：
    //   · 探针的意图表 `desired` 按**成员名**索引 ⇒ 两个团队的同名成员会互相覆盖
    //     （这正是「普通团队若同名成员，可能意外命中残留的 probe 意图」这条缺口的根源）；
    //   · 产品表按 **(Lead 会话, 成员名)** 存意图、按 **childSessionId** 解析 ⇒ 天然隔离，
    //     并且它**不读探针的任何状态**（两条链互不命中，旧探针残留影响不到产品路由）。
    //
    // 位置纪律：必须在 `mountApi` **之前**、在任何子会话诞生之前建好 —— 它的
    // `session/event` 观察者要在第一个成员创建时就位。
    const teamRouting = new TeamRoutingTable({
        config,
        // 惰性：注册期快照会让「删了账号还能用」重新成立（与别名 provider 同一条纪律）。
        accountSeeds: () => seedsNow(),
        homeDir: () => homeDir(),
        stateFile: TeamRoutingTable.defaultStateFile(pluginHome()),
        // 落盘走**同一条链**：与 `POST /session/binding` 和探针的 `bindingSink` 是同一个
        // `bindingExtras.set`（同一个文件、同一个内存态）⇒ 请求层改道读到的就是这一份，
        // 不存在「只在团队路由里成立」的可能。冷恢复能读到它，正是这条落盘保证的。
        writeBinding: (binding) => {
            bindingExtras.set({
                sessionId: binding.sessionId,
                harnessId: binding.harnessId,
                ...(binding.accountId === undefined ? {} : { accountId: binding.accountId }),
                ...(binding.model === undefined ? {} : { model: binding.model }),
            });
        },
        log: (message) => logger?.info?.(`harness-pilot: ${message}`),
        // 模型清单校验：问**该 CLI 自己**（`targetModels()` 就是 `/api/models` 读的那个实现，
        // 它按目标声明的 `modelsCommand` / `modelListArgs` 去问，读不到就如实说读不到）。
        // 用途只有一个：模型给错时**在建成员之前**拒绝，而不是让成员诞生后每轮都失败。
        knownModels: async (target) => (await registry.targetModels(target)).models,
        knownModelsSource: 'ctx.sessions.targetModels(target)（该 CLI 自己的 --list-models / modelsCommand）',
        // `agent/created` 兜底路径的成员名反查：读**宿主自己**的会话日志里那条
        // `team/member`（团队日志是宿主写的，不是本插件自报）；退一步再用成员 prompt 抬头。
        resolveChild: (childSessionId, parentSessionId) => {
            const fromJournal = teammateFromLeadJournal(ctxAny, parentSessionId, childSessionId);
            if (fromJournal !== undefined)
                return { memberName: fromJournal, via: 'agent/created + team/member journal' };
            const fromPrompt = teammateNameFromPromptForRouting(readSessionPrompt(ctxAny, childSessionId));
            return fromPrompt === undefined
                ? {}
                : { memberName: fromPrompt, via: 'agent/created + child prompt' };
        },
    });
    // ── 成员诞生 ⇒ 绑定落位（**首轮之前**）──────────────────────────────────
    // 判据是宿主自己的团队日志事件 `team/member`：它在 `roster.spawnAdmitted()` 的
    // `journal.appendAndFlush` 里发出，而成员的首个 prompt 是稍后
    // `startContinuable → submitMaterialized` 才投递的 ⇒ 这一刻写绑定保证早于首轮。
    // 事件带齐三项，缺一不可：`teamId`（＝ Lead 会话，团队隔离键）、`member.id`（子会话）、
    // `member.name`（成员名）。**不做任何跨团队的模糊匹配。**
    try {
        ctxAny.on?.('session/event', (...args) => {
            // ⚠️ 这是**观察者**（宿主用 `invokeContainedSessionObservers` 调用，不看返回值、
            // 且逐个 try/catch 兜住异常），因此这里**不接管、不转发**任何东西 ——
            // 团队日志的 append 路径不因本观察者而改变。返回值恒为 undefined。
            const event = args.find((value) => value !== null && typeof value === 'object' && typeof value.type === 'string');
            if (event?.type !== 'team/member')
                return;
            const data = (event.data ?? {});
            const teamId = typeof data.teamId === 'string' ? data.teamId : undefined;
            const memberId = typeof data.member?.id === 'string' ? data.member.id : undefined;
            const memberName = typeof data.member?.name === 'string' ? data.member.name : undefined;
            if (teamId === undefined || memberId === undefined || memberName === undefined) {
                logger?.warn?.('harness-pilot: team/member event without (teamId, member.id, member.name) — skipped (no guessing)');
                return;
            }
            const outcome = teamRouting.resolveByIntent({
                leadSessionId: teamId,
                memberName,
                childSessionId: memberId,
                via: 'session/event:team/member',
            });
            if (outcome.binding === undefined) {
                // 不是本插件创建的成员（例如宿主原生 `spawn_teammate`）⇒ 保持原生，**不绑**。
                // 这条日志是「产品成员 vs 原生成员」的可审计分界。
                logger?.info?.(`harness-pilot: team member ${memberName} (${memberId}) left native — ${outcome.reason ?? 'no intent'}`);
            }
        });
    }
    catch (error) {
        // 观察者装不上 ⇒ 首轮前绑定这条腿断了。必须喊出来，而不是让成员静默跑在原生供应商上。
        logger?.warn?.(`harness-pilot: could not install the team/member routing observer — team members will stay native: ${describe(error)}`);
    }
    // 绑定也挂到 vendor 侧的**冻结配方**查询上：请求层改道时按会话 id 取「成员诞生那一刻」
    // 的账号配方，而不是按查询时刻的档案重算。
    //
    // `frozenTargetConfig`（成员诞生那一刻的目标本体）一起带出去：派发侧要用它做**错配判据**
    // —— 受管账号冻结下来的「账号侧参数」是空的（完整元组本来就长在目标上），
    // 只有把「冻结目标 + 冻结账号」重新合并一遍再与冻结本体逐项比对，
    // 才能拦住「冻结了一个 WorkBuddy 账号、却把它派到另一个目标上」这条静默换号的路径。
    const frozenAccountFor = (sessionId) => {
        const recipe = teamRouting.frozenRecipeOf(sessionId);
        const account = recipe?.account;
        if (account === undefined || recipe === undefined)
            return undefined;
        return {
            accountId: account.accountId,
            args: account.args,
            env: { ...account.env },
            note: redactAccountIdsInText(`account=${account.accountId} configDir=${account.configDir} — ${account.isolationNote}（成员创建时冻结；之后档案变化不影响这位成员）`),
            frozenTargetConfig: recipe.targetConfig,
        };
    };
    /**
     * 该会话**冻结的模型 id**（团队路由成员；未冻结 ⇒ `undefined` ⇒ 由 CLI 自己决定）。
     *
     * ⚠️ 它与 `binding.model` 是**两个不同的东西**，必须分开取：改道决策里的 `selection.model`
     * 是**目标名**（`pilot-cli` 路由下 model 就是外部 CLI 目标名），所以请求层改道这条路上
     * `bindingFor(...).model` 从来没有被读进派发 —— 结果是「绑定里写着模型、CLI 按默认模型跑」。
     * 本钩子把创建时冻结的模型**显式**交给派发，`model` 因此不再被静默丢弃。
     */
    const frozenModelOf = (sessionId) => teamRouting.frozenRecipeOf(sessionId)?.model;
    // ── 第 3 阶段：账号档案登记表（动态 CRUD 的落盘处）──
    // 纪律：这里只存**登记信息**（id / harness / 目标 / 显示名 / 区域 / 配置目录名）。
    // **不存**任何凭据，也不指任何凭据内容；认证始终由各 CLI 的原生流程与受保护存储管理。
    const accountRegistryFile = join(pluginHome(), 'harness-accounts.json');
    let accountRegistry = loadAccountRegistry(accountRegistryFile);
    /** 当前**生效**的账号档案（内置 ± 用户增删改）——所有派发/池/探测都必须读它。 */
    const seedsNow = () => effectiveSeeds(accountRegistry).map(seed => {
        if (seed.launch.mode !== 'managed-bootstrap')
            return seed;
        const home = activeWorkBuddyHome(seed.configDir);
        return home === undefined ? seed : { ...seed, nativeAuthRef: { ...seed.nativeAuthRef, scope: 'isolated', locator: '本账号独立 HOME 内的原生加密认证文件与 keyblob' }, isolation: { ...seed.isolation, authStoreIsolated: true, sharedWith: [], disclosure: '独立进程 HOME、配置目录、原生加密认证及受保护 keyblob；空 HOME 已验证不回退全局账号。' }, limits: seed.limits.filter(line => !/认证.*共享|不是.*独立认证/.test(line)), launch: { ...seed.launch, env: { ...seed.launch.env, DSH_WORKBUDDY_FROZEN_HOME: home } } };
    });
    const accountDefaultsFile = join(pluginHome(), 'account-defaults.json');
    let accountDefaults = {};
    try {
        const stored = JSON.parse(readFileSync(accountDefaultsFile, 'utf8'));
        for (const [id, value] of Object.entries(stored))
            if (typeof value === 'string')
                accountDefaults[id] = value;
    }
    catch { /* first use */ }
    const accountForTarget = (target) => {
        const seeds = seedsNow();
        const fixed = seeds.find(seed => target.args.includes(seed.configDir));
        if (fixed)
            return fixed.id;
        const wrapper = target.args.findIndex(arg => /(?:^|[\\/])workbuddy-managed\.cjs$/i.test(arg));
        if (wrapper >= 0)
            return target.args[wrapper + 1];
        const family = seedForTarget(target.name)?.id;
        const selected = seeds.find(seed => seed.id === accountDefaults[family ?? ''] && seed.harnessId === family);
        return selected?.id ?? seeds.find(seed => seed.harnessId === family)?.id;
    };
    const modelScopedTarget = (target) => {
        const id = accountForTarget(target);
        if (id === undefined)
            return target;
        const applied = withAccountTarget({ target, accountId: id, seeds: seedsNow(), homeDir: homeDir() });
        if (!applied.ok)
            throw new Error(applied.reason);
        const seed = seedsNow().find(entry => entry.id === id);
        const argv = seed.identityProbe.configDirFlag && !target.modelsArgs.includes(seed.identityProbe.configDirFlag) ? [seed.identityProbe.configDirFlag, seed.configDir] : [];
        return { ...applied.target, modelsArgs: [...argv, ...target.modelsArgs] };
    };
    /**
     * 同步模型清单出口的**逐目标错误留痕**：某条目标解析失败时，把它从这一组的模型源里剔除
     * （否则一条坏目标会把**整组**模型清零 —— 实测踩到过），但错误**必须留痕**，
     * 由 `/llm-adapter` 的 `harnessRoutes[].modelsPerTarget` 如实回报，绝不静默吞掉。
     */
    const syncModelErrors = new Map();
    const syncModelsFor = (name) => {
        const found = config.resolvedTargets.find((target) => target.name === name);
        if (found === undefined)
            return undefined;
        try {
            const scoped = modelScopedTarget(found);
            const cached = registry.cachedModels(scoped)?.models;
            const local = discoverLocalModelCatalog(scoped);
            const fixed = (scoped.modelsFixed ?? []).filter((entry) => entry.trim().length > 0);
            // ⚠️ 与异步链（`listHarnessModels`）**同一个构造器**：来源分类/可选过滤只写一遍，
            // 否则同一个 harness 在「原生选择器」与「设置页完整清单」两处会给出不同的模型集合。
            const entries = modelEntriesFor({
                ...(cached === undefined || cached.length === 0 ? {} : { cliQuery: cached }),
                catalog: local.entries,
                modelsFixed: fixed,
            });
            const models = selectableIds(entries);
            if (models.length > 0) {
                syncModelErrors.delete(name);
                return models;
            }
            syncModelErrors.delete(name);
            return undefined;
        }
        catch (error) {
            // 只影响**这条目标**的模型发现；其它目标照常。错误记下来给诊断出口。
            syncModelErrors.set(name, describe(error));
            return undefined;
        }
    };
    /** 读一条目标的同步发现错误（诊断用）。 */
    const syncModelErrorFor = (name) => syncModelErrors.get(name);
    const accountAdminExtras = {
        registry: () => accountRegistry,
        isolation: (harnessId) => isolationProfileFor(harnessId),
        crud: (action) => {
            const result = applyAccountCrud(accountRegistry, action, {
                knownTargets: config.resolvedTargets.map((t) => t.name),
                harnessOfTarget: (targetName) => seedForTarget(targetName)?.id,
            });
            if (!result.ok)
                return result;
            accountRegistry = result.state;
            saveAccountRegistry(accountRegistryFile, accountRegistry);
            // 档案增删要**立刻**反映到账号池：新档案补默认条目，被删的档案移除条目，
            // 否则界面上会留下永远点不动的幽灵条目（或看不到刚建的账号）。
            poolState = loadPoolState(poolStateFile, seedsNow());
            savePoolState(poolStateFile, poolState);
            logger?.info?.(`harness-pilot: account registry updated (${action.kind}) -> ${accountRegistryFile}`);
            return result;
        },
        planNativeAuth: (accountId, action) => {
            const seed = seedsNow().find((s) => s.id === accountId);
            if (seed === undefined)
                return { ok: false, harnessId: '', accountId, reason: `未知账号档案：${redactAccount(accountId)}` };
            const target = config.resolvedTargets.find((t) => t.name === seed.targetName);
            const entry = resolveEntry(seedForTarget(seed.targetName), target, federationState.overrides[seed.targetName]).entry;
            return planNativeAuth(seed, entry, action, homeDir());
        },
        runNativeAuth: async (accountId, action) => {
            const seed = seedsNow().find((s) => s.id === accountId);
            if (seed === undefined) {
                return {
                    ok: false, action, accountId, argv: [], exitCode: null, stdout: '', stderr: '', redacted: true,
                    note: `未知账号档案：${redactAccount(accountId)}`, at: new Date().toISOString(),
                };
            }
            const target = config.resolvedTargets.find((t) => t.name === seed.targetName);
            const entry = resolveEntry(seedForTarget(seed.targetName), target, federationState.overrides[seed.targetName]).entry;
            return await runNativeAuth(seed, entry, action, { homeDir: homeDir() });
        },
    };
    // ── P9 账号池 + 切换账本 ──
    // 配置与账本分开落盘：用户意图 vs 事实记录，混在一起会互相覆盖。
    const poolStateFile = join(pluginHome(), 'account-pool.json');
    const switchLogFile = join(pluginHome(), 'switch-log.json');
    // ⚠️ 必须传**当前生效**的种子：否则用户新加的档案在池里永远没有条目。
    let poolState = loadPoolState(poolStateFile, seedsNow());
    let switchLogState = loadSwitchLog(switchLogFile);
    // 并发协调状态（进程内）。**必须真的用上** —— 否则协调模块就是死代码。
    let coordinationState = EMPTY_COORDINATION;
    const poolExtras = {
        state: () => poolState,
        coordination: () => coordinationState,
        // 第 4 阶段：执行侧运行时状态（真实生效的冻结 / 冷却 / 熔断）。
        autoSwitchRuntime: () => autoSwitchRuntime,
        autoSwitchLastResult: () => lastAutoSwitchResult ?? null,
        autoSwitchReset: (accountId) => {
            autoSwitchRuntime = accountId === undefined ? EMPTY_RUNTIME : thawAccount(autoSwitchRuntime, accountId);
            return autoSwitchRuntime;
        },
        update: (patch) => {
            poolState = updatePoolState(poolState, patch);
            savePoolState(poolStateFile, poolState);
            return poolState;
        },
        events: (scope) => eventsFor(switchLogState, scope),
        recent: () => switchLogState.events.slice(-50).reverse(),
        /** 落盘前强制脱敏检查：账本里绝不能出现原始账号 id。 */
        auditRedaction: () => findUnredacted(switchLogState, config.resolvedTargets.map((t) => t.name).concat(seedsNow().map((s) => s.id))),
        /**
         * 手动切换：**判定 + 记账**。不执行派发、不碰凭据。
         * 返回结果里带 warnings，界面必须原样显示 —— 尤其是「模型会改变」与「不得重放」。
         */
        manualSwitch: async (input) => {
            const eligible = isEligibleTarget(poolState, input.toAccountId);
            if (!eligible.ok) {
                // 不在启用的池内 → 拒绝，并且**记一笔**（拒绝也是用户要知道的事实）。
                switchLogState = appendSwitchEvent(switchLogState, {
                    scope: input.scope,
                    harnessId: input.harnessId,
                    fromAccount: redactAccount(input.fromAccountId),
                    toAccount: redactAccount(input.toAccountId),
                    reason: eligible.reason,
                    recovery: 'none',
                    boundary: '未发生切换',
                    result: 'refused',
                    trigger: 'policy-refused',
                    modelPreserved: false,
                });
                saveSwitchLog(switchLogFile, switchLogState);
                return { ok: false, result: { reason: eligible.reason, recovery: '请在「Harness 管理 → 账号池」中启用该账号后重试' } };
            }
            const seeds = seedsNow().find((s) => s.id === input.toAccountId);
            const fromSeed = seedsNow().find((s) => s.id === input.fromAccountId);
            // ── 并发协调（真实生效，不是摆设）──
            // 同一账号的「切换类动作」同一时刻只允许一个持有者：否则两个任务同时切同一个账号，
            // 会互相覆盖登录态。租约带过期时间，持有者崩了不会永久死锁。
            const now = Date.now();
            const leaseTry = acquire(coordinationState, {
                accountId: input.toAccountId,
                holder: input.scope.id,
                purpose: 'switch',
                now,
            }, COORDINATION_POLICY);
            coordinationState = leaseTry.state;
            if (!leaseTry.result.ok) {
                switchLogState = appendSwitchEvent(switchLogState, {
                    scope: input.scope,
                    harnessId: input.harnessId,
                    fromAccount: redactAccount(input.fromAccountId),
                    toAccount: redactAccount(input.toAccountId),
                    reason: leaseTry.result.reason,
                    recovery: 'none',
                    boundary: '未发生切换',
                    result: 'refused',
                    trigger: 'policy-refused',
                    modelPreserved: false,
                    detail: leaseTry.result.heldBy === undefined ? undefined : `heldBy=${leaseTry.result.heldBy}`,
                });
                saveSwitchLog(switchLogFile, switchLogState);
                return {
                    ok: false,
                    result: {
                        reason: leaseTry.result.reason,
                        heldBy: leaseTry.result.heldBy,
                        retryAfterMs: leaseTry.result.retryAfterMs,
                        recovery: '等待该账号上的另一个切换动作结束后重试（租约到期会自动释放，不会永久死锁）',
                    },
                };
            }
            // 抑制窗口只对**自动**切换生效；这里是用户显式操作，仍然放行，但把「刚切过」如实告知。
            const suppression = shouldSuppressSwitch(coordinationState, input.toAccountId, now, COORDINATION_POLICY);
            const recentSwitchNote = suppression.suppress
                ? `提示：该账号在 ${Math.round((suppression.sinceMs ?? 0) / 1000)}s 前刚被切换过。手动操作照常执行；若这是自动切换，本应复用上一次结果而不是再切一次。`
                : '';
            // ── 切换前**真实验证目标账号认证**（异步只读探测）──
            // 这一段的 I/O 有两重意义：① 满足「切换前验证目标账号认证与可用性」的要求；
            // ② 它让上面的租约**真正被争用** —— 之前临界区全同步、0 个 await，
            //    9 个并发切换全部通过、租约一次都没触发（见报告 §1.28）。加了这一步才算真的并发协调。
            const targetSeed = seedsNow().find((s) => s.id === input.toAccountId);
            let probeNote = '';
            let verifiedAuth = input.authOfTarget;
            let probeConflict = '';
            if (targetSeed !== undefined) {
                try {
                    // `execFile` 在 Windows 上**不会**解析 PATH 里的裸名字（实测 `spawn qoderclicn ENOENT`），
                    // 所以必须先把种子里的裸 command 映射到目标配置里的**绝对路径**（那里本来就是绝对路径），
                    // 否则探测必然失败 —— 「切换前验证」就成了空话。
                    const resolved = config.resolvedTargets.find((t) => t.name === targetSeed.launch.command);
                    const entryForProbe = resolved === undefined ? targetSeed.launch.command : resolved.command;
                    const probe = await probeIdentity(targetSeed, entryForProbe, 20000);
                    if (probe.skipped !== undefined) {
                        probeNote = `只读身份探测被跳过（${probe.skipped}）—— 未能独立验证，沿用调用方声明的认证状态`;
                    }
                    else if (probe.loggedIn === true) {
                        verifiedAuth = probe.identity !== undefined && probe.identity.length > 0 ? 'identity-readable' : 'login-ok';
                        probeNote = `已独立探测：目标账号可读到身份（${String(probe.identity ?? '(未给出身份)')} 的指纹级信息）`;
                    }
                    else if (probe.loggedIn === false) {
                        verifiedAuth = 'auth-invalid';
                        probeNote = `已独立探测：目标账号**未登录**，不能作为切换目标`;
                    }
                    else {
                        probeNote = `只读探测未得出结论${probe.error === undefined ? '' : `（${probe.error}）`}—— 探测失败**不等于**认证失效，沿用调用方声明`;
                    }
                }
                catch (error) {
                    // 探测本身失败 **不** 等同于认证失效 —— 不能把工具的问题算成账号的问题。
                    probeNote = `只读探测执行失败（${error instanceof Error ? error.message : String(error)}）—— 探测失败**不等于**认证失效`;
                }
                if (verifiedAuth !== input.authOfTarget) {
                    probeConflict = `调用方声明的认证状态是「${input.authOfTarget}」，而独立探测得到「${verifiedAuth}」—— 以探测结果为准，但两者不一致本身值得注意`;
                }
            }
            // 独立探测确证「未登录」→ 拒绝切换（这正是「切换前验证目标账号」的意义）
            if (verifiedAuth === 'auth-invalid') {
                switchLogState = appendSwitchEvent(switchLogState, {
                    scope: input.scope, harnessId: input.harnessId,
                    fromAccount: redactAccount(input.fromAccountId), toAccount: redactAccount(input.toAccountId),
                    reason: `切换前验证失败：${probeNote}`,
                    recovery: 'none', boundary: '未发生切换', result: 'refused',
                    trigger: 'policy-refused', modelPreserved: false,
                    ...(probeConflict.length === 0 ? {} : { detail: probeConflict }),
                });
                saveSwitchLog(switchLogFile, switchLogState);
                coordinationState = release(coordinationState, input.toAccountId, input.scope.id);
                return {
                    ok: false,
                    result: {
                        reason: `切换前验证目标账号认证失败：${probeNote}`,
                        ...(probeConflict.length === 0 ? {} : { conflict: probeConflict }),
                        recovery: '请先为该账号完成该 Harness 的原生登录，再重试切换',
                    },
                };
            }
            const plan = planManualSwitch({
                scope: input.scope,
                harnessId: input.harnessId,
                fromAccountId: input.fromAccountId,
                toAccountId: input.toAccountId,
                ...(input.currentModel === undefined ? {} : { currentModel: input.currentModel }),
                ...(input.currentProvider === undefined ? {} : { currentProvider: input.currentProvider }),
                authOfTarget: verifiedAuth,
                ...(input.quotaOfTarget === undefined ? {} : { quotaOfTarget: input.quotaOfTarget }),
                ...(input.modelsOfTarget === undefined ? {} : { modelsOfTarget: input.modelsOfTarget }),
                regionOfTarget: seeds?.region ?? 'unknown',
                regionOfCurrent: fromSeed?.region ?? 'unknown',
                // 同区域即兼容；跨区域必须由调用方显式声明（当前一律视为不兼容）。
                regionCompatible: (seeds?.region ?? 'a') === (fromSeed?.region ?? 'b'),
                nativeSessionResumable: input.nativeSessionResumable,
                ...(input.uncertainWriteActions === undefined ? {} : { uncertainWriteActions: input.uncertainWriteActions }),
            });
            switchLogState = appendSwitchEvent(switchLogState, {
                scope: input.scope,
                harnessId: input.harnessId,
                fromAccount: redactAccount(input.fromAccountId),
                toAccount: redactAccount(input.toAccountId),
                reason: plan.ok ? `用户手动切换（当前账号 ${input.fromAccountId === '' ? '未指定' : '已脱敏'}）` : plan.reason,
                recovery: plan.ok ? plan.recovery : 'none',
                boundary: plan.ok ? plan.boundary : '未发生切换',
                result: plan.ok ? 'switched' : 'refused',
                trigger: plan.ok ? 'manual' : 'policy-refused',
                modelPreserved: plan.ok ? plan.modelPreserved : false,
                ...(input.currentModel === undefined ? {} : { model: input.currentModel }),
                ...(input.currentProvider === undefined ? {} : { provider: input.currentProvider }),
                ...(plan.ok ? {} : { detail: plan.recovery }),
            });
            saveSwitchLog(switchLogFile, switchLogState);
            // 成功切换：记下「刚切过去」的时间，并立刻释放租约（切换动作已结束）。
            if (plan.ok) {
                coordinationState = noteSwitch(coordinationState, input.toAccountId, Date.now());
            }
            coordinationState = release(coordinationState, input.toAccountId, input.scope.id);
            return { ok: plan.ok, result: plan.ok ? { ...plan, recentSwitchNote, probeNote, ...(probeConflict.length === 0 ? {} : { conflict: probeConflict }) } : plan };
        },
    };
    // ══════════════════════════════════════════════════════════════════════
    //  第 4 阶段：把**保守额度判定**接到**真实自动切换执行侧**
    //
    //  在此之前，`decideAutoSwitch()` 只是个决策函数 —— 界面上的开关打开也什么都不会发生
    //  （「把开关当执行」）。这一段把它接上**同一批真实派发入口**：
    //    · `TaskManager` 的 dispatch 依赖 → 覆盖 /task/start、子代理 provider、团队子会话；
    //    · /dispatch 处理器 → 覆盖同步 HTTP 派发。
    //  两条路径共用 `autoSwitchBox`，不是两套实现（本项目栽过三次「同能力不同入口行为不一致」）。
    // ══════════════════════════════════════════════════════════════════════
    /** 自动切换的运行时状态（冻结 / 冷却 / 熔断）。**进程内**，DSH 重启即清零。 */
    let autoSwitchRuntime = EMPTY_RUNTIME;
    let lastAutoSwitchResult;
    /**
     * 从一次**真实派发结果**推出副作用边界 —— 这是「不得盲目重放」的证据来源。
     *
     * `none` 只在「终态 error 且回复正文为空」时给出：那说明它终止在模型请求/进程启动层。
     * **这是一条基于可观测信号的判据，不是对 CLI 内部工具调用的逐条审计** ——
     * 边界原文写进 `evidence`，随切换事件一起落账本，事后可以复盘它当时凭什么这么说。
     */
    function effectsBoundaryOf(outcome) {
        const text = (outcome.text ?? '').trim();
        if (outcome.stopReason === 'error' && text.length === 0) {
            return {
                kind: 'none',
                evidence: '本次派发 `stopReason=error` 且**回复正文为空** → 判据：它终止在模型请求/进程启动层，没有已完成的写操作。'
                    + '⚠️ 这是**基于可观测信号的判定**（终态 + 正文长度 + 诊断文本），不是对 CLI 内部工具调用的逐条审计。',
            };
        }
        return {
            kind: 'unknown',
            reason: `本次派发终态为 ${outcome.stopReason}${text.length === 0 ? '' : '（且已产生输出）'} —— `
                + '无法确认是否已经发生写/提交/推送；按纪律必须先核验实际状态，**本次不重跑**。',
        };
    }
    /** 派发作用域 id：同一 target + 同一 prompt 的重复派发归到同一条，退避/上限才有意义。 */
    function dispatchScopeId(spec) {
        return `task-${createHash('sha256').update(`${spec.target.name}\u0000${spec.prompt}`).digest('hex').slice(0, 12)}`;
    }
    autoSwitchBox.current = {
        runtime: () => autoSwitchRuntime,
        reset: (accountId) => {
            autoSwitchRuntime = accountId === undefined ? EMPTY_RUNTIME : thawAccount(autoSwitchRuntime, accountId);
            return autoSwitchRuntime;
        },
        lastResult: () => lastAutoSwitchResult,
        dispatch: async (spec, options) => {
            const accountId = spec.identity?.accountId ?? '';
            // 未启用自动切换 / 没绑定账号 → **原样直通**。开关关闭时行为与从前逐字一致。
            if (poolState.autoSwitchEnabled !== true || accountId.length === 0) {
                return await registry.dispatch(spec, options ?? {});
            }
            const baseTarget = config.resolvedTargets.find((t) => t.name === spec.target.name) ?? spec.target;
            const seeds = seedsNow();
            const scope = { kind: 'task', id: dispatchScopeId(spec) };
            const realOutcomes = [];
            // 账号池 → 决策器要的 PoolEntry（含用户声明的模型清单）。
            const poolEntries = Object.entries(poolState.entries)
                .filter(([id]) => seeds.some((s) => s.id === id))
                .map(([id, entry]) => {
                const seed = seeds.find((s) => s.id === id);
                return {
                    accountId: id,
                    harnessId: seed?.harnessId ?? 'unknown',
                    region: seed?.region ?? 'unknown',
                    enabled: entry.enabled,
                    priority: entry.priority,
                    cooldownMs: entry.cooldownMs,
                    ...(entry.models === undefined ? {} : { models: entry.models }),
                };
            });
            const result = await executeWithAutoSwitch({
                scope,
                harnessId: seedForTarget(baseTarget.name)?.id ?? baseTarget.name,
                accountId,
                ...(spec.model === undefined ? {} : { model: spec.model }),
                policy: {
                    autoSwitchEnabled: true,
                    maxSwitchesPerTask: poolState.policy.maxSwitchesPerTask,
                    backoffBaseMs: poolState.policy.backoffBaseMs,
                    backoffFactor: poolState.policy.backoffFactor,
                    maxConsecutiveFailures: poolState.policy.maxConsecutiveFailures,
                    onModelUnavailable: poolState.policy.onModelUnavailable,
                },
                pool: poolEntries,
                // 额度表**起始为空**：本机这些 Harness 没有原生额度接口，唯一的来源就是
                // 执行侧刚刚真实观测到的结构化错误（由执行器自己写回）。凭空填一个状态是不允许的。
                quota: {},
                auth: Object.fromEntries(seeds.map((s) => [s.id, 'unknown'])),
                nativeSessionResumable: seedForTarget(baseTarget.name)?.sessionResume === 'native-id',
                ...(poolState.defaultAccountId === undefined ? {} : { poolDefaultAccountId: poolState.defaultAccountId }),
                runtime: autoSwitchRuntime,
                coordination: coordinationState,
                switchLog: switchLogState,
                attempt: async (attemptAccountId) => {
                    const applied = withAccountTarget({ target: baseTarget, accountId: attemptAccountId, seeds, homeDir: homeDir() });
                    if (!applied.ok) {
                        return { ok: false, failure: { message: applied.reason }, effects: { kind: 'none', evidence: '账号未通过校验，连进程都没起' }, diagnostic: applied.reason };
                    }
                    const outcome = await registry.dispatch({
                        ...spec,
                        target: applied.target,
                        identity: { ...(spec.identity ?? {}), accountId: attemptAccountId, harnessId: baseTarget.name },
                    }, options ?? {});
                    realOutcomes.push(outcome);
                    // ⚠️ 「非 0 退出」必须算失败。
                    // 实测抓到过：未登录账号的派发里 CLI 打印 `Not logged in · Please run /login` 并 exit 1，
                    // 而 headless 通道给的是 `stopReason=completed`（因为它有 stdout）—— 于是整件事被当成成功，
                    // 执行侧连分类都没做，「认证失效」在这条链上完全不可见。
                    // 通道只在 code !== 0 时写「exited with code N」，所以读到了就是真的非 0 退出。
                    const exitCode = exitCodeFromDiagnostic(outcome.diagnostic);
                    const nonzeroExit = exitCode !== undefined && exitCode !== 0;
                    return {
                        ok: outcome.stopReason === 'completed' && outcome.text.trim().length > 0 && !nonzeroExit,
                        // ⚠️ 必须把**结构化的**失败信号抽出来再交给判定器。
                        // 只传一句人话（diagnostic）的话，判定器永远只能走文本兜底 → 永远 unknown →
                        // 自动切换永远不会发生（那就是「把开关当执行」）。
                        // 抽取器**不新增任何白名单**：agy 的 RESOURCE_EXHAUSTED/429 仍然被判为 unknown。
                        failure: extractFailureSignal({
                            ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
                            ...(outcome.text.length === 0 ? {} : { message: outcome.text.slice(0, 2000) }),
                            ...(outcome.facts === undefined ? {} : { facts: outcome.facts }),
                        }),
                        ...(outcome.identity?.accountId === undefined ? {} : { actualAccountId: outcome.identity.accountId }),
                        ...(outcome.identity?.model === undefined ? {} : { actualModel: outcome.identity.model }),
                        ...(outcome.identity?.nativeSessionId === undefined ? {} : { nativeSessionId: outcome.identity.nativeSessionId }),
                        text: outcome.text,
                        ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
                        effects: effectsBoundaryOf(outcome),
                        // 本机**不可能**在不烧掉用户额度的前提下造出真实额度耗尽；
                        // 因此除非将来拿到真实观测，这里一律按 `injected` 记（默认方向必须是「不声称真实」）。
                        exhaustionProvenance: 'injected',
                    };
                },
                verifyTarget: async (targetAccountId, model) => {
                    const seed = seeds.find((s) => s.id === targetAccountId);
                    if (seed === undefined) {
                        return { identityOk: false, modelOk: false, detail: `目标账号档案不存在：${redactAccount(targetAccountId)}` };
                    }
                    const target = config.resolvedTargets.find((t) => t.name === seed.targetName);
                    const entry = resolveEntry(seedForTarget(seed.targetName), target, federationState.overrides[seed.targetName]).entry;
                    let identityOk = false;
                    let detail = '';
                    try {
                        // **真实只读探测**：不问「切换函数返回了什么」，只问「这个账号此刻能不能读出身份」。
                        const probe = await probeIdentity(seed, entry, 20_000);
                        if (probe.skipped !== undefined) {
                            detail = `无法独立验证目标账号身份（${probe.skipped}）—— 验证不了就不切`;
                        }
                        else if (probe.loggedIn === true) {
                            identityOk = true;
                            detail = probe.identity === undefined
                                ? '只读探测：目标账号已登录（该 CLI 未给出身份主键）'
                                : `只读探测：目标账号身份可读（指纹 ${fingerprintOf(probe.identity).slice(0, 6)}…，原值不外传）`;
                        }
                        else {
                            detail = `只读探测未确认身份：${probe.error ?? 'logged_in 非 true'}`;
                        }
                    }
                    catch (error) {
                        detail = `探测执行失败（${describe(error)}）—— 探测失败**不等于**认证失效，但验证不了就不切`;
                    }
                    // 模型兼容：只认账号池里**用户显式声明**的清单；没声明就不假装核对过。
                    const declared = poolState.entries[targetAccountId]?.models;
                    const modelOk = model === undefined || model.length === 0
                        ? true
                        : declared === undefined || declared.length === 0
                            ? true
                            : declared.includes(model);
                    return {
                        identityOk,
                        modelOk,
                        detail: `${detail}；模型核对：${declared === undefined || declared.length === 0
                            ? '该账号未在账号池里声明模型清单，**未能**在切换前核对 —— 改由切换后的真实派发回报实际模型'
                            : `按账号池声明的清单 ${modelOk ? '通过' : '不通过'}`}`,
                        targetLabel: redactAccount(targetAccountId),
                    };
                },
            });
            autoSwitchRuntime = result.runtime;
            coordinationState = result.coordination;
            switchLogState = result.switchLog;
            lastAutoSwitchResult = result;
            if (result.events.length > 0) {
                saveSwitchLog(switchLogFile, switchLogState);
                logger?.info?.(`harness-pilot: auto-switch ${result.ok ? 'succeeded' : 'stopped'} — ${result.notes.slice(-1)[0] ?? ''}`);
            }
            // 切换后的**真实模型核对**：拿最后一次真实派发回报的实际模型与请求模型比。
            const finalOutcome = realOutcomes[realOutcomes.length - 1];
            if (finalOutcome !== undefined) {
                const reported = finalOutcome.identity?.model;
                if (spec.model !== undefined && spec.model.length > 0 && reported !== undefined && reported !== spec.model) {
                    logger?.warn?.(`harness-pilot: post-switch model mismatch — requested ${spec.model}, harness reported ${reported}`);
                }
            }
            return finalOutcome ?? await registry.dispatch(spec, options ?? {});
        },
    };
    // ── P3 供应商/模型四态发现 ──
    // usable 证据**只**来自本插件自己的任务账本（真实完成 + 非空回复），不做任何推断。
    // DSH 侧供应商走 `dshNative` **单独一栏**，来源标 dsh-native，绝不许混进外部 harness 的列表。
    const tasksDir = join(pluginHome(), 'tasks');
    let usableCache;
    const providersExtras = async (targetName, measure) => {
        const originalTarget = config.resolvedTargets.find((t) => t.name === targetName);
        const target = originalTarget === undefined ? undefined : modelScopedTarget(originalTarget);
        if (target && measure) {
            registry.clearModelCache(target);
            await registry.targetModels(target);
        }
        const seed = seedForTarget(targetName);
        const resolved = resolveEntry(seed, target, federationState.overrides[targetName]);
        if (usableCache === undefined)
            usableCache = readUsableEvidence(tasksDir);
        const dshRoutes = await listDshModels(ctxAny.get?.('llm'));
        const dshNative = dshRoutes.map((p) => ({
            id: p.id,
            displayName: p.name,
            source: 'dsh-native',
            models: p.models.map((m) => ({ id: m, availability: 'configured', evidence: 'DSH 本 profile 已配置' })),
            availability: 'configured',
            evidence: ['DSH 本 profile 的供应商路由；与外部 CLI 的供应商无关'],
        }));
        return await collectProviderInventory({
            target,
            env: target?.env,
            harnessId: seed?.id ?? targetName,
            targetName,
            accountId: `${targetName}-default`,
            seed,
            entry: resolved.entry,
            measure,
            usable: usableCache,
            dshNative,
        });
    };
    // ── P4 供应商/模型的**可编辑操作** + **受约束选择** ──
    // 三处能力探测各有各的**真来源**，没有一个结论是硬编码的：
    //   · DSH 宿主面  → 真枚举 `ctx.get('llm')` 服务对象的方法面（probeServiceShape）；
    //   · 外部 CLI 面 → `measure=true` 时才真的跑一次该 CLI 的**只读**管理子命令帮助；
    //   · 声明层面    → 在**内存副本**上跑一次真实的 updatePoolState，看哪个字段真的落地。
    const catalogCandidates = async (targetName, measure) => {
        const inventory = await providersExtras(targetName, measure);
        const candidates = candidatesFromInventory(inventory);
        const byAvailability = {};
        for (const c of candidates)
            byAvailability[c.availability] = (byAvailability[c.availability] ?? 0) + 1;
        return {
            target: targetName,
            candidates,
            byAvailability,
            note: '候选项**只**来自四态真实发现（该 harness 自己的列表命令 + 它自己的原生配置）。'
                + '`owner=dsh-native` 的是 DSH 本 profile 的路由，`owner=harness-native` 的是该 harness 自己的 —— '
                + '两边永远不会进同一个 owner；跨 owner 选择会被 resolveCatalogSelection 拒绝。',
        };
    };
    const catalogExtras = {
        capabilities: async (targetName, measure) => {
            const target = config.resolvedTargets.find((t) => t.name === targetName);
            const seed = seedForTarget(targetName);
            const resolved = resolveEntry(seed, target, federationState.overrides[targetName]);
            const caps = [...dshCatalogCapabilities(probeServiceShape(ctxAny.get?.('llm')))];
            // 声明层：在**纯内存副本**上真跑一次写入路径（不落盘），看哪个字段真的落地。
            const sample = {
                version: 1,
                autoSwitchEnabled: poolState.autoSwitchEnabled,
                ...(poolState.defaultAccountId === undefined ? {} : { defaultAccountId: poolState.defaultAccountId }),
                policy: poolState.policy,
                entries: poolState.entries,
                updatedAt: poolState.updatedAt,
            };
            const probeAccount = Object.keys(poolState.entries)[0] ?? '__probe__';
            const afterModels = updatePoolState(sample, { entry: { accountId: probeAccount, models: ['__probe__'] } });
            // `providers` 不在 updatePoolState 的 patch 类型里 —— 正是要验证「写了会不会落地」，
            // 所以这里刻意按未知字段传一次（结论由落地字段决定，不由类型声明决定）。
            const afterProviders = updatePoolState(sample, { entry: { accountId: probeAccount, providers: ['__probe__'] } });
            caps.push(...declaredAllowlistCapabilities({
                accountId: probeAccount,
                writePath: 'poolExtras.update → updatePoolState → savePoolState → account-pool.json',
                entryKeysAfterModelsPatch: Object.keys(afterModels.entries[probeAccount] ?? {}),
                entryKeysAfterProvidersPatch: Object.keys(afterProviders.entries[probeAccount] ?? {}),
                note: '在纯内存副本上跑真实的 updatePoolState（不落盘、不改用户状态）。',
            }));
            // 外部 CLI 面：只有 measure 时才真的执行只读帮助探测；没依据就不去探。
            const hint = adminSubcommandFor(seed?.id ?? targetName);
            if (measure && hint.subcommand !== null && resolved.entry !== null) {
                const help = await runHarnessAdminHelp(resolved.entry, hint.subcommand, { timeoutMs: 30_000, wrapping: resolved.wrapping });
                caps.push(...harnessCatalogCapabilities({
                    harnessId: seed?.id ?? targetName,
                    subcommand: hint.subcommand,
                    probeArgv: help.argv,
                    helpText: help.text,
                    exitCode: help.code,
                    configDirIsolated: seed?.multiAccount === 'isolated-config-dir',
                }));
            }
            else {
                caps.push(...harnessCatalogCapabilities({
                    harnessId: seed?.id ?? targetName,
                    subcommand: null,
                    probeArgv: [],
                    helpText: null,
                    exitCode: null,
                    configDirIsolated: seed?.multiAccount === 'isolated-config-dir',
                }));
            }
            return capabilityReport(caps);
        },
        candidates: catalogCandidates,
        select: async (input) => {
            const found = await catalogCandidates(input.target, false);
            return resolveCatalogSelection({
                surface: 'harness-native',
                harnessId: seedForTarget(input.target)?.id ?? input.target,
                requested: input.model,
                candidates: found.candidates,
                ...(input.allowUnlisted === undefined ? {} : { allowUnlisted: input.allowUnlisted }),
                ...(input.minAvailability === undefined ? {} : { minAvailability: input.minAvailability }),
            });
        },
        plan: async (input) => {
            const found = await catalogCandidates(input.target, false);
            const caps = await catalogExtras.capabilities(input.target, true);
            // 与派发链**同一处**分域解析：池默认账号不属于本目标 ⇒ 不用它，退到「本目标 harness 的池内条目」。
            const scopedCatalogDefault = defaultAccountForTarget({
                targetName: input.target,
                candidate: poolState.defaultAccountId ?? '',
                seeds: seedsNow(),
            }).accountId;
            const accountId = input.accountId
                ?? (scopedCatalogDefault.length > 0
                    ? scopedCatalogDefault
                    : Object.keys(poolState.entries).find((id) => seedsNow().find((s) => s.id === id)?.harnessId === (seedForTarget(input.target)?.id ?? input.target)));
            return planCatalogEdit({
                op: input.op,
                harnessId: seedForTarget(input.target)?.id ?? input.target,
                ...(accountId === undefined ? {} : { accountId }),
                ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
                ...(input.models === undefined ? {} : { models: input.models }),
                ...(input.currentDeclared === undefined ? {} : { currentDeclared: input.currentDeclared }),
                ...(input.registryUrl === undefined ? {} : { registryUrl: input.registryUrl }),
                ...(input.allowUnlisted === undefined ? {} : { allowUnlisted: input.allowUnlisted }),
                ...(input.confirmWritesUserConfig === undefined ? {} : { confirmWritesUserConfig: input.confirmWritesUserConfig }),
                candidates: found.candidates,
                capabilities: caps.capabilities,
            });
        },
        execute: async (plan, targetName) => {
            const target = config.resolvedTargets.find((t) => t.name === targetName);
            const seed = seedForTarget(targetName);
            const resolved = resolveEntry(seed, target, federationState.overrides[targetName]);
            return await executeCatalogEdit(plan, {
                // 写入走**既有**那一条链（poolExtras.update 里就是 updatePoolState + savePoolState），
                // 不另开一条口子 —— 否则「界面改的」与「执行侧读的」又会是两份状态。
                applyDeclaredModels: async (patch) => {
                    try {
                        poolExtras.update({ entry: { accountId: patch.accountId, models: [...patch.models] } });
                        return { ok: true };
                    }
                    catch (error) {
                        return { ok: false, error: describe(error) };
                    }
                },
                // **独立**回读落盘文件（不复用写入函数的返回值：那等于自己给自己背书）。
                readDeclaredModels: async (accountId) => readDeclaredModelsFromFile(poolStateFile, accountId),
                // ⚠️ `GET /pool` 这条出口**故意不接**：在同一个进程里「自己读自己」不算独立来源。
                //    它由 probe/verify-catalog-edit.mjs 在**外部**按 HTTP 核对（见 H4 修完之后）。
                // 该 CLI 自己的管理子命令：默认**不注入** ⇒ executeCatalogEdit 会显式拒绝执行。
                // 只有显式设了 HARNESS_PILOT_ALLOW_ADMIN_WRITES=1 才接上（它会写用户真实的 CLI 配置）。
                ...(process.env.HARNESS_PILOT_ALLOW_ADMIN_WRITES === '1' && resolved.entry !== null
                    ? {
                        runHarnessAdminCommand: async (input2) => {
                            const { execFile } = await import('node:child_process');
                            return await new Promise((resolve) => {
                                execFile(input2.entry, [...input2.argv], {
                                    timeout: input2.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 8 << 20,
                                    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
                                }, (error, stdout, stderr) => {
                                    const code = error === null || error === undefined
                                        ? 0
                                        : (typeof error.code === 'number' ? error.code : null);
                                    resolve({ code, stdout: `${stdout ?? ''}`.slice(0, 4000), stderr: `${stderr ?? ''}`.slice(0, 4000) });
                                });
                            });
                        },
                    }
                    : {}),
            }, { harnessEntry: resolved.entry ?? '', timeoutMs: 60_000 });
        },
    };
    // ── P2 账号档案 ──
    // 身份只经 CLI 自己的**只读** status 探测得到，并立即降为不可逆指纹；
    // 「登录成功 / 身份可读 / 模型请求认证有效」三态分开，不许互相冒充。
    const accountsExtras = async (measure) => await collectAccounts({
        entryForTarget: (targetName) => {
            const target = config.resolvedTargets.find((t) => t.name === targetName);
            return resolveEntry(seedForTarget(targetName), target, federationState.overrides[targetName]).entry;
        },
        measure,
        // 必须传**当前生效**的档案：否则用户新增/删除/改名的档案在界面上完全看不出来。
        seeds: seedsNow(),
    });
    // 子代理 provider 的注册**必须排在 TaskManager 之后**：provider 会把每个内部 run
    // 登记进这本账（P7 的"内部子代理可查询"），所以这里要求 tasks 已经就位。
    // 仍然走子 fiber 等 subagents 服务 —— 那才是它原本要解决的问题（服务抢跑）。
    ctxAny.plugin?.({
        name: '@dsh-external/dsh-harness-pilot:subagent-providers',
        inject: ['subagents'],
        apply: (ctx2) => {
            const get = ctx2.get;
            const subagents = get?.call(ctx2, 'subagents');
            if (subagents === undefined)
                return;
            // 第 6 形参：账号别名（target × account）注册所需的**环境依赖**。
            // 不传 = 与旧行为逐字一致（只注册 `harness-<target>`，一个别名都没有）；
            // 传了之后，每个能配对的 (target × account) 都会多出一个 `harness-<target>-acct-<id>`
            // provider —— 这才是「调用方能点名某个账号」的落点（`harness_agent(accountId=…)` 与
            // 宿主 subagent 工具的 `provider=harness-<t>-acct-<id>` 都靠它）。
            // `accounts` 必须是**惰性**的当前生效档案：注册期快照会让「删了账号还能用」成立。
            // 第 7 形参：**「账号 → 目标」的唯一合并实现**（`src/account-target.ts`）。
            // 为什么用注入而不是让 provider.ts 反过来 import：那会形成
            // `provider.ts ↔ account-target.ts` 循环（account-target 需要 provider 的
            // `planAccountAliases()` / `packagedManagedAdapterPath()`）。注入把回路切断，
            // 两侧 import 图因此都是单向的。不注入 ⇒ 普通账号别名**如实跳过**（不自己拼第二套）。
            const registered = registerProviders(subagents, registry, tasks, config.resolvedTargets, config.defaultTarget, {
                accounts: seedsNow,
                homeDir: homeDir(),
                onSkip: (note) => logger?.info?.(`harness-pilot: account alias skipped — ${note}`),
            }, (target, accountId, seeds) => withAccountTarget({ target, accountId, seeds, homeDir: homeDir() }));
            logger?.info?.(`harness-pilot: subagent providers registered: ${registered.join(', ')}`);
        },
    });
    registerTools(ctx, {
        config,
        registry,
        subagents: subagentsFacade,
        // 会话绑定 → 派发默认值（显式参数仍然优先）。
        bindingFor: (sessionId) => sessionId === undefined ? undefined : bindingState.bindings[sessionId],
        // `harness_agent(accountId=…)` 判活用的**当前生效**档案（内置 ± 用户增删改）。
        // 惰性函数：注册期快照会让「删了账号还能用」重新成立。
        accountSeeds: seedsNow,
        // `harness_spawn_teammate` 的两条依赖：身份冻结表 + 团队服务。
        // 两者都**不是**可选降级 —— 缺任何一个，那个工具就显式拒绝（见 tools.ts 的预检）。
        teamRouting,
        agentTeams: ctxAny.get?.('agentTeams'),
        // `fresh` 那一档的 provider 名走宿主自己的配置语义；这里给的是宿主缺省值。
        teamFreshProvider: 'spawn',
        // 持久原生会话（P1/P3）：harness_sessions 的 persistent/release 动作从这里读。
        nativeSessions,
    });
    registerTaskTools(ctx, {
        config,
        registry,
        tasks,
        settings: () => runtimeSettings,
        // 三个入口（/dispatch、/task/start、harness_task_start）共用**唯一**的账号合并实现
        // （`src/account-target.ts` 的 `withAccountTarget()`）。
        withAccount: (target, accountId) => withAccountTarget({
            target: target,
            accountId,
            seeds: seedsNow(),
            homeDir: homeDir(),
        }),
        poolDefaultAccountId: () => poolState.defaultAccountId ?? '',
        /**
         * **按目标分域**的池默认账号（任务工具链用）。
         *
         * 为什么不让它直接用 `poolDefaultAccountId()`：那是**全局一个**默认账号，
         * 用它会让「设了 workbuddy-a 之后 agy 全线失败」（实测缺陷）。
         * 这里交给 `defaultAccountForTarget()`（唯一实现）：不属于本目标 ⇒ 不套用 + 给出原因。
         */
        poolDefaultAccountFor: (targetName) => defaultAccountForTarget({
            targetName,
            candidate: poolState.defaultAccountId ?? '',
            seeds: seedsNow(),
        }),
        // ── harness_route_check（2026-10-16，P-2）：子代理白名单的只读快照 ──
        // 与 `/subagent-model-selection` 的门面同源（同样的两个宿主服务 + 同一份候选计算），
        // 但**只读**：这里绝不写设置。候选的模型表用缓存（syncModelsFor），不起子进程。
        routeCheck: () => {
            const settingsService = ctxAny.get?.('settings');
            const selectionService = ctxAny.get?.('subagentModelSelection');
            const snapshot = readPolicy(settingsService, selectionService);
            const providersNow = () => buildHarnessLlmProviders(config.resolvedTargets, seedsNow().map((seed) => seed.harnessId), seedsNow().map((seed) => seed.id));
            return {
                available: snapshot.available,
                reason: snapshot.reason,
                enabled: snapshot.enabled,
                revision: snapshot.revision,
                routes: snapshot.allowed,
                candidates: candidatesFor(providersNow(), (name) => syncModelsFor(name), snapshot.allowed),
            };
        },
    });
    // ── Path A：pilot-cli LLM 适配器 + 「选择本路由不得写部署默认模型」闸门 ──
    // 顺序纪律：`registerPilotCli` 先装闸门，**装不上就不注册路由**（用户授权是有条件的）。
    // 宣传哪些模型：只宣传「一次性 CLI 阶梯」（transport=auto）且未被停用的目标 ——
    // cdp / 窗口级目标是交互式的，拿它做「每轮一次调用」在语义上就是错的，所以**不宣传**
    // （排除原因在 `/llm-adapter` 里如实列出）。
    // 这里必须**同步、不起子进程**：目录读取很频繁（每次 resolveModelInfo / 目录刷新都会调）。
    const pilotCliTargets = () => config.resolvedTargets
        .filter((target) => target.transport === 'auto')
        .filter((target) => target.order.includes('headless') || target.order.includes('acp'))
        .filter((target) => !['opencode-flash', 'codebuddy'].includes(target.name))
        .filter((target) => registryStateBox.current?.overrides[target.name]?.enabled !== false)
        // ⚠️ `thinking` 必须透传：resolveModel 靠它产出宿主 reasoning 元数据（推理等级子菜单）。
        .map((target) => ({ name: target.name, displayName: { opencode: 'OpenCode', pi: 'Pi', claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', 'zcode-cli': 'ZCode', qodercli: 'Qoder 国际', 'qoder-cli': 'Qoder IDE CLI 国际', qoderclicn: 'Qoder 国内', 'qoder-cn-acct-a': 'Qoder 国内 · A', 'qoder-cn-acct-b': 'Qoder 国内 · B', 'wb-managed-a': 'WorkBuddy 国内', 'wb-managed-ai-b': 'WorkBuddy 国际' }[target.name] ?? target.name, description: redactOverviewDescription(target.description, seedsNow()), transport: target.transport, ...(target.thinking === undefined ? {} : { thinking: target.thinking }) }));
    // ── 目标真实模型的目录供给（2026-10-14：修「选择器里没有模型可选」）──────────
    // `listModels()` 只能同步、不起子进程；缓存未命中时由它说一声，这里排一轮后台预热，
    // 下一次目录刷新（宿主每次 modelCatalog() 都会问）就能看到真实模型条目。
    // 纪律：每个目标**只试一次**（失败不重试 —— 否则每次目录刷新都起一堆 CLI 进程）；
    // 并发限 2；预热只跑该 CLI 自己的 modelsCommand，不发模型请求、不消耗额度。
    const warmAttempted = new Set();
    const warmQueue = [];
    let warmRunning = 0;
    /**
     * 预热并发上限。
     *
     * 实测（冷启动、每条目标真查一次）：agy 7.3s / pi 4.7s / qoder-cn 4.6s / qodercli 3.5s /
     * mimo 2.6s / opencode 0.65s，其余 ~10ms。
     * 并发 2：35 条目标排很久，**首建目录 48.4s**（实测）；
     * 并发 6：14.8s 且 16/16 分组完整；
     * 并发 **10 反而更差**（21.3s、只有 9/16 完整、antigravity 掉回 1 个模型）——
     * 10 个 CLI 同时起互相拖慢，`agy` 那条因此错过预算。定 6 有实测对照，不是随手取的数。
     */
    const WARM_CONCURRENCY = 6;
    /**
     * 每条目标预热的**可等待句柄**：`listModels()` 要能在宿主第一次建目录时**等它**。
     *
     * ⚠️ 2026-10-15 修的实测缺陷：原来预热是纯 fire-and-forget，而宿主第一次
     * `modelCatalog()` 常常早于预热完成 ⇒ 该 harness 分组只剩「CLI 默认模型」一条
     * （插件重载后实测：Qoder 国内 14 → 1、国际 2 → 1），要等下一次目录刷新才恢复。
     * 现在同一条预热既有 promise，也能被 await（**不重复起进程**：同一目标只排一次队）。
     */
    const warmDone = new Map();
    const pumpWarm = () => {
        while (warmRunning < WARM_CONCURRENCY && warmQueue.length > 0) {
            const name = warmQueue.shift();
            warmRunning++;
            void (async () => {
                try {
                    const found = config.resolvedTargets.find((target) => target.name === name);
                    // `force`: 预热**就是刷新**那条路。否则落盘回填的条目会一直命中缓存，
                    // 永远不刷新 —— 展示的是「上次发现」，而它本该只在预热完成前顶上。
                    if (found !== undefined)
                        await registry.targetModels(modelScopedTarget(found), { force: true });
                }
                catch {
                    // 预热失败不致命：该目标在选择器里只出「默认模型」条目；不重试。
                }
                finally {
                    warmRunning--;
                    warmDone.get(name)?.resolve();
                    pumpWarm();
                }
            })();
        }
    };
    /** 预热一条目标；返回的 promise 在它**真的试过**之后完成（已经试过则立即完成）。 */
    const warmModelsOnce = (name) => {
        const existing = warmDone.get(name);
        if (existing !== undefined)
            return existing.promise;
        const found = config.resolvedTargets.find((target) => target.name === name);
        // 三种模型来源都值得预热：命令发现 / 静态清单 / 目录文件。
        // （只看 modelsCommand 会漏掉 WB 这种「无列模型命令但有实测静态清单」的目标。）
        if (found === undefined)
            return Promise.resolve();
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        warmDone.set(name, { promise, resolve });
        warmAttempted.add(name);
        warmQueue.push(name);
        pumpWarm();
        return promise;
    };
    /**
     * **整轮预热**（挂载时扇出一次；所有 provider 等**同一个** promise）。
     *
     * 为什么不让各 provider 各等自己那条：宿主是**逐 provider** 建目录的，
     * 各自等就把「每条目标的首查时间」**求和**了（实测 48.4s）。
     * 等同一个总预热 ⇒ 总代价≈最慢的那一批（并发 6），且不重复起进程
     * （每条目标只排队一次；`registry.targetModels` 另有 in-flight 去重）。
     * 跑完**立刻落盘**：下次重载就不必再等这 14.8s。
     */
    let warmAllPromise;
    const warmAllOnce = () => {
        warmAllPromise ??= Promise.allSettled(config.resolvedTargets
            .filter((target) => (target.transport ?? 'auto') === 'auto')
            .map((target) => warmModelsOnce(target.name))).then(() => { persistModelCache(); });
        return warmAllPromise;
    };
    const awaitModelsFor = async (name) => {
        const found = config.resolvedTargets.find((target) => target.name === name);
        if (found === undefined)
            return undefined;
        /**
         * ⚠️ **已有缓存（内存或落盘回填）就立即返回**，不进等待。
         *
         * 这是「重载后首建目录」的关键：落盘的条目在挂载时已回填，于是第一屏**既完整又即时**；
         * 只有真的什么都没有（首次运行）才需要等整轮预热。
         */
        const cachedNow = syncModelsFor(name);
        if (cachedNow !== undefined && cachedNow.length > 0)
            return cachedNow;
        // 等**整轮预热的同一个 promise**，预算也**只有一个全局截止时刻**——
        // 这样逐 provider 建目录时，先被建的那几个不会被各自的超时落下。
        await warmAllBounded();
        // 整轮预热跑完后这一条仍没被排过（例如它不在自动派发集合里）⇒ 单独补查一次。
        if (!warmAttempted.has(name)) {
            warmAttempted.add(name);
            try {
                await registry.targetModels(modelScopedTarget(found), { force: true });
            }
            catch {
                // 单目标失败 ⇒ 回退同步清单；错误由 `/llm-adapter` 的逐步诊断如实回报。
            }
        }
        return syncModelsFor(name);
    };
    /**
     * 模型发现的**落盘缓存**：`<pluginHome>/model-catalog-cache.json`。
     *
     * 为什么要它（2026-10-15 实测）：每条 CLI 的模型列举命令都要起进程，冷启动整轮预热要
     * **14.8s**（agy 7.3s / pi 4.7s / qoder 4.6s+3.5s / mimo 2.6s）。插件每次重载缓存都丢，
     * 于是「重载后第一次建目录」要么等这 14.8s、要么（改之前）只剩「CLI 默认模型」一条。
     * 现在把上次发现落盘：重载时**回填**（`seedModelCache`，只接受 6 小时内的条目，
     * note 里写明「本地缓存，N 分钟前发现」）⇒ 第一屏既完整又即时；后台预热 `force` 刷新每条目标，
     * 刷完重新落盘。**不新鲜就不冒充新鲜**：超龄的条目在加载时直接丢掉。
     */
    const modelCacheFile = () => join(pluginHome(), 'model-catalog-cache.json');
    const loadModelCacheFromDisk = () => {
        try {
            const raw = readFileSync(modelCacheFile(), 'utf8');
            const parsed = JSON.parse(raw);
            const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
            modelCacheDiag.file = modelCacheFile();
            modelCacheDiag.persistedRows = rows.length;
            const seeded = registry.seedModelCache(rows, {
                maxAgeMs: SEEDED_MODEL_TTL_MS,
                // 键必须与读取路径同源（`syncModelsFor` 用的就是 `modelScopedTarget`），否则回填读不到。
                scope: (target) => {
                    try {
                        return modelScopedTarget(target);
                    }
                    catch {
                        return target;
                    }
                },
            });
            modelCacheDiag.seededOnMount = seeded;
            if (seeded > 0)
                logger?.info?.(`harness-pilot: 模型目录缓存回填 ${seeded} 条（≤ ${Math.round(SEEDED_MODEL_TTL_MS / 3_600_000)}h，后台正在刷新）`);
            return seeded;
        }
        catch {
            // 没有文件 / 文件坏了都只是「没有缓存」，不是错误。
            modelCacheDiag.file = modelCacheFile();
            modelCacheDiag.persistedRows = 0;
            modelCacheDiag.seededOnMount = 0;
            return 0;
        }
    };
    const persistModelCache = () => {
        try {
            const rows = registry.exportModelCache();
            modelCacheDiag.inMemory = rows.length;
            if (rows.length === 0)
                return;
            writeFileSync(modelCacheFile(), `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), rows }, null, 0)}\n`, 'utf8');
        }
        catch {
            // 落盘失败不影响运行（只是下次重载还得重查一遍）。
        }
    };
    const seededOnMount = loadModelCacheFromDisk();
    /** 整轮预热的**有界**版本：同一个 promise、同一个截止时刻（所有 provider 共享）。 */
    let warmBoundedPromise;
    const warmAllBounded = () => {
        warmBoundedPromise ??= Promise.race([
            warmAllOnce(),
            new Promise((done) => { const t = setTimeout(done, MODEL_AWAIT_BUDGET_MS); t.unref?.(); }),
        ]);
        return warmBoundedPromise;
    };
    // **挂载即预热**：宿主的第一次 `modelCatalog()` 很可能早于预热完成，
    // 而「一个 harness 一条 provider」的空组会被宿主直接丢掉（选择器里暂时看不见那条 harness）。
    // 这里主动把每条可派发目标排进队列 —— 只跑该 CLI 自己的模型列举命令，零额度、零推理、每目标只试一次。
    for (const target of config.resolvedTargets) {
        if ((target.transport ?? 'auto') === 'auto')
            warmModelsOnce(target.name);
    }
    /** 会话工作目录：与工具路径同源（`session.header.cwd`），拿不到就用进程 cwd。 */
    const sessionCwdFor = (sessionId) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
            const store = ctxAny.get?.('sessions');
            const cwd = store?.get?.(sessionId)?.header?.cwd;
            if (typeof cwd === 'string' && cwd.length > 0)
                return cwd;
        }
        return process.cwd();
    };
    /**
     * **MCP 桥接**（`src/mcp-bridge.ts`）：给「这一轮真的会被外部 CLI 承接」的子会话开一个
     * **短寿命、loopback 限定、逐入口令牌鉴权**的 MCP 入口，让 CLI 用它**自己的** MCP 客户端
     * 发起真实 `tools/call`，再在**该成员自己的 Agent 作用域**内走 `ctx.tools.execute`。
     *
     * 位置纪律：必须在 `registerPilotCli` **之前**建 —— 它的 `tools/execute` 观察器与
     * `agents.get` 查找都要在第一次改道派发之前就位。
     */
    const mcpBridge = createMcpBridge({
        ctx: ctxAny,
        logPath: join(pluginHome(), 'mcp', 'bridge-events.jsonl'),
        configDir: join(pluginHome(), 'mcp', 'configs'),
    });
    // 插件卸载/热重载时把**所有**入口关掉：绝不留一个「宿主已经换了一版代码、端口还开着」的入口。
    try {
        ctxAny.effect?.(() => () => { mcpBridge.closeAll('plugin-unload'); }, '@dsh-external/dsh-harness-pilot: mcp-bridge');
    }
    catch { /* effect 不可用不影响桥接本身 */ }
    // ── 会话模型选择器可见性（2026-10-15，用户要求「列表不要这么长」+「按 CLI/模型控制显示」）──
    // 状态一份（`let`，POST 后整体替换 ⇒ adapter 闭包读到的永远是当前值）；
    // 门面给 HTTP 路由与概览摘要用；adapter 的 `pickerVisibility` 只读。
    let modelVisibility = loadModelVisibility();
    const modelVisibilityFacade = {
        read: () => modelVisibility,
        write: (patch) => {
            const result = applyVisibilityPatch(modelVisibility, patch);
            if (!result.ok)
                return result;
            const previous = modelVisibility;
            modelVisibility = saveModelVisibility(result.next);
            logger?.info?.(`harness-pilot: model-visibility updated (${patch.providerId}): ${result.note}`);
            return { ok: true, doc: modelVisibility, previous, note: result.note };
        },
        providers: () => buildHarnessLlmProviders(config.resolvedTargets, seedsNow().map((seed) => seed.harnessId), seedsNow().map((seed) => seed.id)).map((spec) => ({
            providerId: spec.id,
            label: spec.name,
            groupId: spec.groupId,
            models: mergeHarnessModels(spec, (name) => syncModelsFor(name)).map((model) => model.id),
        })),
    };
    const executionIdentities = new SessionIdentityStore(join(pluginHome(), 'session-execution-identities.json'));
    // ⚠️ 2026-10-15：Codex 一刀切的「外部模型仅供子代理」会话策略在本轮**按用户最新指示移除**
    // （用户明确要求「增加对每个外部 harness 的单个模型是否显示进行控制」⇒ 会话选择器恢复由
    // `/model-visibility` 逐模型/逐组/上限驱动 —— 该过滤在 `listModels`（pickerVisibility dep）里，
    // 不需要这条 sessionController 包装）。账号型模型（dsh-model-connect）保留它自己的同款策略。
    const pilotCli = registerPilotCli(ctxAny, {
        onExecution: (sessionId, identity) => executionIdentities.set(sessionId, identity),
        logger,
        targets: pilotCliTargets,
        // 真实模型目录出口（同步读缓存；未命中由 warmModelsOnce 排后台预热）。
        // 实现搬到 `syncModelsFor`（同一份实现也被 `/llm-adapter` 的逐步诊断用）。
        modelsFor: (name) => syncModelsFor(name),
        warmModelsFor: (name) => { void warmModelsOnce(name); },
        // 有界等待模型发现（`listModels` 用）：等的是**已经在跑的那条预热**，不重复起进程；
        // 没有它，宿主第一次建目录若早于预热完成，该组就只剩「CLI 默认模型」一条（实测 Qoder 14 → 1）。
        awaitModelsFor: (name) => awaitModelsFor(name),
        // ⚠️ 2026-10-14 起**不再用于截断**：模型目录改成「一个 harness 一个 provider 分组」，
        // 每一组的模型**全部**列出（用户明确要求「点开折叠后才是该 harness 的全部模型」）。
        // 这个 dep 保留只为兼容旧调用点；`listModels` 已不读它。
        sessionModelLimit: () => runtimeSettings.sessionModelLimit,
        /**
         * **会话选择器可见性**（2026-10-15）：每组上限 / 整组隐藏 / 组内隐藏。
         * 只影响 `listModels` 的宣传面；执行校验与子代理候选不过这里（见 `src/model-visibility.ts` 文件头）。
         */
        pickerVisibility: (providerId) => pickerVisibilityFor(modelVisibility, providerId),
        /**
         * **一个 harness 一条 LLM provider**：宿主只按 provider 分组（且没有组级折叠原语），
         * 所以这就是「原生选择器里按 harness 折叠、展开看全部模型」的唯一宿主机制。
         * 分类表唯一来源 = `src/harness-groups.ts`（离线探针逐条断言覆盖率）。
         */
        harnessProviders: () => buildHarnessLlmProviders(config.resolvedTargets, seedsNow().map((seed) => seed.harnessId), seedsNow().map((seed) => seed.id)),
        // 复用本插件既有的通道实现（与 harness_dispatch / 任务同一条路径）：Windows 上 harness 多是
        // .cmd shim，需要 cmd.exe 包装；账号隔离靠档案 env；停用门禁在 SessionRegistry.dispatch 里。
        // 因此这里**不是**宿主的 ctx.subprocess 缝 —— 这一点在报告里如实记录（契约文档 §5 的建议不同）。
        dispatch: async (input) => {
            const found = config.resolvedTargets.find((target) => target.name === input.target);
            if (found === undefined)
                return { ok: false, reason: `unknown harness target "${input.target}"` };
            const priorBinding = input.sessionId === undefined ? undefined : bindingState.bindings[input.sessionId];
            input = { ...input, accountId: input.accountId ?? (priorBinding?.harnessId === found.name ? priorBinding.accountId : undefined) ?? accountForTarget(found) };
            let target = found;
            let accountNote;
            // ── 冻结配方优先（团队路由）─────────────────────────────────────────────
            // 只有**已创建**的团队成员会走到这一支。它按成员诞生那一刻固化的配方执行 ——
            // **不**再按当下的账号档案重算。两条纪律因此成立：账号被停用/删除**不影响**在跑的成员；
            // 也**不存在**「用 A 账号建的成员某轮悄悄跑成 B 账号」这条路径。新成员在 `prepare()` 就被拒。
            //
            // ⚠️ 合并规则**不在本文件里**：走 `src/account-target.ts` 的 `applyAccountToTarget()`，
            // 与 `/team/dispatch`、`withAccountTarget()` 同一处。历史缺陷（**已确证**）是这里写的
            // `[...frozen.args, ...found.args]`：受管账号的冻结 `args` 是**相对**的
            // `['workbuddy-managed.cjs', <档案 id>]`，前置到已经是完整元组的目标参数前面 ⇒
            // `["workbuddy-managed.cjs", <id>, "<绝对 wrapper>", <id>, "-p"]`（两个 WB 账号 2/2）。
            if (input.frozenAccount !== undefined) {
                const frozen = input.frozenAccount;
                const merged = applyAccountToTarget(found, frozen, { seeds: seedsNow(), homeDir: homeDir() });
                if (!merged.ok)
                    return { ok: false, reason: merged.reason };
                target = merged.target;
                accountNote = frozen.note;
                // 冻结的模型也要真的进命令行（同 `/team/dispatch` 那条的理由）。
                // `registry.dispatch` 后面会再走一次 `withModel()`；目标**没有**声明 modelArgs 时
                // 那一步什么都不做，所以这里用该 CLI 已实测的 `--model` 补上。
                if (input.model !== undefined && input.model.length > 0) {
                    const modelArgs = modelArgsFor(found, input.model);
                    if (modelArgs.length > 0)
                        target = { ...target, args: [...target.args, ...modelArgs] };
                }
            }
            else if (typeof input.accountId === 'string' && input.accountId.length > 0) {
                const applied = withAccountTarget({ target: found, accountId: input.accountId, seeds: seedsNow(), homeDir: homeDir() });
                if (!applied.ok)
                    return { ok: false, reason: applied.reason };
                target = applied.target;
                accountNote = applied.note;
            }
            // ── 显式选择的模型必须真的进命令行（非冻结路径；冻结路径上面已处理）────────
            // 覆盖「选择器选了 目标名::模型 / 绑定带了模型」两种来源。与团队路径同一规则：
            // 目标声明了 `modelArgs` 就交给 `registry.dispatch` 里的 `withModel()`（spec.model）；
            // 没声明就用该 CLI **已实测**的 `--model` 补上；两条都承载不了 ⇒ **显式拒绝**，不静默丢弃。
            if (input.model !== undefined && input.model.length > 0 && input.frozenAccount === undefined) {
                const modelArgs = modelArgsFor(found, input.model);
                const delivered = modelArgs.length > 0 || found.modelArgs.length > 0;
                if (!delivered) {
                    return {
                        ok: false,
                        reason: `目标 "${found.name}" 无法承载模型 "${input.model}"（无 modelArgs 且无已实测 --model 注入）——拒绝派发，不静默丢弃`,
                    };
                }
                if (modelArgs.length > 0)
                    target = { ...target, args: [...target.args, ...modelArgs] };
            }
            // ── 推理等级（2026-10-15 用户要求全部模型可选、按模型定制）────────────────
            // 目标声明了 `thinking` 才承载；档位必须在声明词表内（宿主已校验一次，这里兜底）。
            // 未声明的目标带 effort ⇒ **显式拒绝**（不静默丢掉——那会让「选了高却跑默认」无法察觉）。
            // 参数按 `thinking.args` 模板（`{effort}` 替换）追加到命令行，与 modelArgs 兜底同一模式。
            if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0) {
                const effortSpec = target.thinking;
                const effort = input.reasoningEffort;
                const known = effortSpec?.levels.some((level) => level.id === effort) === true;
                if (effortSpec === undefined || !known) {
                    return {
                        ok: false,
                        reason: `目标 "${found.name}" 不支持推理等级 "${effort}"（声明：${effortSpec?.levels.map((level) => level.id).join(', ') ?? '无——该模型不提供推理等级选择'}）`,
                    };
                }
                const effortArgs = effortSpec.args.map((piece) => piece.replace('{effort}', effort));
                target = { ...target, args: [...target.args, ...effortArgs] };
            }
            if (target.args.some(arg => /(?:^|[\\/])workbuddy-managed\.cjs$/i.test(arg))) {
                const seed = seedsNow().find(entry => entry.id === input.accountId);
                if (!seed)
                    return { ok: false, reason: '未选择有效的 WorkBuddy 隔离账号' };
                if (priorBinding?.harnessId === found.name && priorBinding.isolatedAccountHome)
                    target = { ...target, env: { ...target.env, DSH_WORKBUDDY_FROZEN_HOME: priorBinding.isolatedAccountHome } };
                target = prepareWorkBuddyHome(target, seed.configDir, homeDir());
            }
            if (input.sessionId && input.accountId && (priorBinding?.harnessId !== found.name || priorBinding.accountId === undefined || (target.env.DSH_WORKBUDDY_FROZEN_HOME && !priorBinding.isolatedAccountHome))) {
                bindingExtras.set({ sessionId: input.sessionId, harnessId: found.name, accountId: input.accountId, ...(priorBinding?.harnessId === found.name && priorBinding.model ? { model: priorBinding.model } : {}), ...(target.env.DSH_WORKBUDDY_FROZEN_HOME ? { isolatedAccountHome: target.env.DSH_WORKBUDDY_FROZEN_HOME } : {}) });
            }
            // ── MCP 桥接：本轮入口 ──
            // **通道由这一轮真正要走的传输决定**（调用方在这里已经声明了 `input.transport`）：
            //   · `acp`            ⇒ `acp-mcp-servers`：注入向量是 ACP 协议字段 `session/new.mcpServers`
            //                        （**不碰 argv**，因此「这个 CLI 认不认 `--mcp-config`」与它无关），
            //                        令牌由桥接模块内部拼进 header —— 调用方拿不到令牌本体；
            //   · 其它（headless/pty/…）⇒ `argv-mcp-config`：`--mcp-config` + `--allowed-tools`，
            //                        且只对这个 CLI **有已验证注入**时开（否则返回 undefined）。
            // 两种通道都要求该会话**有活 Agent**；不满足就返回 undefined，**一个端口都不开**。
            // 入口在 `finally` 里关闭：正常结束、超时、取消（`input.signal` 一 abort，
            // headless 通道就 killTree → dispatch settle）三条路都会走到这里 ⇒
            // **取消成员时桥接入口同步失效**（服务停监听 + 配置文件删除 + 在飞工具调用被 abort）。
            const bridgeChannel = input.transport === 'acp' ? 'acp-mcp-servers' : 'argv-mcp-config';
            let bridge;
            try {
                bridge = await mcpBridge.openForTurn({
                    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
                    command: target.command,
                    channel: bridgeChannel,
                    origin: 'pilot-cli-redirect',
                    note: { target: target.name, transport: input.transport },
                });
            }
            catch (error) {
                // 桥接失败**不许**让这一轮派发失败：如实记一条，然后按「没有桥」继续。
                logger?.warn?.(`mcp-bridge: openForTurn failed for ${input.target}: ${describe(error)}`);
                bridge = undefined;
            }
            try {
                const outcome = await registry.dispatch({
                    target,
                    prompt: input.prompt,
                    cwd: sessionCwdFor(input.sessionId),
                    signal: input.signal,
                    timeoutMs: target.timeoutMs,
                    // 本次选中的模型：交给 `withModel()`（modelArgs 模板 + ACP 会话内切换）。
                    // 没选就不带 —— 目标按它自己的默认模型跑。
                    ...(input.model === undefined || input.model.length === 0 ? {} : { model: input.model }),
                    ...(bridge === undefined || bridge.extraArgs.length === 0 ? {} : { extraArgs: bridge.extraArgs }),
                    // ── MCP 桥接的**手递凭据**（headless 通道）──────────────────────────────
                    // 这一行是「令牌不进配置文件」这条修复的**送达腿**：入口令牌只经**这一轮 CLI 子进程
                    // 的环境**交给 CLI，CLI 再（实测：深拷贝）交给它 spawn 的 stdio 代理，代理转发回本机入口。
                    //   · **不落盘**：`--mcp-config` 文件里只有「怎么拉起代理」（无 url / 无 headers / 无令牌）；
                    //   · **不进 argv**：所以也不会出现在 CLI 的进程命令行 / manifest 里；
                    //   · **不进日志 / 不进 API 响应**：`view()` 只给变量**名**（`handoffEnvKeys`），不给值；
                    //     这里也**没有**任何把 `handoffEnv` 写进 outcome / facts / diagnostic 的路径。
                    // 变量名为什么是 `DSH_BRIDGE_HANDOFF*` 而不是 `…_TOKEN`：**实测** CLI 会按名字丢掉含
                    // TOKEN/SECRET/KEY/AUTH/PASSWORD/CREDENTIAL 的键（`probe/_mcp-env-semantics-matrix.mjs`），
                    // 用那些名字会得到「凭据被静默清空、代理起不来」。详见 `MCP_BRIDGE_HANDOFF_ENV` 的注释。
                    // ACP 通道 `handoffEnv` 恒为 `{}`（它的注入向量是协议字段，不走 env）。
                    ...(bridge === undefined || Object.keys(bridge.handoffEnv).length === 0 ? {} : { extraEnv: bridge.handoffEnv }),
                    // ACP 通道的注入向量不是 argv，而是 `DispatchSpec.mcpServers`（acp 传输读它去填
                    // `session/new.mcpServers`）。这里**只**在真的是 ACP 通道时带它 ——
                    // 把 ACP 条目塞进 headless 派发只会得到一个没人读的字段。
                    ...(bridge === undefined || bridge.channel !== 'acp-mcp-servers' ? {} : { mcpServers: bridge.mcpServers }),
                    identity: {
                        harnessId: input.target,
                        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
                        provider: PILOT_CLI_ROUTE,
                        // 模型放**目标名**是 `pilot-cli` 路由的既有语义（model 槽 = 目标名，或
                        // `目标名::模型` —— 2026-10-14 起选择器里的真实模型条目用组合槽）；
                        // 真正选中的模型 id 另记在 `modelRequested`，好让「模型到底有没有生效」
                        // 有独立可查的字段，而不是只能从 argv 反推。
                        model: input.target,
                        ...(input.model === undefined ? {} : { modelRequested: input.model }),
                    },
                }, { transport: input.transport });
                const details = [outcome.diagnostic, accountNote].filter((piece) => typeof piece === 'string' && piece.length > 0);
                return {
                    ok: true,
                    text: outcome.text,
                    stopReason: outcome.stopReason,
                    mismatch: outcome.mismatch,
                    ...(details.length === 0 ? {} : { diagnostic: details.join('; ') }),
                    transport: outcome.transport,
                    facts: {
                        ...outcome.facts,
                        // 如实报「本轮开过哪个入口」：`none` = 这个 CLI 没有已验证的注入方式 / 该会话没有活 Agent。
                        // 带上通道名，否则「开过入口」在 ACP 与 argv 两种注入向量下长得一样，读的人无从分辨。
                        mcpBridge: bridge === undefined ? 'none' : `${bridge.id}@127.0.0.1:${String(bridge.port)} (${bridge.channel})`,
                    },
                };
            }
            finally {
                bridge?.close('turn-settled');
            }
        },
        bindingFor: (sessionId) => bindingState.bindings[sessionId],
        defaultAccountId: () => poolState.defaultAccountId ?? '',
        /**
         * **按目标分域**的池默认账号（会话/子代理路由链用，`llm-adapter.ts` 读它）。
         * 与任务工具链的 `poolDefaultAccountFor` 是**同一个实现**：不属于本目标就不套用。
         */
        defaultAccountFor: (targetName) => {
            const scoped = defaultAccountForTarget({ targetName, candidate: poolState.defaultAccountId ?? '', seeds: seedsNow() });
            const target = config.resolvedTargets.find(row => row.name === targetName);
            // Discovery and execution must use the same account scope (especially Qoder INTL).
            const account = target ? accountForTarget(target) : undefined;
            return { ...scoped, accountId: (target && isAccountPinned(target) ? account : scoped.accountId || account) || '' };
        },
        // 团队成员的**冻结**账户配方：按会话 id 取「成员诞生那一刻」的那一份。
        // 它不是可选的锦上添花 —— 没有它，成员会按**查询时刻**的档案重算配置目录，
        // 于是「改名/停用账号」会悄悄改变一位已经存在的成员（正是用户禁止的那类静默换号）。
        frozenAccountFor,
        // 冻结的模型 id：请求层只把「目标名」当 model，所以模型必须从这里显式补上，
        // 否则 binding.model 会被静默丢弃（`--model` 从不进 argv）。
        frozenModelFor: frozenModelOf,
    });
    // ── 团队子会话绑定取证探针（U1）──
    // 在 `mountApi` **之前**建：它的 `agent/created` / `llm/stream` 观测必须在任何
    // 子会话诞生之前就位。绑定走 `bindingExtras.set` —— **与 `POST /session/binding`
    // 完全同一条链**（同一个落盘文件、同一个 `bindingState`），所以「探针写的绑定」
    // 与「用户手写的绑定」对路由是同一个东西，不存在「只在探针里成立」的可能。
    const teamProbe = createTeamMemberProbe(ctx, process.cwd(), config, (binding) => {
        bindingExtras.set({ sessionId: binding.sessionId, harnessId: binding.harnessId, ...(binding.accountId === undefined ? {} : { accountId: binding.accountId }), ...(binding.model === undefined ? {} : { model: binding.model }) });
    });
    /**
     * **产品**团队路由的 HTTP 接线（`/harness-pilot/api/team/*`）。
     *
     * 与上面探针的边界：这里**不**创建成员、**不**按成员名匹配、**不**读探针状态。
     * 只暴露「已经冻结了的身份」与「按冻结配方执行这一轮」两个能力。
     */
    const teamRoutingExtras = {
        routes: () => teamRouting.snapshot(),
        pending: () => teamRouting.pendingIntents(),
        events: (limit) => teamRouting.logs(limit),
        recipeOf: (sessionId) => teamRouting.frozenRecipeOf(sessionId),
        /**
         * 按**该成员冻结的账户配方**执行这一轮。
         *
         * 直连 `registry.dispatch`（与 `/dispatch` 同一条通道梯子），**不**按当下档案重算 ——
         * 账号在这里是**已冻结的参数与环境变量**，不是一次新的选择。
         *
         * ⚠️ 合并规则同样**不在本文件里**：走 `applyAccountToTarget()`（`src/account-target.ts`），
         * 与 `pilotCli.dispatch` 的冻结分支、`withAccountTarget()` 同一处。历史缺陷是这里写的
         * `[...account.args, ...found.args]`：受管账号的冻结 `args` 是相对的，前置到完整元组前面
         * ⇒「两个 wrapper、两个 id」。它同时也会用 `frozenTargetConfig` 拦住「冻结了 A 账号、
         * 却派到另一个目标上」这条错配路径。
         */
        dispatch: async (input) => {
            const found = config.resolvedTargets.find((target) => target.name === input.target);
            if (found === undefined)
                return { ok: false, reason: `unknown harness target "${input.target}"` };
            let target = found;
            let note = '';
            if (input.sessionId !== undefined) {
                // 读**冻结配方本体**（不是界面投影），理由见 `TeamRoutingExtras.recipeOf` 的注释。
                const recipe = teamRoutingExtras.recipeOf(input.sessionId);
                if (recipe === undefined) {
                    return { ok: false, reason: `session ${input.sessionId} has no frozen recipe in the team routing table — refusing to dispatch an unbounded identity` };
                }
                const account = recipe.account;
                if (account !== undefined) {
                    const merged = applyAccountToTarget(found, {
                        accountId: account.accountId,
                        args: account.args,
                        env: account.env,
                        note: '',
                        frozenTargetConfig: recipe.targetConfig,
                    }, { seeds: seedsNow(), homeDir: homeDir() });
                    if (!merged.ok)
                        return { ok: false, reason: merged.reason };
                    target = merged.target;
                    note = `account=${redactAccount(account.accountId)} configDir=${account.configDir}（创建时冻结）`;
                }
                // ── 模型：也要**真的进命令行** ──
                // 目标自己声明了 `modelArgs` 就交给 `withModel()`；没声明就用该 CLI **已实测**的
                // `--model` 开关补上（见 `modelArgsFor` 的注释：本机 qoder 目标的 `modelArgs` 是空的，
                // 不补就等于「冻了个模型、argv 里什么也没发生」＝静默丢弃）。
                if (recipe.model !== undefined && recipe.model.length > 0) {
                    const modelArgs = modelArgsFor(found, recipe.model);
                    const delivered = modelArgs.length > 0 || found.modelArgs.length > 0;
                    if (!delivered) {
                        return { ok: false, reason: `target "${found.name}" cannot carry model "${recipe.model}" (no modelArgs and no verified --model injection) — refusing to dispatch without the frozen model` };
                    }
                    if (modelArgs.length > 0)
                        target = { ...target, args: [...target.args, ...modelArgs] };
                    note = `${note}${note.length === 0 ? '' : ' '}model=${recipe.model}（创建时冻结）`;
                }
            }
            try {
                const outcome = await registry.dispatch({
                    target,
                    prompt: input.prompt,
                    cwd: input.cwd,
                    signal: input.signal,
                    timeoutMs: target.timeoutMs,
                });
                return { ok: true, text: outcome.text, transport: outcome.transport, stopReason: outcome.stopReason, ...(note.length === 0 ? {} : { note }), ...(outcome.facts === undefined ? {} : { facts: outcome.facts }) };
            }
            catch (error) {
                return { ok: false, reason: describe(error) };
            }
        },
    };
    // 设置页/插件页的数据接口 + 给外部 agent（Codex 等）的写接口（client.js 用 fetch 读它）。
    // 走子 fiber 等 webServer 就位再注册路由 —— 这是 bundle 启动场景下路由丢失的修复点。
    const mountApi = (webServer, effect) => {
        const disposeRoute = registerApiRoute(webServer, createApiHandler(registry, config, {
            tasks,
            settings: () => runtimeSettings,
            applySettings,
            registry: federationExtras,
            providers: providersExtras,
            // P4：可编辑操作 + 受约束选择（能力探测决定可编辑范围）。
            catalog: catalogExtras,
            accounts: accountsExtras,
            // 第 3 阶段：动态账号档案 CRUD + 原生登录/退出入口。
            // （`accountManagers` 一度被两个写者各加了一次 ⇒ TS1117 重复键、构建全断；
            //   现只保留这一处。）
            accountManagers,
            accountDefaults: {
                state: () => ({ defaults: Object.fromEntries([...new Set(seedsNow().map(seed => seed.harnessId))].map(id => [id, accountDefaults[id] ?? seedsNow().find(seed => seed.harnessId === id)?.id])) }),
                select: id => {
                    const seed = seedsNow().find(entry => entry.id === id);
                    if (!seed)
                        throw new Error('未知账号');
                    accountDefaults = { ...accountDefaults, [seed.harnessId]: id };
                    writeFileSync(accountDefaultsFile, JSON.stringify(accountDefaults), { mode: 0o600 });
                    for (const target of config.resolvedTargets)
                        if (seedForTarget(target.name)?.id === seed.harnessId)
                            warmAttempted.delete(target.name);
                    return { defaults: accountDefaults, note: '只影响新会话或尚未绑定账号的任务；原有子代理保留其账号。' };
                },
            },
            accountSeeds: seedsNow,
            modelsFor: syncModelsFor,
            modelsErrorFor: syncModelErrorFor,
            // ── 会话模型选择器可见性门面（GET/POST /model-visibility + 概览每组 picker 摘要）──
            modelVisibility: modelVisibilityFacade,
            // ── 子代理模型白名单门面 ──
            // 两个宿主服务在这里（`apply` 的 scope）取一次；路由处理器拿不到 `ctxAny`。
            nativeModelCatalog: async () => {
                const controller = ctxAny.get?.('sessionController');
                if (!controller?.modelCatalog)
                    throw new Error('native model catalog unavailable');
                return controller.modelCatalog();
            },
            subagentModels: (() => {
                const settingsService = ctxAny.get?.('settings');
                const selectionService = ctxAny.get?.('subagentModelSelection');
                const providersNow = () => buildHarnessLlmProviders(config.resolvedTargets, seedsNow().map((seed) => seed.harnessId), seedsNow().map((seed) => seed.id));
                return {
                    ns: SUBAGENT_MODEL_NS,
                    settingsAvailable: typeof settingsService?.update === 'function',
                    selectionAvailable: typeof selectionService?.current === 'function',
                    read: () => readPolicy(settingsService, selectionService),
                    // 账号型模型（WorkBuddy/Qoder）的候选已随 dsh-model-connect 拆出，不再出现在本插件候选里。
                    candidates: () => candidatesFor(providersNow(), (name) => syncModelsFor(name), readPolicy(settingsService, selectionService).allowed),
                    apply: (plan, expected) => applyPolicyChange(settingsService, selectionService, plan, expected),
                };
            })(),
            accountAdmin: accountAdminExtras,
            binding: bindingExtras,
            pool: poolExtras,
            // 进程池的只读快照出口（与账号池 `pool` 不是一回事，名字刻意区别开）。
            processPool: () => ({ describe: () => registry.pool().describe(), eventLog: () => registry.poolEventLog() }),
            // 第 4 阶段：自动切换执行侧（/dispatch 与 TaskManager 共用同一条）。
            autoSwitchDispatch: async (spec, options) => autoSwitchBox.current === undefined
                ? await registry.dispatch(spec, options)
                : await autoSwitchBox.current.dispatch(spec, options),
            llmAdapter: pilotCli,
            teamProbe,
            // **产品**团队路由（与上面的取证探针是两条独立链；此接口只读 + dispatch）。
            teamRouting: teamRoutingExtras,
            mcpBridge,
            // HTTP 处理器拿不到 logger（它不是参数）—— 桥接等失败路径需要有人看得见，这里注入。
            log: (message) => logger?.warn?.(message),
            // 改道归因取证用（`/llm-adapter/redirect-turn`）：真发一条消息唤醒一轮，
            // 然后**只读宿主自己的会话事件日志**。三条都走既有服务，不新增写入路径。
            wake: async (sessionId, text) => await waker.wake(sessionId, text),
            createSession: async (sessionId) => {
                const controller = ctxAny.get?.('sessionController');
                if (controller?.create === undefined)
                    return sessionId;
                const created = await controller.create({ sessionId });
                const value = (created ?? {});
                return typeof value.sessionId === 'string' && value.sessionId.length > 0 ? value.sessionId : sessionId;
            },
            sessionLog: (sessionId) => sessionLogRead(ctxAny, sessionId),
            executionIdentity: (sessionId) => executionIdentities.get(sessionId),
        }), logger);
        if (disposeRoute === undefined) {
            logger?.warn?.(`harness-pilot: no HTTP api on ${API_PATH} — the settings page and the Codex-side HTTP calls will 404`);
            return;
        }
        // ⚠️ cordis 的 `ctx.effect(cb)` 是 **React 语义**：立即执行 cb，并把 cb 的
        // **返回值**当作 disposer（见 cordis `Fiber.effect` → `this._execute(runner)`）。
        // 原来写成 `() => { disposeRoute() }`（块体、无返回）会**在同一个 tick 里**
        // 刚注册就把路由删掉 —— 这就是「日志显示注册成功、接口却永久 404」的真因。
        // 本文件末尾 `ctx.effect(() => () => …)` 才是正确用法。
        effect(() => disposeRoute, '@dsh-external/dsh-harness-pilot: settings + write api');
        logger?.info?.(`harness-pilot: settings + write api on ${API_PATH}${config.apiToken.length > 0 ? ' (token required)' : ''}`);
    };
    ctxAny.plugin?.({
        name: '@dsh-external/dsh-harness-pilot:api-route',
        inject: ['webServer'],
        apply: (ctx2) => {
            const holder = ctx2;
            const webServer = holder.get?.call(ctx2, 'webServer')
                ?? ctx2.webServer;
            if (webServer === undefined) {
                logger?.warn?.('harness-pilot: ctx.webServer resolved empty inside the api-route fiber — settings page will show an empty state');
                return;
            }
            mountApi(webServer, (fn, label) => holder.effect?.call(ctx2, fn, label));
        },
    });
    ctx.effect(() => () => {
        void registry.disposeAll();
        // 双保险（幂等）：`disposeAll()` 已 `poolBox?.dispose()` 并清掉空闲巡检计时器，
        // 这里再显式收一次，保证**即使**日后 `disposeAll()` 改了也不再漏计时器。
        processPool?.dispose();
        void tasks.shutdown();
        helper.dispose();
    }, '@dsh-external/dsh-harness-pilot: sessions + tasks + window helper');
    logger?.info?.(`harness-pilot: ${config.resolvedTargets.length} harness targets, default=${config.defaultTarget}; `
        + `pty=${spawnTerminal === undefined ? 'off' : 'on'}; api route + subagent providers mounted via deferred fibers`);
}
//# sourceMappingURL=index.js.map