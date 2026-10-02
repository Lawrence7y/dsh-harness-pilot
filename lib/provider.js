/**
 * SubagentProvider：把每个 harness 注册成 DSH 的**具名子代理 provider**。
 *
 * 注册后，宿主标准的 subagent 工具（`tool-subagent` 配 `provider: harness-<名字>`）和
 * 本插件的 `harness_agent` 工具都能以「子代理」语义派发 —— 有 run id、有 stopReason、
 * 有 dispose 生命周期，符合 DSH 里其他外部 provider（claude-code / codex / acp）的形状。
 */
import { randomUUID } from 'node:crypto';
import { NO_START_CAPABILITIES, resolveChildCwd, settleRunResult, subprocessRunHandle, } from '@deepseek-ai/dsh-subagent';
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
class HarnessProvider {
    name;
    target;
    sessions;
    capabilities = NO_START_CAPABILITIES;
    inheritsParentContext = false;
    constructor(name, target, sessions) {
        this.name = name;
        this.target = target;
        this.sessions = sessions;
    }
    async start(request) {
        const prompt = textTask(request.prompt);
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
        const result = settleRunResult({
            attempt: async () => {
                const outcome = await this.sessions.dispatch({
                    target: this.target,
                    prompt,
                    cwd,
                    signal: controller.signal,
                    timeoutMs: this.target.timeoutMs,
                    onProgress: (chunk) => {
                        collected = (collected + chunk).slice(-400_000);
                    },
                });
                if (outcome.text.length > 0)
                    collected = outcome.text;
                diagnostic = outcome.diagnostic;
                if (outcome.stopReason === 'completed') {
                    return { output: [{ type: 'text', text: outcome.text }], stopReason: 'completed' };
                }
                const partial = outcome.text.length > 0 ? [{ type: 'text', text: outcome.text }] : [];
                const detail = outcome.diagnostic === undefined
                    ? `harness-pilot (${this.target.name}): run ended with ${outcome.stopReason} over transport ${outcome.transport}`
                    : `harness-pilot (${this.target.name}): ${outcome.diagnostic}`;
                return {
                    output: partial,
                    diagnostic: detail,
                    stopReason: outcome.stopReason === 'aborted' ? 'aborted' : 'error',
                };
            },
            collectOutput: () => (collected.length > 0 ? [{ type: 'text', text: collected }] : []),
            collectDiagnostic: () => diagnostic,
            cancelled: () => controller.signal.aborted,
            onError: (error) => {
                diagnostic = `harness-pilot (${this.target.name}): ${error.message}`;
            },
            signal: request.signal,
            onAbort,
        });
        return subprocessRunHandle({
            id: randomUUID(),
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
 * 为每个目标注册一个 provider；默认目标额外注册 `harness-pilot` 别名。
 * 返回实际注册的 provider 名，供日志与工具描述使用。
 *
 * 幂等：同名 provider 已存在（同一个包被两条 loader 行加载）时跳过，
 * 否则重复注册会让第二条 loader 行的 fiber 失败。
 */
export function registerProviders(registry, sessions, targets, defaultTarget) {
    const existing = new Set(typeof registry.list === 'function' ? registry.list() : []);
    const registered = [];
    const register = (name, target) => {
        if (existing.has(name))
            return;
        registry.registerProvider(new HarnessProvider(name, target, sessions));
        existing.add(name);
        registered.push(name);
    };
    for (const target of targets)
        register(providerNameFor(target), target);
    const preferred = targets.find(target => target.name === defaultTarget);
    if (preferred !== undefined)
        register('harness-pilot', preferred);
    return registered;
}
//# sourceMappingURL=provider.js.map