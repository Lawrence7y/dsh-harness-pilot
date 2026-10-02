/**
 * 会话编排层：把「一个目标 + 一条任务」按通道梯子送出去，并管理长期交互会话。
 *
 * 通道是**懒加载**的：某个通道的依赖在这台机器上不存在（没装 python、没装 SDK、
 * 没有 ConPTY）时，插件仍然能正常加载，只是那一档自动跳过 —— 这也是为什么
 * 这里用运行时 import 而不是顶层 import。
 */
import { randomUUID } from 'node:crypto';
import { probeCommand } from './launcher.js';
import { dispatchHeadless } from './transports/headless.js';
import { dispatchPty, probePty, PtySession } from './transports/pty.js';
import { findTarget } from './config.js';
import { listDshModels, listHarnessModels } from './models.js';
const ALL_TRANSPORTS = ['acp', 'headless', 'pty', 'cdp', 'window'];
/** 模块定位器：specifier 是变量，TS 不会静态解析，缺失时只在运行时降级。 */
const loadModule = (specifier) => import(specifier);
/** 把「本次指定模型」落成目标实际使用的参数：模型参数模板 + ACP 会话内切换。 */
function withModel(target, model) {
    if (model === undefined || model.trim().length === 0)
        return target;
    const chosen = model.trim();
    const args = [...target.args];
    if (target.modelArgs.length > 0) {
        const modelArgs = target.modelArgs.map(piece => piece.replace('{model}', chosen));
        // Positional-prompt CLIs such as agy consume the argument immediately after -p as text.
        // Place model arguments before -p, leaving the prompt as the final CLI value.
        const promptIndex = args.lastIndexOf('-p');
        args.splice(promptIndex < 0 ? args.length : promptIndex, 0, ...modelArgs);
    }
    return {
        ...target,
        args,
        acpModel: chosen,
    };
}
export class SessionRegistry {
    deps;
    sessions = new Map();
    /** harness 模型列表缓存（按目标名，避免每次起进程问）。 */
    modelCache = new Map();
    acpModule = { loaded: false, value: undefined };
    cdpModule = { loaded: false, value: undefined };
    windowModule = { loaded: false, value: undefined };
    counter = 0;
    constructor(deps) {
        this.deps = deps;
    }
    log(level, message) {
        this.deps.log?.(level, message);
    }
    async acp() {
        if (!this.acpModule.loaded) {
            this.acpModule.loaded = true;
            try {
                this.acpModule.value = (await loadModule('./transports/acp.js'));
            }
            catch (error) {
                this.log('warn', `harness-pilot: acp transport unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return this.acpModule.value;
    }
    async cdp() {
        if (!this.cdpModule.loaded) {
            this.cdpModule.loaded = true;
            try {
                this.cdpModule.value = (await loadModule('./transports/cdp.js'));
            }
            catch (error) {
                this.log('warn', `harness-pilot: cdp transport unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return this.cdpModule.value;
    }
    async window() {
        if (!this.windowModule.loaded) {
            this.windowModule.loaded = true;
            try {
                this.windowModule.value = (await loadModule('./transports/window.js'));
            }
            catch (error) {
                this.log('warn', `harness-pilot: window transport unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return this.windowModule.value;
    }
    /** 通道预检：只判断「这一档能不能用」，不派发任务（避免失败后重复执行）。 */
    async preflight(kind, target) {
        switch (kind) {
            case 'headless': {
                const probe = probeCommand(target.command);
                return { available: probe.available, detail: probe.available ? `headless: ${probe.path}` : `headless: ${probe.error ?? 'no command'}` };
            }
            case 'acp': {
                const module = await this.acp();
                if (module === undefined)
                    return { available: false, detail: 'acp: transport module unavailable' };
                const probe = module.probeAcp(target);
                return { available: probe.available, detail: `acp: ${probe.detail ?? (probe.available ? 'ready' : 'not ready')}` };
            }
            case 'pty': {
                if (this.deps.spawnTerminal === undefined)
                    return { available: false, detail: 'pty: host has no ctx.subprocess.spawnTerminal' };
                const probe = probePty(target);
                return { available: probe.available, detail: probe.detail ?? (probe.available ? 'pty: ready' : 'pty: not ready') };
            }
            case 'cdp': {
                const module = await this.cdp();
                if (module === undefined)
                    return { available: false, detail: 'cdp: transport module unavailable' };
                const port = target.cdp.port > 0 ? target.cdp.port : this.deps.config.cdpPortBase;
                return await module.probeCdpTarget(target, port);
            }
            case 'window': {
                const module = await this.window();
                if (module === undefined)
                    return { available: false, detail: 'window: transport module unavailable' };
                try {
                    await this.deps.helper.ensure();
                }
                catch (error) {
                    return { available: false, detail: `window: helper unavailable (${error instanceof Error ? error.message : String(error)})` };
                }
                const match = { ...(target.window.title ? { title: target.window.title } : {}), ...(target.window.process ? { process: target.window.process } : {}) };
                const found = Object.keys(match).length > 0 ? await this.deps.helper.find(match, 15000) : [];
                if (found.length > 0)
                    return { available: true, detail: `window: attached to "${found[0].title}" (hwnd ${found[0].hwnd})` };
                if (target.window.launch.length > 0)
                    return { available: true, detail: `window: can launch "${target.window.launch}"` };
                return { available: false, detail: `window: no window matching ${JSON.stringify(match)} and no window.launch configured` };
            }
            default:
                return { available: false, detail: `unknown transport "${kind}"` };
        }
    }
    /** 按梯子选一档并跑一次任务；失败不会自动换档重跑（避免重复执行）。 */
    async dispatch(spec, options = {}) {
        const target = withModel(spec.target, spec.model);
        const request = target === spec.target ? spec : { ...spec, target };
        const requested = options.transport ?? target.transport;
        const candidates = requested !== '' && requested !== 'auto'
            ? [requested]
            : (target.order.length > 0 ? target.order : ALL_TRANSPORTS)
                .filter((kind) => ALL_TRANSPORTS.includes(kind));
        const report = [];
        let chosen;
        for (const kind of candidates) {
            const check = await this.preflight(kind, target);
            report.push(`${kind}=${check.available ? 'ok' : 'skip'} (${check.detail})`);
            if (check.available) {
                chosen = kind;
                break;
            }
        }
        if (chosen === undefined) {
            return {
                transport: 'headless',
                text: '',
                stopReason: 'error',
                diagnostic: `no usable transport for target "${target.name}": ${report.join('; ')}`,
                facts: { ladder: report.join('; ') },
            };
        }
        const outcome = await this.run(chosen, request);
        return { ...outcome, facts: { ...outcome.facts, ladder: report.join('; ') } };
    }
    async run(kind, spec) {
        switch (kind) {
            case 'headless':
                return await dispatchHeadless(spec);
            case 'acp': {
                const module = await this.acp();
                if (module === undefined)
                    return { transport: 'acp', text: '', stopReason: 'error', diagnostic: 'acp module unavailable' };
                return await module.dispatchAcp(spec);
            }
            case 'pty': {
                if (this.deps.spawnTerminal === undefined)
                    return { transport: 'pty', text: '', stopReason: 'error', diagnostic: 'host has no spawnTerminal' };
                return await dispatchPty(spec, this.deps.spawnTerminal);
            }
            case 'cdp': {
                const module = await this.cdp();
                if (module === undefined)
                    return { transport: 'cdp', text: '', stopReason: 'error', diagnostic: 'cdp module unavailable' };
                return await module.dispatchCdp(spec, { launch: true, portBase: this.deps.config.cdpPortBase });
            }
            case 'window': {
                const module = await this.window();
                if (module === undefined)
                    return { transport: 'window', text: '', stopReason: 'error', diagnostic: 'window module unavailable' };
                return await module.dispatchWindow(this.deps.helper, spec, { launch: true });
            }
            default:
                return { transport: 'headless', text: '', stopReason: 'error', diagnostic: `unsupported transport "${kind}"` };
        }
    }
    /** 打开一个长期交互会话（GUI harness 优先 CDP，其次窗口，最后 pty）。 */
    async open(target, options) {
        const launch = options.launch ?? true;
        const order = (target.order.length > 0 ? target.order : ALL_TRANSPORTS)
            .filter((kind) => ALL_TRANSPORTS.includes(kind));
        const attempts = [];
        for (const kind of order) {
            if (kind === 'headless')
                continue; // headless 没有会话概念
            const check = await this.preflight(kind, target);
            attempts.push(`${kind}=${check.available ? 'ok' : 'skip'} (${check.detail})`);
            if (!check.available)
                continue;
            try {
                const session = await this.create(kind, target, { cwd: options.cwd, launch });
                if (session !== undefined)
                    return session;
            }
            catch (error) {
                attempts.push(`${kind}=error (${error instanceof Error ? error.message : String(error)})`);
            }
        }
        throw new Error(`cannot open an interactive session for "${target.name}": ${attempts.join('; ')}`);
    }
    wrapPty(session, target) {
        const id = this.mintId();
        const summary = {
            id,
            target: target.name,
            transport: 'pty',
            detail: `pty pid ${session.pid}`,
            openedAt: Date.now(),
            closed: false,
        };
        return {
            id,
            target,
            transport: 'pty',
            detail: summary.detail,
            summary,
            read: async () => {
                const read = session.read();
                return { text: read.text, source: read.source };
            },
            send: async (input) => await session.send(input),
            close: async () => {
                await session.close();
            },
        };
    }
    async create(kind, target, options) {
        if (kind === 'pty') {
            if (this.deps.spawnTerminal === undefined)
                return undefined;
            const session = await PtySession.open(target, { cwd: options.cwd, spawnTerminal: this.deps.spawnTerminal });
            const wrapped = this.wrapPty(session, target);
            this.sessions.set(wrapped.id, wrapped);
            return wrapped;
        }
        if (kind === 'cdp') {
            const module = await this.cdp();
            if (module === undefined)
                return undefined;
            const session = await module.openCdp(target, { cwd: options.cwd, launch: options.launch, portBase: this.deps.config.cdpPortBase });
            const id = this.mintId();
            const summary = {
                id,
                target: target.name,
                transport: 'cdp',
                detail: `cdp port ${session.port} page ${session.pageId}`,
                openedAt: Date.now(),
                closed: false,
            };
            const wrapped = {
                id,
                target,
                transport: 'cdp',
                detail: summary.detail,
                summary,
                read: async ({ limit }) => await session.read({ limit }),
                send: async (input) => await session.send({ text: input.text ?? '', submit: input.submit }),
                ...(session.evaluate === undefined
                    ? {}
                    : { evaluate: async (expression) => await session.evaluate(expression) }),
                ...(session.mouse === undefined
                    ? {}
                    : { mouse: async (action, x, y) => await session.mouse(action, x, y) }),
                close: async () => {
                    await session.close();
                },
            };
            this.sessions.set(id, wrapped);
            return wrapped;
        }
        if (kind === 'window') {
            const module = await this.window();
            if (module === undefined)
                return undefined;
            const session = await module.openWindow(this.deps.helper, target, { cwd: options.cwd, launch: options.launch, timeoutMs: target.window.appearTimeoutMs });
            const id = this.mintId();
            const summary = {
                id,
                target: target.name,
                transport: 'window',
                detail: `window "${session.title}" (hwnd ${session.hwnd}, pid ${session.pid})`,
                openedAt: Date.now(),
                closed: false,
            };
            const wrapped = {
                id,
                target,
                transport: 'window',
                detail: summary.detail,
                summary,
                read: async ({ limit, mode }) => await module.readWindow(this.deps.helper, session, { limit, ...(mode === undefined ? {} : { mode }) }),
                send: async (input) => await module.sendToWindow(this.deps.helper, target, session, { text: input.text, submit: input.submit }),
                clickElement: async (name) => {
                    const result = await this.deps.helper.clickByName(session.hwnd, name);
                    const detail = result.found
                        ? `clicked <${result.element?.ct ?? '?'} "${result.element?.name ?? ''}"> at ${result.clicked?.x ?? '?'},${result.clicked?.y ?? '?'}`
                        : `no UIA element matched "${name}"${result.alternatives !== undefined && result.alternatives.length > 0 ? `; near misses: ${result.alternatives.join(' | ')}` : ''}`;
                    return { found: result.found, detail };
                },
                close: async () => {
                    await module.closeWindow(this.deps.helper, session);
                },
            };
            this.sessions.set(id, wrapped);
            return wrapped;
        }
        return undefined;
    }
    mintId() {
        this.counter += 1;
        return `hp-${this.counter}-${randomUUID().slice(0, 8)}`;
    }
    list() {
        return [...this.sessions.values()].map(session => session.summary);
    }
    get(id) {
        return this.sessions.get(id);
    }
    async close(id) {
        const session = this.sessions.get(id);
        if (session === undefined)
            return false;
        this.sessions.delete(id);
        try {
            await session.close();
        }
        catch {
            // 关闭失败不影响列表状态
        }
        return true;
    }
    async disposeAll() {
        const ids = [...this.sessions.keys()];
        for (const id of ids)
            await this.close(id);
    }
    /** 供工具层使用：把目标名解析成 TargetConfig。 */
    target(name) {
        const wanted = name === undefined || name.trim().length === 0 ? this.deps.config.defaultTarget : name.trim();
        const target = findTarget(this.deps.config, wanted);
        if (target === undefined) {
            const names = this.deps.config.resolvedTargets.map(entry => entry.name).join(', ');
            throw new Error(`unknown harness target "${wanted}"; known targets: ${names}`);
        }
        return target;
    }
    /** harness 自报的模型列表（带缓存）；modelsCommand 未配置时返回空。 */
    async targetModels(target) {
        const cached = this.modelCache.get(target.name);
        const now = Date.now();
        if (cached !== undefined && now - cached.at < target.modelsCacheMs) {
            return { models: cached.models, note: cached.note };
        }
        const found = await listHarnessModels(target, target.modelsTimeoutMs);
        this.modelCache.set(target.name, { at: now, models: found.models, note: found.note });
        return { models: found.models, note: found.note };
    }
    /** 清掉模型缓存（UI 上「刷新模型」用）。 */
    clearModelCache() {
        this.modelCache.clear();
    }
    /**
     * 设置页/概览用的全量画像：目标 + 可用性 + 模型 + 活跃会话 + DSH 已配置的供应商模型。
     * `models: true` 会去问每个 harness（起进程，慢），默认只用缓存/静态信息。
     */
    async overview(options = {}) {
        const targets = [];
        for (const target of this.deps.config.resolvedTargets) {
            const probe = target.command.length > 0 ? probeCommand(target.command) : { available: false, error: 'no command configured (GUI-only harness)' };
            let models = [];
            let modelsNote = target.modelsCommand.length > 0 ? `${target.modelsCommand} ${target.modelsArgs.join(' ')}`.trim() : '';
            if (options.models === true && target.modelsCommand.length > 0) {
                const found = await this.targetModels(target);
                models = found.models;
                modelsNote = found.note;
            }
            targets.push({
                name: target.name,
                description: target.description,
                transport: target.transport,
                order: [...target.order],
                command: target.command,
                ...(probe.available && probe.path !== undefined ? { commandPath: probe.path } : {}),
                available: probe.available,
                ...(probe.available || probe.error === undefined ? {} : { reason: probe.error }),
                model: target.acpModel.length > 0 ? target.acpModel : '',
                canSelectModel: target.modelArgs.length > 0 || target.acpArgs.length > 0, models,
                modelsNote,
            });
        }
        targets.sort((left, right) => {
            if (left.available !== right.available)
                return left.available ? -1 : 1;
            return left.name.localeCompare(right.name);
        });
        return {
            plugin: { name: '@dsh-external/dsh-harness-pilot', version: '0.1.0' },
            defaultTarget: this.deps.config.defaultTarget,
            targets,
            sessions: this.list(),
            dsh: { providers: await listDshModels(this.deps.llm) },
            generatedAt: Date.now(),
        };
    }
}
//# sourceMappingURL=sessions.js.map