/**
 * 账号池配置 + **手动**一键切换。
 *
 * ## 为什么先做「手动」而不是「自动」
 * 自动切换依赖额度判定，而额度在本机**没有原生接口**（见 quota.ts），只能靠结构化错误，
 * 证据面较窄；手动切换则是用户明确点一下、意图无歧义。因此先把**手动**这条链路打通并验收，
 * 自动再往上接 —— 顺序反过来会先把一个判据不够硬的自动化放出去。
 *
 * ## 这个模块负责什么
 *   · 账号池配置（哪些账号在池内、是否启用、优先级、冷却、是否允许自动切换、默认账号）；
 *   · 手动切换的**决策与事件记录**（验证目标账号、算出恢复方式与交接边界、写切换账本）。
 *
 * ## 这个模块**不**负责什么（必须说清）
 *   · **不执行**真实派发，**不碰凭据**，不复制/解密任何认证文件；
 *   · 不做自动注册、获取新账号；
 *   · 登录/退出仍由各 Harness **自己的**原生流程负责。本模块只做规划与记账；
 *     真正把命令交给 CLI 的是 `accounts.ts` 的 `planNativeAuth` / `runNativeAuth`
 *     （它们调用的是 CLI 自己的 `login` / `logout` / `status` 子命令，**不自己实现登录协议**）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACCOUNT_SEEDS } from './accounts.js';
import { DEFAULT_POLICY } from './pool.js';
/** 从账号种子生成初始池：**默认不启用任何自动行为**。 */
export function defaultPoolState(at = new Date().toISOString(), seeds = ACCOUNT_SEEDS) {
    const entries = {};
    seeds.forEach((seed, index) => {
        entries[seed.id] = { enabled: false, priority: index, cooldownMs: 300_000 };
    });
    return {
        version: 1,
        autoSwitchEnabled: false,
        policy: {
            maxSwitchesPerTask: DEFAULT_POLICY.maxSwitchesPerTask,
            backoffBaseMs: DEFAULT_POLICY.backoffBaseMs,
            backoffFactor: DEFAULT_POLICY.backoffFactor,
            maxConsecutiveFailures: DEFAULT_POLICY.maxConsecutiveFailures,
            onModelUnavailable: DEFAULT_POLICY.onModelUnavailable,
        },
        entries,
        updatedAt: at,
    };
}
/**
 * 读账号池配置。
 *
 * `seeds` 传**当前生效**的账号列表（内置 ± 用户增删改）。为什么必须传：
 * 用户新加的档案如果不在补默认值的种子里，它在池里就永远没有条目，
 * 于是「新账号默认不启用」会退化成「新账号根本不出现在界面上」。
 */
export function loadPoolState(file, seeds = ACCOUNT_SEEDS) {
    const fallback = defaultPoolState(new Date().toISOString(), seeds);
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (raw.version !== 1)
            return fallback;
        const known = new Set(seeds.map((s) => s.id));
        const stored = raw.entries ?? {};
        // 已被删除的档案要**从池里移除**；否则它会以幽灵条目留在界面上。
        const entries = {};
        for (const [id, entry] of Object.entries(stored)) {
            if (!known.has(id))
                continue;
            entries[id] = entry;
        }
        return {
            version: 1,
            autoSwitchEnabled: raw.autoSwitchEnabled === true,
            ...(typeof raw.defaultAccountId === 'string' && known.has(raw.defaultAccountId)
                ? { defaultAccountId: raw.defaultAccountId }
                : {}),
            policy: { ...fallback.policy, ...(raw.policy ?? {}) },
            // 池里出现的新账号（用户新加的档案）用默认值补齐，而不是丢弃。
            entries: { ...fallback.entries, ...entries },
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : fallback.updatedAt,
        };
    }
    catch {
        return fallback;
    }
}
export function savePoolState(file, state) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
export function updatePoolState(state, patch, at = new Date().toISOString()) {
    const entries = { ...state.entries };
    if (patch.entry !== undefined) {
        const current = entries[patch.entry.accountId] ?? { enabled: false, priority: 999, cooldownMs: 300_000 };
        const models = patch.entry.models === undefined
            ? current.models
            : patch.entry.models === null
                ? undefined
                : patch.entry.models;
        entries[patch.entry.accountId] = {
            enabled: patch.entry.enabled ?? current.enabled,
            priority: patch.entry.priority ?? current.priority,
            cooldownMs: patch.entry.cooldownMs ?? current.cooldownMs,
            ...(models === undefined || models.length === 0 ? {} : { models }),
        };
    }
    if (patch.dropEntry !== undefined)
        delete entries[patch.dropEntry];
    const clearingDefault = patch.defaultAccountId === null
        || (patch.dropEntry !== undefined && state.defaultAccountId === patch.dropEntry);
    const next = {
        version: 1,
        autoSwitchEnabled: patch.autoSwitchEnabled ?? state.autoSwitchEnabled,
        ...(clearingDefault
            ? {}
            : { defaultAccountId: patch.defaultAccountId ?? state.defaultAccountId }),
        policy: { ...state.policy, ...(patch.policy ?? {}) },
        entries,
        updatedAt: at,
    };
    return next;
}
/** 账号脱敏：只保留尾部少量字符，且**不可反推**。 */
export function redactAccount(accountId) {
    const t = accountId.trim();
    if (t.length <= 4)
        return `acct:***`;
    return `acct:…${t.slice(-2)}${t.length.toString(36)}`;
}
/**
 * 手动切换的判定。**纯函数**：不 I/O、不碰凭据。
 *
 * 与自动切换共用同一批纪律：
 *   · 目标必须在启用的池内、同 Harness、区域兼容；
 *   · 目标认证**不得**为 auth-invalid（否则应当先重新登录，而不是切换）；
 *   · 额度已耗尽的目标**不是**合法目标（换过去等于白换）；
 *   · 模型保不住要**显式**回报，绝不静默换模型；
 *   · 结果不确定的写操作要**提醒先核验**，不得盲目重放。
 */
export function planManualSwitch(input) {
    if (input.toAccountId === input.fromAccountId) {
        return { ok: false, reason: '目标账号与当前账号相同，无需切换', recovery: '请选择另一个账号' };
    }
    if (input.authOfTarget === 'auth-invalid') {
        return {
            ok: false,
            reason: `目标账号认证已失效，切换过去也无法执行 —— 应当先为该账号重新登录`,
            recovery: '请先为该账号重新登录：执行该 Harness 自己的原生登录流程（本插件不代管凭据），成功后重新探测身份确认认证有效，再切换',
        };
    }
    if (input.quotaOfTarget?.state === 'exhausted') {
        return {
            ok: false,
            reason: `目标账号额度也已耗尽（${input.quotaOfTarget.reason}），换过去没有意义`,
            recovery: '改选另一个账号，或等待额度恢复',
        };
    }
    if (!input.regionCompatible && input.regionOfTarget !== input.regionOfCurrent) {
        return {
            ok: false,
            reason: `目标账号服务区域「${input.regionOfTarget}」与当前「${input.regionOfCurrent}」不兼容`,
            recovery: '请选择同区域或已声明兼容的账号',
        };
    }
    const models = input.modelsOfTarget;
    const modelPreserved = input.currentModel === undefined
        || models === undefined || models.length === 0
        || models.includes(input.currentModel);
    const recovery = input.nativeSessionResumable ? 'native-resume' : 'checkpoint-new-session';
    const boundary = input.nativeSessionResumable
        ? '该 Harness 支持原生跨账号恢复：优先用原生机制保留并恢复会话'
        : '该 Harness **不支持**跨账号恢复会话：将用可追溯、脱敏的交接检查点新建会话；'
            + '**原生历史（工具调用记录、文件状态、模型侧上下文）不会随账号迁移**，新会话只带检查点里明确写下的内容';
    const warnings = [];
    if (!modelPreserved) {
        warnings.push(`⚠️ 目标账号不支持当前模型「${input.currentModel}」，切换后**模型会改变**（不会静默发生，但你必须知道）`);
    }
    if (input.authOfTarget !== 'model-request-authorized') {
        warnings.push(`目标账号认证状态为「${input.authOfTarget}」，尚未取得「模型请求已验证」级别的证据`);
    }
    if (input.quotaOfTarget === undefined || input.quotaOfTarget.state === 'unknown') {
        warnings.push('目标账号额度状态为「未知」（该 Harness 无原生额度接口），不等于额度充足');
    }
    if (input.uncertainWriteActions !== undefined && input.uncertainWriteActions.length > 0) {
        warnings.push(`有 ${input.uncertainWriteActions.length} 个**结果不确定**的写操作（${input.uncertainWriteActions.join('、')}）：`
            + '必须先核验实际状态，**不得**因换账号而重放');
    }
    return {
        ok: true,
        fromAccount: redactAccount(input.fromAccountId),
        toAccount: redactAccount(input.toAccountId),
        recovery,
        boundary,
        modelPreserved,
        warnings,
    };
}
/** 目标账号是否在**启用的**池内。不在就不允许作为切换目标。 */
export function isEligibleTarget(state, accountId) {
    const entry = state.entries[accountId];
    if (entry === undefined)
        return { ok: false, reason: `账号 ${redactAccount(accountId)} 不在账号池配置里` };
    if (!entry.enabled)
        return { ok: false, reason: `账号 ${redactAccount(accountId)} 未启用（不在可切换的池内）` };
    return { ok: true, reason: 'ok' };
}
/**
 * 把一个账号档案解析成**可执行的启动配方**：要加的参数、要设的环境变量、以及它的配置目录。
 *
 * 这是「切换真的改变执行」的落点 —— 没有它，账号切换就只是账本上的一行字。
 *
 * 各 Harness 的隔离机制不同，`AccountSeed.launch` 如实记录了实测结论：
 *   · Qoder：`--config-dir <dir>`，且 `.auth/` 就在该目录内 → **认证真正隔离**；
 *   · WorkBuddy：配置目录可用环境变量指定，但**认证存储是厂商共享的**（不随目录变化），
 *     所以这里给的是配置目录环境变量，**不代表认证被隔离**（见 accounts.ts 的隔离披露）。
 *
 * **不碰凭据**：这里只拼参数与环境变量，从不读取、复制或解密任何认证文件。
 */
export function resolveAccountLaunch(accountId, homeDir, seeds = ACCOUNT_SEEDS) {
    const seed = seeds.find((s) => s.id === accountId);
    if (seed === undefined) {
        return { ok: false, reason: `未知账号档案 ${redactAccount(accountId)}；已知：${seeds.map((s) => s.id).join(', ')}` };
    }
    const configDir = seed.configDir.length > 0 ? seed.configDir : join(homeDir, '.dsh', 'harness-accounts', seed.id);
    const subst = (value) => value.replace(/\{configDir\}/g, configDir);
    const args = seed.launch.args.map(subst);
    const env = {};
    for (const [key, value] of Object.entries(seed.launch.env))
        env[key] = subst(value);
    // 隔离结论**只**来自该档案自己的 isolation（由 accounts.ts 的实测画像生成），
    // 不再按 launch.mode 猜 —— 猜出来的「已隔离」比不说更糟。
    const isolationNote = seed.isolation.authStoreIsolated
        ? `配置目录按档案隔离，且该 Harness 的认证存储随它变化（依据：${seed.isolation.evidence[0] ?? '实测记录'}）`
        : `配置目录按档案隔离，但**认证存储未随它隔离** —— ${seed.isolation.disclosure}`;
    return { ok: true, args, env, configDir, isolationNote };
}
export { existsSync };
//# sourceMappingURL=poolconfig.js.map