import { join } from 'node:path';
import { Config, resolveConfig } from './config.js';
import { WindowHelper } from './helper.js';
import { registerProviders } from './provider.js';
import { SessionRegistry } from './sessions.js';
import { loadSettings, pluginHome, saveSettings } from './settings.js';
import { TaskManager } from './tasks.js';
import { registerTaskTools } from './task-tools.js';
import { currentModelOf, mechanismOf, registerTools, switchModel, switchModelInPage, } from './tools.js';
import { buildReceipt, createSessionWaker } from './wake.js';
export const name = '@dsh-external/dsh-harness-pilot';
/**
 * 只声明**激活必需且注册顺序有保证**的核心服务（dsh-base 提供，先于本插件就位）。
 * subagents / webServer / 唤醒链服务不在这里：它们由子 fiber（等到再注册）或
 * 惰性解析处理 —— 见 apply() 里的「服务时序纪律」注释。
 */
export const inject = ['tools', 'llm', 'subprocess'];
export { Config };
/** 设置页 / 外部 agent 的数据接口前缀。 */
const API_PATH = '/harness-pilot/api';
/** POST body 上限：这些接口只收小 JSON，超了直接 413，避免被流式 body 拖住。 */
const API_MAX_BODY_BYTES = 64 * 1024;
const API_TRANSPORTS = ['acp', 'headless', 'pty', 'cdp', 'window'];
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 清掉 webserver 路由表里以 `path` 开头的残留条目 —— 与超级模组的 `dev_clear_routes`
 * 同一套做法：直接操作 Service 实例上的 `exact` / `prefixes` / `upgrades` 三张 Map。
 *
 * 为什么需要：热重载被打断（旧 fiber 的 disposer 没跑完）时，路由表里会留下同路径的
 * 旧条目，`register()` 于是抛 `duplicate prefix route`，而插件重启又不会自己清 —— 结果
 * 就是接口静默 404。这里先清残留再重试一次，把「一次被打断的重载」变成自愈。
 *
 * 已知残留风险：若旧 fiber 的 disposer 在**我们重新注册之后**才迟到执行，它按路径
 * `table.delete(path)` 会把我们新注册的这条一起删掉（表按 path 索引，分不清世代）。
 * 这种迟到 disposer 无法从外部拦截；届时网页端会再一次 404，重新加载插件即可恢复。
 *
 * 导出仅为 probe/verify-route-heal.mjs 能直接驱动它（插件入口的其余导出同理）。
 */
export function clearStaleRoutes(webServer, path) {
    const cleaned = [];
    const holder = webServer;
    for (const tableName of ['exact', 'prefixes', 'upgrades']) {
        const table = holder[tableName];
        if (table === null || table === undefined)
            continue;
        if (typeof table.keys !== 'function' || typeof table.delete !== 'function')
            continue;
        for (const key of [...table.keys()]) {
            if (!String(key).startsWith(path))
                continue;
            table.delete(key);
            cleaned.push(`${tableName}[${String(key)}]`);
        }
    }
    return cleaned;
}
/**
 * 注册 `/harness-pilot/api` 前缀路由，失败时自愈：
 *   1. `register` 抛错（多半是中断重载留下的同路径残留）→ 清掉残留；
 *   2. 再试一次；
 *   3. 还是失败 → 用 warn 把两次的原始错误都打出来（不吞）。
 *
 * @returns 注册成功时为该路由的 disposer，否则 undefined。
 */
export function registerApiRoute(webServer, handler, logger) {
    const route = { kind: 'prefix', path: API_PATH, handler };
    try {
        return webServer.register(route);
    }
    catch (firstError) {
        const cleaned = clearStaleRoutes(webServer, API_PATH);
        logger?.warn?.(`harness-pilot: register("${API_PATH}") failed (${describe(firstError)}); `
            + `cleared stale route entries: ${cleaned.length > 0 ? cleaned.join(', ') : 'none'}; retrying once`);
        try {
            return webServer.register(route);
        }
        catch (secondError) {
            logger?.warn?.(`harness-pilot: settings + write api route "${API_PATH}" is STILL not registered after cleanup: `
                + `${describe(secondError)} (first error was: ${describe(firstError)}; cleaned: `
                + `${cleaned.length > 0 ? cleaned.join(', ') : 'none'}). The settings page and the HTTP api will 404 until this is fixed; `
                + 'reloading the plugin (or dev_clear_routes with prefix "/harness-pilot") repairs it.');
            return undefined;
        }
    }
}
/** 读 POST body：有上限、JSON 解析失败与非法形状都变成 400（不抛给上层）。 */
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > API_MAX_BODY_BYTES) {
            // 继续把连接读干（客户端可能还在写），但不留数据；真的失控就直接断开。
            overflow = true;
            chunks.length = 0;
            if (size > API_MAX_BODY_BYTES * 8) {
                req.destroy();
                return { ok: false, status: 413, error: `request body exceeds ${API_MAX_BODY_BYTES} bytes` };
            }
            continue;
        }
        chunks.push(buffer);
    }
    if (overflow)
        return { ok: false, status: 413, error: `request body exceeds ${API_MAX_BODY_BYTES} bytes` };
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0)
        return { ok: true, value: {} };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { ok: false, status: 400, error: `invalid JSON body: ${describe(error)}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, status: 400, error: 'body must be a JSON object' };
    }
    return { ok: true, value: parsed };
}
/** 令牌常量时间比较（长度不同直接判否，避免 timingSafeEqual 抛错）。 */
function tokensMatch(provided, expected) {
    if (provided.length !== expected.length)
        return false;
    let diff = 0;
    for (let index = 0; index < provided.length; index += 1) {
        diff |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    return diff === 0;
}
export function createApiHandler(registry, config, extras = {}) {
    const sleep = async (ms) => {
        if (ms > 0)
            await new Promise(resolve => { setTimeout(resolve, ms); });
    };
    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = (req.method ?? 'GET').toUpperCase();
        const json = (status, value) => {
            if (res.writableEnded)
                return;
            const body = JSON.stringify(value);
            res.statusCode = status;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(body);
        };
        try {
            // ── 令牌守卫（见函数头注释）──
            const expected = config.apiToken;
            if (expected.length > 0) {
                const raw = req.headers['x-harness-pilot-token'];
                const provided = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
                if (!tokensMatch(provided, expected)) {
                    json(401, { error: 'unauthorized: this harness-pilot api requires a matching x-harness-pilot-token header' });
                    return;
                }
            }
            /** 解析 target（名字或省略=默认目标）；未知目标回 400 并返回 undefined。 */
            const targetOr400 = (raw) => {
                const wanted = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
                try {
                    return registry.target(wanted);
                }
                catch (error) {
                    json(400, { error: describe(error) });
                    return undefined;
                }
            };
            const methodNotAllowed = (allowed) => {
                res.setHeader('allow', allowed);
                json(405, { error: `method ${method} is not allowed on ${url.pathname}; use ${allowed}` });
            };
            // ── GET /overview：目标画像 + 活跃会话 + DSH 供应商模型 ──
            if (url.pathname === `${API_PATH}/overview`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                // ?models=1 会去问每个 harness 的模型列表（起进程，慢），默认只回静态信息。
                const withModels = url.searchParams.get('models') === '1';
                const overview = { ...(await registry.overview({ models: withModels })) };
                // 设置页要用的运行时设置与最近任务一并带上（缺省省略，老客户端不受影响）。
                if (extras.settings !== undefined)
                    overview.runtimeSettings = extras.settings();
                if (extras.tasks !== undefined)
                    overview.tasks = extras.tasks.list().slice(0, 30);
                json(200, overview);
                return;
            }
            // ── GET /probe?target=…：通道梯子逐档预检（不派发任务）──
            if (url.pathname === `${API_PATH}/probe`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                const target = targetOr400(url.searchParams.get('target') ?? '');
                if (target === undefined)
                    return;
                const order = (target.order.length > 0 ? target.order : ['acp', 'headless', 'pty', 'cdp', 'window'])
                    .filter((kind) => API_TRANSPORTS.includes(kind));
                const ladder = [];
                for (const kind of order) {
                    const check = await registry.preflight(kind, target);
                    ladder.push({ transport: kind, available: check.available, detail: check.detail });
                }
                json(200, { target: target.name, ladder });
                return;
            }
            // ── POST /models：这个 harness 自己列的模型 + 它是怎么被选中的 ──
            if (url.pathname === `${API_PATH}/models`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                if (body.value.refresh === true)
                    registry.clearModelCache();
                const found = await registry.targetModels(target);
                json(200, { target: target.name, models: found.models, note: found.note, mechanism: mechanismOf(target) });
                return;
            }
            // ── POST /dispatch：一次性派发（与 harness_dispatch 同一条通道梯子）──
            if (url.pathname === `${API_PATH}/dispatch`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (prompt.trim().length === 0) {
                    json(400, { error: 'body.prompt is required (a non-empty string)' });
                    return;
                }
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                const transport = body.value.transport;
                if (transport !== undefined && transport !== 'auto' && !API_TRANSPORTS.includes(String(transport))) {
                    json(400, { error: `body.transport must be one of: auto, ${API_TRANSPORTS.join(', ')}` });
                    return;
                }
                const model = typeof body.value.model === 'string' && body.value.model.trim().length > 0 ? body.value.model.trim() : undefined;
                const cwd = typeof body.value.cwd === 'string' && body.value.cwd.length > 0 ? body.value.cwd : process.cwd();
                const timeoutMs = typeof body.value.timeout_ms === 'number' && Number.isFinite(body.value.timeout_ms) && body.value.timeout_ms > 0
                    ? body.value.timeout_ms
                    : target.timeoutMs;
                // HTTP 客户端断开 = 取消这次派发（别让 harness 在没人听的时候继续跑）。
                const abort = new AbortController();
                res.on('close', () => {
                    if (!res.writableEnded)
                        abort.abort();
                });
                const outcome = await registry.dispatch({
                    target,
                    prompt,
                    cwd,
                    signal: abort.signal,
                    timeoutMs,
                    ...(model === undefined ? {} : { model }),
                }, typeof transport === 'string' && transport.length > 0 ? { transport } : {});
                json(200, {
                    target: target.name,
                    transport: outcome.transport,
                    stopReason: outcome.stopReason,
                    text: outcome.text,
                    ...(outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic }),
                    ...(outcome.facts === undefined ? {} : { facts: outcome.facts }),
                });
                return;
            }
            // ── POST /send：{ target, model? } 开会话；{ sessionId, text? } 往里写 ──
            if (url.pathname === `${API_PATH}/send`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
                // 写模式：往已有会话里打字（或不打字，只读屏）。
                if (sessionId.length > 0) {
                    const session = registry.get(sessionId);
                    if (session === undefined) {
                        json(404, {
                            error: `unknown session "${sessionId}"`,
                            sessions: registry.list().map(entry => entry.id),
                        });
                        return;
                    }
                    const text = typeof body.value.text === 'string' ? body.value.text : undefined;
                    const hasText = text !== undefined && text.length > 0;
                    const note = hasText
                        ? (await session.send({ text: text, submit: body.value.submit !== false })).note
                        : 'read-only';
                    const waitMs = typeof body.value.wait_ms === 'number' && Number.isFinite(body.value.wait_ms) && body.value.wait_ms > 0
                        ? body.value.wait_ms
                        : (hasText ? 1500 : 0);
                    await sleep(waitMs);
                    const read = await session.read({ limit: config.maxScreenChars });
                    json(200, {
                        sessionId: session.id,
                        target: session.target.name,
                        transport: session.transport,
                        action: note,
                        text: read.text,
                        source: read.source,
                        ...(read.diagnostic === undefined ? {} : { diagnostic: read.diagnostic }),
                    });
                    return;
                }
                // 开/复用模式：GUI harness 优先 CDP，其次窗口，最后 pty。
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                const existing = registry.list().find(entry => !entry.closed && entry.target === target.name);
                const reused = existing === undefined ? undefined : registry.get(existing.id);
                const session = reused ?? await registry.open(target, {
                    cwd: typeof body.value.cwd === 'string' && body.value.cwd.length > 0 ? body.value.cwd : process.cwd(),
                    launch: body.value.launch !== false,
                });
                const notes = [reused === undefined ? 'opened' : `reused ${session.id}`];
                // 换模型只对 CDP 会话有效：GUI harness 的模型选择器在它自己的界面里，
                // CLI 参数（modelArgs）只在一次性派发时有意义。
                let currentModel = '';
                const wanted = typeof body.value.model === 'string' && body.value.model.trim().length > 0 ? body.value.model.trim() : undefined;
                if (wanted !== undefined) {
                    const evaluate = session.evaluate;
                    if (evaluate === undefined) {
                        json(400, {
                            error: `session ${session.id} uses the ${session.transport} transport, which cannot switch models; `
                                + 'GUI harnesses need the cdp transport (open the target with launch=true or start it with a debugging port)',
                        });
                        return;
                    }
                    const mouse = session.mouse;
                    if (mouse === undefined) {
                        notes.push(await switchModelInPage({ evaluate: async (expression) => await evaluate(expression) }, wanted));
                    }
                    else {
                        const report = await switchModel({
                            evaluate: async (expression) => await evaluate(expression),
                            mouse: async (action, x, y) => await mouse(action, x, y),
                        }, wanted);
                        currentModel = report.after;
                        notes.push(`model switch: ${report.ok ? 'ok' : 'FAILED'} before=${JSON.stringify(report.before)} via=${report.via} `
                            + `picked=${JSON.stringify(report.picked)} after=${JSON.stringify(report.after)}`
                            + (report.detail === undefined ? '' : ` detail=${report.detail}`));
                    }
                }
                // 没让我们换模型时，尽量读一眼当前模型（非 CDP 会话读不到，如实回空串）。
                if (currentModel.length === 0) {
                    const evaluate = session.evaluate;
                    if (evaluate !== undefined) {
                        try {
                            currentModel = await currentModelOf({ evaluate: async (expression) => await evaluate(expression) });
                        }
                        catch (error) {
                            notes.push(`reading the current model failed: ${describe(error)}`);
                        }
                    }
                    else {
                        notes.push(`current model is not readable over the ${session.transport} transport (not a cdp session)`);
                    }
                }
                json(200, {
                    sessionId: session.id,
                    transport: session.transport,
                    currentModel,
                    detail: session.detail,
                    notes,
                });
                return;
            }
            // ── GET /settings：运行时设置（设置页表单的数据源）──
            if (url.pathname === `${API_PATH}/settings`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                json(200, {
                    settings: extras.settings?.() ?? null,
                    tasksDir: join(pluginHome(), 'tasks'),
                    settingsFile: join(pluginHome(), 'runtime-settings.json'),
                });
                return;
            }
            // ── POST /settings：保存运行时设置（立即生效）──
            if (url.pathname === `${API_PATH}/settings/save`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                if (extras.applySettings === undefined) {
                    json(500, { error: 'runtime settings are not wired in this composition' });
                    return;
                }
                json(200, { settings: extras.applySettings(body.value) });
                return;
            }
            // ── GET /tasks：最近任务（新→旧）──
            if (url.pathname === `${API_PATH}/tasks`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                json(200, { tasks: extras.tasks.list() });
                return;
            }
            // ── GET /task?id=…&result=1&log_offset=…：单个任务的状态/进度/结果 ──
            if (url.pathname === `${API_PATH}/task`) {
                if (method !== 'GET') {
                    methodNotAllowed('GET');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const id = (url.searchParams.get('id') ?? '').trim();
                if (!/^[0-9a-f-]{36}$/.test(id)) {
                    json(400, { error: 'query id must be a task uuid' });
                    return;
                }
                const offset = Math.max(0, Number(url.searchParams.get('log_offset') ?? 0) || 0);
                const wantResult = url.searchParams.get('result') !== '0';
                try {
                    const progress = extras.tasks.progress(id, offset, 20000);
                    const body = { ...progress };
                    if (wantResult && ['completed', 'error', 'timeout', 'aborted', 'interrupted'].includes(progress.status)) {
                        body.result = extras.tasks.result(id).result;
                    }
                    json(200, body);
                }
                catch (error) {
                    json(404, { error: describe(error) });
                }
                return;
            }
            // ── POST /task/start：后台派发（外部调用方可自带 session_id 要回执唤醒）──
            if (url.pathname === `${API_PATH}/task/start`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.tasks === undefined || extras.settings === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const prompt = typeof body.value.prompt === 'string' ? body.value.prompt : '';
                if (prompt.trim().length === 0) {
                    json(400, { error: 'body.prompt is required (a non-empty string)' });
                    return;
                }
                const target = targetOr400(body.value.target);
                if (target === undefined)
                    return;
                const transport = body.value.transport;
                if (transport !== undefined && transport !== 'auto' && !API_TRANSPORTS.includes(String(transport))) {
                    json(400, { error: `body.transport must be one of: auto, ${API_TRANSPORTS.join(', ')}` });
                    return;
                }
                const model = typeof body.value.model === 'string' && body.value.model.trim().length > 0 ? body.value.model.trim() : undefined;
                const cwd = typeof body.value.cwd === 'string' && body.value.cwd.length > 0 ? body.value.cwd : process.cwd();
                const runtime = extras.settings();
                const timeoutMs = typeof body.value.timeout_ms === 'number' && Number.isFinite(body.value.timeout_ms) && body.value.timeout_ms > 0
                    ? body.value.timeout_ms
                    : runtime.defaultTaskTimeoutMs;
                try {
                    const view = extras.tasks.start({
                        target,
                        prompt,
                        cwd,
                        timeoutMs,
                        ...(model === undefined ? {} : { model }),
                        ...(transport === undefined || transport === 'auto' ? {} : { transport: transport }),
                        callback: {
                            notify: body.value.notify !== false,
                            sessionId: typeof body.value.session_id === 'string' ? body.value.session_id.trim() : '',
                            instruction: typeof body.value.instruction === 'string' ? body.value.instruction : '',
                        },
                    });
                    json(200, { task: view });
                }
                catch (error) {
                    json(400, { error: describe(error) });
                }
                return;
            }
            // ── POST /task/cancel：{ task_id } ──
            if (url.pathname === `${API_PATH}/task/cancel`) {
                if (method !== 'POST') {
                    methodNotAllowed('POST');
                    return;
                }
                if (extras.tasks === undefined) {
                    json(500, { error: 'task manager is not wired in this composition' });
                    return;
                }
                const body = await readJsonBody(req);
                if (!body.ok) {
                    json(body.status, { error: body.error });
                    return;
                }
                const id = typeof body.value.task_id === 'string' ? body.value.task_id.trim() : '';
                if (!/^[0-9a-f-]{36}$/.test(id)) {
                    json(400, { error: 'body.task_id must be a task uuid' });
                    return;
                }
                try {
                    json(200, extras.tasks.cancel(id));
                }
                catch (error) {
                    json(404, { error: describe(error) });
                }
                return;
            }
            json(404, { error: `unknown harness-pilot endpoint: ${method} ${url.pathname}` });
        }
        catch (error) {
            json(500, { error: describe(error) });
        }
    };
}
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    const logger = ctx.logger;
    const ctxAny = ctx;
    const helper = new WindowHelper(config.pythonPath);
    // 宿主 subprocess 服务：提供 ConPTY（无原生依赖的 pty 通道）。inject 声明保证已就位。
    const subprocess = ctxAny.get?.('subprocess');
    const spawnTerminalImpl = subprocess?.spawnTerminal;
    const spawnTerminal = spawnTerminalImpl === undefined
        ? undefined
        : async (spec) => await spawnTerminalImpl.call(subprocess, spec);
    // 宿主 llm 服务：读出「本 profile 已配置的供应商模型」，供 harness_models 与设置页使用。
    const llm = ctxAny.get?.('llm');
    const registry = new SessionRegistry({
        config,
        helper,
        ...(spawnTerminal === undefined ? {} : { spawnTerminal }),
        ...(llm === undefined ? {} : { llm }),
        log: (level, message) => {
            if (level === 'warn')
                logger?.warn?.(message);
            else
                logger?.info?.(message);
        },
    });
    // ── 服务时序纪律 ──────────────────────────────────────────────
    // cordis 只保证 `inject` 声明的服务在 apply 前就位；subagents / webServer /
    // 唤醒链（agents / sessionController / sessions）的注册顺序**不保证**，
    // 主 fiber 里 ctx.get 可能拿到 undefined（实测：bundle 启动时 webServer 抢跑失败，
    // 路由静默丢失）。因此：
    //   · subagents / webServer → 子 fiber（inject 声明，服务到了才注册，永不抢跑）；
    //   · 唤醒链服务 → 投递回执时惰性解析。
    const subagentsFacade = {
        registerProvider: (provider) => {
            const real = ctxAny.get?.('subagents');
            if (real === undefined)
                throw new Error('ctx.subagents is not available in this composition');
            return real.registerProvider(provider);
        },
        list: () => ctxAny.get?.('subagents')?.list?.() ?? [],
        start: async (name, request) => {
            const real = ctxAny.get?.('subagents');
            if (real === undefined)
                throw new Error('ctx.subagents is not available in this composition');
            return await real.start(name, request);
        },
    };
    ctxAny.plugin?.({
        name: '@dsh-external/dsh-harness-pilot:subagent-providers',
        inject: ['subagents'],
        apply: (ctx2) => {
            const get = ctx2.get;
            const subagents = get?.call(ctx2, 'subagents');
            if (subagents === undefined)
                return;
            const registered = registerProviders(subagents, registry, config.resolvedTargets, config.defaultTarget);
            logger?.info?.(`harness-pilot: subagent providers registered: ${registered.join(', ')}`);
        },
    });
    // ── 运行时设置 + 异步任务 + 完成回执（设置页可编辑；任务完成唤醒会话）──
    let runtimeSettings = loadSettings();
    // 唤醒链（对齐 dsh-schedule）：sessionController.resolveAgent（不在线自动 resume =
    // 会话重新启动）→ agent.followup（排队新 turn 并唤醒）→ sessions.flush（落盘确认）。
    const waker = createSessionWaker({
        resolve: () => ({
            ...(ctxAny.get?.('sessionController') === undefined
                ? {}
                : { sessionController: ctxAny.get?.('sessionController') }),
            ...(ctxAny.get?.('agents') === undefined
                ? {}
                : { agents: ctxAny.get?.('agents') }),
            ...(ctxAny.get?.('sessions') === undefined
                ? {}
                : { sessions: ctxAny.get?.('sessions') }),
        }),
    });
    const tasks = new TaskManager({
        directory: join(pluginHome(), 'tasks'),
        dispatch: async (spec, options) => await registry.dispatch(spec, options ?? {}),
        maxConcurrent: runtimeSettings.maxConcurrent,
        onComplete: async (view, callback, result) => {
            // 交付内容 + 续办提示一起打包，唤醒（必要时先重新启动）发起会话。
            const receipt = buildReceipt(view, callback, result, runtimeSettings);
            return await waker.wake(callback.sessionId, receipt);
        },
        log: message => logger?.warn?.(message),
    });
    const applySettings = (raw) => {
        runtimeSettings = saveSettings(raw, runtimeSettings);
        tasks.setMaxConcurrent(runtimeSettings.maxConcurrent);
        logger?.info?.(`harness-pilot: runtime settings applied: ${JSON.stringify(runtimeSettings)}`);
        return runtimeSettings;
    };
    registerTools(ctx, {
        config,
        registry,
        subagents: subagentsFacade,
    });
    registerTaskTools(ctx, {
        config,
        registry,
        tasks,
        settings: () => runtimeSettings,
    });
    // 设置页/插件页的数据接口 + 给外部 agent（Codex 等）的写接口（client.js 用 fetch 读它）。
    // 走子 fiber 等 webServer 就位再注册路由 —— 这是 bundle 启动场景下路由丢失的修复点。
    const mountApi = (webServer, effect) => {
        const disposeRoute = registerApiRoute(webServer, createApiHandler(registry, config, { tasks, settings: () => runtimeSettings, applySettings }), logger);
        if (disposeRoute === undefined) {
            logger?.warn?.(`harness-pilot: no HTTP api on ${API_PATH} — the settings page and the Codex-side HTTP calls will 404`);
            return;
        }
        effect(() => { disposeRoute(); }, '@dsh-external/dsh-harness-pilot: settings + write api');
        logger?.info?.(`harness-pilot: settings + write api on ${API_PATH}${config.apiToken.length > 0 ? ' (token required)' : ''}`);
    };
    ctxAny.plugin?.({
        name: '@dsh-external/dsh-harness-pilot:api-route',
        inject: ['webServer'],
        apply: (ctx2) => {
            const holder = ctx2;
            const webServer = holder.get?.call(ctx2, 'webServer')
                ?? ctx2.webServer;
            if (webServer === undefined) {
                logger?.warn?.('harness-pilot: ctx.webServer resolved empty inside the api-route fiber — settings page will show an empty state');
                return;
            }
            mountApi(webServer, (fn, label) => holder.effect?.call(ctx2, fn, label));
        },
    });
    ctx.effect(() => () => {
        void registry.disposeAll();
        void tasks.shutdown();
        helper.dispose();
    }, '@dsh-external/dsh-harness-pilot: sessions + tasks + window helper');
    logger?.info?.(`harness-pilot: ${config.resolvedTargets.length} harness targets, default=${config.defaultTarget}; `
        + `pty=${spawnTerminal === undefined ? 'off' : 'on'}; api route + subagent providers mounted via deferred fibers`);
}
//# sourceMappingURL=index.js.map