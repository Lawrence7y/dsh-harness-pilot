/** The private shim emits this marker only after an explicit upstream quota classification. */
export const QUOTA_WIRE_MARKER = 'DSH_PILOT_QUOTA_EXHAUSTED';
export function guardWorkBuddyResult(value) {
    if (value.ok)
        return value;
    const kind = value.status === 401 || value.status === 403 ? 'session_dead' : value.status === 429 ? 'soft_rate' : value.status >= 500 ? 'server' : value.kind;
    return { ...value, kind };
}
export function guardWireQuota(adapter) {
    return {
        providerInfo: (...args) => adapter.providerInfo(...args),
        listModels: (...args) => adapter.listModels(...args),
        resolveModel: (...args) => adapter.resolveModel(...args),
        prepareCall: async (...args) => {
            const prepared = await adapter.prepareCall(...args);
            return { ...prepared, stream: (options) => (async function* () {
                    try {
                        for await (const chunk of prepared.stream(options)) {
                            if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
                                const failure = chunk.reason.failure ?? {};
                                // pi-ai reduces HTTP errors to strings. Do not trust its broad text-based quota classifier.
                                const confirmed = String(failure.message ?? '').includes(QUOTA_WIRE_MARKER);
                                if (confirmed || ['QUOTA', 'ACCOUNT_QUOTA'].includes(failure.code)) {
                                    yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code: confirmed ? 'QUOTA' : 'UPSTREAM_ERROR' } } };
                                    continue;
                                }
                            }
                            yield chunk;
                        }
                    }
                    catch (error) {
                        if (String(error?.message ?? '').includes(QUOTA_WIRE_MARKER))
                            throw Object.assign(new Error('Confirmed account quota exhaustion'), { code: 'QUOTA' });
                        if (['QUOTA', 'ACCOUNT_QUOTA'].includes(error?.code))
                            throw Object.assign(new Error('Unconfirmed upstream error'), { code: 'UPSTREAM_ERROR' });
                        throw error;
                    }
                })() };
        },
    };
}
//# sourceMappingURL=wire-quota.js.map