/**
 * **账号目标解析的唯一来源**（单一实现处）。
 *
 * ## 为什么要有这个模块（缺口原文，逐条对应）
 * 「账号 + 目标」这一格历史上被写成了**四份**独立实现，于是同一个能力在不同入口
 * 行为不一致 —— 本项目三次栽在这上面（用户点名要求收口）：
 *   1. `src/index.ts` 的私有 `withAccountTarget()`（`/task/start`、`harness_task_start`、
 *      自动切换 `attempt()`、别名 provider 的普通分支都从它派生语义）；
 *   2. `src/index.ts` 的 `/dispatch` 内联合并（**没有**同 Harness 判定、
 *      `account` note **未脱敏**、受管账号同样拼出「两个 wrapper、两个 id」）；
 *   3. `src/index.ts` 团队冻结配方两处 `[...frozen.args, ...found.args]`
 *      （`pilotCli.dispatch` 与 `/team/dispatch`）—— 受管账号的冻结 `args` 是**相对**的
 *      `['workbuddy-managed.cjs', <档案 id>]`，前置到已经是完整元组的目标参数前面，
 *      必然拼出「两个 wrapper、两个 id」；
 *   4. `src/provider.ts` 的 `planAccountAliases()` 普通别名分支（注册期自己拼一份）。
 *
 * 现在**只有这一处**决定「某账号在某目标上的启动配方是什么」。四个入口都不再各写一份：
 *   · `/dispatch`、`/task/start`、`harness_task_start`、自动切换、子代理 provider
 *     → `withAccountTarget()`（本模块）；
 *   · 团队 `prepare()` 冻结配方 → `resolveAccountRecipe()` / `withAccountTarget()`（本模块），
 *     `src/team-routing.ts` 只做**委派**（`accountSideOf()` 取「账号侧那一份」）；
 *   · 团队冻结配方的派发合并 → `applyAccountToTarget()`（本模块）；
 *   · 别名 provider 注册 → `planAccountAliases()` 收到注入的**同一个** `withAccountTarget()`；
 *   · 别名与派发两条出口的**合并规则**共用 `mergePlainAccountInto()`（普通）/ 整份复用（硬绑定与受管）。
 *
 * ## 循环 import 如何避免（**实测的**结构，写之前先核对了 import 图）
 * `src/index.ts` → `src/team-routing.ts`（`index.ts` 依赖团队路由）。
 * 若把这份实现留在 `index.ts` 里再由 `team-routing.ts` 反向 import，就会形成
 * **`index.ts` ↔ `team-routing.ts` 循环**（ESM 下表现为「某一边拿到未初始化的绑定」，
 * 失败方式与「改动没生效」长得一模一样 —— 正是本项目反复吃亏的形状）。
 *
 * 实现因此放进这个新模块。**真实的 import 图**（写完后用「加载即核 + 探针」两级核对）：
 *
 * ```
 *   index.ts ──▶ team-routing.ts ──▶ account-target.ts ──▶ provider.ts
 *      │                                   ▲                   │
 *      │                                   └── 惰性解析（createRequire）──┘
 *      │                                      只在**真的要合并**时发生一次
 *      └──▶ 第 7 形参注入 withAccountTarget()   （静态图上没有回路）
 *                                   │
 *         federation/accounts · federation/poolconfig · federation/registry
 *         task-tools(redactAccountIdsInText) · types(类型)
 * ```
 *
 * 三条规则把回路切断，**每一条都可核对**：
 *   ① 本模块 → `provider.ts`：**静态、单向** import `planAccountAliases()` /
 *      `packagedManagedAdapterPath()`（受管元组校验要用同一份实现，不另抄一份）；
 *   ② `provider.ts` **不**静态 import 本模块：普通账号别名那一步改成
 *      **惰性解析**（`createRequire(import.meta.url)('./account-target.js')`，见
 *      `mergeAccountByPolicyLazy()`），并且 `index.ts` 还在 `registerProviders()` 的
 *      第 7 形参上**注入**同一处实现 —— 惰性解析只是探针/单测直接调 `planAccountAliases()`
 *      时的兜底；解析失败就**如实跳过**那个别名，绝不自己再拼一份合并规则；
 *   ③ `provider.ts` 的运行期依赖只有 `federation/poolconfig.js`（`sessions.js` / `tasks.js`
 *      都是 `import type`，运行时不存在），也不 import `index.ts` / `team-routing.ts`。
 *
 * 两级核对（不是读代码推断）：`node probe/verify-account-target-unify.mjs`（四入口矩阵 53 格）
 * 与 `node probe/_check-alias-dispatch-equivalence.mjs`（别名合并 == 派发合并，逐字）。
 * 若真出现「未初始化绑定」，这两条会直接崩或判 FAIL —— 不会静默通过。
 *
 * ## 安全口径（沿用既有纪律，逐条落地）
 *   · **不读凭据**：本模块只拼参数与环境变量，从不读、不复制、不解密任何认证文件；
 *   · **不静默换账号**：任何不匹配都是**显式拒绝**（返回可读原因），永不回退到别的账号、
 *     也永不回退到「不带账号的目标」；
 *   · **不输出原始 accountId**：本模块产出的**每一条面向人的文案**（拒绝原因、note）
 *     在返回前都过 `redactAccountIdsInText()`；原始 id 只用于路由与 `identity` 记录。
 */
import { win32 } from 'node:path';
import { resolveAccountLaunch } from './federation/poolconfig.js';
import { seedForTarget } from './federation/registry.js';
// 产品身份表（「一个 harness」的唯一分类实现）：判「账号与目标是不是同一个 harness」用它。
import { classifyHarnessId, classifyTarget } from './harness-groups.js';
import { packagedManagedAdapterPath, planAccountAliases } from './provider.js';
import { redactAccountIdsInText } from './task-tools.js';
/** 账号是否**受管 bootstrap**（WorkBuddy 的厂商内部协议适配器那条路）。 */
export function isManagedBootstrapSeed(seed) {
    return seed.launch.mode === 'managed-bootstrap';
}
// ── 路径 / 文案小工具（逐字沿用既有实现，避免第二套判定）─────────────────────
function redactedLabel(accountId) {
    // 与 `federation/poolconfig.ts` 的 `redactAccount()` **同一规则**（尾部 2 字符 + 长度 base36）。
    // ⚠️ 为什么在这里**内联**而不 import：`redactAccount()` 只在 `federation/poolconfig.js` 导出，
    // `task-tools.js` 并**没有**它（实测：按那个假设取用时拿到 `redactAccount is not a function`）。
    // 本函数只依赖一条字符串规则，内联 3 行比多引一个跨模块导出更可靠；
    // 若与 poolconfig 那份漂移，`verify-account-target-unify.mjs` 的脱敏格子会立刻变红。
    const trimmed = accountId.trim();
    if (trimmed.length <= 4)
        return 'acct:***';
    return `acct:…${trimmed.slice(-2)}${trimmed.length.toString(36)}`;
}
function labelOf(seed) {
    return redactAccountIdsInText(seed.id);
}
/** 面向人的文案一律过这一道（本模块的**唯一**出口脱敏点）。 */
function safe(text) {
    return redactAccountIdsInText(text);
}
// ── 远端配置目录的「硬绑定」检测（Qoder 型目标）──────────────────────────────
//
// 存在这样一类已验收目标：它把某个账号档案的配置目录**明文写在自己的 argv 里**，
// 于是「用账号 X 跑目标 T」这件事已经固化在 T 的配方里。本机实测有两个：
//   · `qoder-cn-acct-a` / `qoder-cn-acct-b`：`args` 里明文写着
//     `--config-dir C:\…\harness-accounts\qoder-cn-a|b`（`--config-dir` 隔离，实测身份不同）。
//
// 对它们再叠一层账号参数会**重复注入**（两个**完全相同**的 `--config-dir`），
// 而重复的 `--config-dir` 谁生效取决于 CLI ⇒ 「看起来换了账号、其实没有」。
// `src/provider.ts` 早就对**别名注册**跳过这种目标（`targetAlreadyCarriesConfigDir()`），
// 但派发侧（`/task/start` / `/dispatch` / 团队冻结配方）没有 —— 这正是本模块要收的那一格。
//
// ⚠️ 判据**不是**名字（目标名里恰好含 `-acct-` 一律不算数：本 profile 就有两个目标叫
// `qoder-cn-acct-a/b`，而 `harness-<target>-acct-<id>` 这种**选择器**名也长得像），
// 而是**真实完整配方**的逐项比对（配置目录 + 可执行文件 + 参数前缀 + 环境变量），见
// `sameAccountRecipe()`。
/** `harness-accounts/<id>` 形状的引用（只取**默认根**下的，避免猜用户自定义路径）。 */
const DEFAULT_ACCOUNT_DIR_REFERENCE = /harness-accounts[\\/]+([^\\/\s"']+)/gi;
/** 一段文本里出现的 `harness-accounts\<id>` 的 id 集合（**已脱敏写出**的不算，它们不是真实引用）。 */
function accountIdsReferencedIn(text) {
    const out = new Set();
    for (const match of text.matchAll(DEFAULT_ACCOUNT_DIR_REFERENCE)) {
        const id = match[1];
        if (id === undefined || id.length === 0)
            continue;
        // 脱敏器把 id 换成 `acct:…xx` 这种形态；那种写法落在目录名位置上不是真实路径引用。
        if (id === 'acct:' || /^acct:/i.test(id))
            continue;
        out.add(id);
    }
    return out;
}
/** 目标自身的 `args` / `env` 里引用了哪些账号的默认配置目录（含被明文写死的那种）。 */
export function accountIdsCarriedByTarget(target) {
    const out = new Set();
    for (const arg of target.args)
        for (const id of accountIdsReferencedIn(arg))
            out.add(id);
    for (const value of Object.values(target.env))
        for (const id of accountIdsReferencedIn(value))
            out.add(id);
    return [...out];
}
// ── 持久原生会话（最小改造 v2）的**烘焙账号**识别（唯一实现）──────────────────
//
// 五路产品入口把账号烘焙在目标 argv 里（WorkBuddy 受管 wrapper 的第 2 个参数、
// Qoder 的 `--config-dir` 档案目录）。审查 R4 指出：派发门禁若只看
// `spec.identity?.accountId`，调用方省略账号时会**整体绕过**版本/哈希门禁。
// 因此「有效账号」的解析必须是共享实现：index.ts（门禁/冻结 HOME）、sessions.ts
// （派发前门禁）、tasks.ts（会话绑定冻结/复核）都从这一处取，不各写一份。
/** 受管 WorkBuddy 的已验收账号 id（与 wrapper 内建白名单一致；升级需重新验收）。 */
export const NATIVE_MANAGED_WORKBUDDY_IDS = ['workbuddy-a', 'workbuddy-ai-b'];
/** 从目标 argv 识别烘焙账号引用；没有则 undefined（该目标不靠 argv 绑定账号）。 */
export function bakedAccountRefOf(target) {
    // 防御：类型上 args 必填，但测试/HTTP 组装的部分目标可能缺省 —— 缺数组等同「无烘焙账号」。
    const argv = target.args ?? [];
    const wrapper = argv.findIndex(arg => /(?:^|[\\/])workbuddy-managed\.cjs$/i.test(arg));
    if (wrapper >= 0) {
        const id = argv[wrapper + 1];
        return { kind: 'managed-wrapper', value: typeof id === 'string' ? id : '' };
    }
    const cfg = argv.findIndex(arg => arg === '--config-dir');
    if (cfg >= 0 && typeof argv[cfg + 1] === 'string') {
        return { kind: 'config-dir', value: argv[cfg + 1] };
    }
    return undefined;
}
/** 绑定比较键（类型+值；config-dir 的值做过路径规范化，Windows 大小写不敏感）。 */
export function bakedAccountRefKey(ref) {
    const value = ref.kind === 'config-dir' ? win32.resolve(ref.value).toLowerCase() : ref.value;
    return `${ref.kind}:${value}`;
}
/**
 * 目标里**真实存在**的另一个账号 —— 静默串号的判据。
 *
 * 三种「像但不是」必须排除（第一版判据在这里把正常路径判红过）：
 *   · 引用的 id 就是本次要用的账号 ⇒ 不是别人；
 *   · 引用的 id 在**当前生效档案里根本没有**（例如临时/已删除档案的名字恰好出现在 argv 里）
 *     ⇒ 无法据此断定「这是别人的配置目录」，不拒绝；
 *   · 引用的 id 虽然是个真档案，但它**自己的**配置目录并不是目标里写的那个目录
 *     ⇒ 目标写的不是「这个档案的目录」，同样不据此拒绝。
 *
 * 只有「引用的是一个真实生效档案，且它的配置目录确实被写进了目标」才算串号 —— 那时才拒绝。
 */
function foreignAccountIdsInTarget(target, seeds, homeDir, accountId) {
    const out = [];
    for (const id of accountIdsCarriedByTarget(target)) {
        if (id === accountId)
            continue;
        const seed = seeds.find((entry) => entry.id === id);
        if (seed === undefined)
            continue;
        const launch = resolveAccountLaunch(id, homeDir, [seed]);
        if (!launch.ok || launch.configDir.length === 0)
            continue;
        if (!targetCarriesAccountConfigDir(target, launch.configDir))
            continue;
        out.push(id);
    }
    return out;
}
/** 目标是否**已经**把该账号的配置目录写进自己的 `args` / `env`（同一套判定，别名注册也在用）。 */
export function targetCarriesAccountConfigDir(target, configDir) {
    if (configDir.length === 0)
        return false;
    const needle = configDir.toLowerCase();
    return target.args.some((arg) => arg.toLowerCase().includes(needle))
        || Object.values(target.env).some((value) => value.toLowerCase().includes(needle));
}
/**
 * 目标声明的可执行文件是否**就是**该账号档案声明的那个命令。
 *
 * 档案里的 `launch.command` 可能是**裸名**（qoder 档案就是 `qoderclicn`，靠 PATH / 已探测的
 * 绝对路径解析），而目标里通常是绝对路径 ⇒ 用「路径末段相等」判定，而不是字符串相等。
 *
 * ⚠️ 归一化必须包含 **`.exe` 去尾**：本机实测档案写 `qoderclicn`，目标写
 * `C:\…\.qodersec\bin\qoderclicn.exe` —— 不去尾就会把「账号 + 它自己硬绑定的目标」
 * 判成「不是同一个可执行文件」而拒绝（这正是 `/task/start` 对 `qoder-cn-acct-a` 误拒的成因之一）。
 * 绝对路径 vs 绝对路径同样按 Windows 规则归一后逐字比。
 */
function commandMatchesLaunch(target, seed) {
    return commandTokenMatches(target.command ?? '', seed.launch.command ?? '');
}
/**
 * 「目标已经把该账号的**完整启动配方**带在身上」的逐项判定。
 *
 * 五项缺一不可（任何一项不成立都**不算**同账号，也就不会走「整份复用」那条路）：
 *   ① 目标 `args` / `env` 里出现该账号的配置目录；
 *   ② 目标 `command` 与该档案的 `launch.command` 指向同一个可执行文件；
 *   ③ 该档案的 `launch.args`（`{configDir}` 已替换）是目标 `args` 的**前缀**；
 *   ④ 该档案 `launch.env` 的每个键值都已在目标 `env` 里**逐字相同**地存在；
 *   ⑤ 档案自己给出的 `configDir` 确实就是那个被写进目标的目录。
 *
 * 这就是用户口径里的「用**真实完整配方**确认同账号，**不靠名字猜**」。
 */
export function sameAccountRecipe(target, seed, homeDir) {
    const launch = resolveAccountLaunch(seed.id, homeDir, [seed]);
    if (!launch.ok)
        return false;
    if (launch.configDir.length === 0)
        return false;
    if (!targetCarriesAccountConfigDir(target, launch.configDir))
        return false;
    if (!commandMatchesLaunch(target, seed))
        return false;
    if (launch.args.length === 0)
        return false;
    if (target.args.length < launch.args.length)
        return false;
    for (let index = 0; index < launch.args.length; index += 1) {
        if (target.args[index] !== launch.args[index])
            return false;
    }
    for (const [key, value] of Object.entries(launch.env)) {
        if (target.env[key] !== value)
            return false;
    }
    return true;
}
// ── **普通合并**的唯一实现（别名注册与派发两侧都调它）─────────────────────────
//
// ⚠️ 为什么这一个 3 行的合并要单独成函数并导出：它此前在**四个地方**各写了一遍
// （本模块、`index.ts` 的 `/dispatch` 内联、`team-routing.ts`、`provider.ts` 的别名注册）。
// 收口后只剩这一处，`provider.ts` 的 `planAccountAliases()` 也调**同一个**它 ——
// 那是「同一能力的四个入口」不会再次漂移的**唯一**可判定保证（探针 B1 的
// 「别名合并结果 == 派发合并结果」就是核对这一点的）。
//
// 语义（**与历史逐字一致**，不许顺手改）：账号参数**前置**、账号环境变量**覆盖**目标自身。
// 受管 bootstrap 与「目标已硬绑定同一账号」两种情形**不走这里**（那两条是整份复用，
// 见 `withAccountTarget()` / `applyAccountToTarget()` 的显式分支）。
/** 普通合并：账号参数前置、账号 env 覆盖目标 env。 */
export function mergePlainAccountInto(target, accountArgs, accountEnv) {
    return { ...target, args: [...accountArgs, ...target.args], env: { ...target.env, ...accountEnv } };
}
/**
 * 别名注册用的**策略级**合并（与 `withAccountTarget()` 的第 ④ 分支同源、同一条实现）。
 *
 * 输入是**已解算好**的账号配方（别名规划在调用它之前已经核过「档案在不在」、
 * 「目标是不是已经写着该档案的配置目录」两件事）。判定顺序与 `withAccountTarget()` 一致：
 * ① 目标已带着**别人的**真实配置目录 ⇒ 拒绝；② 目标已按真实完整配方带着**同一账号** ⇒ 整份复用；
 * ③ 其余 ⇒ `mergePlainAccountInto()` 的普通合并。
 */
export function mergeAccountByPolicy(input) {
    const { target, seed, launch, seeds, homeDir } = input;
    const foreign = foreignAccountIdsInTarget(target, seeds, homeDir, seed.id);
    if (foreign.length > 0) {
        return {
            ok: false,
            reason: safe(`目标「${target.name}」的启动配方里已经写着账号 ${foreign.map((id) => `‹${id}›`).join('、')} 的配置目录，`
                + `而本次要求用账号 ${redactedLabel(seed.id)} ⇒ 拒绝（不静默串号：argv 里两个不同的 --config-dir 谁生效由 CLI 决定）。`),
        };
    }
    if (launch.configDir.length > 0
        && targetCarriesAccountConfigDir(target, launch.configDir)
        && sameAccountRecipe(target, seed, homeDir)) {
        return {
            ok: true,
            target: { ...target, args: [...target.args], acpArgs: [...target.acpArgs], env: { ...target.env } },
            note: safe(`account=${seed.id} configDir=${launch.configDir}`
                + '（该目标已按真实完整配方带着这个账号：整份复用，不重复注入）'),
        };
    }
    return {
        ok: true,
        target: mergePlainAccountInto(target, launch.args, launch.env),
        note: safe(`account=${seed.id} configDir=${launch.configDir}`),
    };
}
// ── 受管 bootstrap 的完整元组核对（**Root 侧**显式闸门）────────────────────────
/**
 * 受管目标的**完整启动元组**逐项核对（在 `provider.ts` 的 `managedAccountAliasRefusal()` 之外
 * 再加一道**显式**闸门，返回可读原因 = 拒绝）。
 *
 * 逐项含义（缺一项都会让「跑的是哪个账号」变得不可判定）：
 *   · `command`          —— 已验收的那个厂商可执行文件（受管模式要它自己的 Node 模式）；
 *   · `args` / `acpArgs` —— **绝对** wrapper 恰好 1 次 + 档案 id 恰好 1 次 + 各自的旗标，
 *                           且**不得残留**相对 wrapper 名（缺陷就是这个形状）；
 *   · `env`              —— `ELECTRON_RUN_AS_NODE=1`（档案侧与目标侧都要有）；
 *   · `configDir`        —— 档案配置目录必须是 `~/.dsh/harness-accounts/<档案 id>`；
 *   · 版本前缀           —— 必须**声明**（真实测量与哈希门禁在 `managedBootstrapRuntimeGate()`，
 *                           本函数不冒充它，只保证「配方不是无门禁的」）。
 */
export function managedRecipeTupleProblem(target, seed, home) {
    const bootstrap = seed.launch.bootstrap;
    if (bootstrap === undefined)
        return '账号档案没有受管 bootstrap 配方（适配器 id / 厂商可执行文件 / 版本前缀）';
    if (bootstrap.adapterId !== seed.id)
        return '受管适配器 id 与账号档案 id 不一致';
    if (typeof bootstrap.requiresVendorVersionPrefix !== 'string' || bootstrap.requiresVendorVersionPrefix.length === 0) {
        return '受管配方没有声明版本前缀（不允许无门禁运行）';
    }
    const wrapper = packagedManagedAdapterPath();
    const same = (left, right) => typeof left === 'string' && win32.isAbsolute(left) && win32.isAbsolute(right)
        && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
    /** 相对 wrapper 名残留（绝对路径那一份不算残留）。 */
    const isRelativeWrapper = (arg) => /(^|[\\/])workbuddy-managed\.cjs$/i.test(arg) && !same(arg, wrapper);
    const checkArgv = (argv, flag, kind) => {
        if (argv.length !== 3)
            return `${kind} 参数不是 3 项（实测 ${argv.length} 项）`;
        const wrappers = argv.filter((arg) => same(arg, wrapper)).length;
        if (wrappers !== 1)
            return `${kind} 参数里的随包适配器**绝对**路径出现 ${wrappers} 次（必须恰好 1 次）`;
        const ids = argv.filter((arg) => arg === seed.id).length;
        if (ids !== 1)
            return `${kind} 参数里的档案 id 出现 ${ids} 次（必须恰好 1 次）`;
        if (argv[1] !== seed.id)
            return `${kind} 参数第 2 项不是该账号档案 id`;
        if (argv[2] !== flag)
            return `${kind} 参数第 3 项不是 ${flag}`;
        const residue = argv.filter(isRelativeWrapper);
        if (residue.length > 0)
            return `${kind} 参数里残留**相对** wrapper「${residue[0]}」—— 适配器必须以绝对路径、且只出现一次`;
        return undefined;
    };
    if (!win32.isAbsolute(target.command))
        return '目标 command 不是绝对路径';
    if (!same(target.command, bootstrap.vendorExecutable))
        return '目标 command 不是已验收的厂商可执行文件';
    const headless = checkArgv(target.args, '-p', 'headless');
    if (headless !== undefined)
        return headless;
    const acp = checkArgv(target.acpArgs, '--acp', 'ACP');
    if (acp !== undefined)
        return acp;
    if (target.env.ELECTRON_RUN_AS_NODE !== '1')
        return '目标 env 缺少 ELECTRON_RUN_AS_NODE=1（厂商 exe 的 Node 模式）';
    if (seed.launch.env.ELECTRON_RUN_AS_NODE !== '1')
        return '账号档案的 launch.env 缺少 ELECTRON_RUN_AS_NODE=1';
    const expectedConfig = win32.join(home, '.dsh', 'harness-accounts', seed.id);
    if (!same(seed.configDir, expectedConfig))
        return '账号档案的配置目录不是 ~/.dsh/harness-accounts/<档案 id>';
    return undefined;
}
/**
 * 认领一个**受管 bootstrap**账号在给定目标上的**已验收启动计划**（整份复用，不叠加）。
 *
 * 计划来源就是别名 provider 用的那一处：`planAccountAliases()` → 内部的
 * `managedAccountAliasRefusal()` 已经逐项核过厂商 exe / 绝对 wrapper / 档案 id / `-p` /
 * `--acp` / `ELECTRON_RUN_AS_NODE` / 配置目录 / 版本前缀。这里**不另写第二套配方校验**，
 * 只在它之外补一道 `managedRecipeTupleProblem()` 的显式核对，并把「认领不到」变成
 * **显式拒绝**（脱敏、不 fallback、不换账号）。
 */
export function claimManagedAccountRecipe(target, seed, home, seeds) {
    const label = labelOf(seed);
    const plan = planAccountAliases([target], { accounts: () => seeds, homeDir: home });
    const refuse = (why) => ({
        ok: false,
        reason: safe(`harness-pilot: 受管 bootstrap 账号 ${label} 在目标「${target.name}」上没有可用的**已验收启动计划**，本次是显式拒绝。`
            + `\n· 原因      ${why}`
            + '\n· 受管目标自带完整启动元组（绝对 wrapper 路径 + 档案 id + 旗标 + ELECTRON_RUN_AS_NODE + 厂商可执行文件）。'
            + '本插件**不会**把档案里那个**相对**的 wrapper 名（workbuddy-managed.cjs）叠加到它上面：'
            + '那会拼出两个 wrapper、两个账号 id，最终跑成哪个账号由 CLI 自己决定 —— 也就是「看起来用了这个账号、其实没有」。'
            + '\n· 也不会改用其它账号、或回退到不带账号的目标：那等于换一个身份执行。'
            + `\n· 恢复方式：核对账号档案的 launch.bootstrap（适配器 id / 厂商可执行文件 / 配置目录 / 版本前缀）`
            + `与目标「${target.name}」的 command / args / acpArgs / env 是否仍是已验收配方。`
            + (plan.skipped.length === 0 ? '' : `\n· 规划期说明 ${plan.skipped.join('；')}`)),
    });
    const matches = plan.aliases.filter((alias) => alias.binding.accountId === seed.id);
    if (matches.length !== 1) {
        return refuse(matches.length === 0
            ? '规划期没有产出该账号在这个目标上的条目（配方校验未通过）'
            : `规划期产出了 ${matches.length} 条同账号条目，无法确定唯一计划`);
    }
    const planned = matches[0].target;
    const problem = managedRecipeTupleProblem(planned, seed, home);
    if (problem !== undefined)
        return refuse(problem);
    // 不可变快照：与别名 provider 注册期同一形状（三层都复制），此后不再改。
    return { ok: true, target: { ...planned, args: [...planned.args], acpArgs: [...planned.acpArgs], env: { ...planned.env } } };
}
// ── 配方解算（账号 → 启动配方）──────────────────────────────────────────────
/**
 * 账户解算器：**产品化默认实现**。
 *
 * 直接复用 `resolveAccountLaunch`（账号池/派发/别名 provider 三方共用的**同一处**实现）——
 * 本模块**不**另写一份账户配方逻辑，否则「派发用 A 配方、路由用 B 配方」这种不一致迟早出现。
 */
export function resolveAccountRecipe(accountId, seeds, homeDir) {
    const launch = resolveAccountLaunch(accountId, homeDir, seeds);
    if (!launch.ok)
        return { ok: false, reason: launch.reason };
    return {
        ok: true,
        recipe: {
            accountId,
            label: redactedLabel(accountId),
            args: [...launch.args],
            env: { ...launch.env },
            configDir: launch.configDir,
            isolationNote: launch.isolationNote,
        },
    };
}
/**
 * **唯一**的「把账号配方套到目标上」实现。**六个产品入口全部走这里**（见文件头）。
 *
 * 四条分支，全部**显式**、全部可判：
 *   ① 受管 bootstrap 账号 ⇒ `claimManagedAccountRecipe()` 认领**完整元组**（整份复用）；
 *   ② 目标**已经**带着该账号的真实完整配方（Qoder 型硬绑定目标）⇒ **整份复用目标**，
 *      并逐项复核同账号 ⇒ **不重复注入**同值 `--config-dir`；
 *   ③ 目标带着**别人**的账号配置目录 ⇒ **显式拒绝**（不许把 A 的目录当 B 的账号用）；
 *   ④ 其余（目标自身不带账号）⇒ 既有语义：**档案参数前置、档案环境变量覆盖目标 env**，
 *      且**必须**通过同 Harness 判定。
 *
 * 任何一条不成立都返回 `{ok:false, reason}` —— 调用方必须原样拒绝，**不得**回退到别的账号、
 * 也不得回退到「不带账号的目标」。
 */
export function withAccountTarget(input) {
    const { target, accountId, seeds, homeDir } = input;
    const seed = seeds.find((entry) => entry.id === accountId);
    if (seed === undefined) {
        // 保留既有文案（普通路径的逐字等价口径就落在这里）：它列出的是**档案 id 的枚举**，
        // 属于「有哪些选项」而不是「这次用的是哪个」；面向人的两处出口（`/task/start` 的 400
        // 与 `tools.ts` 的 `harness_task_start`）在返回前还会再过一次脱敏器。
        return { ok: false, reason: `未知账号档案；已知：${seeds.map((entry) => entry.id).join(', ')}` };
    }
    // ── ① 受管 bootstrap：认领已验收的完整元组，**不** prepend 档案的相对参数 ──
    //
    // 实测缺陷（本函数此前对受管账号做的是 `args: [...launch.args, ...target.args]`）：
    //   · 档案的 `launch.args` 是 **相对** 的 `['workbuddy-managed.cjs', <档案 id>]`；
    //   · 受管目标 `wb-managed-a` 的 `args` **已经**是完整元组 `[<绝对 wrapper>, <档案 id>, '-p']`；
    //   ⇒ 直接前置拼出「两个 wrapper、两个 id」：
    //        WorkBuddy.exe workbuddy-managed.cjs <id> <绝对 wrapper> <id> -p
    //   相对那个由 CLI 按 cwd 解析，跑成哪个账号取决于它 —— 正是用户点名要防的
    //   「重复 wrapper / 错账号」。别名 provider 路径（`planAccountAliases()`）没这个问题，
    //   因为它**整份复用**目标元组。
    //
    // 为什么配对判定也必须走 `planAccountAliases()`：受管账号 ↔ 目标的配对权威是
    // provider.ts 的 `MANAGED_ALIAS_RECIPES`（`wb-managed-a` ↔ 档案 `workbuddy-a`），
    // **不是** `seedForTarget(target.name)` —— 受管目标的名字本来就不是任何档案的 `targetName`，
    // 原来那条同 Harness 判定会把**唯一正确的配对**判成「不是同一个 Harness」而拒绝
    // （实测：`/task/start` 对两个 WB 账号一律 400，连 `launch.args` 都没机会拼错）。
    if (isManagedBootstrapSeed(seed)) {
        const claimed = claimManagedAccountRecipe(target, seed, homeDir, seeds);
        if (!claimed.ok)
            return { ok: false, reason: safe(claimed.reason) };
        // 收尾信息仍按档案给出（隔离披露照实说：WorkBuddy 的认证存储不随配置目录隔离）。
        const launch = resolveAccountLaunch(accountId, homeDir, seeds);
        return {
            ok: true,
            target: claimed.target,
            note: safe(`account=${accountId} configDir=${launch.ok ? launch.configDir : '(未解析)'} — ${launch.ok ? launch.isolationNote : launch.reason}`),
        };
    }
    const launch = resolveAccountLaunch(accountId, homeDir, seeds);
    if (!launch.ok)
        return { ok: false, reason: safe(launch.reason) };
    const carried = accountIdsCarriedByTarget(target);
    const carriedByThisAccount = targetCarriesAccountConfigDir(target, launch.configDir);
    // ── ② 目标已经带着该账号的**真实完整配方**（Qoder 型硬绑定目标）⇒ 整份复用 ──
    // 判据是 `sameAccountRecipe()` 的五项逐项比对，**不是**目标名、也不是目录名匹配。
    // 复用 ⇒ 同一个 `--config-dir` **不会**被注入两次（重复注入的语义取决于 CLI，
    // 那等于「这个账号到底生效没有」不可判定）。
    if (carriedByThisAccount && sameAccountRecipe(target, seed, homeDir)) {
        return {
            ok: true,
            target: { ...target, args: [...target.args], acpArgs: [...target.acpArgs], env: { ...target.env } },
            note: safe(`account=${accountId} configDir=${launch.configDir} — ${launch.isolationNote}`
                + `（该目标已按真实完整配方带着这个账号：可执行文件 / 参数前缀 / 配置目录 / 环境变量逐项一致 ⇒ 整份复用，不重复注入）`),
        };
    }
    // ── ③ 目标带着**别人**的账号配置目录 ⇒ 显式拒绝 ──
    // 这一格是「静默串号」的入口：把 B 的账号套到「已经写死 A 的配置目录」的目标上，
    // argv 里会同时出现两个不同的 `--config-dir`，最终跑成哪个由 CLI 决定。
    const foreign = foreignAccountIdsInTarget(target, seeds, homeDir, accountId);
    if (foreign.length > 0) {
        return {
            ok: false,
            reason: safe(`目标「${target.name}」的启动配方里已经写着账号 ${foreign.map((id) => `‹${id}›`).join('、')} 的配置目录，`
                + `而本次要求用账号 ${redactedLabel(accountId)} ⇒ 拒绝。`
                + '\n· 把另一个账号的配置目录叠加上去，argv 里会同时出现两个不同的 `--config-dir`，'
                + '最终跑成哪个账号由 CLI 自己决定 —— 那就是「看起来换了账号、其实没有」。'
                + `\n· 要按账号 ${target.name} 自带的那一个跑，请**不要**传 accountId；`
                + '要换账号请改用不带账号配置目录的目标（例如 `qoderclicn`）+ accountId。'
                + '\n· 本次是**显式拒绝**：没有产出配方，也没有派发。'),
        };
    }
    if (carriedByThisAccount) {
        // 走到这里 = 目录名对得上，但配方**其余项对不上**（可执行文件 / 参数前缀 / 环境变量被改过）。
        // 这是篡改形状，必须拒绝而不是「照旧叠加」。
        return {
            ok: false,
            reason: safe(`目标「${target.name}」虽然带着账号 ${redactedLabel(accountId)} 的配置目录，`
                + '但与该账号档案的**真实完整配方**不一致（可执行文件 / 参数前缀 / 环境变量至少一项对不上）⇒ 拒绝。'
                + '\n· 判据是逐项比对，不是名字或目录名的匹配：改过一处的目标可能让这个账号实际不生效。'
                + '\n· 本次是**显式拒绝**：没有产出配方，也没有派发。'),
        };
    }
    // ── ④ 普通路径：档案参数前置、档案 env 覆盖目标 env（语义与从前逐字一致）──
    //
    // ⚠️ **账号必须与目标属于同一个 Harness**。
    // 不加这条校验的后果是实测出来的：`agy` + `qoder-cn-a` 会把这个 Qoder 账号的配置目录
    // 硬塞给 agy，任务直接 `status=error`、回复为空 —— 而且没有任何提示说明原因。
    // 所以这里**显式拒绝**，并说明该账号属于哪个 Harness。
    //
    // 目标名的规范身份用 `seedForTarget(target.name)?.id ?? target.name`（既有实现的原样语义）。
    // 历史缺陷记录（**已由 ② 修掉**）：`seedForTarget('qoder-cn-acct-a')` 解析不到档案，于是
    // `targetSeedId` 回落成目标名 ⇒「账号 + 它自己硬绑定的目标」被误判成「不是同一个 Harness」，
    // `/task/start` 对它一律 400（P7「2 Qoder 账号并发」的真实阻塞点）。现在这种目标在 ② 就被
    // 认成同账号并整份复用，根本走不到这一条。
    const targetSeedId = seedForTarget(target.name)?.id ?? target.name;
    if (targetSeedId !== seed.harnessId) {
        return {
            ok: false,
            reason: safe(`账号 ${accountId} 属于 Harness「${seed.harnessId}」，与目标「${target.name}」（${targetSeedId}）不是同一个 Harness，`
                + '不能把它套用到该目标上 —— 那样只会把一个无关的配置目录塞给另一个 CLI，轻则无效、重则让任务失败。'
                + `该目标可用的账号：${seeds.filter((entry) => entry.harnessId === targetSeedId).map((entry) => entry.id).join(', ') || '(无)'}`),
        };
    }
    return {
        ok: true,
        target: mergePlainAccountInto(target, launch.args, launch.env),
        // ⚠️ 这行文案会进**成功响应**（`/dispatch` 与 `/task/start` 的 `account` 字段），
        // 也会被拼进派发结果的 diagnostic。它此前原样带着 `account=<原始 id>` 与
        // `…\harness-accounts\<原始 id>\` —— 工具面早就把这份 note 脱敏了（task-tools 的
        // `account: ${redactAccountIdsInText(accountNote)}`），HTTP 出口却没有：同一个 note 两条
        // 出口两种形态。所以**在构造处**脱敏一次（所有下游自动一致；下游那次整词替换对本结果幂等）。
        // 幂等性很关键：这里换出来的 `acct:…` 标签再被整词替换器扫一遍也**不会**再变。
        note: safe(`account=${accountId} configDir=${launch.configDir} — ${launch.isolationNote}`),
    };
}
/**
 * 把「账号池默认账号」按**目标所属 Harness** 解析（唯一实现）。
 *
 * ⚠️ 判据用 `src/harness-groups.ts` 的**产品身份表**（`classifyTarget` / `classifyHarnessId`），
 * **不**用 `seedForTarget(target.name)?.id`：实测踩到过 —— 内置 WorkBuddy 账号档案的 `targetName`
 * 写成了账号 id（`workbuddy-a`，见 `src/federation/accounts.ts:162`），于是 `seedForTarget('wb-managed-a')`
 * 解析不到，回落成目标名 ⇒ 把**唯一正确的配对**（workbuddy-a × wb-managed-a）判成「不是同一个 Harness」。
 * 身份表是这一层唯一的一份实现，两边都按它归一化。
 */
export function defaultAccountForTarget(input) {
    const candidate = input.candidate.trim();
    if (candidate.length === 0)
        return { accountId: '', ignoredReason: null };
    const seed = input.seeds.find((entry) => entry.id === candidate);
    if (seed === undefined) {
        return {
            accountId: '',
            ignoredReason: `账号池里的默认账号不是本 profile 里可验证的档案 ⇒ 本次**不套用**它（既不换别的账号，也不因此让整次派发失败）`,
        };
    }
    const targetKey = classifyTarget({ name: input.targetName }).key;
    const accountKey = classifyHarnessId(seed.harnessId).key;
    if (targetKey !== accountKey) {
        return {
            accountId: '',
            ignoredReason: `账号池默认账号属于 Harness「${seed.harnessId}」，与目标「${input.targetName}」（${targetKey}）不是同一个 Harness`
                + ' ⇒ 本次**不套用**它（目标用自己的账号/全局认证；不影响这次派发）',
        };
    }
    return { accountId: candidate, ignoredReason: null };
}
/** 目标的四项启动元组是否逐字相同（命令 / headless 参数 / ACP 参数 / 环境变量）。 */
export function sameTargetTuple(left, right) {
    const normCommand = (value) => win32.normalize(value).toLowerCase();
    return normCommand(left.command) === normCommand(right.command)
        && left.args.length === right.args.length
        && left.args.every((arg, index) => arg === right.args[index])
        && left.acpArgs.length === right.acpArgs.length
        && left.acpArgs.every((arg, index) => arg === right.acpArgs[index])
        && envEqual(left.env, right.env);
}
/**
 * 目标里**属于账号**的那一部分（命令 + 参数前缀），从该目标引用的档案反推。
 *
 * ⚠️ 它**只服务比较**（`sameTargetUnbound()` 的裁剪），**不参与任何派发判定** ——
 * 判定一律走 `withAccountTarget()` / `applyAccountToTarget()` 的显式分支。
 * 之所以需要它：冻结快照里的 `targetConfig.args` 可能**已经含着**账号参数
 * （目标把账号硬绑定进 argv 的那种），直接与「当下目标」逐字比会把**同一个目标**判成不同。
 */
function accountBearing(t, seeds, homeDir) {
    for (const id of accountIdsCarriedByTarget(t)) {
        const seed = seeds.find((entry) => entry.id === id);
        if (seed === undefined)
            continue;
        const launch = resolveAccountLaunch(id, homeDir, [seed]);
        if (!launch.ok)
            continue;
        if (!commandMatchesLaunch(t, seed))
            continue;
        return { command: seed.launch.command ?? '', args: launch.args };
    }
    return { command: '', args: [] };
}
/**
 * 「目标身份」的比较口径：**剥掉账号那一层**之后逐项比对。
 *
 * 四项：目标名（必须相等）、命令、headless 参数、ACP 参数、环境变量。
 * 为什么不能直接比抹平后的整元组：冻结快照里的目标可能**已经**含账号参数
 * （`qoder-cn-acct-a` 那种把 `--config-dir` 写在 argv 里的目标），
 * 而「当下目标」是同一份配置 —— 两者只在「账号那一层是否已被合并进 args」上不同。
 */
export function sameTargetUnbound(current, frozen, seeds, homeDir) {
    if (current.name !== frozen.name)
        return false;
    const stripCurrent = accountBearing(current, seeds, homeDir);
    const stripFrozen = accountBearing(frozen, seeds, homeDir);
    // 命令：两侧都取「剥掉账号那一层」之后的归一形式（`.exe` 去尾那一条在
    // `normalizeCommandToken()` 里），避免「档案写裸名、目标写绝对路径」造成的假不等。
    const normalizedCommand = (t, strip) => strip.command.length === 0 || !commandTokenMatches(t.command, strip.command)
        ? normalizeCommandToken(t.command)
        : normalizeCommandToken(strip.command);
    if (normalizedCommand(current, stripCurrent) !== normalizedCommand(frozen, stripFrozen))
        return false;
    const stripArgs = (t, strip) => {
        if (strip.args.length === 0 || t.args.length < strip.args.length)
            return t.args;
        const head = t.args.slice(0, strip.args.length);
        const sameHead = head.every((arg, index) => arg === strip.args[index]);
        return sameHead ? t.args.slice(strip.args.length) : t.args;
    };
    const currentArgs = stripArgs(current, stripCurrent);
    const frozenArgs = stripArgs(frozen, stripFrozen);
    if (currentArgs.length !== frozenArgs.length)
        return false;
    if (!currentArgs.every((arg, index) => arg === frozenArgs[index]))
        return false;
    if (current.acpArgs.length !== frozen.acpArgs.length)
        return false;
    if (!current.acpArgs.every((arg, index) => arg === frozen.acpArgs[index]))
        return false;
    if (!envEqual(current.env, frozen.env))
        return false;
    return true;
}
/** 命令令牌的归一形式（小写 + 去 `.exe`）：档案写裸名、目标写绝对路径时靠它对齐。 */
function normalizeCommandToken(value) {
    const stripped = win32.normalize(value).toLowerCase().replace(/^\\\\\?\\/, '');
    return stripped.endsWith('.exe') ? stripped.slice(0, -4) : stripped;
}
/** 「目标声明的可执行文件」是否就是「这个命令令牌」（裸名或绝对路径都接受）。 */
function commandTokenMatches(actual, launchCommand) {
    const launch = launchCommand.trim();
    if (launch.length === 0 || actual.trim().length === 0)
        return false;
    if (win32.isAbsolute(launch))
        return win32.isAbsolute(actual) && normalizeCommandToken(launch) === normalizeCommandToken(actual);
    const normalized = normalizeCommandToken(actual);
    const bare = normalizeCommandToken(launch);
    return normalized === bare || normalized.endsWith(`\\${bare}`);
}
function envEqual(left, right) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length)
        return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
        if (leftKeys[index] !== rightKeys[index])
            return false;
        const key = leftKeys[index];
        if (left[key] !== right[key])
            return false;
    }
    return true;
}
/**
 * 把**冻结**配方合并进目标（团队成员的每一轮派发走这里）。
 *
 * 与 `withAccountTarget()` 的关系（这是本轮收口的关键一格）：
 *   · **不**按「查询时刻的账号档案」重算 —— 冻结就是冻结，档案改名/停用/删除都不得
 *     改变一位已经存在的成员（`docs/verified/team-routing.md` 的纪律）；
 *   · 但**合并规则**与 `withAccountTarget()` 同源：受管账号**整份复用**目标的完整元组，
 *     普通账号才前置（且目标若已硬绑定同一账号则整份复用，不重复注入）。
 *
 * 修复前的形状（**已确证**，见 `docs/verified/managed-account-target-fix.md` §5.0）：
 * `team-routing.ts` 的 `resolveAccountRecipe()` 走 `resolveAccountLaunch()` ⇒ 冻结下来的
 * `args` 是**相对**的 `['workbuddy-managed.cjs', <档案 id>]`；派发侧按
 * `[...frozen.args, ...found.args]` 合并 ⇒ `["workbuddy-managed.cjs", <id>, "<绝对 wrapper>", <id>, "-p"]`
 * （相对残留 1、档案 id ×2，两个 WB 账号 **2/2**）。
 *
 * @returns `ok:false` + 可读原因 = 冻结配方与该目标**不是同一个账号**（显式拒绝，不换号）。
 */
export function applyAccountToTarget(target, account, options) {
    const seed = options.seeds.find((entry) => entry.id === account.accountId);
    if (seed === undefined) {
        return {
            ok: false,
            reason: safe(`成员冻结的账号 ${redactedLabel(account.accountId)} 已不在当前生效档案里，`
                + '本次按冻结配方派发失败 —— 已创建的成员不会因此改跑别的账号，但也无法继续（这是**显式拒绝**，不是静默换号）。'),
        };
    }
    // ── 受管 bootstrap：整份复用目标的完整元组（不改 command，不动 env）──
    if (isManagedBootstrapSeed(seed)) {
        let frozenParts;
        for (const candidate of [target.args, target.acpArgs]) {
            if (candidate.length !== 3)
                continue;
            if (candidate[1] !== seed.id)
                continue;
            frozenParts = candidate;
            break;
        }
        // 目标里既没有 freeze 时的那个 id，也没有该 id 的完整元组 ⇒ 冻结配方与目标对不上。
        const idPresent = target.args.includes(seed.id) || target.acpArgs.includes(seed.id);
        if (frozenParts === undefined && !idPresent) {
            return {
                ok: false,
                reason: safe(`成员冻结的账号 ${labelOf(seed)} 与目标「${target.name}」对不上：`
                    + '受管目标的启动元组里没有这个档案 id，也不是「绝对 wrapper + 档案 id + 旗标」的完整形状 ⇒ 拒绝'
                    + '（把冻结配方硬叠上去会得到两个 wrapper、两个 id，最终跑成哪个账号由 CLI 决定）。'),
            };
        }
        const claimed = claimManagedAccountRecipe(target, seed, options.homeDir, options.seeds);
        if (!claimed.ok)
            return { ok: false, reason: safe(claimed.reason) };
        return verifyFrozenTarget(claimed.target, account, options);
    }
    // ── 目标已硬绑定**同一账号**：整份复用，不重复注入 ──
    // 配置目录优先用**冻结那一刻**的值（`account.configDir`），没有才退回按当前档案解。
    const resolvedLaunch = resolveAccountLaunch(seed.id, options.homeDir, [seed]);
    const frozenConfigDir = account.configDir !== undefined && account.configDir.length > 0
        ? account.configDir
        : (resolvedLaunch.ok ? resolvedLaunch.configDir : '');
    if (frozenConfigDir.length > 0
        && targetCarriesAccountConfigDir(target, frozenConfigDir)
        && sameAccountRecipe(target, seed, options.homeDir)) {
        return verifyFrozenTarget({ ...target, args: [...target.args], acpArgs: [...target.acpArgs], env: { ...target.env } }, account, options);
    }
    // ── 目标带着**别人**的配置目录：显式拒绝（静默串号入口）──
    const foreign = foreignAccountIdsInTarget(target, options.seeds, options.homeDir, account.accountId);
    if (foreign.length > 0) {
        return {
            ok: false,
            reason: safe(`目标「${target.name}」的启动配方里已经写着账号 ${foreign.map((id) => `‹${id}›`).join('、')} 的配置目录，`
                + `而这位成员冻结的是账号 ${redactedLabel(account.accountId)} ⇒ 拒绝（不静默换号）。`),
        };
    }
    // ── 普通路径：**逐字**保留既有语义（冻结参数前置、冻结 env 覆盖目标 env）──
    const plainMerged = mergePlainAccountInto(target, account.args, account.env);
    const frozenPlain = account.frozenTargetConfig;
    if (frozenPlain === undefined)
        return { ok: true, target: plainMerged, reused: account.args.length === 0 };
    return verifyFrozenAgainstOwnMerge(plainMerged, frozenPlain, account);
}
/**
 * 冻结配方的**错配/篡改判据**：本次要派发的目标是否仍是「冻结那一刻的那个目标」。
 *
 * 判据 = `sameTargetUnbound()`（目标名 + 剥掉账号那一层后的命令 / headless 参数 / ACP 参数 / env
 * 逐项相同）。为什么必须有它 —— 受管账号冻结下来的「账号侧参数」是**空**的
 * （完整元组本来就长在目标上），于是「冻结了一个 WorkBuddy 账号、却把它派到另一个目标上」
 * 这条路径没有任何别的判据能拦住：空参数前置到任何目标上都不会报错，
 * 结果就是**静默换了一个身份执行**（实测：`wb-managed-a` 的成员被派到 `wb-managed-ai-b`，
 * 未加这道判据时它会照跑并带上错误的账号 id）。
 *
 * 旧记录（没有 `frozenTargetConfig`）⇒ 如实跳过这一项，不据此拒绝（不吃掉既有能力）。
 */
function verifyFrozenTarget(merged, account, options) {
    const frozen = account.frozenTargetConfig;
    const reused = account.args.length === 0;
    if (frozen === undefined)
        return { ok: true, target: merged, reused };
    if (!sameTargetUnbound(merged, frozen, options.seeds, options.homeDir)) {
        return {
            ok: false,
            reason: safe(`成员冻结的目标配方与本次要派发的目标「${merged.name}」对不上`
                + `（冻结时是「${frozen.name}」；命令 / headless 参数 / ACP 参数 / 环境变量至少一项不同）⇒ 拒绝。`
                + '\n· 冻结配方是成员诞生那一刻的身份快照；按当下目标重新叠加等于**静默换目标/换账号**。'
                + '\n· 本次是**显式拒绝**：没有派发，也没有改用其它账号或目标。'),
        };
    }
    return { ok: true, target: merged, reused };
}
/**
 * 冻结配方的**错配/篡改判据**（**冻结目标 + 冻结账号**口径）。
 *
 * 与上面那条的分工：受管账号的完整元组**长在目标上**（`frozenTargetConfig` 就带着它），
 * 所以「合并结果 vs 冻结目标」是可以直接比的；而普通账号的账号参数是**叠加**上去的，
 * 「当前目标」与「冻结目标」在 `args` 上天然多一层 —— 直接比会把同一个目标判成不同
 * （这正是第一版判据的错，实测把 `qoderclicn` 的正常冻结成员拒成 502）。
 *
 * 因此普通账号这条改成：把**冻结目标**按同一套规则重新合并一次，再与本次的合并结果逐字比。
 * 两个前置条件缺一不可：
 *   · 冻结目标与当前目标**同名**（这一项永远可判）；
 *   · 合并结果的 `args` 必须以「本次账号的 args」开头（长度/内容都对得上）。
 */
function verifyFrozenAgainstOwnMerge(merged, frozen, account) {
    const reused = account.args.length === 0;
    const refuse = (why) => ({
        ok: false,
        reason: safe(`成员冻结的目标配方与本次要派发的目标「${merged.name}」对不上（${why}）⇒ 拒绝。`
            + '\n· 冻结配方是成员诞生那一刻的身份快照；按当下目标重新叠加等于**静默换目标/换账号**。'
            + '\n· 本次是**显式拒绝**：没有派发，也没有改用其它账号或目标。'),
    });
    if (merged.name !== frozen.name)
        return refuse(`冻结时是「${frozen.name}」`);
    if (!commandTokenMatches(merged.command, frozen.command))
        return refuse('可执行文件不同');
    if (merged.acpArgs.length !== frozen.acpArgs.length
        || !merged.acpArgs.every((arg, index) => arg === frozen.acpArgs[index]))
        return refuse('ACP 参数不同');
    const expected = [...account.args, ...frozen.args];
    if (merged.args.length !== expected.length
        || !merged.args.every((arg, index) => arg === expected[index]))
        return refuse('headless 参数与「冻结目标 + 冻结账号」的重放结果不同');
    const expectedEnv = { ...frozen.env, ...account.env };
    for (const [key, value] of Object.entries(merged.env)) {
        if (expectedEnv[key] !== value)
            return refuse(`环境变量 ${key} 与重放结果不同`);
    }
    for (const key of Object.keys(expectedEnv)) {
        if (merged.env[key] !== expectedEnv[key])
            return refuse(`环境变量 ${key} 缺失或被改`);
    }
    return { ok: true, target: merged, reused };
}
// ── 同 Harness 判定的**规范身份**（供需要它的调用方复用同一处语义）───────────
/** 目标名的规范 Harness 身份（`seedForTarget` 的兜底原样保留：目标名本身就是种子 id 的情况）。 */
export function harnessIdOfTarget(targetName) {
    return seedForTarget(targetName)?.id ?? targetName;
}
//# sourceMappingURL=account-target.js.map