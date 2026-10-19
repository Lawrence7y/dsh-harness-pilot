export declare function externalSessionIdentity(log: {
    header?: unknown;
    events?: readonly {
        type: string;
        data: unknown;
    }[];
}): {
    external: boolean;
    provider: string;
    source: string;
    harness: string;
    requestedModel: string;
    actualModel: null;
};
export interface SessionExecutionIdentity {
    provider: string;
    requestedModel: string;
    target: string;
    stopReason: string;
    mismatch: readonly string[];
    at: string;
    accountId?: string;
    accountLabel?: string;
}
/** Completed one-shot children leave the live registry; retain names only for their pages. */
export declare class SessionIdentityStore {
    private readonly file;
    private rows;
    constructor(file: string);
    get(id: string): SessionExecutionIdentity;
    set(id: string, row: SessionExecutionIdentity): void;
}
