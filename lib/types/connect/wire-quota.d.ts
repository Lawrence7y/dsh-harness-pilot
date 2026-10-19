/** The private shim emits this marker only after an explicit upstream quota classification. */
export declare const QUOTA_WIRE_MARKER = "DSH_PILOT_QUOTA_EXHAUSTED";
export declare function guardWorkBuddyResult(value: any): any;
export declare function guardWireQuota(adapter: any): {
    providerInfo: (...args: any[]) => any;
    listModels: (...args: any[]) => any;
    resolveModel: (...args: any[]) => any;
    prepareCall: (...args: any[]) => Promise<any>;
};
