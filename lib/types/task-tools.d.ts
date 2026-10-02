import type { ResolvedConfig } from './config.js';
import type { TaskManager } from './tasks.js';
import type { RuntimeSettings } from './settings.js';
import type { SessionRegistry } from './sessions.js';
export interface TaskToolDeps {
    readonly config: ResolvedConfig;
    readonly registry: SessionRegistry;
    readonly tasks: TaskManager;
    readonly settings: () => RuntimeSettings;
}
export declare function registerTaskTools(ctx: any, deps: TaskToolDeps): void;
