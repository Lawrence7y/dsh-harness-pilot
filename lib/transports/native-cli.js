/**
 * 结构化 CLI 适配器（最小改造执行计划 P2）。
 *
 * 五路产品入口共用**两个**协议归一化器，不为每家再造整套服务：
 *   · claude-stream-json —— WorkBuddy / WorkBuddyAI（经 assets/workbuddy-managed.cjs 受管
 *     bootstrap，原样透传）/ Qoder CN CLI（qoderclicn）。
 *       实测事件（work/cli-session-audit/ 2026-10-15）：
 *         {"type":"system","subtype":"init",...,"session_id":…}
 *         {"type":"assistant",…}
 *         {"type":"result","subtype":"success","is_error":false,"result":"…","session_id":…,
 *          "usage":{…,"request_id":…}}（Qoder 在 usage 里带 request_id；WorkBuddy 无则留空）
 *       新会话 `--session-id <uuid>`；精确恢复 `--resume <nativeId>`。
 *   · agy-jsonl —— Antigravity（agy CLI）。
 *       实测事件：
 *         {"event":"init","conversation_id":…}
 *         {"event":"step_update",…,"text_delta":…}
 *         {"event":"result","result":{"conversation_id":…,"status":"SUCCESS","response":…}}
 *       新会话由 CLI 生成 conversation id（首轮 mint）；恢复 `--conversation <id>`（**不用** --continue）。
 *
 * Qoder CN IDE 没有等价的 headless CLI（其 `bin/qodercn.cmd` 会把 CLI 参数分流到桌面 IDE，
 * 把 IDE 启动命令冒充成低内存 Headless Harness 是错的）——该入口**不声明**协议能力，
 * 保留桌面 cdp 通道，账号/额度继承如实标未验证。
 *
 * 铁律：
 *   · stdout / stderr 分开；最终回答与进度事件分开（answer 只来自 result 事件）。
 *   · 只有声明协议能力（TargetConfig.nativeCli）的目标才走本模块；旧 text CLI 路径原样保留。
 *   · 退出码 0 或非空 stdout 都**不够**判定成功：终态以结构化 result 事件为准；
 *     没有 result 事件 ⇒ error（不冒充成功）。
 *   · upstream_queued / waiting_permission 事件可见时如实带出，不折叠成 completed。
 *   · 参数一律走 argv 数组 + stdin；不拼 shell 命令；不用「绕过所有权限」掩盖接入缺陷。
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildArgv } from '../launcher.js';
import { killTree, modelRejectionOf } from './headless.js';
/** 逐行解析：claude 风格 stream-json（WorkBuddy / WorkBuddyAI / Qoder CN CLI）。 */
export function parseClaudeStreamJsonLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{'))
        return undefined;
    let raw;
    try {
        raw = JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
    const type = typeof raw.type === 'string' ? raw.type : '';
    const session = typeof raw.session_id === 'string' && raw.session_id.length > 0 ? raw.session_id : undefined;
    const requestId = (() => {
        if (typeof raw._requestId === 'string' && raw._requestId.length > 0)
            return raw._requestId;
        const usage = (raw.usage ?? undefined);
        const fromUsage = usage !== undefined && typeof usage.request_id === 'string' ? usage.request_id : undefined;
        return fromUsage !== undefined && fromUsage.length > 0 ? fromUsage : undefined;
    })();
    if (type === 'system' && raw.subtype === 'init') {
        return { kind: 'init', session };
    }
    if (type === 'result') {
        const isError = raw.is_error === true;
        const answer = typeof raw.result === 'string' ? raw.result : '';
        const status = typeof raw.subtype === 'string' ? raw.subtype : undefined;
        // 厂商在 result 里的权限拒绝清单（claude 语义：permission_denials 非空 = 本轮有被拦的操作）。
        const denials = Array.isArray(raw.permission_denials) ? raw.permission_denials.length : 0;
        return {
            kind: 'result',
            session,
            requestId,
            answer,
            isError,
            status,
            ...(denials > 0 ? { signal: 'waiting_permission' } : {}),
        };
    }
    if (type === 'assistant') {
        const message = (raw.message ?? undefined);
        const content = Array.isArray(message?.content) ? message?.content : [];
        let progress = '';
        for (const block of content) {
            const record = (block ?? undefined);
            if (record !== undefined && record.type === 'text' && typeof record.text === 'string')
                progress += record.text;
        }
        return progress.length > 0 ? { kind: 'assistant', progress, session, requestId } : { kind: 'assistant', session, requestId };
    }
    return { kind: type.length > 0 ? type : 'unknown', session, requestId };
}
/** 逐行解析：agy 风格 JSONL（Antigravity）。 */
export function parseAgyJsonLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{'))
        return undefined;
    let raw;
    try {
        raw = JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
    const event = typeof raw.event === 'string' ? raw.event : '';
    if (event === 'init') {
        const session = typeof raw.conversation_id === 'string' && raw.conversation_id.length > 0 ? raw.conversation_id : undefined;
        return { kind: 'init', session };
    }
    if (event === 'step_update') {
        const step = (raw.step_update ?? undefined);
        const delta = step !== undefined && typeof step.text_delta === 'string' ? step.text_delta : '';
        const session = step !== undefined && typeof step.conversation_id === 'string' ? step.conversation_id : undefined;
        if (delta.length > 0)
            return { kind: 'step_update', progress: delta, session };
        // 工具/等待类 step（无文本增量）也如实上报种类，供 waiting 信号识别。
        const stepType = step !== undefined && typeof step.step_type === 'string' ? step.step_type : '';
        if (/permission|approval/i.test(stepType))
            return { kind: 'step_update', signal: 'waiting_permission', session };
        return { kind: 'step_update', session };
    }
    if (event === 'result') {
        const result = (raw.result ?? undefined);
        const session = result !== undefined && typeof result.conversation_id === 'string' ? result.conversation_id : undefined;
        const answer = result !== undefined && typeof result.response === 'string' ? result.response : '';
        const status = result !== undefined && typeof result.status === 'string' ? result.status : undefined;
        const usage = (result?.usage ?? undefined);
        const requestId = usage !== undefined && typeof usage.request_id === 'string' && usage.request_id.length > 0 ? usage.request_id : undefined;
        return {
            kind: 'result',
            session,
            requestId,
            answer,
            isError: status !== undefined ? status.toUpperCase() !== 'SUCCESS' : undefined,
            status,
        };
    }
    return { kind: event.length > 0 ? event : 'unknown' };
}
/** 一次 native CLI 轮次解析的累积器（离线可测：feed 逐块喂 stdout）。 */
export class NativeCliStreamParser {
    buffer = '';
    parseLine;
    answer = '';
    sessionId;
    requestId;
    events = 0;
    signals = [];
    resultSeen = false;
    resultIsError;
    resultStatus;
    constructor(protocol) {
        this.parseLine = protocol === 'agy-jsonl' ? parseAgyJsonLine : parseClaudeStreamJsonLine;
    }
    /** 喂一段 stdout；返回本段产生的进度文本增量。 */
    feed(chunk) {
        this.buffer += chunk;
        let progress = '';
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);
            const event = this.parseLine(line);
            if (event !== undefined) {
                this.events += 1;
                if (event.session !== undefined)
                    this.sessionId = event.session;
                if (event.requestId !== undefined)
                    this.requestId = event.requestId;
                if (event.progress !== undefined)
                    progress += event.progress;
                if (event.signal !== undefined)
                    this.signals.push(event.signal === 'waiting_permission' ? 'waiting_permission' : 'upstream_queued');
                if (event.kind === 'result') {
                    this.resultSeen = true;
                    this.answer = event.answer ?? '';
                    this.resultIsError = event.isError;
                    this.resultStatus = event.status;
                }
            }
            index = this.buffer.indexOf('\n');
        }
        return progress;
    }
    /** 终态判据（退出码只是辅助；result 事件才是权威）。 */
    terminal() {
        if (!this.resultSeen) {
            return {
                runState: 'failed',
                answer: '',
                diagnostic: '结构化流结束但没有 result 终态事件 —— 退出码不能替代结构化终态，本轮按失败处理（不冒充成功）',
            };
        }
        if (this.resultIsError === true) {
            return {
                runState: 'failed',
                answer: this.answer,
                diagnostic: `厂商 result 事件报告失败（status=${this.resultStatus ?? '未回报'}）；失败原文保留在结果正文`,
            };
        }
        if (this.answer.trim().length === 0) {
            return {
                runState: 'failed',
                answer: '',
                diagnostic: 'result 事件没有可交付正文（answer 为空）—— 按失败处理，不用进度文本冒充回答',
            };
        }
        return { runState: 'completed', answer: this.answer };
    }
}
/** 按会话引用拼 argv 的会话段（new / resume）。 */
export function sessionArgsFor(profile, ref, requestedSessionId) {
    if (ref.nativeSessionId !== undefined && ref.nativeSessionId.length > 0 && profile.resumeArgs.length > 0) {
        return { argv: profile.resumeArgs.map(piece => piece.replace('{sessionId}', ref.nativeSessionId)), mode: 'resume' };
    }
    return { argv: profile.newSessionArgs.map(piece => piece.replace('{sessionId}', requestedSessionId)), mode: 'new' };
}
/**
 * 跑一次结构化 native CLI 轮次（headless 通道的 JSONL 分支）。
 *
 * 生命周期事实（pid 登记 / 结束回报 / 整树终止）与 `dispatchHeadless` 同一套语义；
 * 差异只在输出侧：stdout 逐行喂给解析器，进度增量走 `onProgress`，最终回答只取
 * result 事件；stderr 单独累积，只进诊断。本函数永不 reject。
 */
export async function dispatchNativeCli(spec) {
    const profile = spec.target.nativeCli;
    const ref = spec.nativeSession;
    const started = Date.now();
    if (profile === undefined || ref === undefined) {
        return { transport: 'headless', text: '', stopReason: 'error', diagnostic: 'native CLI dispatch requires target.nativeCli and spec.nativeSession' };
    }
    // 协议取值显式校验（schemastery 层只有 string）：未知值显式拒绝，不静默按某家解析。
    if (profile.protocol !== 'claude-stream-json' && profile.protocol !== 'agy-jsonl') {
        return { transport: 'headless', text: '', stopReason: 'error', diagnostic: `unknown nativeCli protocol "${profile.protocol}"（已知：claude-stream-json / agy-jsonl）；本轮未执行` };
    }
    // 会话段：resume（精确原生 ID）或 new（新 UUID / CLI mint）。
    const requestedSessionId = randomUUID();
    const session = sessionArgsFor(profile, ref, requestedSessionId);
    // 结构化 argv：基础参数 + 输出旗标 + 会话段 + extraArgs +（模型在 target.modelArgs 里已由 withModel 合并）。
    // ⚠️ 次要项回归：extraArgs（调用方显式追加的参数）在 native 分支**同样生效**——
    // 之前只拼了基础+输出+会话段，extraArgs 被静默丢弃（审查指出的回归风险）。
    // 模型参数走 target.modelArgs → sessions.withModel() 在进入本函数前已并入 target.args。
    // prompt 缺省走 stdin；但目标声明了 `nativeCli.promptArg`（`{prompt}` 占位符）时必须内联 ——
    // 2026-10-16 现场实测：agy 的 `-p` 是「必须紧跟参数」的旗标（原话 `flag needs an argument: -p`），
    // **不接受** stdin prompt；「五个产品 CLI 的 -p 都接受 stdin」这个旧假设对它不成立。
    const promptArg = profile.promptArg !== undefined && profile.promptArg.length > 0
        ? profile.promptArg.map(piece => piece.replace('{prompt}', spec.prompt))
        : undefined;
    const argvTail = [...profile.outputArgs, ...(promptArg ?? []), ...session.argv, ...(spec.extraArgs ?? [])];
    const { verbatimArgv, launcher, verbatim } = buildArgv(spec.target.command, [...spec.target.args, ...argvTail]);
    const plan = { argv: verbatimArgv, resolved: launcher.resolved, verbatim, stdinText: promptArg === undefined ? spec.prompt : '' };
    // argv 长度护栏（与 headless 同一上限；结构化旗标一般很短，超限说明调用方塞了异常参数）。
    const argvChars = plan.argv.join(' ').length;
    if (process.platform === 'win32' && argvChars >= 32_768) {
        return {
            transport: 'headless', text: '', stopReason: 'error',
            diagnostic: `native CLI 命令行约 ${argvChars} 字符 ≥ 平台上限 32768；本轮未执行（不截断、不换通道）`,
            facts: { argvChars, refusedOverArgvLimit: true },
        };
    }
    return await new Promise((resolve) => {
        const child = spawn(plan.argv[0], plan.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.target.env, ...spec.extraEnv, NO_COLOR: '1', TERM: 'dumb' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            windowsVerbatimArguments: plan.verbatim,
        });
        const parser = new NativeCliStreamParser(profile.protocol);
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let sawSignal;
        const spawnedAtMs = Date.now();
        let exitedAtMs = null;
        let killReason;
        let treeKillIssued = false;
        let observationError;
        let exitReported = false;
        let exitReporter;
        let exitInfo;
        const reportExit = (terminatedBy, extra = {}) => {
            if (exitReported)
                return;
            exitReported = true;
            exitedAtMs = Date.now();
            try {
                exitReporter?.({
                    at: exitedAtMs,
                    terminatedBy,
                    ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
                    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
                    ...(extra.cancelled === undefined ? {} : { cancelled: extra.cancelled }),
                });
            }
            catch (error) {
                observationError = `exit observer failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        };
        const killTreeNoted = (reason) => {
            killReason = reason;
            treeKillIssued = true;
            killTree(child.pid);
        };
        if (child.pid !== undefined && child.pid > 0) {
            try {
                exitReporter = spec.onSpawn?.({ pid: child.pid, channel: 'headless', command: plan.resolved, at: spawnedAtMs, argvChars }) ?? undefined;
            }
            catch (error) {
                observationError = `spawn observer failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        const finish = (stopReason, diagnostic) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            spec.signal.removeEventListener('abort', onAbort);
            const terminal = stopReason === 'completed' ? parser.terminal() : { runState: (timedOut ? 'failed' : stopReason === 'aborted' ? 'cancelled' : 'failed'), answer: parser.answer };
            const text = terminal.answer;
            const details = [];
            if (diagnostic !== undefined && diagnostic.length > 0)
                details.push(diagnostic);
            if (terminal.diagnostic !== undefined)
                details.push(terminal.diagnostic);
            if (sawSignal !== undefined)
                details.push(`结构化信号：${sawSignal}（进程退出前可见，如实带出）`);
            if (stderr.trim().length > 0)
                details.push(`stderr tail: ${stderr.trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 800)}`);
            // 恢复语义：带了原生 ID 恢复却连 init/会话证据都没见到 ⇒ 显式 recovery_needed，不静默新建。
            const attemptedResume = session.mode === 'resume';
            const recoveryNeeded = attemptedResume && parser.sessionId === undefined
                ? true
                : attemptedResume && parser.sessionId !== undefined && parser.sessionId !== ref.nativeSessionId;
            if (recoveryNeeded)
                details.push(`原生会话恢复未确认：请求恢复 ${ref.nativeSessionId}，厂商未回报同一会话（本轮未按原会话执行，标记 recovery_needed；不静默新建）`);
            const runState = recoveryNeeded ? 'recovery_needed' : (terminal.runState === 'completed' && sawSignal !== undefined ? 'completed' : terminal.runState);
            // 模型被拒签名（复用 headless 的判定）：退出码 0 也可能是厂商明确拒绝。
            const rejection = runState !== 'completed' ? modelRejectionOf(`${parser.answer}\n${stderr}`) : undefined;
            if (rejection !== undefined)
                details.push(`厂商明确拒绝本次模型：${rejection.headline}${rejection.supported.length > 0 ? `；该账号当前支持（厂商原文）：${rejection.supported.join(', ')}` : ''}`);
            const finalStop = runState === 'completed' && !recoveryNeeded && rejection === undefined
                ? 'completed'
                : (stopReason === 'aborted' ? 'aborted' : 'error');
            resolve({
                transport: 'headless',
                text,
                ...(details.length > 0 ? { diagnostic: details.join('; ') } : {}),
                stopReason: finalStop,
                identity: {
                    harnessId: spec.target.name,
                    ...(parser.sessionId !== undefined && !recoveryNeeded ? { nativeSessionId: parser.sessionId } : {}),
                },
                native: {
                    sessionId: parser.sessionId,
                    ...(parser.requestId !== undefined ? { requestId: parser.requestId } : {}),
                    runState,
                    protocol: profile.protocol,
                    sessionMode: session.mode,
                    events: parser.events,
                    ...(parser.signals.length > 0 ? { signals: [...new Set(parser.signals)] } : {}),
                },
                facts: {
                    command: plan.resolved,
                    durationMs: Date.now() - started,
                    nativeProtocol: profile.protocol,
                    nativeSessionMode: session.mode,
                    nativeEvents: parser.events,
                    ...(parser.signals.length > 0 ? { nativeSignals: [...new Set(parser.signals)].join(',') } : {}),
                    ...(parser.sessionId !== undefined ? { nativeSessionId: parser.sessionId } : {}),
                    ...(parser.requestId !== undefined ? { nativeRequestId: parser.requestId } : {}),
                    ...(exitInfo === undefined || exitInfo.code === null ? {} : { exitCode: exitInfo.code }),
                    ...(child.pid === undefined || child.pid <= 0 ? {} : { pid: child.pid }),
                    ...(child.pid === undefined || child.pid <= 0 ? {} : { spawnedAtMs }),
                    ...(exitedAtMs === null ? {} : { exitedAtMs }),
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
            finish('timeout', `native CLI run exceeded ${spec.timeoutMs}ms and was terminated`);
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
            const progress = parser.feed(chunk.toString('utf8'));
            // 次要项修复：把解析器累计的结构化信号**真正接入**执行面——sawSignal 之前从未赋值，
            // waiting_permission / upstream_queued 只停留在解析器里，任务状态看不到（审查指出）。
            if (parser.signals.length > 0)
                sawSignal = parser.signals[parser.signals.length - 1];
            if (progress.length > 0)
                spec.onProgress?.(progress);
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            reportExit('spawn-error', { cancelled: false });
            finish('error', `spawn failed: ${error.message}`);
        });
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
            // 剩余缓冲（无换行结尾的最后一段）也要喂给解析器。
            parser.feed('\n');
            if (signalName !== null) {
                finish('aborted', `native CLI was terminated by signal ${signalName}`);
                return;
            }
            if (code === null) {
                finish('error', 'native CLI exited without an exit code or a signal');
                return;
            }
            if (code !== 0) {
                finish('error', `native CLI exited with code ${String(code)}（结构化 result 事件${parser.resultSeen ? '已出现' : '未出现'}；原文见结果正文）`);
                return;
            }
            finish('completed');
        });
        child.stdin.end(plan.stdinText);
    });
}
//# sourceMappingURL=native-cli.js.map