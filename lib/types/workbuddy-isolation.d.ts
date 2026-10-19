import type { TargetConfig } from './types.js';
export declare function activeWorkBuddyHome(profileDir: string): string | undefined;
export declare function workBuddyStoredAccounts(profileDir: string): {
    handle: string;
    label: string;
    fingerprint: string;
    selected: boolean;
    authenticatedAt?: string;
}[];
export declare function selectWorkBuddyAccount(profileDir: string, handle: string): void;
export declare function captureWorkBuddyAccount(target: TargetConfig, profileDir: string, label: string, realHome?: string): void;
export declare function recordWorkBuddyAuthorization(target: TargetConfig): void;
export declare function protectedWorkBuddyPrincipal(bytes: Buffer): string;
/** Separate native HOME and protected keyblob for each profile. Never decrypt/export tokens. */
export declare function prepareWorkBuddyHome(target: TargetConfig, profileDir: string, realHome?: string): TargetConfig;
