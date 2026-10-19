/**
 * headless 通道：用 CLI 的一次性打印模式跑任务（`opencode run`、`agy --print`、
 * `claude -p`、`codex exec` …）。
 *
 * 这是最便宜、最可靠的一档：没有 TUI 解析、没有屏幕读取，stdout 就是要的结果。
 * 代价是 harness 必须支持非交互模式；不支持时自动降到 pty / cdp / window。
 */
import { spawn } from 'node:child_process';
import { buildArgv } from '../launcher.js';
import { cleanOutput } from '../text.js';
import { usableEvidenceRejection } from '../federation/providers.js';
/** 整棵进程树终止（Windows 用 taskkill /T，POSIX 用进程组）。 */
export function killTree(pid) {
    if (pid === undefined || pid <= 0)
        return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
        }
        else {
            process.kill(-pid, 'SIGKILL');
        }
    }
    catch {
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch {
            // 已经退出
        }
    }
}
/**
 * Windows 命令行长度上限（`CreateProcess` 的 `lpCommandLine`）。
 *
 * **实测**（`probe/_stdin-capability.mjs` T5，二分；零模型额度）：整条命令行
 * **32,763 字符仍成功**、**32,773 字符报 `spawn ENAMETOOLONG`** —— 与文档值 32,767 一致。
 * 门槛取 32,768：**低于它的输入今天本来就能跑**（这次改动不许把它们拒掉），
 * 高于它的输入今天**必然**失败。
 *
 * 量度就是 `argv.join(' ').length`（与 T5 同一定义）。注意它是**真实命令行的下界**：
 * 带空格/引号的参数会被 Node 再包一层引号 ⇒ 真命令行更长。取下界是为了**宁可漏判、不可误拒**
 * —— 漏判只是退回今天的行为（`spawn ENAMETOOLONG`），误拒则是把本来能跑的轮次挡掉。
 * POSIX 没有这条限制（`ARGV_LINE_LIMIT = 0` ⇒ 不启用该检查）。
 */
export const HEADLESS_ARGV_LINE_LIMIT = process.platform === 'win32' ? 32_768 : 0;
/** 一次 headless 调用的 argv / stdin 计划（含「prompt 到底走了哪条路」的如实记录）。 */
/**
 * 识别厂商 CLI「**模型被拒**」的签名（供 headless 的终止性质判定使用）。
 *
 * 实测原文（WorkBuddy CN/INTL，2026-10-14 直测该 CLI）：
 * ```
 * 400 model [gpt-6-astra] service info not found (01a13af4…/01a13af4-…)
 * Currently supported models for your account:
 *   - fast-model
 *   - balanced-model
 *   - primary-model
 *   - deep-model
 * Please use --model <model_id> to specify a valid model.
 * ```
 * ⚠️ 这条判据的必要性：该 CLI 在**模型被拒**时**仍以 0 退出** —— 只看退出码会把假成功报成 completed。
 * @returns 命中的摘录与该账号支持清单（无命中返回 undefined；**绝不猜**）。
 */
export function modelRejectionOf(output) {
    const match = /(?:^|\n)\s*(\d{3})\s+model\s+\[([^\]\r\n]{1,120})\]/.exec(output);
    if (match === null)
        return undefined;
    const headline = `HTTP ${match[1]} model [${match[2]}]`;
    const supported = [];
    const listMatch = /Currently supported models[^:\r\n]*:[ \t]*\r?\n((?:[ \t]*-[ \t]*[^\r\n]{1,120}\r?\n?)+)/i.exec(output);
    if (listMatch !== null) {
        for (const line of listMatch[1].split(/\r?\n/)) {
            const item = line.replace(/^\s*-\s*/, '').trim();
            if (item.length > 0 && item.length <= 120)
                supported.push(item);
        }
    }
    return { headline, supported: supported.slice(0, 40) };
}
/** 拼接一次 headless 调用的完整 argv（prompt 走内联旗标 / 末尾参数或 stdin）。 */
export function headlessArgv(spec) {
    const { target } = spec;
    const extra = [...(spec.extraArgs ?? [])];
    // ⚠️ prompt 内联旗标优先（2026-10-16）：`nativeCli.promptArg` 声明了 `{prompt}` 占位符
    // （如 agy 的 `['-p', '{prompt}']`）时，prompt 按占位符放进 argv —— 这类 CLI 的旗标
    // 必须紧跟参数、不吃 stdin（现场原话 `flag needs an argument: -p`）。
    const promptArg = target.nativeCli?.promptArg;
    if (promptArg !== undefined && promptArg.length > 0) {
        const inline = promptArg.map(piece => piece.replace('{prompt}', spec.prompt));
        const { verbatimArgv, launcher, verbatim } = buildArgv(target.command, [...target.args, ...inline, ...extra]);
        return {
            argv: verbatimArgv,
            resolved: launcher.resolved,
            verbatim,
            promptDelivery: 'argv',
            promptChars: spec.prompt.length,
            argvChars: verbatimArgv.join(' ').length,
        };
    }
    if (target.promptViaStdin) {
        const { verbatimArgv, launcher, verbatim } = buildArgv(target.command, [...target.args, ...extra]);
        return {
            argv: verbatimArgv,
            stdinText: spec.prompt,
            resolved: launcher.resolved,
            verbatim,
            promptDelivery: 'stdin',
            promptChars: spec.prompt.length,
            argvChars: verbatimArgv.join(' ').length,
        };
    }
    const { verbatimArgv, launcher, verbatim } = buildArgv(target.command, [...target.args, ...extra, spec.prompt]);
    return {
        argv: verbatimArgv,
        resolved: launcher.resolved,
        verbatim,
        promptDelivery: 'argv',
        promptChars: spec.prompt.length,
        argvChars: verbatimArgv.join(' ').length,
    };
}
/**
 * 「prompt 只能走 argv，而 argv 已经装不下」时的**显式拒绝**（不是静默截断）。
 *
 * 背景（实测）：`spawn` 对超长命令行是**同步抛** `ENAMETOOLONG`（不是 `error` 事件），
 * 它会直接穿透本模块的 Promise 变成 rejection，上游只看到一句 `spawn ENAMETOOLONG`。
 * 那既不解释原因，也看不出「是谁把 prompt 塞进了命令行」。
 *
 * 这里宁可**明确拒绝这一轮**，也**不**做三件被禁止的事：截断 prompt、丢弃工具 schema、
 * 偷偷换通道。目标若真支持从 stdin 读 prompt，正解是声明 `promptViaStdin: true`。
 */
function argvOverflowOutcome(spec, plan) {
    const limit = HEADLESS_ARGV_LINE_LIMIT;
    return {
        transport: 'headless',
        text: '',
        stopReason: 'error',
        diagnostic: `prompt 无法送达目标 "${spec.target.name}"：该目标未声明 promptViaStdin，prompt 只能拼进命令行，`
            + `而本次命令行约 ${plan.argvChars} 字符 ≥ 平台上限 ${limit}（Windows CreateProcess；实测 32,763 成功 / 32,773 报 ENAMETOOLONG）。`
            + `本轮 prompt 共 ${plan.promptChars} 字符。**这一轮未执行**，且**没有**截断 prompt、**没有**丢弃工具 schema、`
            + `**没有**改用别的通道或别的 harness —— 拒绝是显式的。`
            + `修法：目标 CLI 支持从 stdin 读 prompt 时给它声明 promptViaStdin: true（已实测 qoderclicn/qoder-cli 支持）。`,
        mismatch: [
            `命令行装不下 prompt（约 ${plan.argvChars} ≥ ${limit} 字符）：本轮**未执行**，不是「跑完但结果为空」。`,
            '不采用「截断历史/丢工具 schema」的降级 —— 那会让模型看不到真实上下文却仍然报成功。',
        ],
        facts: {
            promptDelivery: plan.promptDelivery,
            promptChars: plan.promptChars,
            argvChars: plan.argvChars,
            argvLimitChars: limit,
            refusedOverArgvLimit: true,
            command: plan.resolved,
        },
    };
}
/**
 * 跑一次 headless 派发；永不 reject（异常折叠成 stopReason）。
 *
 * `spec.onSpawn` 是**可选**挂钩：给了就在 `spawn()` 成功那一刻把「真实拉起的 pid +
 * 启动时刻」回报出去（这是进程池能登记"我拥有的进程"的唯一来源），并拿回一个
 * 结束回报回调（何时结束 / 退出码 / 信号 / 是否被取消）。没给也能照常跑 ——
 * 只是那时池只能等派发结果里的 facts，属于**未登记启动时刻**，会被如实标注。
 */
export async function dispatchHeadless(spec) {
    const started = Date.now();
    let plan;
    try {
        plan = headlessArgv(spec);
    }
    catch (error) {
        return {
            transport: 'headless',
            text: '',
            diagnostic: error instanceof Error ? error.message : String(error),
            stopReason: 'error',
        };
    }
    // ── prompt 装不进命令行 ⇒ 显式拒绝（不截断、不丢 schema、不换通道）──
    if (plan.promptDelivery === 'argv' && HEADLESS_ARGV_LINE_LIMIT > 0 && plan.argvChars >= HEADLESS_ARGV_LINE_LIMIT) {
        return argvOverflowOutcome(spec, plan);
    }
    return await new Promise((resolve) => {
        const child = spawn(plan.argv[0], plan.argv.slice(1), {
            cwd: spec.cwd,
            // `extraEnv`（本轮一次性）放在**最后**：它含 MCP 桥接的手递凭据，必须不被目标/档案的
            // 静态 env 覆盖 —— 否则「令牌只经子进程环境送达」会静默失效。它**从不**落盘、不进日志。
            env: { ...process.env, ...spec.target.env, ...spec.extraEnv, NO_COLOR: '1', TERM: 'dumb' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // .cmd/.bat 已经由 launcher 拼好整条命令行，必须原样交给 cmd.exe。
            windowsVerbatimArguments: plan.verbatim,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        // ── 启动生命周期事实（**实测**，不是推断）──────────────────────────────
        // 这几格存在的理由：没有它们，"我拉起的那个进程何时开始、何时结束、被谁终止"
        // 就只能靠猜；而取消/空闲回收的可观测性正是建立在这几格之上的。
        const spawnedAtMs = Date.now();
        let exitedAtMs = null;
        /** 我们主动终止它时的原因（超时 / 调用方取消）；它自己退出时保持 undefined。 */
        let killReason;
        /** 是否发出过整树终止（`killTree`）。 */
        let treeKillIssued = false;
        /** 观测挂钩本身失败时留下的如实标记（绝不影响派发本身）。 */
        let observationError;
        let exitReported = false;
        let exitReporter;
        /** 把「结束事实」回报给池：第一次为准；失败只留痕，不影响派发。 */
        const reportExit = (terminatedBy, extra = {}) => {
            if (exitReported)
                return;
            exitReported = true;
            exitedAtMs = Date.now();
            const payload = {
                at: exitedAtMs,
                terminatedBy,
                ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
                ...(extra.signal === undefined ? {} : { signal: extra.signal }),
                ...(extra.cancelled === undefined ? {} : { cancelled: extra.cancelled }),
            };
            try {
                exitReporter?.(payload);
            }
            catch (error) {
                observationError = `exit observer failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        };
        /** 发出整树终止并**记下是谁发的**（超时 / 取消 / 其它出口）。 */
        const killTreeNoted = (reason) => {
            killReason = reason;
            treeKillIssued = true;
            killTree(child.pid);
        };
        // spawn 已经成功 ⇒ 现在就把这个 pid 回报出去（**运行期**登记，不等派发结算）。
        if (child.pid !== undefined && child.pid > 0) {
            try {
                exitReporter = spec.onSpawn?.({
                    pid: child.pid,
                    channel: 'headless',
                    command: plan.resolved,
                    at: spawnedAtMs,
                    argvChars: plan.argvChars,
                }) ?? undefined;
            }
            catch (error) {
                observationError = `spawn observer failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        /**
         * 真实终止信号（退出码 / 信号名）。**只由 `close` 填写**；
         * 超时、被调用方取消、spawn 失败这三条路径不经过它 ⇒ facts 里不出现这两个字段
         * （「没测到」与「测到 0」必须能分辨）。
         */
        let exitInfo;
        const finish = (stopReason, diagnostic) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            spec.signal.removeEventListener('abort', onAbort);
            const text = cleanOutput(stdout) || cleanOutput(stderr);
            const details = [];
            if (stopReason === 'completed' && usableEvidenceRejection({ text }) !== undefined) {
                stopReason = 'error';
                details.push('harness authentication required; no model response was produced');
            }
            if (diagnostic !== undefined && diagnostic.length > 0)
                details.push(diagnostic);
            if (stderr.trim().length > 0 && text !== cleanOutput(stderr)) {
                details.push(`stderr tail: ${cleanOutput(stderr).split(/\r?\n/).slice(-4).join(' | ').slice(0, 800)}`);
            }
            resolve({
                transport: 'headless',
                text,
                ...(details.length > 0 ? { diagnostic: details.join('; ') } : {}),
                stopReason,
                facts: {
                    command: plan.resolved,
                    durationMs: Date.now() - started,
                    stdoutChars: stdout.length,
                    // 「prompt 走了哪条路、有多长、命令行多长」——这是 ENAMETOOLONG 类问题的**直接证据**，
                    // 不靠推断：`promptDelivery=stdin` ⇒ prompt 根本没进命令行。
                    promptDelivery: plan.promptDelivery,
                    promptChars: plan.promptChars,
                    argvChars: plan.argvChars,
                    stdinChars: plan.stdinText === undefined ? 0 : plan.stdinText.length,
                    argvLimitChars: HEADLESS_ARGV_LINE_LIMIT,
                    // 结构化终止事实：非 0 退出不再只体现在一句人话里（见 close 分支）。
                    ...(exitInfo === undefined || exitInfo.code === null ? {} : { exitCode: exitInfo.code }),
                    ...(exitInfo === undefined || exitInfo.signal === null ? {} : { exitSignal: exitInfo.signal }),
                    // ── 启动生命周期事实（pid 与时刻）────────────────────────────────
                    // ⚠️ 只有**真的 spawn 出了进程**才有 `pid`；没执行（例如 argv 超限显式拒绝）
                    // 时这里不会出现 pid —— 池据此知道"这一轮没有可核对的进程"，而不是"已核对干净"。
                    //
                    // 命名纪律：`pidsFromFacts()` 会把**任何键名含 `pid` 的数值字段**当成 pid，
                    // 所以时刻类字段叫 `spawnedAtMs` / `exitedAtMs`，不许叫 `pidStartedAt`。
                    ...(child.pid === undefined || child.pid <= 0 ? {} : { pid: child.pid }),
                    ...(child.pid === undefined || child.pid <= 0 ? {} : { spawnedAtMs, spawnedAt: new Date(spawnedAtMs).toISOString() }),
                    ...(exitedAtMs === null ? {} : { exitedAtMs, exitedAt: new Date(exitedAtMs).toISOString() }),
                    ...(killReason === undefined ? {} : { terminatedBy: killReason }),
                    cancelled: stopReason === 'aborted',
                    treeKillIssued,
                    ...(observationError === undefined ? {} : { spawnObserverError: observationError }),
                },
            });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killTreeNoted('timeout');
            reportExit('timeout', { cancelled: false });
            finish('timeout', `headless run exceeded ${spec.timeoutMs}ms and was terminated`);
        }, Math.max(1000, spec.timeoutMs));
        const onAbort = () => {
            killTreeNoted('caller-abort');
            reportExit('caller-abort', { cancelled: true });
            finish('aborted', 'cancelled by caller');
        };
        spec.signal.addEventListener('abort', onAbort, { once: true });
        if (spec.signal.aborted) {
            onAbort();
            return;
        }
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stdout += text;
            spec.onProgress?.(text);
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            reportExit('spawn-error', { cancelled: false });
            finish('error', `spawn failed: ${error.message}`);
        });
        // 独立于出口逻辑的**结束事实回报**：即使 `finish` 早就因为超时/取消结算过，
        // 这一条也要把真实的退出码/信号带回池（否则取消路径永远缺"它到底怎么死的"这一格）。
        child.on('close', (code, signalName) => {
            reportExit(killReason ?? 'child-exit', {
                exitCode: code,
                signal: signalName,
                ...(killReason === 'caller-abort' ? { cancelled: true } : {}),
            });
        });
        child.on('close', (code, signalName) => {
            if (settled)
                return;
            if (timedOut)
                return;
            exitInfo = { code, signal: signalName };
            // ── 终止性质判定（本轮修复的真实缺陷）─────────────────────────────
            // 修复前这里对「非 0 退出但**有** stdout」写的是 `finish('completed', …)`，
            // 于是**未登录**的 CLI（打印 `Not logged in · Please run /login` 并 exit 1）
            // 被整条链当成成功。原始证据逐字留在 `probe/out/auto-switch-live.json`：
            //   { "stopReason": "completed", "text": "Not logged in · Please run /login",
            //     "diagnostic": "harness exited with code 1 after producing output" }
            // 现在的铁律：**partial 输出一律保留**（finish 只决定 stopReason/diagnostic，
            // 绝不因为失败就丢掉 text），但非 0 退出 ⇒ `error`，被信号终止 ⇒ `aborted`。
            // 绝不允许再出现「有 stdout 就算跑完了」。
            const partialNote = stdout.trim().length === 0
                ? 'and produced no stdout'
                : 'after producing output（partial 输出已保留在 text；非 0 退出 ⇒ 本轮算失败，'
                    + '**不得**当作成功、也不得当作「模型可用」的证据）';
            // 被信号终止（外部 kill / 崩溃）：`code` 为 null，**以前会走到 `completed`**（null !== 0）。
            if (signalName !== null) {
                finish('aborted', `harness was terminated by signal ${signalName}${stdout.trim().length === 0 ? ' and produced no stdout' : `, partial output kept (${stdout.length} chars in text)`}`);
                return;
            }
            if (code === null) {
                // 既没有退出码也没有信号名：终止原因未知 —— 保守判失败，绝不报 completed。
                finish('error', `harness exited without an exit code or a signal${stdout.trim().length === 0 ? ' and produced no stdout' : `, partial output kept (${stdout.length} chars in text)`}`);
                return;
            }
            if (code !== 0) {
                // ⚠️ 这句里的 `exited with code N` 是**既有读取方**的契约：`exitCodeFromDiagnostic()`
                // （src/federation/autoswitch.ts）就靠它把退出码抽成结构化信号，措辞不得改动。
                finish('error', `harness exited with code ${String(code)} ${partialNote}`);
                return;
            }
            if (code === 0) {
                /**
                 * ⚠️ **退出码 0 ≠ 成功**（2026-10-14 实测新增的洞，来源：用户提示去参考同类实现）。
                 *
                 * WorkBuddy 的 headless 在「要求一个该账号不支持的模型」时，会打印
                 * ```
                 * 400 model [gpt-6-astra] service info not found (…)
                 * Currently supported models for your account:
                 *   - fast-model
                 *   …
                 * Please use --model <model_id> to specify a valid model.
                 * ```
                 * 并**以 0 退出**。只判退出码就会把「模型被拒」报成 `completed` —— 正是最坏的那种假成功。
                 * 这里把厂商的拒绝签名识别出来，判 `error`，并把**厂商原文给出的该账号可用模型清单**
                 * 一并写进 diagnostic（这是**按账号**的真实清单，比静态配置更权威）。
                 *
                 * ⚠️ 必须**stdout + stderr 一起判**：实测这条 400 是打到 **stderr** 的
                 * （`stdoutChars=0`），只判 stdout 时端到端仍然报 `completed`（第一版就这样漏了，已复核修正）。
                 */
                const rejection = modelRejectionOf(`${stdout}\n${stderr}`);
                if (rejection !== undefined) {
                    finish('error', `harness exited with code 0 但厂商**明确拒绝**了本次模型：${rejection.headline}。`
                        + '模型被拒不等于本轮成功 —— 退出码为 0，判据只能看输出。'
                        + (rejection.supported.length === 0
                            ? ''
                            : ` 该账号当前支持的模型（厂商原文）：${rejection.supported.join(', ')}`));
                    return;
                }
                finish('completed');
            }
        });
        if (plan.stdinText !== undefined) {
            child.stdin.end(plan.stdinText);
        }
        else {
            child.stdin.end();
        }
    });
}
//# sourceMappingURL=headless.js.map