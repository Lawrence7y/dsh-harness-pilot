import type { AccountStore, ConnectFamily, ConnectRegion } from './account-store.js';
export interface AccountBinding {
    id: string;
    family: ConnectFamily;
    region: ConnectRegion;
    enabled: boolean;
    priority: number;
    models: readonly string[];
    label?: string;
}
export interface NativeModel {
    provider: string;
    id: string;
    name: string;
    [key: string]: unknown;
}
export interface NativePrepared {
    model: NativeModel;
    stream: (options: any) => AsyncIterable<any>;
    [key: string]: unknown;
}
export interface NativeAdapter {
    providerInfo(provider: string): any;
    listModels(provider: string): Promise<readonly NativeModel[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<NativeModel>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<NativePrepared>;
    stream?(options: any): AsyncIterable<any>;
}
export interface PoolAdapterOptions {
    provider: string;
    name: string;
    family: ConnectFamily;
    region: ConnectRegion;
    store: AccountStore;
    bindings: () => readonly AccountBinding[];
    factory: (binding: AccountBinding) => NativeAdapter | Promise<NativeAdapter>;
    onSelected?: (info: {
        provider: string;
        accountId: string;
        label?: string;
        requestedModel: string;
        model: string;
        sessionId?: string;
    }) => void;
    onFinished?: (info: {
        provider: string;
        accountId: string;
        label?: string;
        requestedModel: string;
        model: string;
        sessionId?: string;
        stopReason: 'stop' | 'error' | 'aborted';
    }) => void;
}
/** Structured exhaustion only; auth, rate-limit and network failures never rotate accounts. */
export declare function isQuotaExhaustion(error: unknown): boolean;
/** One service + region provider. Native messages, tool schemas and chunks remain untouched. */
export declare class PoolAdapter {
    private readonly options;
    private readonly sessions;
    private readonly activeSessions;
    constructor(options: PoolAdapterOptions);
    releaseSession(sessionId: string): boolean;
    private retainSession;
    private candidates;
    private check;
    private decode;
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    listModels(provider: string): Promise<NativeModel[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<NativeModel>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<NativePrepared>;
    stream(options: any): AsyncIterable<any>;
}
