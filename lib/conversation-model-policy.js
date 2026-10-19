export function conversationModelCatalog(catalog, externalProviders) {
    const external = (id) => typeof id === 'string' && externalProviders.has(id);
    return {
        ...catalog,
        ...(catalog.groups === undefined ? {} : { groups: catalog.groups.filter(row => !external(row.id)) }),
        ...(catalog.routableProviders === undefined ? {} : { routableProviders: catalog.routableProviders.filter(id => !external(id)) }),
        ...(catalog.failures === undefined ? {} : { failures: catalog.failures.filter(row => !external(row.id)) }),
    };
}
const MARK = Symbol.for('dsh-harness-pilot.conversation-model-policy');
/** Reversible instance wrappers; never change the LLM registry or subagent tool policy. */
export function installConversationModelPolicy(service, providers) {
    const raw = (service[Symbol.for('cordis.original')] ?? service);
    const prior = raw[MARK];
    const baseCatalog = prior?.baseCatalog ?? raw.modelCatalog;
    const baseSelect = prior?.baseSelect ?? raw.selectModel;
    if (typeof baseCatalog !== 'function' || typeof baseSelect !== 'function')
        throw Error('sessionController modelCatalog/selectModel unavailable');
    const catalogDescriptor = prior ? prior.catalogDescriptor : Object.getOwnPropertyDescriptor(raw, 'modelCatalog');
    const selectDescriptor = prior ? prior.selectDescriptor : Object.getOwnPropertyDescriptor(raw, 'selectModel');
    const wrappedCatalog = async function () {
        return conversationModelCatalog(await baseCatalog.call(this), providers());
    };
    const wrappedSelect = function (request) {
        if (typeof request?.provider === 'string' && providers().has(request.provider)) {
            throw Object.assign(Error('外部 harness 模型仅供模型通过子代理工具选择。请在提示词中指定 harness 和模型。'), { code: 'EXTERNAL_MODEL_SUBAGENT_ONLY' });
        }
        return baseSelect.call(this, request);
    };
    Object.defineProperty(raw, 'modelCatalog', { configurable: true, writable: true, value: wrappedCatalog });
    Object.defineProperty(raw, 'selectModel', { configurable: true, writable: true, value: wrappedSelect });
    const mark = { baseCatalog, baseSelect, catalogDescriptor, selectDescriptor };
    raw[MARK] = mark;
    return () => {
        if (raw.modelCatalog === wrappedCatalog) {
            if (catalogDescriptor)
                Object.defineProperty(raw, 'modelCatalog', catalogDescriptor);
            else
                delete raw.modelCatalog;
        }
        if (raw.selectModel === wrappedSelect) {
            if (selectDescriptor)
                Object.defineProperty(raw, 'selectModel', selectDescriptor);
            else
                delete raw.selectModel;
        }
        if (raw[MARK] === mark)
            delete raw[MARK];
    };
}
//# sourceMappingURL=conversation-model-policy.js.map