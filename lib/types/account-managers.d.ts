import type { TargetConfig } from './types.js';
export type ManagerKind = 'buddy' | 'agy';
export type BuddyRegion = 'cn' | 'ai';
export interface ManagerConfig {
    buddyUrl: string;
    agyCommand: string;
}
export interface ManagerAccount {
    handle: string;
    label: string;
    region: string;
    current: boolean;
    disabled: boolean;
    cliAdoption: 'unverified';
}
export declare function normalizeBuddyUrl(value: string): string;
export declare function validateAgyCommand(value: string): string;
/** Narrow transport, numeric loopback only. Redirects are errors and errors never echo response bodies. */
export declare function localManagerJson(base: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown>;
export declare function runAgyManager(command: string, args: readonly string[]): Promise<unknown>;
/** Shared-slot read leases last for the whole CLI/session lifetime; writers never interrupt readers. */
export declare class ManagerSlotLeases {
    private readonly readers;
    private readonly writers;
    beginUse(resource: string): () => void;
    beginWrite(resource: string): () => void;
    snapshot(): {
        resource: string;
        uses: number;
        switching: boolean;
    }[];
}
export declare function managerResourceForTarget(target: Pick<TargetConfig, 'name' | 'command' | 'args'>): string | undefined;
/** Only boolean slot occupancy leaves this process query; no command lines are returned/logged. */
export declare function managerExternalOccupied(resource: string): Promise<boolean>;
export interface AccountManagerDeps {
    file?: string;
    buddy?: typeof localManagerJson;
    agy?: typeof runAgyManager;
    externalOccupied?: (resource: string) => Promise<boolean>;
}
export declare class AccountManagers {
    private readonly deps;
    private config;
    private readonly refs;
    private readonly logins;
    readonly slots: ManagerSlotLeases;
    constructor(deps?: AccountManagerDeps);
    configure(input: Record<string, unknown>, persist?: boolean): ManagerConfig;
    /**
     * 管理器**积分快照**（Buddy Switch 桌面版落盘的官方积分，只读）。
     *
     * 与本类的 HTTP 通道（`buddyUrl → /api/…`）**不是一回事**，两条路径必须分清：
     *   · HTTP 通道 ⇒ 能列账号 / 能切账号，但**只在 webui 构建里存在**（本机装的是 Tauri 桌面版，不监听端口）；
     *   · 本快照  ⇒ 只有「每个账号的官方积分 + 采集时间 + 区域」，**不能切账号**，但**本机真实可用**。
     * 因此 `state()` 同时给出两者，并明确说明「未绑定 ⇒ 不参与自动切换」。
     */
    quotaSnapshot(): unknown;
    state(): unknown;
    beginExecution(target: Pick<TargetConfig, 'name' | 'command' | 'args'>): () => void;
    private buddy;
    private agy;
    private metadata;
    list(kind: ManagerKind, region?: BuddyRegion): Promise<unknown>;
    current(kind: ManagerKind, region?: BuddyRegion): Promise<unknown>;
    private ref;
    private writing;
    switch(kind: ManagerKind, handle: string, options?: {
        automatic?: boolean;
        confirmAppImpact?: boolean;
    }): Promise<unknown>;
    importLocal(region: BuddyRegion): Promise<unknown>;
    delete(handle: string): Promise<unknown>;
    oauthStart(region: BuddyRegion): Promise<unknown>;
    oauthStatus(handle: string): Promise<unknown>;
}
