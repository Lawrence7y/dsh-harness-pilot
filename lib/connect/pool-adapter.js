/** Structured exhaustion only; auth, rate-limit and network failures never rotate accounts. */
export function isQuotaExhaustion(error) {
    if (!error || typeof error !== 'object')
        return false;
    const value = error;
    const status = Number(value.status ?? value.statusCode ?? value.response?.status);
    if (status === 401 || status === 403 || status === 429 || status >= 500)
        return false;
    const code = String(value.code ?? value.failure?.code ?? value.error?.code ?? value.body?.error?.code ?? '').toLowerCase();
    // rc.2 dsh-llm exports QUOTA_EXCEEDED_CODE='QUOTA', ACCOUNT_QUOTA_EXCEEDED_CODE='ACCOUNT_QUOTA'.
    return ['quota', 'account_quota', 'quota_exceeded', 'quota_exhausted', 'quotaexceeded', 'insufficient_quota', 'credit_exhausted', 'credits_exhausted', 'insufficient_credits', 'subscription_quota_exhausted', 'balance_exhausted'].includes(code)
        || status === 402;
}
function semanticChunk(chunk) {
    if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')
        return String(chunk.text ?? chunk.delta ?? '').length > 0;
    if (chunk?.type === 'tool-call-delta' || chunk?.type === 'tool-call' || chunk?.type === 'tool-call-start')
        return true;
    if (chunk?.type === 'block-start' && chunk.blockType === 'tool-call')
        return true;
    if (chunk?.type === 'block-end')
        return chunk.block?.type === 'tool-call' || String(chunk.block?.text ?? '').length > 0;
    // Unknown extensions can carry observable output; never buffer and replay those.
    return !['usage', 'header', 'block-start', 'block-end', 'finish', 'text-delta', 'reasoning-delta'].includes(String(chunk?.type));
}
/** One service + region provider. Native messages, tool schemas and chunks remain untouched. */
export class PoolAdapter {
    options;
    sessions = new Map();
    activeSessions = new Map();
    constructor(options) {
        this.options = options;
    }
    releaseSession(sessionId) {
        if ((this.activeSessions.get(sessionId) ?? 0) > 0)
            return false;
        return this.sessions.delete(sessionId);
    }
    retainSession(sessionId, binding) {
        this.sessions.delete(sessionId);
        this.sessions.set(sessionId, binding);
        if (this.sessions.size > 2000)
            for (const id of this.sessions.keys()) {
                if (id !== sessionId && !this.activeSessions.has(id))
                    this.sessions.delete(id);
                if (this.sessions.size <= 2000)
                    break;
            }
    }
    candidates(model) {
        return this.options.bindings().filter((a) => a.enabled && a.family === this.options.family && a.region === this.options.region && (model === undefined || a.models.includes(model)))
            .map((a) => ({ ...a, models: [...a.models] })).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    }
    check(provider) { if (provider !== this.options.provider)
        throw new Error('CONNECT_PROVIDER_MISMATCH'); }
    decode(requested) {
        const separator = requested.indexOf('::');
        return separator < 0 ? { model: requested } : { accountId: requested.slice(0, separator), model: requested.slice(separator + 2) };
    }
    providerInfo(provider) { this.check(provider); return { id: provider, name: this.options.name }; }
    async listModels(provider) {
        this.check(provider);
        const result = new Map();
        for (const account of this.candidates()) {
            const adapter = await this.options.factory(account);
            for (const model of await adapter.listModels(provider)) {
                if (!result.has(model.id))
                    result.set(model.id, { ...model, provider });
                const alias = `${account.id}::${model.id}`;
                result.set(alias, { ...model, provider, id: alias, name: `${model.name} · ${account.label || account.id.slice(0, 8)}` });
            }
        }
        return [...result.values()];
    }
    async resolveModel(provider, model, signal) {
        this.check(provider);
        const decoded = this.decode(model);
        const account = this.candidates(decoded.model).find((item) => !decoded.accountId || item.id === decoded.accountId);
        if (!account)
            throw new Error('CONNECT_MODEL_UNAVAILABLE: 当前区域没有已启用且支持该模型的账号');
        const adapter = await this.options.factory(account);
        return { ...await adapter.resolveModel(provider, decoded.model, signal), provider, id: model };
    }
    async prepareCall(provider, model, signal) {
        this.check(provider);
        const requestedModel = model;
        const decoded = this.decode(model);
        model = decoded.model;
        const candidates = this.candidates(model).filter((item) => !decoded.accountId || item.id === decoded.accountId);
        // Freeze account adapters at prepare time: changing defaults/importing new credentials cannot reroute an active request.
        const preparedFrozen = await Promise.all(candidates.map(async (account) => ({ account, adapter: await this.options.factory(account) })));
        const catalogAccount = preparedFrozen[0] ?? (!decoded.accountId ? [...this.sessions.values()].find((value) => value.account.models.includes(model)) : undefined);
        if (!catalogAccount)
            throw new Error('CONNECT_MODEL_UNAVAILABLE: 当前区域没有支持该模型的账号');
        const resolved = await catalogAccount.adapter.resolveModel(provider, model, signal);
        const policy = this.options.store.config();
        const maxSwitches = !decoded.accountId && policy.autoSwitchEnabled ? Math.min(2, policy.maxSwitches) : 0;
        const self = this;
        return { model: { ...resolved, provider, id: requestedModel }, stream: (options) => (async function* () {
                const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : undefined;
                const sticky = sessionId && !decoded.accountId ? self.sessions.get(sessionId) : undefined;
                if (sticky && !sticky.account.models.includes(model))
                    throw new Error('CONNECT_SESSION_MODEL_UNAVAILABLE: 当前会话固定账号不支持请求模型，拒绝静默更换账号');
                const frozen = sticky ? [sticky, ...preparedFrozen.filter((value) => value.account.id !== sticky.account.id)] : [...preparedFrozen];
                if (!frozen.length)
                    throw new Error('CONNECT_MODEL_UNAVAILABLE: 当前会话没有可用账号');
                if (sessionId)
                    self.activeSessions.set(sessionId, (self.activeSessions.get(sessionId) ?? 0) + 1);
                try {
                    let emitted = false;
                    for (let index = 0; index <= maxSwitches && index < frozen.length; index++) {
                        const current = frozen[index];
                        if (sessionId)
                            self.retainSession(sessionId, current);
                        const info = { provider, accountId: current.account.id, label: current.account.label, requestedModel, model, sessionId };
                        self.options.store.record({ type: 'selected', accountId: info.accountId, provider, requestedModel, model, sessionId });
                        const eventFields = { accountId: info.accountId, provider, requestedModel, model, sessionId };
                        try {
                            self.options.onSelected?.(info);
                        }
                        catch { /* Observers cannot replace provider output. */ }
                        const finish = (stopReason) => {
                            try {
                                self.options.onFinished?.({ ...info, stopReason });
                            }
                            catch { /* Terminal observer failures cannot alter completed output. */ }
                        };
                        if (signal?.aborted || options?.signal?.aborted) {
                            finish('aborted');
                            throw new Error('CONNECT_ABORTED');
                        }
                        try {
                            const prepared = await current.adapter.prepareCall(provider, model, signal);
                            // Decode only the model routing alias; preserve messages/tool schemas and every upstream chunk.
                            const forwarded = decoded.accountId ? { ...options, model } : options;
                            let failedFinish = false;
                            let exhaustedFinish = false;
                            let finished = false;
                            let abortedFinish = false;
                            let prefix = [];
                            let prefixSize = 0;
                            for await (const chunk of prepared.stream(forwarded)) {
                                if (chunk?.type === 'finish') {
                                    finished = true;
                                    failedFinish = ['error', 'aborted', 'abort', 'cancelled'].includes(String(chunk.reason?.kind));
                                    abortedFinish = ['aborted', 'abort', 'cancelled'].includes(String(chunk.reason?.kind));
                                    exhaustedFinish = chunk.reason?.kind === 'error' && isQuotaExhaustion(chunk.reason.failure);
                                    // A terminal error before meaningful output can discard the entire unused prefix.
                                    if (!emitted && chunk.reason?.kind === 'error' && isQuotaExhaustion(chunk.reason.failure)
                                        && index < maxSwitches && frozen[index + 1] && !signal?.aborted && !options?.signal?.aborted) {
                                        throw Object.assign(new Error('CONNECT_QUOTA_BEFORE_OUTPUT'), { code: chunk.reason.failure.code });
                                    }
                                }
                                if (!emitted && chunk?.type !== 'finish' && !semanticChunk(chunk) && prefix.length < 4096 && prefixSize < 1024 * 1024) {
                                    prefix.push(chunk);
                                    prefixSize += JSON.stringify(chunk).length;
                                    continue;
                                }
                                if (!emitted) {
                                    emitted = true;
                                    for (const buffered of prefix)
                                        yield buffered;
                                    prefix = [];
                                }
                                yield chunk;
                            }
                            if (!finished)
                                throw Object.assign(new Error('CONNECT_STREAM_CLOSED'), { code: 'STREAM_CLOSED' });
                            self.options.store.record({ type: exhaustedFinish ? 'exhausted' : failedFinish ? 'failure' : 'success', from: current.account.id, reason: exhaustedFinish ? 'quota_exhausted' : failedFinish ? 'upstream_finish_error' : undefined, ...eventFields });
                            finish(abortedFinish ? 'aborted' : failedFinish ? 'error' : 'stop');
                            return;
                        }
                        catch (error) {
                            const exhausted = isQuotaExhaustion(error);
                            self.options.store.record({ type: exhausted ? 'exhausted' : 'failure', from: current.account.id, reason: exhausted ? 'quota_exhausted' : 'request_failed', ...eventFields });
                            finish(signal?.aborted || options?.signal?.aborted ? 'aborted' : 'error');
                            if (emitted || signal?.aborted || options?.signal?.aborted || !exhausted || index >= maxSwitches || !frozen[index + 1])
                                throw error;
                            self.options.store.record({ type: 'switch', from: current.account.id, to: frozen[index + 1].account.id, reason: 'quota_exhausted_before_output', ...eventFields });
                        }
                    }
                    throw new Error('CONNECT_POOL_EXHAUSTED: 同区域、同模型的账号池已不可用');
                }
                finally {
                    if (sessionId) {
                        const remaining = (self.activeSessions.get(sessionId) ?? 1) - 1;
                        if (remaining <= 0)
                            self.activeSessions.delete(sessionId);
                        else
                            self.activeSessions.set(sessionId, remaining);
                    }
                }
            })() };
    }
    async *stream(options) {
        const prepared = await this.prepareCall(options.provider, options.model, options.signal);
        yield* prepared.stream(options);
    }
}
//# sourceMappingURL=pool-adapter.js.map