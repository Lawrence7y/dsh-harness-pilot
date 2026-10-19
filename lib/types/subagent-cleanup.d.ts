import type { AllowedRoute } from './subagent-models.js';
export interface LiveModelCatalog {
    groups: readonly {
        id: string;
        name?: string;
        models: readonly {
            id: string;
            name?: string;
        }[];
    }[];
    failures?: readonly {
        id: string;
    }[];
}
/** Listing failures are unknown, not evidence of removal. Never delete those routes. */
export declare function obsoleteSubagentRoutes(allowed: readonly AllowedRoute[], catalog: LiveModelCatalog): AllowedRoute[];
