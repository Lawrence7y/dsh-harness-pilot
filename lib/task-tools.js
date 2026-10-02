/**
 * 异步任务工具面：把长任务丢给外部 harness 后台跑，完成后由回执唤醒本会话。
 *
 *   harness_task_start   派发后台任务，立即拿到 task_id（不阻塞）
 *   harness_task_status  查状态 / 进度 / 终态结果（含交付内容）
 *   harness_task_list    列出最近任务
 *   harness_task_cancel  取消一个在跑的任务
 *
 * 与一次性 harness_dispatch 的分工：短任务用 dispatch（同步等结果）；
 * 长任务用 task_start（跑着的时候 DSH 可以继续别的事，完成时回执唤醒）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
function textOutput(text) {
    return { text };
}
const OUTPUT = {
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
};
/** 调用方 Agent 的 workspace 与会话 id（回执要唤醒的就是这个会话；Agent.id 即 SessionId）。 */
function agentContext(agent) {
    const source = agent;
    const cwd = source?.session?.header?.cwd;
    const sessionId = typeof source?.id === 'string'
        ? source.id
        : (typeof source?.session?.id === 'string' ? source.session.id : undefined);
    return {
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
    };
}
function describe(view) {
    const model = view.model === null ? '' : ` model=${view.model}`;
    const transport = view.transport === undefined ? '' : ` transport=${view.transport}`;
    const diagnostic = view.diagnostic === null || view.diagnostic.length === 0 ? '' : `\n  diagnostic: ${view.diagnostic}`;
    const callback = view.callback === null
        ? ''
        : `\n  回执: notify=${view.callback.notify} session=${view.callback.sessionId || '(none)'} status=${view.callback.status}`
            + (view.callback.error === undefined ? '' : ` error=${view.callback.error}`);
    return (`task ${view.task_id}\n`
        + `  target=${view.target}${model}${transport} status=${view.status} elapsed=${Math.round(view.elapsed_ms / 1000)}s\n`
        + `  cwd=${view.cwd}\n`
        + `  output_chars=${view.output_chars} result=${view.result_path}${diagnostic}${callback}`);
}
export function registerTaskTools(ctx, deps) {
    const { config, registry, tasks, settings } = deps;
    const register = (definition, label) => {
        const toolName = definition.name ?? '';
        if (toolName.length > 0 && typeof ctx.tools?.get === 'function' && ctx.tools.get(toolName) !== undefined)
            return;
        ctx.effect(() => ctx.tools.register(definition), `@dsh-external/dsh-harness-pilot: ${label}`);
    };
    register(defineTool({
        name: 'harness_task_start',
        description: 'Dispatch one task to another agent harness IN THE BACKGROUND and return a task id immediately. Use this for '
            + 'long-running work: the harness runs while you continue, and on completion the plugin delivers its output '
            + 'back into THIS session as a completion receipt that re-wakes the session to continue the original goal. '
            + 'Use harness_dispatch for short synchronous tasks.',
        parameters: {
            target: { type: 'string', required: true, description: 'Harness name from harness_list (e.g. opencode, agy, zcode)' },
            prompt: { type: 'string', required: true, description: 'The complete, self-contained task for that harness (it cannot see this conversation)' },
            model: { type: 'string', description: 'Model id for this run; see harness_models' },
            cwd: { type: 'string', description: 'Working directory; defaults to this session workspace' },
            transport: { type: 'string', enum: ['auto', 'acp', 'headless', 'pty', 'cdp', 'window'], description: 'Force one transport (default auto)' },
            timeout_ms: { type: 'integer', description: 'Hard deadline in ms (default: plugin defaultTaskTimeoutMs setting)' },
            notify: { type: 'boolean', description: 'On completion, deliver the result and re-wake this session (default true)' },
            resume_instruction: { type: 'string', description: 'Note recorded for the completion receipt: what to do when the session is re-woken' },
        },
        output: OUTPUT,
        async execute(args, exec) {
            const target = registry.target(String(args.target));
            const agent = agentContext(exec?.agent);
            const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : (agent.cwd ?? process.cwd());
            const model = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model.trim() : undefined;
            const transport = typeof args.transport === 'string' && args.transport !== 'auto'
                ? args.transport
                : undefined;
            const runtime = settings();
            const prompt = String(args.prompt);
            if (prompt.trim().length === 0)
                throw new Error('prompt must be a non-empty string');
            const view = tasks.start({
                target,
                prompt,
                cwd,
                timeoutMs: Number(args.timeout_ms ?? runtime.defaultTaskTimeoutMs),
                ...(model === undefined ? {} : { model }),
                ...(transport === undefined ? {} : { transport }),
                callback: {
                    notify: args.notify !== false,
                    sessionId: agent.sessionId ?? '',
                    instruction: typeof args.resume_instruction === 'string' ? args.resume_instruction : '',
                },
            });
            return textOutput(`started ${describe(view)}\n`
                + 'The harness runs in the background. On completion the result is delivered back to this session as a receipt '
                + '(when notify=true). Check with harness_task_status; cancel with harness_task_cancel.');
        },
        presentCall(args) {
            return { card: 'generic', title: `harness_task_start → ${String(args.target ?? '?')}`, kind: 'execute' };
        },
    }), 'harness_task_start');
    register(defineTool({
        name: 'harness_task_status',
        description: 'Check one background harness task: status, progress output and (once terminal) the delivered result. '
            + 'Pass include_result=true to inline the final output text.',
        parameters: {
            task_id: { type: 'string', required: true, description: 'Task id from harness_task_start' },
            include_result: { type: 'boolean', description: 'Include the full result text when the task is terminal (default true)' },
            log_offset: { type: 'integer', description: 'Progress log offset for incremental reads (default 0)' },
            log_limit: { type: 'integer', description: 'Max progress characters to return (default 4000)' },
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args) {
            const id = String(args.task_id);
            const offset = Math.max(0, Number(args.log_offset ?? 0));
            const limit = Math.min(64000, Math.max(200, Number(args.log_limit ?? 4000)));
            const progress = tasks.progress(id, offset, limit);
            const includeResult = args.include_result !== false;
            const terminal = ['completed', 'error', 'timeout', 'aborted', 'interrupted'].includes(progress.status);
            const lines = [describe(progress)];
            if (progress.text.length > 0) {
                lines.push(`\n--- progress (offset ${progress.offset}..${progress.next_offset}${progress.has_more ? ', more available' : ''}) ---\n${progress.text}`);
            }
            if (terminal && includeResult) {
                const result = tasks.result(id);
                if (result.ready && result.result !== null) {
                    lines.push(`\n--- result (stop=${result.result.stopReason}) ---\n${result.result.text.trim().length > 0 ? result.result.text : '(no text returned)'}`);
                }
                else {
                    lines.push('\n--- result ---\n(not readable yet; see diagnostic above)');
                }
            }
            return textOutput(lines.join('\n'));
        },
        presentCall(args) {
            return { card: 'generic', title: `harness_task_status ${String(args.task_id ?? '?')}`, kind: 'read' };
        },
    }), 'harness_task_status');
    register(defineTool({
        name: 'harness_task_list',
        description: 'List recent background harness tasks (newest first) with status, target and receipt state.',
        parameters: {},
        output: OUTPUT,
        isConcurrencySafe: () => true,
        async execute() {
            const views = tasks.list();
            if (views.length === 0)
                return textOutput('no harness tasks recorded');
            return textOutput(views.map(describe).join('\n\n'));
        },
        presentCall() {
            return { card: 'generic', title: 'harness_task_list', kind: 'read' };
        },
    }), 'harness_task_list');
    register(defineTool({
        name: 'harness_task_cancel',
        description: 'Cancel a running background harness task. Terminal tasks are left untouched.',
        parameters: {
            task_id: { type: 'string', required: true, description: 'Task id from harness_task_start' },
        },
        output: OUTPUT,
        async execute(args) {
            const id = String(args.task_id);
            const { view, cancellation_requested } = tasks.cancel(id);
            return textOutput(`${cancellation_requested ? 'cancellation requested' : 'not cancelled (already terminal or unknown)'}\n${describe(view)}`);
        },
        presentCall(args) {
            return { card: 'generic', title: `harness_task_cancel ${String(args.task_id ?? '?')}`, kind: 'execute' };
        },
    }), 'harness_task_cancel');
    void config;
}
//# sourceMappingURL=task-tools.js.map