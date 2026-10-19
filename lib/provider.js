/**
 * SubagentProvider：把每个 harness 注册成 DSH 的**具名子代理 provider**。
 *
 * 注册后，宿主标准的 subagent 工具（`tool-subagent` 配 `provider: harness-<名字>`）和
 * 本插件的 `harness_agent` 工具都能以「子代理」语义派发 —— 有 run id、有 stopReason、
 * 有 dispose 生命周期，符合 DSH 里其他外部 provider（claude-code / codex / acp）的形状。
 *
 * ── 2026-10-14 追加：**(target × account) 身份别名**（注册期注入）──────────────
 *
 * 目标：让「子代理任务用**指定账号**跑」这件事成立，而不是只能靠 `harness_task_start accountId=…`。
 *
 * 接线点为什么只能是**注册期**（三条都是本轮实测的契约原文，不是推断）：
 *   1. `SubagentStartRequest`（rc.2 `typert.host.js:779`）字段是
 *      `label / prompt / parent / signal / agentOptions / outputSchema / maxDepth / toolFilter / persona`
 *      —— **没有任何账号字段**；
 *   2. 唯一能夹带路由的 `AgentOptions`（`:243`）是
 *      `provider / model / reasoningEffort / maxTokens / subagentDepth` —— **同样没有账号字段**；
 *      而且本 provider 的能力广告是 `NO_START_CAPABILITIES`，宿主在 `start` **之前**就会拒掉
 *      per-child 选项（`agentOptions` 等），所以这条路连「塞进 agentOptions」都不可能。
 *   3. 于是 `start(request)` 里**只有 `request` 可用**，而 `request` 里没有账号 ——
 *      唯一的干净落点就是**注册那一刻**：为每个 (target × account) 组合注册一个 provider 名，
 *      把账号的启动配方（参数 + 环境变量）在**构造期**合并进该 provider 的目标。
 *
 * 三条纪律（用户明确要求，写进代码而不是只写进文档）：
 *   · **不静默改号/改 harness**：别名绑定的账号被停用或删除后，**新的**子代理任务
 *     **显式拒绝**（抛错、不创建 run、不执行任何 harness），并给出可读原因与恢复方式；
 *     绝不「换个账号凑一下」，也绝不回退到不带账号的同名 target。
 *   · **已创建任务的快照不变**：判活**只在** `start()` 那一刻做一次；判定通过后，这次 run
 *     用的是**注册期固化**的那份账号配方（`args`/`env` 已合并进不可变的目标对象）。
 *     之后账号被停用/删除/改名，都**不得**影响已经在跑或已经创建的任务。
 *   · **不输出原始 accountId**：provider.ts 产出的所有**文案**（拒绝原因、身份行、跳过说明）
 *     一律用 `redactAccount()` 的 `acct:…` 形式。唯一带档案 id 的地方是**别名 provider 名本身**
 *     —— 它是**选择器**（调用方必须能拼出来），与既有的 `harness_task_start accountId=…` 形参、
 *     以及既有「按账号目标」参数里的明文配置目录属于同一类**接口数据**。
 *
 * ⚠️ 仍未打通的一条（**如实说明，不伪造**）：**可继续 / 团队路径没有账号接线点**。
 *   宿主的 `ctx.subagents.startContinuable()` 要求 provider 实现 `prepareContinuable`
 *   （rc.2 `dsh-subagent/lib/index.js:3149-3152`：没有就抛
 *   `UNSUPPORTED_CAPABILITY "… does not support continuable children"`），而
 *   `ContinuableCreateRequest`（`typert.host.js:334`）只有 `sessionId / parent / signal`，
 *   `ContinuableStartSpec.request` 又是 `Omit<SubagentStartRequest, …>` —— 两处都没有账号字段。
 *   本 provider 是**一次性派发**的实现（没有 inbox / continuation 语义），因此这里**不**实现
 *   `prepareContinuable`：给团队路径伪造一个「看起来支持账号」的能力，比明说「不支持」更糟。
 */
import { NO_START_CAPABILITIES, settleRunResult, subprocessRunHandle, } from '@deepseek-ai/dsh-subagent';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAdapterIntegrity, checkManagedBootstrapGate, WORKBUDDY_ADAPTER_SHA256, } from './federation/accounts.js';
import { redactAccount, resolveAccountLaunch } from './federation/poolconfig.js';
// ⚠️ 只借一个常量（本插件路由名），不借行为：`llm-adapter.ts` 顶层只 import node 内置模块，
// 所以这里不会形成 `provider.ts ↔ llm-adapter.ts` 的循环（本文件被 index.ts 与 llm-adapter
// 的注册路径同时引用，重复一份字面量就会有两种事实）。
import { ROUTE } from './llm-adapter.js';
/**
 * 内部子代理 run 的停滞判定（毫秒）：超过这么久既无进度也无终态就标记 `stalled`。
 * 120s 是拍板值 —— 有些 harness 单轮确实会安静好几分钟，再长就失去预警意义。
 */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;
/** 从 ContentBlock[] 里取纯文本任务；带图/带文件的请求直接拒绝（外部 harness 收不到）。 */
function textTask(prompt) {
    if (prompt.length === 0)
        throw new Error('harness-pilot: the delegated task must contain text blocks');
    const texts = [];
    for (const block of prompt) {
        if (block.type !== 'text')
            throw new Error('harness-pilot: the delegated task must contain only text blocks');
        texts.push(block.text);
    }
    const joined = texts.join('');
    if (joined.trim().length === 0)
        throw new Error('harness-pilot: the delegated task must not be empty');
    return joined;
}
/** 父会话 workspace（Agent 结构随版本演进，这里按最小形状读取）。 */
function parentCwdOf(parent) {
    const session = parent.session;
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}
/**
 * 0.2.1-rc.1 起 dsh-subagent 移除了 `resolveChildCwd` 导出（原实现：配置 cwd 原样
 * 优先；否则取父会话 cwd 并校验绝对路径 + 可进入）。本插件改为自带同语义实现，
 * 不再依赖宿主内部 API 的导出面——宿主升 rc 时这一处不再连带炸掉整个插件。
 * 「可进入」用 existsSync + 目录探测的轻量校验，与宿主旧实现等价。
 */
function resolveChildCwd(prefix, configured, parentCwd) {
    if (configured !== undefined)
        return configured;
    if (parentCwd === undefined) {
        throw new Error(`${prefix}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`);
    }
    if (!win32.isAbsolute(parentCwd)) {
        throw new Error(`${prefix}: parent session cwd must be an absolute path: ${parentCwd}`);
    }
    if (!existsSync(parentCwd)) {
        throw new Error(`${prefix}: parent session cwd is not an accessible directory: ${parentCwd}`);
    }
    return parentCwd;
}
// ── 子代理可见面上的「真实身份」 ────────────────────────────────────────
// 用户在 rc.2 上要求：子代理 / 团队 / 执行卡片要看到**真实 Harness、脱敏账号、供应商、
// 模型、原生会话 id、执行状态**，而不是一个笼统的 `external` / `harness` 标签。
//
// 先把可写字段查清（本轮实测，非推断）：
//   · `SubagentProvider` 只有 `name` / `capabilities` / `inheritsParentContext` /
//     `agentRouteDefaults` / `start()`（宿主 `subagents` 服务的服务契约原文）；
//   · 结果侧只有 `SubagentResult.output` / `structured` / `diagnostic` / `stopReason`；
//     其中 `diagnostic` 上限 4096 字节（`limitSubagentDiagnostic`），失败时会被渲染成
//     `Diagnostic: …`（宿主 subagent 工具 / 作业详情），**成功时宿主不渲染它**；
//   · 子代 session 的 `label` 由调用方（`args.description`）写、descriptor 由宿主写，
//     **插件写不到**；`TeamMemberView` 是 `.strict()` 闭集（id/name/description/provider/
//     context/phase/error），插件能写的只有 `provider`（＝我们注册的 provider 名）。
// 结论：身份必须落在 **provider 名 + diagnostic + 本插件自己的执行账本** 这三处。
// 因此这里**无条件**产出身份行 —— 成功路径上它是 `harness_agent` 唯一能显示身份的出口。
//
// 两条纪律与 task-tools.ts 相同：**绝不打印原始 accountId**（过 `redactAccount`）；
// 字段缺失写「未回报」，不折叠成「没有」或「一致」。
/** 一个账号 id 的脱敏形式（复用账号池同一套 `redactAccount`；空/未给返回 undefined）。 */
function redactAccountId(accountId) {
    if (accountId === undefined)
        return undefined;
    const trimmed = accountId.trim();
    return trimmed.length === 0 ? undefined : redactAccount(trimmed);
}
// ── (target × account) 身份别名 ───────────────────────────────────────
/** 别名 provider 名的固定前缀：`harness-<target>-acct-`。 */
function aliasPrefixOf(targetName) {
    return `harness-${targetName}-acct-`;
}
/**
 * 别名 provider 名（**选择器**）：`harness-<target>-acct-<档案 id>`。
 *
 * 档案 id 的字符集由 `accounts.ts` 的 `ACCOUNT_ID_RE` 限制为 `a-z0-9._-`，
 * 所以这个名字一定是安全的 provider 名（不含空格/路径分隔符/大写歧义）。
 */
export function accountAliasNameFor(target, accountId) {
    return `${aliasPrefixOf(target.name)}${accountId}`;
}
/**
 * 同一个别名的**脱敏写法**（`harness-<target>-acct-‹acct:…›`）：**所有文案**都用它，
 * 这样 provider.ts 的输出里永远不会出现原生档案 id。
 */
export function redactedAccountAliasName(target, accountId) {
    return `${aliasPrefixOf(target.name)}‹${redactAccount(accountId)}›`;
}
/**
 * 把一串 provider 名渲染成**脱敏**形式：别名名结尾的档案 id 换成 `acct:…`，其余原样。
 *
 * 用途：注册日志与界面文案。别名名本身是**选择器**（调用方要能拼出来，所以含档案 id 是接口事实），
 * 但日志属于**输出** —— 本项目的纪律是输出里不出现原始 id。给 `accountIds` 传当前生效档案 id 即可。
 */
export function redactProviderNames(names, accountIds) {
    const ordered = [...accountIds].filter((id) => id.length > 0).sort((a, b) => b.length - a.length);
    return names.map((name) => {
        for (const id of ordered) {
            const suffix = `-acct-${id}`;
            if (name.endsWith(suffix))
                return `${name.slice(0, name.length - suffix.length)}-acct-‹${redactAccount(id)}›`;
        }
        return name;
    });
}
/**
 * **惰性**拿到 `src/account-target.ts` 的合并实现（普通账号别名用），失败返回 `undefined`。
 *
 * 为什么是惰性 import：`account-target.ts` 需要本模块的 `planAccountAliases()` /
 * `packagedManagedAdapterPath()` / `managedBootstrapRuntimeGate()`；本模块若在**顶部**
 * 静态 import 它，就形成 `provider.ts ↔ account-target.ts` 静态循环（ESM 顺序敏感，
 * 失败方式与「改动没生效」长得一样）。惰性解析在**第一次真的要合并时**才发生，
 * 那时两个模块都已求值完毕。解析失败 ⇒ 返回 `undefined` ⇒ 调用方**如实跳过**这个别名
 * （绝不退回自己拼一份合并规则）。
 */
function mergeAccountByPolicyLazy() {
    try {
        // 本包是 ESM（`"type": "module"`）⇒ 没有全局 `require`；用 `createRequire` 建一个，
        // 目标就是本模块自己的 URL（同一份构建产物目录）。
        const requireHere = createRequire(import.meta.url);
        const mod = requireHere('./account-target.js');
        if (typeof mod.mergeAccountByPolicy !== 'function')
            return undefined;
        return (target, accountId, seeds) => {
            const seed = seeds.find((entry) => entry.id === accountId);
            if (seed === undefined)
                return { ok: false, reason: '未知账号档案' };
            const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
            const launch = resolveAccountLaunch(accountId, home, seeds);
            if (!launch.ok)
                return { ok: false, reason: launch.reason };
            return mod.mergeAccountByPolicy({
                target,
                seed,
                launch: { args: launch.args, env: launch.env, configDir: launch.configDir },
                seeds,
                homeDir: home,
            });
        };
    }
    catch {
        return undefined;
    }
}
/**
 * 判定一个别名绑定的账号**现在**能不能用于新任务。**纯函数**（只读入参），便于离线验收。
 *
 * 三态分明：
 *   · 账号在 `accounts()` 里、也没有额外拒绝原因 → `undefined`（可用）；
 *   · 账号**不在** `accounts()` 里 → 「已停用或删除」（内置 delete = 墓碑，新增 delete = 移出）；
 *   · 账号在，但 `refusalFor` 给了原因 → 原样带出该原因。
 */
export function accountAliasRefusal(target, accountId, options) {
    const label = redactAccountId(accountId) ?? 'acct:***';
    const redactedName = redactedAccountAliasName(target, accountId);
    const extra = options.refusalFor?.(accountId);
    const present = options.accounts().some((seed) => seed.id === accountId);
    if (present && extra === undefined)
        return undefined;
    const reason = present
        ? `该账号现在不能用于新任务：${extra ?? '(未说明原因)'}`
        : '该账号档案已被**停用或删除**（不在当前生效的账号档案里）';
    return `harness-pilot: 子代理 provider「${redactedName}」绑定的账号 ${label} 不可用于**新任务**：${reason}。`
        + '\n本次是**显式拒绝**：没有创建子代理 run，也没有执行任何 harness。'
        + `\n· 不会改用其它账号，也不会回退到不带账号的「harness-${target.name}」—— 那等于换一个身份执行；`
        + '要那样做必须由调用方**显式**改用那个名字。'
        + '\n· 恢复方式：在「账号档案」里恢复该档案（内置档案被删除＝停用，可用 restore 恢复；'
        + '新增档案被删除后需要重新 create），之后的新任务即可再次使用该别名。'
        + '\n· **已创建/正在跑的任务不受影响**：它们用的是创建时固化的那份账号配方。';
}
/**
 * 该目标的参数/环境里**是否已经写着**这个档案的配置目录。
 *
 * 存在这种目标（例如 P7 的 `qoder-cn-acct-a`：`args` 里明文写着
 * `--config-dir …\harness-accounts\qoder-cn-a`）。对它们再叠一层账号参数会**重复注入**，
 * 而重复的 `--config-dir` 谁生效取决于 CLI —— 那就是「看起来换了账号、其实没有」。
 * 所以这里**跳过**并说明原因，而不是硬叠（宁可没有别名，也不要一个指错账号的名字）。
 */
function targetAlreadyCarriesConfigDir(target, configDir) {
    if (configDir.length === 0)
        return false;
    const needle = configDir.toLowerCase();
    return target.args.some((arg) => arg.toLowerCase().includes(needle))
        || Object.values(target.env).some((value) => value.toLowerCase().includes(needle));
}
/** Explicit, audited managed recipes; never pair by harness alone. */
const MANAGED_ALIAS_RECIPES = [
    // ⚠️ `seedTarget` 必须与档案的 `targetName` **逐字一致**（`managedAccountAliasRefusal()` 会核对），
    // 且两者都必须是**目标表里的真实目标名**：`wb-managed-a` / `wb-managed-ai-b`。
    // 此前档案写的是账号 id（`workbuddy-a`），配对靠这里的旧值「互相顶住」才没报错，
    // 但账号 CRUD 与 `seedForTarget(真实目标名)` 全都查不到（实测缺陷，2026-10-14 修）。
    { id: 'workbuddy-a', harnessId: 'workbuddy', seedTarget: 'wb-managed-a', target: 'wb-managed-a' },
    { id: 'workbuddy-ai-b', harnessId: 'workbuddy-ai', seedTarget: 'wb-managed-ai-b', target: 'wb-managed-ai-b' },
];
function sameAbsoluteWindowsPath(left, right) {
    return typeof left === 'string' && typeof right === 'string'
        && win32.isAbsolute(left) && win32.isAbsolute(right)
        && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}
/** Recipe validation only; runtime version/hash/auth evidence cannot be inferred from this check. */
export function managedAccountAliasRefusal(target, seed, home) {
    const recipe = MANAGED_ALIAS_RECIPES.find((entry) => entry.id === seed.id);
    const bootstrap = seed.launch.bootstrap;
    const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'workbuddy-managed.cjs');
    const actualHome = process.env.USERPROFILE ?? '';
    const expectedConfig = win32.join(actualHome, '.dsh', 'harness-accounts', seed.id);
    if (!sameAbsoluteWindowsPath(home, actualHome)
        || (target.env.USERPROFILE !== undefined && !sameAbsoluteWindowsPath(target.env.USERPROFILE, actualHome)))
        return '受管用户目录不匹配';
    if (recipe === undefined || seed.harnessId !== recipe.harnessId
        || seed.targetName !== recipe.seedTarget || target.name !== recipe.target)
        return '受管账号与目标配对不匹配';
    if (seed.launch.mode !== 'managed-bootstrap' || bootstrap?.adapterId !== seed.id)
        return '受管 bootstrap 身份配方不匹配';
    if (!sameAbsoluteWindowsPath(bootstrap.vendorExecutable, target.command))
        return '受管厂商可执行文件不匹配';
    if (!sameAbsoluteWindowsPath(seed.configDir, expectedConfig))
        return '受管账号配置目录不匹配';
    if (bootstrap.requiresVendorVersionPrefix !== '2.156.0')
        return '受管版本配方未经验收';
    if (target.env.ELECTRON_RUN_AS_NODE !== '1' || seed.launch.env.ELECTRON_RUN_AS_NODE !== '1')
        return '受管 Node 环境不匹配';
    if (target.args.length !== 3 || !sameAbsoluteWindowsPath(target.args[0] ?? '', wrapper)
        || target.args[1] !== seed.id || target.args[2] !== '-p')
        return '受管 headless 参数配方不匹配';
    if (target.acpArgs.length !== 3 || !sameAbsoluteWindowsPath(target.acpArgs[0] ?? '', wrapper)
        || target.acpArgs[1] !== seed.id || target.acpArgs[2] !== '--acp')
        return '受管 ACP 参数配方不匹配';
    return undefined;
}
// ══════════════════ 受管 bootstrap 的**执行前**门禁（真实测量）══════════════════
//
// ⚠️ 这一段为什么必须存在（本轮集成补的缺口，不是重复劳动）：
// `federation/accounts.ts` 里的 `checkManagedBootstrapGate()` 与 `checkAdapterIntegrity()`
// 此前是**死代码**（全仓 0 调用点）。于是「配方里写着 2.156.0」只等于**注册期的一次字符串比对**，
// 它证明不了两件真正要紧的事：
//   ① 本机现在跑的那个厂商 CLI **实测**版本仍以已验收前缀开头（厂商升级后内部协议可能已变）；
//   ② 随包适配器仍是**验收过的那一份**（sha256 可比对，改一个字节就该被发现）。
// 受管 bootstrap 依赖厂商**内部**发布模块与一次性命名管道协议，一旦对不上，失败方式极可能是
// 「悄悄跑起来但身份/凭据链路不对」—— 那比直接拒绝更糟。所以门禁放在**派发之前**，且真去测量。
//
// 位置纪律：本函数只被 `HarnessProvider.start()` 调用，且调用点在**任何副作用之前**
// （还没建 AbortController、还没登记账本、还没 spawn）；不通过 ⇒ 抛错 ⇒ 宿主这边连 run 都没有。
/** 随包受管适配器的绝对路径（与 `managedAccountAliasRefusal` 校验的是**同一个**文件）。 */
export function packagedManagedAdapterPath() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'workbuddy-managed.cjs');
}
/**
 * 厂商 CLI 的 headless 入口：从**已配方校验**的 `vendorExecutable` 推导，不另写一份机器路径。
 * 实测该入口就是 `docs/verified/harness-probe.json` 记录的那一个（`--version` 短路返回 `2.156.0`）。
 */
export function managedVendorCliEntry(seed) {
    const executable = seed.launch.bootstrap?.vendorExecutable;
    if (typeof executable !== 'string' || executable.length === 0)
        return undefined;
    return win32.join(win32.dirname(executable), 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-headless.js');
}
/**
 * 版本探测**只**继承这些环境变量（外加 `ELECTRON_RUN_AS_NODE=1`）。
 *
 * 为什么用白名单而不是 `{...process.env}`：这是**只读版本探测**，不需要任何厂商凭据类变量；
 * 白名单让「一次探测」不携带身份上下文，也避免把宿主环境里的东西顺手交给厂商进程。
 * 实测（2026-10-14）：白名单下 exit 0、stdout 恰好 `2.156.0`、stderr 空。
 */
function versionProbeEnv() {
    const keep = [
        'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATH', 'USERPROFILE', 'PATHEXT', 'COMSPEC',
        'NUMBER_OF_PROCESSORS', 'OS', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
        'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH',
    ];
    const env = { ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', TERM: 'dumb' };
    for (const key of keep) {
        const value = process.env[key];
        if (typeof value === 'string' && value.length > 0)
            env[key] = value;
    }
    return env;
}
/**
 * **真实测量**厂商 CLI 版本：`ELECTRON_RUN_AS_NODE=1 <厂商 exe> <随包 codebuddy-headless.js> --version`。
 *
 * 为什么用厂商 exe 而不是另找一个 `node.exe`：`(command, ELECTRON_RUN_AS_NODE=1)` 这一对
 * **就是配方里已经校验过的那一对**（`seed.launch.command` / `seed.launch.env`）；
 * 再引入第二个解释器路径等于又造一份「本机路径知识」，换机器/升级就会失效。
 * 只读、零额度、不碰账号配置目录、不读任何凭据文件。
 */
export async function measureManagedVendorVersion(seed, timeoutMs = 30_000) {
    const executable = seed.launch.bootstrap?.vendorExecutable;
    const entry = managedVendorCliEntry(seed);
    if (typeof executable !== 'string' || executable.length === 0 || entry === undefined) {
        return { version: undefined, exitCode: null, argv: [], detail: '受管配方未声明厂商可执行文件，无法测量版本' };
    }
    if (!existsSync(executable)) {
        return { version: undefined, exitCode: null, argv: [executable, entry, '--version'], detail: `厂商可执行文件不存在：${executable}` };
    }
    if (!existsSync(entry)) {
        return { version: undefined, exitCode: null, argv: [executable, entry, '--version'], detail: `厂商 CLI 入口不存在：${entry}` };
    }
    const argv = [executable, entry, '--version'];
    const { execFile } = await import('node:child_process');
    return await new Promise((settle) => {
        execFile(executable, [entry, '--version'], {
            timeout: timeoutMs, windowsHide: true, maxBuffer: 64 << 10, env: versionProbeEnv(),
        }, (error, stdout, stderr) => {
            const code = error === null || error === undefined
                ? 0
                : (typeof error.code === 'number' ? error.code : null);
            const match = /(\d+\.\d+\.\d+)/.exec(`${stdout ?? ''}`);
            if (match !== null) {
                settle({ version: match[1], exitCode: code, argv, detail: `--version 实测输出取到 ${match[1]}（exit=${String(code)}）` });
                return;
            }
            const tail = `${stderr ?? ''}`.trim().replace(/\s+/g, ' ').slice(0, 240);
            settle({
                version: undefined,
                exitCode: code,
                argv,
                detail: `未能从 --version 输出取到版本号（exit=${String(code)}${tail.length === 0 ? '' : `，stderr=${tail}`}）`,
            });
        });
    });
}
/**
 * **执行前**门禁：哈希 + 实测版本，两条都过才放行。返回 `undefined` = 放行，字符串 = 拒绝原因。
 *
 * `seed.launch.mode !== 'managed-bootstrap'` 时**不做**任何测量（普通账号没有这套协议依赖，
 * 给它加门禁只会制造无理由的失败）—— 这一点是显式的，不是「测不到就跳过」。
 */
export async function managedBootstrapRuntimeGate(seed, targetName) {
    if (seed.launch.mode !== 'managed-bootstrap')
        return undefined;
    const label = redactAccount(seed.id) ?? 'acct:***';
    const adapter = packagedManagedAdapterPath();
    // ── ① 适配器指纹（可校验实体，不是声明）──
    let actualSha256;
    try {
        actualSha256 = createHash('sha256').update(readFileSync(adapter)).digest('hex');
    }
    catch {
        actualSha256 = undefined;
    }
    const integrity = checkAdapterIntegrity(actualSha256);
    if (!integrity.ok) {
        return `harness-pilot: 受管 bootstrap 的**执行前门禁未通过**（随包适配器指纹），账号 ${label}、目标 ${targetName}。`
            + `\n· 期望 sha256=${WORKBUDDY_ADAPTER_SHA256}`
            + `\n· 实测        ${actualSha256 ?? '(读不到该文件)'}`
            + `\n· 文件        ${adapter}`
            + `\n· 原因        ${integrity.reason ?? '(未说明)'}`
            + '\n本次是**显式拒绝**：没有创建子代理 run，也没有执行任何 harness。'
            + '\n· 受管 bootstrap 依赖厂商内部协议，随包适配器一旦被改动（或被厂商升级挤掉）就必须重新验收；'
            + '\n  这里**不会**降级成「不带适配器直接跑」—— 那等于绕开凭据保护链路。';
    }
    // ── ② 厂商 CLI **实测**版本（不是配方字符串）──
    const probe = await measureManagedVendorVersion(seed);
    const gate = checkManagedBootstrapGate(seed, probe.version);
    if (!gate.ok) {
        return `harness-pilot: 受管 bootstrap 的**执行前门禁未通过**（厂商 CLI 实测版本），账号 ${label}、目标 ${targetName}。`
            + `\n· 期望前缀  ${gate.requiredPrefix}`
            + `\n· 实测      ${gate.observed ?? '(未测到版本)'}`
            + `\n· 测量方式  ELECTRON_RUN_AS_NODE=1 ${probe.argv.join(' ')}`
            + `\n· 测量详情  ${probe.detail}`
            + `\n· 原因      ${gate.reason ?? '(未说明)'}`
            + '\n本次是**显式拒绝**：没有创建子代理 run，也没有执行任何 harness。'
            + '\n· 「不知道版本」不等于「版本兼容」，所以测不到版本时同样不放行（fail closed）。'
            + '\n· 恢复方式：把厂商 CLI 装回已验收版本，或对升级后的版本重新做一次验收后更新配方。';
    }
    return undefined;
}
/** Ordinary accounts use exact target names; managed accounts reuse only validated, baked recipes. */
export function planAccountAliases(targets, options, 
/**
 * 「账号 → 目标」的合并实现（**依赖注入**，不是可选装饰）。
 *
 * 值来自 `src/account-target.ts` 的 `withAccountTarget()` —— 「账号 → 目标」的**唯一**实现。
 * 这里刻意用**注入**而不是 `import`：`account-target.ts` 需要本模块的
 * `planAccountAliases()` / `packagedManagedAdapterPath()`，若本模块反过来 import 它，
 * 就形成 `provider.ts ↔ account-target.ts` **循环**。依赖注入把这个回路切断，
 * 两侧的 import 图因此都是单向的（核对见 `account-target.ts` 文件头）。
 *
 * 缺省时（探针/单测直接调本函数）退回 `options.withAccount`；两者都没有 ⇒
 * 普通账号**如实跳过**并说明，绝不自己再拼一份合并规则。
 */
injectedMerge) {
    const seeds = options.accounts();
    const home = options.homeDir ?? (process.env.USERPROFILE ?? process.env.HOME ?? '');
    const nameOf = options.aliasName ?? accountAliasNameFor;
    const aliases = [];
    const skipped = [];
    const taken = new Set();
    const paired = new Set();
    /**
     * 跳过一条别名：本地收集 + **同时**回调 `onSkip`。
     *
     * 这里是 `onSkip` 的**唯一**触发点（`registerProviders` 不再重复回调）：调用方直接调
     * `planAccountAliases()` 时也能拿到同一条说明，不会出现「注册路径有说明、规划路径没有」。
     */
    const skip = (note) => {
        skipped.push(note);
        options.onSkip?.(note);
    };
    for (const target of targets) {
        for (const seed of seeds) {
            const managedRecipe = MANAGED_ALIAS_RECIPES.find((entry) => entry.id === seed.id);
            const managed = managedRecipe !== undefined || seed.launch.mode === 'managed-bootstrap';
            if (managed ? target.name !== (managedRecipe?.target ?? seed.targetName) : seed.targetName !== target.name)
                continue;
            paired.add(seed.id);
            const label = redactAccountId(seed.id) ?? 'acct:***';
            const name = nameOf(target, seed.id);
            if (taken.has(name)) {
                // ⚠️ 说明里的名字也要**脱敏**：provider.ts 的任何文案都不得带原始档案 id。
                skip(`别名 ${redactedAccountAliasName(target, seed.id)} 在同一批规划里重名，已跳过`);
                continue;
            }
            taken.add(name);
            if (managed) {
                const refusal = managedAccountAliasRefusal(target, seed, home);
                if (refusal !== undefined) {
                    skip(`账号 ${label} 未给目标 ${target.name} 建别名：${refusal}`);
                    continue;
                }
                aliases.push({
                    name,
                    target: { ...target, args: [...target.args], acpArgs: [...target.acpArgs], env: { ...target.env, ...(seed.launch.env.DSH_WORKBUDDY_FROZEN_HOME ? { DSH_WORKBUDDY_FROZEN_HOME: seed.launch.env.DSH_WORKBUDDY_FROZEN_HOME } : {}) } },
                    binding: {
                        accountId: seed.id, label, providerName: name,
                        redactedName: redactedAccountAliasName(target, seed.id),
                        refusalOfNewTask: () => accountAliasRefusal(target, seed.id, options),
                        // 受管账号额外挂**执行前**门禁：注册期的 `managedAccountAliasRefusal` 只核配方文本，
                        // 这里核的是**这台机器此刻的真实前提**（随包适配器指纹 + 厂商 CLI 实测版本）。
                        runtimeGate: () => managedBootstrapRuntimeGate(seed, target.name),
                    },
                });
                continue;
            }
            const launch = resolveAccountLaunch(seed.id, home, seeds);
            if (!launch.ok) {
                skip(`账号 ${label} 的启动配方解析失败（${launch.reason}），未给目标 ${target.name} 建别名`);
                continue;
            }
            if (targetAlreadyCarriesConfigDir(target, launch.configDir)) {
                skip(`目标 ${target.name} 的参数/环境里已经写着账号 ${label} 的配置目录：`
                    + '账号已固化在目标里，再叠一层会重复注入（可能让 CLI 用错账号），故不给它建别名');
                continue;
            }
            // ⚠️ **不再自己拼一份** `args` / `env` 合并：合并**整份**来自
            // `src/account-target.ts` 的 `mergeAccountByPolicy()`（它内部调
            // `mergePlainAccountInto()` —— 与 `withAccountTarget()` 第 ④ 分支**同一个函数**），
            // 于是「别名注册期的合并」与「派发期的合并」不可能再漂移。
            //
            // 依赖方向说明（为什么走**惰性 import** 而不是顶部静态 import）：
            // `account-target.ts` 需要本模块的 `planAccountAliases()` / `packagedManagedAdapterPath()`
            // / `managedBootstrapRuntimeGate()`，所以本模块**不能**在顶部 import 它 ——
            // 那会形成 `provider.ts ↔ account-target.ts` 静态循环（ESM 下顺序敏感）。
            // 惰性解析把顺序问题彻底消掉，且失败时**显式跳过**（绝不退回自己拼一份）。
            const merge = injectedMerge ?? options.withAccount ?? mergeAccountByPolicyLazy();
            if (merge === undefined) {
                skip(`账号 ${label} 未给目标 ${target.name} 建别名：本次规划没有注入「账号 → 目标」的唯一合并实现`
                    + '（`src/account-target.ts`），本模块不自己再拼一份，避免两套语义漂移');
                continue;
            }
            const applied = merge(target, seed.id, seeds);
            if (!applied.ok) {
                skip(`账号 ${label} 未给目标 ${target.name} 建别名：${applied.reason}`);
                continue;
            }
            aliases.push({
                name,
                // 合并**整份**来自那一处（账号参数前置、账号环境变量覆盖目标自身；
                // 受管账号与「目标已硬绑定同一账号」两种情形在那里统一走整份复用）。
                target: applied.target,
                binding: {
                    accountId: seed.id,
                    label,
                    providerName: name,
                    redactedName: redactedAccountAliasName(target, seed.id),
                    refusalOfNewTask: () => accountAliasRefusal(target, seed.id, options),
                },
            });
        }
    }
    // Unmatched accounts are reported explicitly; managed accounts require the audited tuple above.
    for (const seed of seeds) {
        if (paired.has(seed.id))
            continue;
        const label = redactAccountId(seed.id) ?? 'acct:***';
        skip(seed.targetName.length === 0
            ? `账号 ${label} 没有声明 targetName ⇒ 无法确定它该跑在哪个目标上，不建别名`
            : `账号 ${label} 声明的 targetName 未匹配本 profile 中可验证的目标 ⇒ 不建别名`
                + '（该账号的启动配方可能是给某个已把账号写进参数的目标用的，硬叠会重复注入）');
    }
    return { aliases, skipped };
}
/**
 * 一次 run 的真实身份行。
 *
 * `outcome` 缺失 = 派发还没回报身份（例如抛错路径）：此时**如实写未回报**，
 * 并把原因带出来，而不是省略这一行 —— 省略会让人以为「这次没有身份这回事」。
 *
 * `ledgerId` = 这次 run 在**本插件账本**里的 id（＝子代理 run id），
 * 身份行里带上它，子代理页面/作业详情就能指向完整执行记录。
 *
 * `alias` = 这次 run 走的是 **(target × account) 别名**（注册期注入）。带上它，身份行才会
 * 说明「账号是从哪来的」，而不是留下与不带账号路径相同的那句「不接受账号参数」。
 */
export function subagentIdentityNote(target, outcome, ledgerId, alias) {
    const actual = outcome?.identity;
    const transport = actual?.transport ?? outcome?.transport;
    const account = redactAccountId(actual?.accountId);
    const nativeSession = actual?.nativeSessionId === undefined
        ? '(未回报：本通道未提取原生会话 id —— 是「还没打通」，不是「该 Harness 没有会话」)'
        : actual.nativeSessionId;
    const accountField = alias === undefined
        // 不带账号的 provider 路径**没有**账号入口（`SubagentStartRequest` 无账号字段，宿主对
        // `agentOptions=false` 的 provider 会在 start 之前拒掉 per-child 选项），所以这里如实写
        // 「未套用账号档案」+ 替代路径，而不是留空让人猜。
        ? `account=${account ?? 'none（provider 路径不接受账号参数；按账号跑请用带账号的 provider 别名，或 harness_task_start accountId=…）'}`
        : account === undefined
            // 有别名但通道没回报 accountId：**不得**把请求值当成已核实。
            ? `account=${alias.label}(请求值；实际身份未回报 —— 不得据此判定一致)`
            : `account=${account}${account === alias.label ? '' : `(⚠️ 与别名绑定的 ${alias.label} 不一致)`}`;
    const aliasClause = alias === undefined
        ? ''
        : ` alias=${alias.redactedName}（该名字在**注册期**就把账号烘进了 provider）`;
    const head = 'identity: '
        + `harness=${actual?.harnessId ?? target.name}`
        + ` ${accountField}`
        + aliasClause
        + ` provider=${actual?.provider ?? '(原生执行未回报，无法确认实际供应商)'}`
        + ` model=${actual?.model ?? '(原生执行未回报，无法确认实际模型)'}`
        + ` nativeSessionId=${nativeSession}`
        + ` transport=${transport ?? '(未回报)'}`;
    // 账号绑定的作用范围必须写清：`actual.accountId` 是**请求身份的原样带出**（见 sessions.ts 的
    // `foldOutcomeIdentity`：它直接取 `spec.identity.accountId`），通道**无法**独立核验账号。
    // 独立证据只能来自子进程实际收到的 argv/env（probe/verify-subagent-account-alias.mjs 实测）。
    const bindingNote = alias === undefined
        ? ''
        : `\naccountBinding: provider 名「${alias.redactedName}」在注册期已把账号 ${alias.label} 的启动配方`
            + '（参数 + 环境变量）合并进目标；`start()` 依旧**没有**账号入口，账号来自名字本身。'
            + 'actual.accountId 是请求身份的原样带出，**不是**通道的独立核验 —— '
            + '独立证据是子进程实际收到的 argv/env（probe/verify-subagent-account-alias.mjs）。';
    const ledger = ledgerId === undefined
        ? ''
        : `\nledger: harness_task_status task_id=${ledgerId}（完整执行记录：真实 Harness / 脱敏账号 / 供应商 / 模型 / 原生会话 id / 状态）`;
    const mismatch = [...(outcome?.mismatch ?? [])];
    // 别名路径的额外判据：请求账号与实际回报的账号不一致 → 必须显式报出来（不得算成功）。
    if (alias !== undefined && actual?.accountId !== undefined && actual.accountId !== alias.accountId) {
        const shown = redactAccountId(actual.accountId) ?? '(未回报)';
        mismatch.push(`别名绑定账号 ${alias.label}，但实际回报的账号是 ${shown}`);
    }
    if (outcome === undefined) {
        return `${head}${bindingNote}${ledger}\n⚠️ 本次派发**没有回报实际身份**（run 在回报身份之前就结束了）—— 不得据此判定身份与请求一致。`;
    }
    return mismatch.length === 0
        ? `${head}${bindingNote}${ledger}`
        : `${head}${bindingNote}${ledger}\n⚠️ mismatch（请求值 ≠ 实际值，不得当作成功）：${mismatch.join('；')}`;
}
// ── per-child 选项（`agentOptions`）：本 provider 能兑现什么，兑现不了就拒绝 ──────
//
// 宿主契约（0.2.0-rc.2，逐条核对过行号，不是推断）：
//   · `SubagentStartRequest.agentOptions?: AgentOptions`，字段是
//     `{provider?, model?, reasoningEffort?, maxTokens?, subagentDepth?}`
//     （`dsh-subagent/lib/typert.host.js:242`、`:778`；`ResolvedSubagentStartRequest` 只是加壳）；
//   · `subagents.start()` 只做「请求里 `agentOptions` 有值 ⇒ `capabilities.agentOptions` 必须为真」
//     这一道 gate（`dsh-subagent/lib/types/index.js:457-470`，抛 `UNSUPPORTED_CAPABILITY`），
//     **没有任何字段级校验** —— 字段级后果由 provider 自己承担；
//   · 因此「声明了能力就必须真的兑现」：接受之后忽略，就是宿主注释里明说的
//     never accepted-then-ignored 反例。
//
// 本 provider **只能**兑现 `model`（落到目标自己的 `modelArgs`；实测 qoder 目标是 `-m {model}`）。
// 其余字段一律**显式拒绝**（抛错 ⇒ 连 run 都不创建）：DSH 的 reasoning 档位与 maxTokens
// 不是外部 CLI 的概念，替它编一个映射比拒绝更糟。
// `subagentDepth` 是宿主自己的递归记账（`dsh-subagent/lib/types/child-agent.js:33` 校验），
// 不是调用方的业务意图，故**接收但不解释**。
/** 本 provider 接受的子代理 LLM 路由名 = 本插件自己的路由（`pilot-cli`，唯一来源见 `llm-adapter.ts`）。 */
const CHILD_ROUTE = ROUTE;
/**
 * 把宿主的 per-child `agentOptions` 折成**本 provider 真正能兑现的那一部分**（纯函数，可离线固化）。
 *
 * 兑现规则：
 *   · `provider`：只接受本插件路由（`pilot-cli`）或未给。给了宿主供应商，说明调用方想让它
 *     跑在 DSH 自己的模型上 —— 那不该经由「外部 harness 的子代理 provider」，显式拒绝。
 *   · `model`：接受裸模型名，也接受 `目标名::模型` 组合；组合的前缀必须是**本 provider 的目标**，
 *     否则就是「点了另一个 harness，却想用这个 provider 跑」—— 拒绝，绝不悄悄换。
 *   · `target.modelArgs` 为空时**拒绝**：没有任何机制能把模型落到命令行，
 *     接受等于静默丢弃（旧行为），那是本项目明确禁止的一类不实。
 *   · `reasoningEffort` / `maxTokens`：拒绝（理由见上）。
 *   · `subagentDepth`：接收不解释（宿主记账）。
 */
export function childAgentOptionsDecision(target, raw) {
    if (raw === undefined || raw === null)
        return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { refusal: `harness-pilot: 子代理 provider「harness-${target.name}」收到的 agentOptions 形状不对（需要对象）。本次是**显式拒绝**：没有创建子代理 run。` };
    }
    const record = raw;
    const refuse = (detail) => ({
        refusal: `harness-pilot: 子代理 provider「harness-${target.name}」不能兑现本次子代理选项：${detail}`
            + '\n本次是**显式拒绝**：没有创建子代理 run，也没有执行任何 harness（要么按本 provider 能兑现的方式重发，要么换一条真正支持它的通道）。',
    });
    const provider = record.provider;
    if (provider !== undefined && provider !== null) {
        if (typeof provider !== 'string' || provider.trim().length === 0)
            return refuse('provider 必须是非空字符串');
        if (provider.trim() !== CHILD_ROUTE) {
            return refuse(`子代理的 LLM 路由请求是「${provider.trim()}」，但本 provider 是外部 harness 的执行通道，`
                + `只能承载自己的路由「${CHILD_ROUTE}」（每一轮由外部 CLI 产生）。`
                + `\n· 想用宿主供应商跑子代理：用**不带** harness provider 的标准 subagent 工具，或省略 provider；`
                + `\n· 想换一台外部 harness：换目标（provider 名里的目标在注册期就固定了）。`);
        }
    }
    for (const [key, label] of [['reasoningEffort', '推理档位'], ['maxTokens', '输出上限']]) {
        const value = record[key];
        if (value !== undefined && value !== null) {
            return refuse(`${label}（\`${key}\`）兑现不了 —— 它不是外部 CLI 的概念，本插件**不替它声称**一个映射。`
                + `\n· 该 CLI 自己的档位请在目标配置（或它的 config 文件）里固化，而不是按轮传。`);
        }
    }
    const rawModel = record.model;
    if (rawModel === undefined || rawModel === null)
        return {};
    if (typeof rawModel !== 'string' || rawModel.trim().length === 0)
        return refuse('model 必须是非空字符串');
    const trimmed = rawModel.trim();
    const separator = trimmed.indexOf('::');
    const head = separator < 0 ? '' : trimmed.slice(0, separator).trim();
    const chosen = separator < 0 ? trimmed : trimmed.slice(separator + 2).trim();
    if (head.length > 0 && head !== target.name) {
        return refuse(`模型「${trimmed}」属于另一个目标「${head}」，而本 provider 固定在目标「${target.name}」`
            + '（provider 名与目标在注册期绑定，承载不了「本次换成别的 harness」）。');
    }
    if (chosen.length === 0)
        return refuse(`模型「${trimmed}」里没有模型名（形如「目标名::模型名」）`);
    if (target.modelArgs.length === 0) {
        return refuse(`目标「${target.name}」没有声明 \`modelArgs\`，没有任何机制能把模型「${chosen}」落到它的命令行。`
            + '\n· 接受但不注入 = 静默丢弃（本插件禁止这一类不实）⇒ 这里改成拒绝。');
    }
    return { model: chosen };
}
/**
 * 本插件注册的每个 harness provider 的**能力广告**（唯一一份，导出以便离线探针直接断言）。
 *
 * 只把 `agentOptions` 打开，其余照抄 `NO_START_CAPABILITIES` 的 false：
 *   · `outputSchema` / `depthLimit` / `toolFilter` / `persona` 我们**兑现不了** ——
 *     外部 CLI 的产出是纯文本，没有结构化输出、也不受 DSH 的递归预算/工具过滤/人格约束；
 *     开着它们等于对宿主撒谎（宿主会照信，然后在需要时拿到一个兑现不了的承诺）。
 *   · `agentOptions` 打开的唯一理由：**真的**能兑现 per-child 的 `model`
 *     （`childAgentOptionsDecision()` → `sessions.dispatch({model})` → 目标 `modelArgs`）。
 */
export const HARNESS_PROVIDER_CAPABILITIES = Object.freeze({
    ...NO_START_CAPABILITIES,
    agentOptions: true,
});
class HarnessProvider {
    name;
    target;
    sessions;
    tasks;
    stallTimeoutMs;
    alias;
    /**
     * 能力广告：**只把 `agentOptions` 打开**（见 `HARNESS_PROVIDER_CAPABILITIES` 的理由）。
     *
     * 为什么必须开：宿主 `subagents.start()` 在 `provider.start()` **之前**就按
     * 「请求里 `agentOptions` 有值 ⇒ `capabilities.agentOptions` 必须为真」gate 掉
     * （rc.2 `dsh-subagent/lib/types/index.js:457-470`，抛 `UNSUPPORTED_CAPABILITY`；
     * 打包同义 `lib/index.js:3176`/`:3196`），而 `dsh-tool-subagent` 挂载时还会对
     * `modelSelectionSettings` / `config.agentOptions` 的行**硬校验**同一个能力
     * （`dsh-tool-subagent/lib/index.js:376-386`）。不开这一项，外部 harness 就永远
     * 承载不了「本次换模型」，只能退化成「按目标配方写死的那个模型」。
     *
     * 开了就必须**真的兑现**：兑现范围与拒绝规则见 `childAgentOptionsDecision()`
     * （只兑现 `model`；`reasoningEffort` / `maxTokens` / 非本插件路由一律显式拒绝）。
     */
    capabilities = HARNESS_PROVIDER_CAPABILITIES;
    inheritsParentContext = false;
    constructor(name, target, sessions, tasks, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS, 
    /**
     * 账号别名绑定（`undefined` = 不带账号的普通 provider）。
     *
     * 目标对象 `target` 对别名而言**已经含账号配方**，且在注册期就构造完成 ——
     * 运行期没有任何一步会再去读账号配置，所以账号状态变化影响不到已创建的 run。
     */
    alias) {
        this.name = name;
        this.target = target;
        this.sessions = sessions;
        this.tasks = tasks;
        this.stallTimeoutMs = stallTimeoutMs;
        this.alias = alias;
    }
    async start(request) {
        // ── 账号别名的**新任务**准入 ──
        // 位置纪律：判活在**创建**这一刻做且只做一次，且发生在任何副作用之前
        // （还没建 AbortController、还没登记账本、还没 spawn）。判定失败 ⇒ 抛出可读原因，
        // 于是宿主这边连 run 都不会有（`subagents.start` 的契约：provider 在 start 里抛错，
        // 调用方拿不到 run，也没有 run 生命周期事件）—— 「显式拒绝」就落在这里。
        const refusal = this.alias?.refusalOfNewTask();
        if (refusal !== undefined)
            throw new Error(refusal);
        // ── **执行前**门禁（受管 bootstrap 专用，真实测量）──
        // 位置与上面那条判活**同级**：都在任何副作用之前，且都只在 `start()` 这一刻做一次。
        // 与判活的区别：判活读的是**档案是否还在**（纯函数）；这一条真去测**运行前提**
        // （随包适配器 sha256 + 厂商 CLI `--version` 实测），因为「配方里写着 2.156.0」
        // 证明不了「本机现在真是 2.156.0」。不通过 ⇒ 抛错 ⇒ 宿主这边连 run 都不会有。
        const gateRefusal = this.alias?.runtimeGate === undefined ? undefined : await this.alias.runtimeGate();
        if (gateRefusal !== undefined)
            throw new Error(gateRefusal);
        // ── per-child 选项（`agentOptions`）：**兑现不了就拒绝**，绝不接受后忽略 ──
        // 与上面两条同级：都在任何副作用之前（还没建 AbortController、还没登记账本、还没 spawn）。
        // 宿主已按 `capabilities.agentOptions=true` 放行到这里，字段级后果由本 provider 承担。
        const childOptions = childAgentOptionsDecision(this.target, request.agentOptions);
        if (childOptions.refusal !== undefined)
            throw new Error(childOptions.refusal);
        // 本次要注入的模型：落到目标自己的 `modelArgs`（`sessions.ts` 的 `withModel()`），
        // 于是「选了模型」= 命令行里真的出现那个模型（不是只写进账本）。
        const requestedModel = childOptions.model;
        const prompt = textTask(request.prompt);
        // 0.2.1-rc.1 起 dsh-subagent 移除了 `resolveChildCwd`（configured→parent 回退链 + 校验）。
        // 回退链移到本插件内部实现（见下方 resolveChildCwd），不再依赖宿主内部 API 的导出面。
        const cwd = resolveChildCwd('harness-pilot', this.target.cwd.length > 0 ? this.target.cwd : undefined, parentCwdOf(request.parent));
        const controller = new AbortController();
        const requestCancel = () => {
            if (!controller.signal.aborted)
                controller.abort(new Error('harness-pilot: run cancelled locally'));
        };
        const onAbort = () => { requestCancel(); };
        request.signal.addEventListener('abort', onAbort, { once: true });
        let collected = '';
        let diagnostic;
        // P7：把这次 run 登记进任务账本。
        // 以前 runId 只出现在工具返回的文本里，既不落盘也不进注册表 —— 于是「这次派发到底怎么了」
        // 只能靠"预期产物不存在"反推。这里刻意**不**带 callback：调用方本来就在 await 结果，
        // 再回执一次就是重复唤醒；卡住的情况由 stallTimeoutMs 标成 `stalled`，供查询。
        const tracked = this.tasks.track({
            kind: 'subagent',
            target: this.target,
            prompt,
            cwd,
            identity: { harnessId: this.target.name,
                ...(this.alias === undefined ? {} : { accountId: this.alias.accountId }),
                // 请求身份里的模型：账本的 requested/actual 对照要用它（不写就等于「请求里没有模型」）。
                ...(requestedModel === undefined ? {} : { model: requestedModel }) },
            stallTimeoutMs: this.stallTimeoutMs,
        });
        let trackedSettled = false;
        const settleTracked = (action) => {
            if (trackedSettled)
                return;
            trackedSettled = true;
            action();
        };
        const result = settleRunResult({
            attempt: async () => {
                const outcome = await this.sessions.dispatch({
                    target: this.target,
                    prompt,
                    cwd,
                    signal: controller.signal,
                    timeoutMs: this.target.timeoutMs,
                    // 本次模型（来自子代理的 per-child `agentOptions`）：交给 `withModel()` 落到
                    // 目标的 `modelArgs`（qoder 目标是 `-m {model}`）。**没有**声明 modelArgs 的目标
                    // 在 `childAgentOptionsDecision()` 里就已被显式拒绝，所以这里不会是静默丢弃。
                    ...(requestedModel === undefined ? {} : { model: requestedModel }),
                    // 门禁幂等声明：上面**已经真跑过**受管账号的执行前门禁并通过，所以
                    // `sessions.dispatch` 那一层（HTTP 三入口的收口）不必再起第二个 `--version` 子进程。
                    // ⚠️ 只有真的测过才置 true；没有 `runtimeGate` 的普通 provider 不声明。
                    ...(this.alias?.runtimeGate === undefined ? {} : { accountGateChecked: true }),
                    // 身份透传：`/dispatch`、`/task/start`、`harness_task_start` 三个入口都传 `identity`，
                    // 子代理 provider 是**第四个**入口，这里也显式传。
                    // ⚠️ **如实说明它的作用边界（实测，不是推断）**：`sessions.foldOutcomeIdentity` 本来就会
                    // 用 `target.name` 填 `identity.harnessId`，所以 `harnessId` 这一项**不是**「不写就没有
                    // actual」的关键改动 —— 它是把意图写成显式，并在上游哪天改了推导逻辑时仍然成立。
                    // `accountId` 则**只在别名路径上**声明，而且它声明的正是**注册期固化**的那个账号；
                    // 不带账号的普通 provider 依旧不声明 accountId —— 声明了就是撒谎。
                    identity: {
                        harnessId: this.target.name,
                        ...(this.alias === undefined ? {} : { accountId: this.alias.accountId }),
                    },
                    onProgress: (chunk) => {
                        collected = (collected + chunk).slice(-400_000);
                        tracked.progress(chunk);
                    },
                });
                if (outcome.text.length > 0)
                    collected = outcome.text;
                diagnostic = outcome.diagnostic;
                const identity = subagentIdentityNote(this.target, outcome, tracked.id, this.alias);
                // 身份行同时写进**账本**：子代理 run 的记录（`.json` / `/task?id=` / 设置页任务面板 /
                // harness_task_status）此前只有一个 `actual` 对象，没有一句人话说明「谁在跑」。
                // 这里把身份行作为这条 run 的 diagnostic 落账 —— **只为记录，不改判**：
                // `finish()` 用 `stopReason` 决定状态，diagnostic 不参与成败判定（已核对 tasks.ts 的 finish）。
                settleTracked(() => tracked.finish({
                    ...outcome,
                    diagnostic: outcome.diagnostic === undefined || outcome.diagnostic.length === 0
                        ? identity
                        : `${outcome.diagnostic}\n${identity}`,
                }));
                // 成功路径**也**带身份行：宿主只在失败时渲染 diagnostic，而 harness_agent 会无条件打印它，
                // 于是这是成功 run 上唯一能显示「真实 Harness / 账号 / 模型 / 原生会话 id」的可见面。
                if (outcome.stopReason === 'completed') {
                    return { output: [{ type: 'text', text: outcome.text }], diagnostic: identity, stopReason: 'completed' };
                }
                const partial = outcome.text.length > 0 ? [{ type: 'text', text: outcome.text }] : [];
                const detail = outcome.diagnostic === undefined
                    ? `harness-pilot (${this.target.name}): run ended with ${outcome.stopReason} over transport ${outcome.transport}`
                    : `harness-pilot (${this.target.name}): ${outcome.diagnostic}`;
                return {
                    output: partial,
                    diagnostic: `${detail}\n${identity}`,
                    stopReason: outcome.stopReason === 'aborted' ? 'aborted' : 'error',
                };
            },
            collectOutput: () => (collected.length > 0 ? [{ type: 'text', text: collected }] : []),
            collectDiagnostic: () => diagnostic,
            cancelled: () => controller.signal.aborted,
            onError: (error) => {
                // 抛错路径没有 outcome，就用不带 outcome 的身份行：它仍然写明真实 Harness 与账本 id，
                // 并把「没有回报身份」这件事**说出来**，而不是留一片空白让人当成正常。
                diagnostic = `harness-pilot (${this.target.name}): ${error.message}\n${subagentIdentityNote(this.target, undefined, tracked.id, this.alias)}`;
                settleTracked(() => tracked.fail(error));
            },
            signal: request.signal,
            onAbort,
        });
        return subprocessRunHandle({
            // 直接用**任务账本里的 id** 作为子代理 run id：这样 harness_agent 返回的 runId
            // 可以原样拿去 harness_task_status 查询，调用方不必在两个 id 之间做映射（P7）。
            id: tracked.id,
            result,
            signal: request.signal,
            onAbort,
            requestCancel,
            teardown: async () => {
                // 一次性派发的通道会自己收尾（进程树/窗口/CDP 连接）；这里无需额外动作。
            },
        });
    }
}
/** 该 harness 的子代理 provider 名（`harness-opencode`、`harness-zcode` …）。 */
export function providerNameFor(target) {
    return `harness-${target.name}`;
}
/**
 * 为每个目标注册一个 provider；默认目标额外注册 `harness-pilot` 别名；
 * 给了 `options.accounts` 时**再**为每个 (target × account) 注册一个**身份别名**
 * （`harness-<target>-acct-<档案 id>`，账号配方在注册期烘进构造）。
 * 返回实际注册的 provider 名（按注册顺序），供日志与工具描述使用。
 *
 * 幂等：同名 provider 已存在（同一个包被两条 loader 行加载）时跳过，
 * 否则重复注册会让第二条 loader 行的 fiber 失败（宿主 `registerProvider` 对重名抛
 * `DUPLICATE_PROVIDER`）。
 *
 * ⚠️ 两条**如实说明**的边界：
 *   · 别名的集合是**注册期**算出来的。之后用户**新增**的账号档案不会自动多出一个 provider
 *     名字（要等下一次插件重载）；而**停用/删除**是**不需要**重载的 —— 判活在 `start()` 里
 *     实时做，新任务会被显式拒绝。
 *   · `harness-pilot` 这个默认别名**不带**账号变体（它是「默认目标」的短名，不是账号选择器）。
 *
 * `injectedMerge`（第 7 形参）= 「账号 → 目标」的**唯一**合并实现，由调用方注入
 * `src/account-target.ts` 的 `withAccountTarget()`。为什么是注入而不是 import：
 * 见 `AccountMergeLike` 的注释（切断 `provider.ts ↔ account-target.ts` 循环）。
 * 不注入 ⇒ 普通账号别名**如实跳过**（绝不自己再拼一份合并规则）。
 */
export function registerProviders(registry, sessions, tasks, targets, defaultTarget, optionsOrStallTimeout = {}, injectedMerge) {
    const options = typeof optionsOrStallTimeout === 'number'
        ? { stallTimeoutMs: optionsOrStallTimeout }
        : optionsOrStallTimeout;
    const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const existing = new Set(typeof registry.list === 'function' ? registry.list() : []);
    const registered = [];
    const register = (name, target, alias) => {
        if (existing.has(name))
            return;
        registry.registerProvider(new HarnessProvider(name, target, sessions, tasks, stallTimeoutMs, alias));
        existing.add(name);
        registered.push(name);
    };
    for (const target of targets)
        register(providerNameFor(target), target);
    const preferred = targets.find(target => target.name === defaultTarget);
    if (preferred !== undefined)
        register('harness-pilot', preferred);
    if (options.accounts !== undefined) {
        // 只有**真的拿到**惰性档案读取器才注册别名：`accounts` 是把账号带进这条路径的唯一入口。
        const aliasOptions = { ...options, accounts: options.accounts };
        // 跳过说明由 `planAccountAliases()` 统一回调 `onSkip`（规划路径与注册路径同一处出口）。
        const plan = planAccountAliases(targets, aliasOptions, injectedMerge ?? options.withAccount);
        for (const entry of plan.aliases) {
            if (existing.has(entry.name)) {
                options.onSkip?.(`别名 ${entry.binding.redactedName} 与已有 provider 同名，已跳过`);
                continue;
            }
            register(entry.name, entry.target, entry.binding);
        }
    }
    return registered;
}
//# sourceMappingURL=provider.js.map