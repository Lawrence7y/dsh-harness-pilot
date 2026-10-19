import { AccountStore, type AccountMetadata, type ConnectFamily, type ConnectRegion } from './account-store.js';
type Options = {
    home: string;
    onSelected?: (value: any) => void;
    onFinished?: (value: any) => void;
    resolveAttachments?: () => any;
    resolveImageAccess?: (...args: any[]) => any;
    changed?: () => void;
};
export declare const CONNECT_PROVIDERS: string[];
export declare const CONNECT_SOURCES: readonly [{
    readonly id: "workbuddy-cn";
    readonly family: "workbuddy";
    readonly region: "cn";
    readonly label: "WorkBuddy 国内版当前桌面登录";
}, {
    readonly id: "workbuddy-intl";
    readonly family: "workbuddy";
    readonly region: "intl";
    readonly label: "WorkBuddy.AI 国际版当前桌面登录";
}, {
    readonly id: "qoder-cn";
    readonly family: "qoder";
    readonly region: "cn";
    readonly label: "Qoder CN 当前桌面登录";
}, {
    readonly id: "qoder-cn-ide";
    readonly family: "qoder";
    readonly region: "cn";
    readonly label: "Qoder CN IDE 当前桌面登录";
}, {
    readonly id: "qoder-intl";
    readonly family: "qoder";
    readonly region: "intl";
    readonly label: "Qoder 国际版当前桌面登录";
}];
export declare function createConnectService(options: Options): Promise<{
    adapter: {
        providerInfo: (provider: string) => {
            id: string;
            name: string;
        };
        providerRetryPolicy: () => any;
        imageRequestPricing: () => undefined;
        listModels: (provider: string) => Promise<import("./pool-adapter.js").NativeModel[]>;
        resolveModel: (provider: string, model: string, signal?: AbortSignal) => Promise<import("./pool-adapter.js").NativeModel>;
        prepareCall: (provider: string, model: string, signal?: AbortSignal) => Promise<import("./pool-adapter.js").NativePrepared>;
    };
    store: AccountStore;
    summary: () => {
        sources: ({
            error: string;
            id: "workbuddy-cn";
            family: "workbuddy";
            region: "cn";
            label: "WorkBuddy 国内版当前桌面登录";
        } | {
            error: string;
            id: "workbuddy-intl";
            family: "workbuddy";
            region: "intl";
            label: "WorkBuddy.AI 国际版当前桌面登录";
        } | {
            error: string;
            id: "qoder-cn";
            family: "qoder";
            region: "cn";
            label: "Qoder CN 当前桌面登录";
        } | {
            error: string;
            id: "qoder-cn-ide";
            family: "qoder";
            region: "cn";
            label: "Qoder CN IDE 当前桌面登录";
        } | {
            error: string;
            id: "qoder-intl";
            family: "qoder";
            region: "intl";
            label: "Qoder 国际版当前桌面登录";
        })[];
        config: import("./account-store.js").PoolConfig;
        events: import("./account-store.js").AccountEvent[];
        accounts: {
            provider: string;
            status: any;
            credits: any;
            error: any;
            updatedAt: any;
            models: any;
            id: string;
            family: ConnectFamily;
            region: ConnectRegion;
            label: string;
            fingerprint: string;
            enabled: boolean;
            priority: number;
            source: string;
            createdAt: string;
        }[];
    };
    importSource: (sourceId: string, label?: string) => Promise<AccountMetadata>;
    openLoginSource: (sourceId: string) => Promise<void>;
    refresh: (id?: string) => Promise<void>;
    initialize: () => Promise<void>;
    remove: (id: string) => Promise<void>;
    update: (id: string, patch: {
        label?: string;
        enabled?: boolean;
        priority?: number;
    }) => void;
    configure: (value: {
        autoSwitchEnabled?: boolean;
        maxSwitches?: number;
    }) => void;
    close: () => Promise<void>;
}>;
export type ConnectService = Awaited<ReturnType<typeof createConnectService>>;
export {};
