/** Read only route names from host history; never return prompts or credentials. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const object = (value) => value !== null && typeof value === 'object' ? value : {};
const name = (value) => typeof value === 'string' ? value.trim() : '';
export function externalSessionIdentity(log) {
    let route = object(object(log.header).config);
    let source = 'request/header';
    // The latest request wins over a historical assistant response or a pending selection.
    for (const event of log.events ?? []) {
        if (event.type !== 'request/header')
            continue;
        const candidate = object(object(object(event.data).header).config);
        if (name(candidate.provider))
            route = candidate;
    }
    if (!name(route.provider)) {
        for (const event of log.events ?? []) {
            if (event.type === 'assistant/message') {
                const observed = object(object(object(event.data).message).source);
                if (name(observed.provider)) {
                    route = observed;
                    source = 'assistant/message.source';
                }
            }
        }
    }
    const provider = name(route.provider), model = name(route.model);
    const external = provider === 'pilot-cli' || provider.startsWith('harness-');
    const split = model.indexOf('::');
    return {
        external, provider, source,
        harness: provider === 'pilot-cli' ? (split < 0 ? model : model.slice(0, split)) : provider.replace(/^harness-/, ''),
        requestedModel: provider === 'pilot-cli' ? (split < 0 ? '' : model.slice(split + 2))
            : model === 'cli-default' ? '' : split < 0 ? model : model.slice(split + 2),
        // A host route or argv proves the request, not the vendor's internal model.
        actualModel: null,
    };
}
/** Completed one-shot children leave the live registry; retain names only for their pages. */
export class SessionIdentityStore {
    file;
    rows = Object.create(null);
    constructor(file) {
        this.file = file;
        try {
            const stored = object(JSON.parse(readFileSync(file, 'utf8')));
            for (const [id, raw] of Object.entries(stored)) {
                const row = object(raw);
                if (name(row.provider) && name(row.target))
                    this.rows[id] = {
                        provider: name(row.provider), requestedModel: name(row.requestedModel), target: name(row.target),
                        stopReason: name(row.stopReason), at: name(row.at),
                        mismatch: Array.isArray(row.mismatch) ? row.mismatch.filter((value) => typeof value === 'string') : [],
                        ...(name(row.accountId) ? { accountId: name(row.accountId), accountLabel: name(row.accountLabel) } : {}),
                    };
            }
        }
        catch { /* no previous execution names */ }
    }
    get(id) { return this.rows[id]; }
    set(id, row) {
        this.rows[id] = row;
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file + '.tmp', JSON.stringify(this.rows), { mode: 0o600 });
        renameSync(this.file + '.tmp', this.file);
    }
}
//# sourceMappingURL=session-identity.js.map