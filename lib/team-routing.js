/**
 * **产品化团队路由**：让「Lead 在**真实产品入口**下创建的团队成员」在被外部 Harness 承接之前
 * 就拿到一份**冻结的身份快照**（Harness / 账号 / 模型），而不是靠**全局成员名匹配**去猜。
 *
 * ## 为什么需要这个模块（缺口原文，逐条对应）
 * 收尾前的接线只有 `/probe/team/*` 这一条驱动路径，且它的意图表是
 * `desired = new Map<string, TeamMemberProbeTarget>()`，**按成员名称**索引
 * （`src/index.ts` 的 `createTeamMemberProbe`）。三个后果：
 *   1. **没有 Lead/team 隔离**：两个团队的 `worker` 同名 ⇒ 后配置的覆盖前一个，
 *      成员的落点取决于「谁最后 configure」，与它实际属于哪个团队无关；
 *   2. **没有产品入口**：`configure` 只有探针 HTTP 路径能调，模型/用户没有创建身份的正式工具；
 *   3. **绑定时机是「事后补写」**：`spawn()` 里 `member.id` 是 spawn **返回之后**才知道的
 *      （子会话 id 由 `roster.js` 在插件外 `randomUUID()` 生成），所以那条路是
 *      「先诞生、后绑定」—— 首轮已经可能跑在原生供应商上了。
 *
 * ## 本模块的隔离键（**不是**全局成员名）
 * 两级、都可审计，且都**不含**「全局成员名」这一项单独成键：
 *   - **意图键** = `(leadSessionId, memberName)`：Lead 会话 id 是**团队**的身份
 *     （`agentTeams.tryMembership()` 把 `root.id` 当 TeamId，成员是它的直接子会话）；
 *     同名成员在**不同 Lead 下是两个不同条目**，互不命中。
 *   - **解析键** = `childSessionId`：一旦知道子会话 id，路由**只**认它。成员改名、
 *     团队解散、同名成员并存都不会影响已解析的条目。
 *
 * ## 首轮之前绑定怎么做到（时序，按真实 rc.2 契约）
 * `team/member` 是**团队日志**里的一条事件（`dsh-experimental-agent-team/lib/types/roster.js`：
 * `journal.appendAndFlush(root, 'team/member', { version: 2, teamId, member })`），
 * 它在 `startContinuable()` **之前**发生（`spawnAdmitted:241-262`），而成员的首个 prompt 是
 * `startContinuable` 内部 `submitMaterialized(..., delivery:'queue')` 才投递的（`:1738-1744`）。
 * 所以「收到 `team/member` ⇒ 此刻写绑定」保证绑定**早于**该成员的第一次模型请求。
 *
 * ⚠️ 两条必须说清的边界，不许读成更强的结论：
 *   · 该事件经宿主 `session/event` 转发（宿主子系统契约），**不是**本插件自己 emit 的
 *     自证信号；落地判据见 `docs/verified/team-routing.md` 的实测记录。
 *   · `agent/created` 那条**兜底**路径是「成对」的：它能拿到的只有
 *     `(childSessionId, parentSessionId)`，**成员名要靠 Lead 日志反查**；拿不到就不绑，
 *     并且**不猜**（不按模糊名字命中）。
 *
 * ## 与产品改道链路的关系（决定「外部 CLI 真的被调用」）
 * 本模块**不**自己执行外部 CLI，它只产出 `SessionBinding` 并交给**已经产品化、已实测**的
 * 请求层改道：`src/llm-adapter.ts` 在 `agent/request` 瀑布上读 `bindingFor(sessionId)`，
 * 命中 `harnessKind==='external'` ⇒ 把该轮 provider/model 改写为 `pilot-cli` + 目标名；
 * `streamFor()` 再把该轮交给 `src/index.ts` 注入的 `dispatch`（真实 launcher 子进程）。
 * **账号与模型因此同时可用**：账号走 `streamFor` 的 `accountId`（`selection.accountId` ←
 * 本条绑定的 `accountId`），模型走 `binding.model`（`resolveDispatchDefaults`）。
 *
 * ⚠️ **不实现 `prepareContinuable`**（理由见 `src/provider.ts` 文件头 36-43 行，本轮复核后
 * 结论不变）：`ContinuableCreateRequest` 的字段是 `sessionId / parent / signal`，
 * `ContinuableStartSpec.request` 又是 `Omit<SubagentStartRequest, …>`，**两处都没有账号字段**；
 * 而 `startContinuable` 的产物是**宿主自己的 continuable child**（`activations.materialize`
 * 造 DSH 会话、`submitMaterialized` 投递首轮）。一次性外部 CLI 派发器伪装成它，只会得到
 * 「`spawn_teammate` 成功、外部 CLI 一次不被调用」——用户已实测并明确禁止。本模块走的是
 * 「原生 spawn + 产品路由服务」那条路。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeBinding } from './federation/binding.js';
import { redactAccount, resolveAccountLaunch } from './federation/poolconfig.js';
import { accountAliasRefusal, redactProviderNames } from './provider.js';
// ⚠️ **账号 → 目标」的唯一来源**：本模块**不再**自己拼合并规则，也不自己写第二份
// 配方校验。`src/account-target.ts` 是那一处（受管完整元组认领 / 硬绑定目标整份复用 /
// 同 Harness 判定 / 全部文案脱敏），`provider.ts` 的别名注册也走它。
// 依赖方向：`index.ts → team-routing.ts → account-target.ts → provider.ts`（单向，无回路）。
import { isManagedBootstrapSeed, withAccountTarget, } from './account-target.js';
/** 意图键：**团队**(Lead 会话) + 成员名。两个团队的同名成员在这里天然是两条。 */
export function teamIntentKey(leadSessionId, memberName) {
    return `${leadSessionId}\u0000${memberName}`;
}
/**
 * 把「冻结的模型 id」变成**真的会进命令行**的参数。
 *
 * ## 为什么需要这一步（本轮实测抓到的第二个静默丢弃）
 * 目标自己的 `modelArgs` 是这个插件唯一会用的模型注入机制（`sessions.ts` 的
 * `withModel()`：`modelArgs.map(piece => piece.replace('{model}', chosen))`）。
 * 但**本机这些 qoder 目标的 `modelArgs` 是空的**（实测：`headlessArgv` 拼出来只有
 * `--config-dir … -p`），于是「冻了个模型」这句话在 argv 上**什么也没发生** ——
 * 这正是用户禁止的「静默丢 `model`」。
 *
 * 这里补上**已实测**的落点：该 CLI 自己的模型开关是 `-m, --model <model>`
 * （`qoderclicn --help`），且**真的生效**（实测：`--model Qwen3.8-Flash` 被接受；
 * `--model definitely-not-a-model-xyz` ⇒ **exit 42** 并列出可用模型）。
 * 也就是说「模型被真的用了」与「模型非法」两件事都由 CLI 自己**响亮**地判，不靠猜。
 *
 * ⚠️ 只在目标**没有**声明 `modelArgs` 时才补：目标声明了就走目标那条（不重复注入，
 * 那会变成两个模型开关，谁生效取决于 CLI —— 与账号的重复 `--config-dir` 是同一类错误）。
 */
export function modelArgsFor(target, model) {
    if (model === undefined || model.length === 0)
        return [];
    if (target.modelArgs.length > 0)
        return []; // 交给 `withModel()`
    return ['--model', model];
}
/**
 * 账户解算器：**再导出唯一来源**（`src/account-target.ts` 的 `resolveAccountRecipe()`）。
 *
 * 历史：这里曾自己拼一份（`resolveAccountLaunch` + 手工组装 recipe），而它产出的 `args`
 * 对受管账号是**相对**的 `['workbuddy-managed.cjs', <档案 id>]` —— 派发侧再前置到已经是
 * 完整元组的目标参数前面，就拼出「两个 wrapper、两个 id」（两个 WB 账号 2/2，见
 * `docs/verified/managed-account-target-fix.md` §5.0）。
 * 现在这里只是**同一个函数**的再导出：「账号 → 启动配方」在全仓只有一处实现。
 */
export { resolveAccountRecipe } from './account-target.js';
/**
 * 冻结的**账号侧**贡献 —— 即「派发侧要叠加到目标上的那一份」。
 *
 * 三态，与 `applyAccountToTarget()` 的分支**一一对应**（必须对应：否则「冻结了什么」与
 * 「派发时叠加什么」会错位，那就是本文件历史上 `[...frozen.args, ...found.args]` 缺陷的同类形状）：
 *   · **整份复用**（受管 bootstrap / 目标已按真实完整配方带着同一账号）⇒ **空**：
 *     账号侧新增参数为 0，派发侧按 `frozenTargetConfig` 复现完整元组（不叠加、不重复注入）；
 *   · **普通合并** ⇒ 账号档案自己的启动参数与环境变量（`withAccountTarget()` 在**空目标**上的产物，
 *     与真目标上的判定同源，所以两条路不可能给出不同的账号侧）；
 *   · 空目标上解不出来（调用方注入了只看真目标的解算器）⇒ 按「已合并目标 = 账号参数 + 原目标参数」
 *     做**差分**兜底（剥掉原目标那一段）。
 *
 * ⚠️ 这里**不复制**任何合并规则：判断交给 `account-target.ts` 那一处。
 */
function accountSideOf(target, applied, accountId, seeds, homeDir, resolveRecipe) {
    // 受管 bootstrap：账号**没有**「自己那一份 argv」——完整元组本来长在目标上，
    // 冻结算账侧的**新增**参数就是空。显式写出来，避免下游把「空」误读成「没账号」。
    const seed = seeds.find((entry) => entry.id === accountId);
    if (seed !== undefined && isManagedBootstrapSeed(seed))
        return { args: [], env: {}, reused: true };
    // 真目标上已经「整份复用」（硬绑定同一账号）⇒ 账号侧同样是空。
    // 判据：`applied` 的参数与原目标**逐项相同**（没有任何账号参数被前置）。
    if (applied.args.length === target.args.length
        && applied.args.every((arg, index) => arg === target.args[index])) {
        return { args: [], env: {}, reused: true };
    }
    const probe = { ...target, args: [], acpArgs: [], env: {} };
    const accountOnly = withAccountTarget({
        target: probe,
        accountId,
        seeds,
        homeDir,
        ...(resolveRecipe === undefined ? {} : { resolveRecipe }),
    });
    if (accountOnly.ok)
        return { args: [...accountOnly.target.args], env: { ...accountOnly.target.env }, reused: false };
    // 空目标上解析不出来（调用方注入了只看真目标的解算器）⇒ 差分兜底：
    // 已合并目标的参数必然以「账号参数 + 原目标参数」开头，剥掉原目标那一段即可。
    const merged = applied.args;
    const prefixLength = merged.length - target.args.length;
    const args = prefixLength > 0 && target.args.every((arg, index) => merged[prefixLength + index] === arg)
        ? merged.slice(0, prefixLength)
        : [];
    const env = {};
    for (const [key, value] of Object.entries(applied.env)) {
        if (probe.env[key] !== value)
            env[key] = value;
    }
    return { args, env, reused: false };
}
/** 路由表：**产品**团队身份的唯一权威处（探针不再参与产品判定）。 */
export class TeamRoutingTable {
    deps;
    intents = new Map();
    routes = new Map();
    events = [];
    seq = 0;
    constructor(deps) {
        this.deps = deps;
        if (deps.stateFile !== undefined)
            this.load(deps.stateFile);
    }
    // ── 审计 ────────────────────────────────────────────────────────────────
    /** 追加一条记录。**同步**：判定依据是先后顺序，异步落盘会把先后变成猜测。 */
    log(event, detail) {
        const entry = {
            time: (this.deps.now?.() ?? new Date()).toISOString(),
            seq: ++this.seq,
            event,
            ...(detail === undefined ? {} : { detail }),
        };
        this.events.push(entry);
        if (this.events.length > 500)
            this.events.splice(0, this.events.length - 500);
        // 同时给插件 logger 一条人话：内存环形缓冲只服务 HTTP 查询，进程日志才是崩溃后还能看的。
        this.deps.log?.(`team-routing: ${event} ${detail === undefined ? '' : JSON.stringify(detail)}`);
        return entry;
    }
    logs(limit = 200) {
        return this.events.slice(-Math.max(1, limit));
    }
    /** 某次 spawn 观测到的 `seq` 水位 —— 用于「这一步到底写没写」的取证。 */
    seqWatermark() {
        return this.seq;
    }
    // ── 意图（spawn 之前）────────────────────────────────────────────────────
    /**
     * 校验并冻结一次成员身份。**必须在 `spawnTeammate` 之前调用。**
     *
     * 位置纪律（与 provider.ts 的别名判活同级）：判活发生在**任何副作用之前**，
     * 判定失败 ⇒ 返回可读原因，调用方**不得**继续 spawn（「停用/删除账号 ⇒ 新建拒绝」就落在这里）。
     *
     * `async` 是因为模型清单校验要读该 CLI 自己报出的清单 —— 那是**唯一**能判
     * 「这个模型该 CLI 认不认」的依据，不能靠猜。
     */
    async prepare(input) {
        const target = this.deps.config.resolvedTargets.find((entry) => entry.name === input.target);
        if (target === undefined) {
            return {
                ok: false, code: 'UNKNOWN_TARGET',
                reason: `未知 Harness 目标「${input.target}」；已知：`
                    + `${this.deps.config.resolvedTargets.map((entry) => entry.name).join(', ') || '(无)'}`,
            };
        }
        // 只有 `transport=auto`（一次性 CLI 阶梯）的目标才能承接**每一轮**模型请求：
        // cdp / 窗口级目标是交互式的，拿它做「每轮一次调用」在语义上就是错的
        // （与 `pilotCliTargets()` 的排除理由同一句）。
        if (target.transport !== 'auto') {
            return {
                ok: false, code: 'TARGET_NOT_DISPATCHABLE',
                reason: `Harness 目标「${target.name}」的 transport=${target.transport}，不是可逐轮派发的 'auto' 阶梯；`
                    + '团队成员的每一轮模型请求都必须能被外部 CLI 承接，所以这里**显式拒绝**而不是悄悄降级。',
            };
        }
        // 团队身份：成员是 Lead 的**直接子会话**，所以父会话 id 必须与 Lead 会话 id 一致。
        // 这条是「不使用全局成员名匹配」的落地检查 —— 没有它，任何会话都能声称自己是任何团队的 Lead。
        if (input.parentSessionId !== undefined && input.parentSessionId !== input.leadSessionId) {
            return {
                ok: false, code: 'NOT_TEAM_LEAD_SESSION',
                reason: `调用方不是它自己声明的那个团队 Lead：Lead 会话=${input.leadSessionId}，`
                    + `而本次调用的父会话=${input.parentSessionId}。成员的父会话必须是 Lead 本身。`,
            };
        }
        const key = teamIntentKey(input.leadSessionId, input.memberName);
        if (this.intents.has(key)) {
            return {
                ok: false, code: 'DUPLICATE_MEMBER_INTENT',
                reason: `本团队（Lead 会话 ${input.leadSessionId}）已有成员「${input.memberName}」的未决身份，`
                    + '本次不重复创建（同名成员在同一团队内本就由宿主判为 TEAM_MEMBER_NAME_TAKEN）。',
            };
        }
        const seeds = this.deps.accountSeeds();
        let account;
        if (input.accountId !== undefined && input.accountId.length > 0) {
            const accountId = input.accountId;
            // 判活用 provider.ts 那**唯一**一份实现（「不在当前生效档案里」＝已停用/删除）。
            const refusal = accountAliasRefusal(target, accountId, { accounts: this.deps.accountSeeds, homeDir: this.deps.homeDir() });
            if (refusal !== undefined) {
                this.log('prepare.refused', { member: input.memberName, detail: { code: 'ACCOUNT_REFUSED', account: redactAccount(accountId), target: target.name } });
                return { ok: false, code: 'ACCOUNT_REFUSED', reason: refusal };
            }
            const seed = seeds.find((entry) => entry.id === accountId);
            if (seed === undefined) {
                return {
                    ok: false, code: 'ACCOUNT_REFUSED',
                    reason: `账号档案 ${redactAccount(accountId)} 不在当前生效档案里（已停用或删除）—— 本次是**显式拒绝**，不回退到别的账号。`,
                };
            }
            // ── 配方：**委派给唯一来源**（`src/account-target.ts` 的 `withAccountTarget()`）──
            //
            // 这里此前自己写了一份「同 Harness 判定 + resolveAccountRecipe」，而后**冻结**下来的
            // 只是 `resolveAccountLaunch()` 的结果。两处后果（都已确证并修掉）：
            //   · 受管账号（WorkBuddy）的冻结 `args` 是**相对**的 `['workbuddy-managed.cjs', <id>]`，
            //     派发侧前置到已经是完整元组的目标参数前面 ⇒「两个 wrapper、两个 id」；
            //   · 「同 Harness」的判据（`seedForTarget` + 名字回落）与派发侧**不是同一份**，
            //     于是「账号 + 它自己硬绑定的目标」在两条入口上得到相反结论。
            //
            // 现在判定与配方都来自那一处：受管账号**整份复用**目标元组、目标已按真实完整配方
            // 带着同一账号（Qoder 型硬绑定目标）也**整份复用**、其余才前置；不匹配一律显式拒绝。
            // 冻结的形状仍是 `FrozenAccountRecipe`（args = **账号侧新增的参数**、env = 账号侧环境变量），
            // 与派发侧 `applyAccountToTarget()` 的合并语义逐字对应。
            //
            // ⚠️ 与 `provider.ts` 的 `accountAliasRefusal()` **两层分工**（都在，不重复）：
            // 那一层是**纯函数判活**（该账号此刻还在不在、有没有额外停用原因），产出的是
            // 「已停用/删除」那条最准确的文案；本层回答「这个账号能不能用在这个目标上、
            // 以及它的启动配方是什么」。两层都必须过，任一不过都是显式拒绝。
            const appliedAccount = withAccountTarget({
                target,
                accountId,
                seeds,
                homeDir: this.deps.homeDir(),
                ...(this.deps.resolveAccount === undefined ? {} : { resolveRecipe: this.deps.resolveAccount }),
            });
            if (!appliedAccount.ok) {
                this.log('prepare.refused', { member: input.memberName, detail: { code: 'ACCOUNT_RECIPE_FAILED', account: redactAccount(accountId), target: target.name } });
                return { ok: false, code: 'ACCOUNT_REQUIRES_POOL_HARNESS', reason: appliedAccount.reason };
            }
            // 冻结 = 「账号侧那一份」。两条分支都由 `withAccountTarget()` 判定：
            //   · 整份复用（受管 / 目标已硬绑定同一账号）：账号侧新增参数为**空** ⇒
            //     成员每一轮直接复用目标自己的完整元组（`applyAccountToTarget()` 会认出来）；
            //   · 普通合并：账号档案的参数与环境变量 —— 与从前逐字一致。
            const accountSide = accountSideOf(target, appliedAccount.target, accountId, seeds, this.deps.homeDir(), this.deps.resolveAccount);
            const launch = resolveAccountLaunch(accountId, this.deps.homeDir(), seeds);
            account = {
                accountId,
                label: redactAccount(accountId),
                args: accountSide.args,
                env: accountSide.env,
                // `reused` 只用于**审计文案**（团队路由事件里能看出这一条是「整份复用」还是「普通合并」）：
                // 它对派发结果没有任何影响 —— 合并本身由 `applyAccountToTarget()` 按冻结的目标本体重放。
                configDir: launch.ok ? launch.configDir : seed.configDir,
                isolationNote: launch.ok
                    ? `${launch.isolationNote}${accountSide.reused ? '（本目标已按真实完整配方带着这个账号：整份复用，未重复注入）' : ''}`
                    : `配置目录按档案隔离，但**认证存储未随它隔离** —— ${seed.isolation.disclosure}`,
            };
        }
        // ── 模型：**不许静默丢弃**，也不许拿一个该 CLI 根本没有的模型去建成员 ──
        // 三态，全部落在「说了就要做到」上：
        //   · 真的能读到该 CLI 的模型清单 且 模型不在其中 ⇒ **显式拒绝**（不建成员）；
        //   · 读到清单 且 模型在其中 ⇒ 通过，随后由 `modelArgsFor()` 真的把它写进命令行；
        //   · 读不到清单（CLI 不报错但给不出） ⇒ **不据此拒绝**（那会把「没测到」当「不存在」），
        //     模型照传；合法性最终由 CLI 自己响亮地判（实测：非法模型 ⇒ exit 42 + 可用清单）。
        let modelNote = { model: input.model ?? null, checked: false };
        if (input.model !== undefined && input.model.length > 0) {
            if (this.deps.knownModels !== undefined) {
                try {
                    const offered = await this.deps.knownModels(target);
                    const usable = offered.filter((entry) => entry.length > 0);
                    modelNote = {
                        model: input.model,
                        checked: true,
                        offeredCount: usable.length,
                        offeredSource: this.deps.knownModelsSource ?? '(未说明)',
                        inList: usable.includes(input.model),
                        // 清单为空 ⇒ 该 CLI 这一格**没给出**可用模型：不据此拒绝（见上）。
                        refused: usable.length > 0 && !usable.includes(input.model),
                    };
                    if (usable.length > 0 && !usable.includes(input.model)) {
                        this.log('prepare.refused', { member: input.memberName, detail: { code: 'MODEL_NOT_OFFERED', ...modelNote } });
                        return {
                            ok: false, code: 'MODEL_NOT_OFFERED',
                            reason: `模型「${input.model}」不在 Harness「${target.name}」**自己报出**的模型清单里`
                                + `（来源：${this.deps.knownModelsSource ?? '(未说明)'}，共 ${usable.length} 个）⇒ 本次**显式拒绝**，`
                                + '没有创建任何成员。可用的有：' + usable.slice(0, 24).join(', ')
                                + (usable.length > 24 ? ` …（共 ${usable.length} 个）` : '')
                                + '\n本次**不**静默丢弃 model，也**不**用一个该 CLI 不认的模型去建成员。',
                        };
                    }
                }
                catch (error) {
                    modelNote = { model: input.model, checked: false, readError: error instanceof Error ? error.message : String(error) };
                }
            }
            this.log('prepare.model-check', { member: input.memberName, detail: { target: target.name, ...modelNote } });
        }
        const frozen = {
            target: target.name,
            targetConfig: target,
            ...(account === undefined ? {} : { account }),
            ...(input.model === undefined || input.model.length === 0 ? {} : { model: input.model }),
            frozenAt: (this.deps.now?.() ?? new Date()).toISOString(),
        };
        const intent = {
            key,
            leadSessionId: input.leadSessionId,
            memberName: input.memberName,
            description: input.description ?? `harness ${target.name}`,
            context: input.context ?? 'fresh',
            provider: input.provider,
            frozen,
            createdAt: frozen.frozenAt,
        };
        this.intents.set(key, intent);
        this.log('prepare.accepted', {
            detail: {
                member: input.memberName,
                leadSessionId: input.leadSessionId,
                target: target.name,
                account: account === undefined ? null : account.label,
                model: frozen.model ?? null,
                accountApplied: account !== undefined,
                modelApplied: frozen.model !== undefined,
                provider: input.provider,
            },
        });
        return {
            ok: true,
            intent,
            spec: {
                target: target.name,
                account: account === undefined ? null : account.label,
                model: frozen.model ?? null,
                accountApplied: account !== undefined,
                modelApplied: frozen.model !== undefined,
            },
        };
    }
    /** 撤销一份未决意图（spawn 失败时**必须**调；否则会留下一个永不兑现的身份）。 */
    abortIntent(leadSessionId, memberName, reason) {
        const key = teamIntentKey(leadSessionId, memberName);
        const had = this.intents.delete(key);
        this.log('intent.aborted', { detail: { member: memberName, leadSessionId, removed: had, reason } });
        return had;
    }
    pendingIntents() {
        return [...this.intents.values()].map((intent) => ({
            key: intent.key,
            leadSessionId: intent.leadSessionId,
            memberName: intent.memberName,
            target: intent.frozen.target,
            resolved: this.routes.has(intent.childSessionId ?? ''),
        }));
    }
    // ── 解析（绑定写入）─────────────────────────────────────────────────────
    /**
     * 用 **(Lead 会话, 成员名)** 解析并**立刻写入**绑定。
     *
     * 这是主路径：`team/member` 事件带齐三项，且发生在成员首轮之前。
     */
    resolveByIntent(input) {
        const key = teamIntentKey(input.leadSessionId, input.memberName);
        const intent = this.intents.get(key);
        if (intent === undefined) {
            // 这里**不**做任何模糊匹配：这是「不使用全局成员名匹配」的硬纪律。
            return {
                reason: `团队（Lead 会话 ${input.leadSessionId}）没有成员「${input.memberName}」的身份意图 —— `
                    + '不猜、不按名字跨团队命中。',
            };
        }
        return this.commit(intent, input.childSessionId, input.via);
    }
    /**
     * 兜底路径：只知道 `(childSessionId, parentSessionId)`，成员名由调用方**反查**得到。
     *
     * 与主路径的区别是「成员名从哪来」；**隔离键不变** —— 仍然是 `(Lead 会话, 成员名)` 两级，
     * 因为没有成员名就无从在该 Lead 下定位意图（宁可**不绑**，也不猜）。
     *
     * `memberName` 不给时走 `deps.resolveChild` 反查（宿主自己的已落盘事实）；反查不到
     * **保持未绑**并记一条 `resolve.deferred` —— 后续仍可由主路径补上。
     */
    resolveByChild(input) {
        // 已经解析过的子会话**保持原样**：冷恢复会再次触发 `agent/created`，
        // 重写只会把 `setAt` 推后、让「绑定有没有被盲目重放」这类判据失真，而值本来就一样。
        const existing = this.routes.get(input.childSessionId);
        if (existing !== undefined) {
            this.log('resolve.kept', { detail: { childSessionId: input.childSessionId, member: existing.memberName, target: existing.target, via: input.via } });
            return { binding: existing.binding, route: existing };
        }
        let memberName = input.memberName;
        let via = input.via;
        if (memberName === undefined) {
            const found = this.deps.resolveChild?.(input.childSessionId, input.parentSessionId);
            memberName = found?.memberName;
            if (memberName !== undefined && found?.via !== undefined)
                via = found.via;
            if (memberName === undefined) {
                this.log('resolve.deferred', {
                    detail: {
                        childSessionId: input.childSessionId,
                        parentSessionId: input.parentSessionId,
                        via: input.via,
                        reason: '成员名反查不到 ⇒ 不绑（不按模糊名字跨团队命中）',
                    },
                });
                return { reason: 'member-name-not-resolvable' };
            }
        }
        return this.resolveByIntent({
            leadSessionId: input.parentSessionId,
            memberName,
            childSessionId: input.childSessionId,
            via,
        });
    }
    commit(intent, childSessionId, via) {
        // ── 幂等：同一份意图对**同一个**子会话只写一次 ──
        // 本轮真机实测抓到的现象：`team/member`（seq 1/2）先写好，随后 `agent/created`
        // 兜底路径又来一次（seq 3），两次内容**完全相同**，只是 `setAt` 被推后 2.5 秒。
        // 后果不是功能错，而是**判据失真**：「绑定早于首轮」这句话在日志里变成两条，
        // 且第二条的时间戳落在成员首轮**之后** —— 读的人完全可能据此得出相反结论。
        // 冷恢复时重写还会把 `setAt` 一直往后推，让「绑定有没有被盲目重放」也判不出来。
        if (intent.childSessionId === childSessionId && this.routes.has(childSessionId)) {
            const kept = this.routes.get(childSessionId);
            this.log('resolve.kept', {
                detail: {
                    childSessionId,
                    member: kept.memberName,
                    leadSessionId: kept.leadSessionId,
                    target: kept.target,
                    via,
                    mechanism: 'same intent already resolved for this child — the frozen snapshot is NOT rewritten',
                    setAt: kept.binding.setAt,
                },
            });
            return { binding: kept.binding, route: kept };
        }
        const frozen = intent.frozen;
        const binding = makeBinding({
            sessionId: childSessionId,
            // `harnessId` = 目标名：请求层改道把它当 `model`（`pilot-cli` + 目标名）。
            harnessId: frozen.target,
            // ⚠️ 关键一处：`accountId` 必须进绑定。请求层 `streamFor()` 取的是
            // `selection.accountId ?? bindingFor(sessionId)?.accountId`，而改道路径**不**传
            // `selection.accountId`（`routeDecisionFor` 只产出 provider/model），所以**绑定里的
            // accountId 就是这条路上唯一的账号来源** —— 这也是「account 与 model 同时可用」的落点。
            ...(frozen.account === undefined ? {} : { accountId: frozen.account.accountId }),
            provider: 'pilot-cli',
            ...(frozen.model === undefined ? {} : { model: frozen.model }),
        }, frozen.frozenAt);
        const route = {
            childSessionId,
            leadSessionId: intent.leadSessionId,
            memberName: intent.memberName,
            target: frozen.target,
            ...(frozen.account === undefined ? {} : { accountId: frozen.account.accountId, accountLabel: frozen.account.label }),
            ...(frozen.model === undefined ? {} : { model: frozen.model }),
            binding,
            via,
            resolvedAt: (this.deps.now?.() ?? new Date()).toISOString(),
            frozen,
        };
        this.routes.set(childSessionId, route);
        intent.childSessionId = childSessionId;
        intent.resolvedVia = via;
        if (this.deps.writeBinding !== undefined) {
            try {
                this.deps.writeBinding(binding);
            }
            catch (error) {
                // 落盘失败**不得**让路由失效：内存表才是运行期判据；但必须如实记一条，
                // 因为「冷恢复能不能读到」完全取决于这次落盘。
                this.log('binding.persist-failed', { detail: { childSessionId, error: error instanceof Error ? error.message : String(error) } });
            }
        }
        this.persist();
        this.log('resolve.written', {
            detail: {
                childSessionId,
                member: intent.memberName,
                leadSessionId: intent.leadSessionId,
                target: frozen.target,
                account: frozen.account === undefined ? null : frozen.account.label,
                model: frozen.model ?? null,
                via,
                setAt: binding.setAt,
            },
        });
        return { binding, route };
    }
    /** 冷恢复：**读已绑定的快照**（不重算、不按当下配置重新决定身份）。 */
    resolve(sessionId) {
        const route = this.routes.get(sessionId);
        if (route === undefined)
            return { reason: 'not-in-team-routing-table' };
        return { binding: route.binding, route };
    }
    /** 面向查询的只读快照（按钮/文案一律用 `accountLabel`，不出原始 id）。 */
    snapshot() {
        return [...this.routes.values()];
    }
    /**
     * 该会话此刻的冻结配方（账号 args/env + 目标配置 + 固定模型）。
     *
     * 用途：派发侧想**严格**按冻结配方执行时取它 —— 不按查询时刻的账号档案重算。
     * `undefined` = 这个会话不在路由表里。
     *
     * 取值顺序体现了上面 `TeamRoute.frozen` 那条教训：**先读记录自带的配方**
     * （它落过盘、冷恢复也在），内存意图只作为同进程内的补充来源。
     */
    frozenRecipeOf(sessionId) {
        const route = this.routes.get(sessionId);
        if (route === undefined)
            return undefined;
        if (route.frozen !== undefined && route.frozen !== null)
            return route.frozen;
        const intent = this.intents.get(teamIntentKey(route.leadSessionId, route.memberName));
        return intent?.frozen;
    }
    // ── 落盘 / 冷启动 ───────────────────────────────────────────────────────
    load(file) {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            let skipped = 0;
            for (const [sessionId, route] of Object.entries(raw.routes ?? {})) {
                // 判据是「这条记录**自足**」：没有 `binding` 就没法路由，没有 `frozen` 就没法按
                // 冻结配方派发。缺任一条都**不静默收下** —— 收下只会得到一个「看着在册、
                // 一派发就被拒」的幽灵条目（本轮实测踩过，见 `TeamRoute.frozen` 注释）。
                if (route === null || typeof route !== 'object'
                    || typeof route.binding !== 'object'
                    || route.frozen === undefined) {
                    skipped += 1;
                    continue;
                }
                this.routes.set(sessionId, route);
            }
            this.log('state.loaded', { detail: { routes: this.routes.size, skipped, file } });
            if (skipped > 0) {
                this.deps.log?.(`team-routing: ${skipped} persisted route(s) were skipped as non-self-contained (missing binding or frozen recipe) — they would have been unusable for dispatch`);
            }
        }
        catch (error) {
            // 首次运行没有文件是正常的；但**读到了却读不动**必须喊出来（不许静默当成空表：
            // 那会让「重启后成员身份丢了」看起来像「本来就没有成员」）。
            const code = error?.code;
            if (code !== 'ENOENT') {
                this.deps.log?.(`team-routing: could not load ${file} — starting with an empty routing table: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    persist() {
        const file = this.deps.stateFile;
        if (file === undefined)
            return;
        try {
            mkdirSync(dirname(file), { recursive: true });
            const state = {
                version: 1,
                routes: Object.fromEntries(this.routes),
                updatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
            };
            writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        }
        catch (error) {
            this.log('state.persist-failed', { detail: { error: error instanceof Error ? error.message : String(error) } });
        }
    }
    /** 默认落盘位置（插件 home 下，与 `session-bindings.json` 同目录、**不同文件**）。 */
    static defaultStateFile(home) {
        return join(home, 'team-routing.json');
    }
}
/**
 * 从成员 prompt 里读成员名 —— **次选**接缝，保留作为对照。
 *
 * 工具路径的 prompt 抬头是宿主的固定文案（`tool-agent-team/lib/index.js:276-278`：
 * `You are teammate "<name>".`）。`team/member` 事件本身带 `member.name`，所以主路径
 * 用不到它；这里保留是为了在事件缺失时**仍有**一条可解释的来源，而不是让调用方去猜。
 */
export function teammateNameFromPrompt(prompt) {
    if (prompt === undefined)
        return undefined;
    for (const block of prompt) {
        const text = block;
        if (text.type !== 'text' || typeof text.text !== 'string')
            continue;
        const match = /You are teammate "([^"]+)"/.exec(text.text);
        if (match !== null && match[1].length > 0)
            return match[1];
    }
    return undefined;
}
/** 脱敏一行 provider 名（复用 provider.ts 那份实现，避免第二套脱敏规则）。 */
export function redactProviderList(names, accountIds) {
    return redactProviderNames(names, accountIds);
}
//# sourceMappingURL=team-routing.js.map