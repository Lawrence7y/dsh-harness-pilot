export type ConnectFamily = 'workbuddy' | 'qoder';
export type ConnectRegion = 'cn' | 'intl';
export interface AccountMetadata {
    id: string;
    family: ConnectFamily;
    region: ConnectRegion;
    label: string;
    fingerprint: string;
    enabled: boolean;
    priority: number;
    source: string;
    createdAt: string;
    updatedAt: string;
}
export interface PoolConfig {
    autoSwitchEnabled: boolean;
    maxSwitches: number;
}
export interface AccountEvent {
    at?: string;
    type: 'selected' | 'switch' | 'exhausted' | 'failure' | 'success';
    from?: string;
    to?: string;
    reason?: string;
    model?: string;
    sessionId?: string;
    accountId?: string;
    requestedModel?: string;
    provider?: string;
}
type Credential = Record<string, unknown>;
export interface AccountStoreOptions {
    /** Tests may inject encryption; production uses CurrentUser Windows DPAPI. */
    protect?: (value: Buffer) => Buffer;
    unprotect?: (value: Buffer) => Buffer;
}
export declare class AccountStore {
    readonly root: string;
    private readonly protect;
    private readonly unprotect;
    private state;
    constructor(root: string, options?: AccountStoreOptions);
    private path;
    private write;
    private save;
    list(): AccountMetadata[];
    add(input: {
        family: ConnectFamily;
        region: ConnectRegion;
        label?: string;
        credential: Credential;
        source?: string;
    }): AccountMetadata;
    readCredential(id: string): Credential;
    updateCredential(id: string, value: Credential): void;
    patch(id: string, value: {
        label?: string;
        enabled?: boolean;
        priority?: number;
    }): AccountMetadata;
    remove(id: string): void;
    config(): PoolConfig;
    configure(value: Partial<PoolConfig>): PoolConfig;
    record(event: AccountEvent): void;
    summary(): {
        accounts: AccountMetadata[];
        config: PoolConfig;
        events: AccountEvent[];
    };
}
export {};
