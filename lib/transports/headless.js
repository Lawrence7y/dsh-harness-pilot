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
/** 拼接一次 headless 调用的完整 argv（prompt 走末尾参数或 stdin）。 */
export function headlessArgv(spec) {
    const { target } = spec;
    const extra = [...(spec.extraArgs ?? [])];
    if (target.promptViaStdin) {
        const { verbatimArgv, launcher, verbatim } = buildArgv(target.command, [...target.args, ...extra]);
        return { argv: verbatimArgv, stdinText: spec.prompt, resolved: launcher.resolved, verbatim };
    }
    const { verbatimArgv, launcher, verbatim } = buildArgv(target.command, [...target.args, ...extra, spec.prompt]);
    return { argv: verbatimArgv, resolved: launcher.resolved, verbatim };
}
/** 跑一次 headless 派发；永不 reject（异常折叠成 stopReason）。 */
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
    return await new Promise((resolve) => {
        const child = spawn(plan.argv[0], plan.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.target.env, NO_COLOR: '1', TERM: 'dumb' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            // .cmd/.bat 已经由 launcher 拼好整条命令行，必须原样交给 cmd.exe。
            windowsVerbatimArguments: plan.verbatim,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const finish = (stopReason, diagnostic) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            spec.signal.removeEventListener('abort', onAbort);
            const text = cleanOutput(stdout) || cleanOutput(stderr);
            const details = [];
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
                },
            });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
            finish('timeout', `headless run exceeded ${spec.timeoutMs}ms and was terminated`);
        }, Math.max(1000, spec.timeoutMs));
        const onAbort = () => {
            killTree(child.pid);
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
            finish('error', `spawn failed: ${error.message}`);
        });
        child.on('close', (code) => {
            if (settled)
                return;
            if (timedOut)
                return;
            if (code !== 0 && stdout.trim().length === 0) {
                finish('error', `harness exited with code ${String(code)} and produced no stdout`);
                return;
            }
            if (code !== 0) {
                finish('completed', `harness exited with code ${String(code)} after producing output`);
                return;
            }
            finish('completed');
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