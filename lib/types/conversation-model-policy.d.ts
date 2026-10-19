/** Keep external CLI discovery available to native tools, but out of the user picker. */
type Row = {
    id?: unknown;
};
export declare function conversationModelCatalog<T extends {
    groups?: readonly Row[];
    routableProviders?: readonly string[];
    failures?: readonly Row[];
}>(catalog: T, externalProviders: ReadonlySet<string>): T;
interface Controller {
    modelCatalog(): Promise<{
        groups?: Row[];
        routableProviders?: string[];
        failures?: Row[];
    }>;
    selectModel(request: {
        provider?: unknown;
    }): unknown;
}
/** Reversible instance wrappers; never change the LLM registry or subagent tool policy. */
export declare function installConversationModelPolicy(service: Controller, providers: () => ReadonlySet<string>): () => void;
export {};
