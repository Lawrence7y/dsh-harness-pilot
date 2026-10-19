import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AccountStore } from './account-store.js';
import { PoolAdapter } from './pool-adapter.js';
import { guardWireQuota, guardWorkBuddyResult } from './wire-quota.js';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
const load = (family, file) => {
    const url = new URL(`../../vendor/connect/${family}/${file}.js`, import.meta.url);
    const digest = createHash('sha256').update(readFileSync(url)).digest('hex');
    return import(`${url.href}?pilot=${digest}`);
};
const providerFor = (family, region) => `harness-${family}-${region}`;
const nameFor = (family, region) => `${family === 'workbuddy' ? 'WorkBuddy' : 'Qoder'}（${region === 'cn' ? '国内' : '国际'}${family === 'workbuddy' && region === 'intl' ? ' / WorkBuddy.AI' : ''}）`;
export const CONNECT_PROVIDERS = ['harness-workbuddy-cn', 'harness-workbuddy-intl', 'harness-qoder-cn', 'harness-qoder-intl'];
export const CONNECT_SOURCES = [
    { id: 'workbuddy-cn', family: 'workbuddy', region: 'cn', label: 'WorkBuddy 国内版当前桌面登录' },
    { id: 'workbuddy-intl', family: 'workbuddy', region: 'intl', label: 'WorkBuddy.AI 国际版当前桌面登录' },
    { id: 'qoder-cn', family: 'qoder', region: 'cn', label: 'Qoder CN 当前桌面登录' },
    { id: 'qoder-cn-ide', family: 'qoder', region: 'cn', label: 'Qoder CN IDE 当前桌面登录' },
    { id: 'qoder-intl', family: 'qoder', region: 'intl', label: 'Qoder 国际版当前桌面登录' },
];
export async function createConnectService(options) {
    const [wbAuth, wbCrypto, wbVariants, wbUpstream, wbCatalog, wbShim, wbAdapter, qAuth, qUpstream, qShim, qAdapter, qCatalog] = await Promise.all([
        load('workbuddy', 'auth'), load('workbuddy', 'desktop-credential-protection'), load('workbuddy', 'variants'), load('workbuddy', 'upstream'),
        load('workbuddy', 'catalog'), load('workbuddy', 'shim'), load('workbuddy', 'adapter'), load('qoder', 'credentials'), load('qoder', 'upstream'),
        load('qoder', 'shim'), load('qoder', 'adapter'), load('qoder', 'catalog-entry'),
    ]);
    const root = join(options.home, 'connect-api');
    const store = new AccountStore(join(root, 'accounts'));
    // Explicitly authorized by the user for this migration; zero/one-account pools remain bounded.
    if (store.list().length === 0)
        store.configure({ autoSwitchEnabled: true, maxSwitches: 2 });
    const runtimes = new Map(), state = new Map(), refreshes = new Map();
    const sourceErrors = {};
    const wbClient = new wbUpstream.WorkBuddyUpstreamClient();
    const cacheFile = (id) => join(root, `catalog-${id}.json`);
    const readCache = (id) => { try {
        return JSON.parse(readFileSync(cacheFile(id), 'utf8'));
    }
    catch {
        return { models: [], source: 'unknown' };
    } };
    const regionFor = (account) => ({ ...qAuth.REGIONS.find((region) => region.mode === (account.region === 'cn' ? 'cn' : 'global')),
        id: providerFor(account.family, account.region), displayName: nameFor(account.family, account.region) });
    const safeError = (error) => {
        const code = String(error?.reasonCode ?? error?.code ?? error?.name ?? 'upstream_error');
        return /^[\w.-]{1,100}$/.test(code) ? code : 'upstream_error';
    };
    const resolveCredential = async (account) => {
        let credential = store.readCredential(account.id);
        if (account.family === 'workbuddy' && Number(credential.expiresAtMs) <= Date.now() + 300000) {
            const update = await wbClient.refreshToken(credential);
            credential = { ...credential, accessToken: update.accessToken, refreshToken: update.refreshToken ?? credential.refreshToken,
                expiresAtMs: Date.now() + Number(update.expiresInSec ?? 3600) * 1000, source: 'dsh' };
            store.updateCredential(account.id, credential);
        }
        return credential;
    };
    async function runtimeFor(account) {
        const previous = runtimes.get(account.id);
        if (previous)
            return previous;
        const cache = state.get(account.id) ?? readCache(account.id);
        state.set(account.id, cache);
        const provider = providerFor(account.family, account.region);
        let runtime;
        const images = { resolveAttachments: options.resolveAttachments, resolveImageAccess: options.resolveImageAccess };
        if (account.family === 'workbuddy') {
            const catalog = new wbCatalog.WorkBuddyCatalog(cache.models ?? []);
            catalog.setVisible(true);
            const credentialStore = { resolve: () => resolveCredential(account), current: () => resolveCredential(account) };
            const client = { chatStream: async (...args) => {
                    // HTTP auth/rate/server failures never become quota just because their body mentions credits.
                    return guardWorkBuddyResult(await wbClient.chatStream(...args));
                } };
            const shim = wbShim.createWorkBuddyShim({ store: credentialStore, client, catalog });
            await shim.ready;
            const built = wbAdapter.createWorkBuddyAdapter({ providerId: provider, displayName: nameFor(account.family, account.region),
                region: account.region === 'cn' ? 'cn' : 'global', store: credentialStore, shim, catalog, ...images });
            runtime = { adapter: guardWireQuota(built.adapter), catalog, invalidate: built.invalidate, models: cache.models ?? [], close: () => shim.close() };
        }
        else {
            const region = regionFor(account);
            let models = cache.models ?? [];
            const shim = qShim.createQoderShim({ region, resolveCredential: () => resolveCredential(account), resolveModels: () => models,
                resolveUpstreamKey: (id) => models.find((row) => row.id === id)?.key,
                resolveAlwaysThinking: (id) => models.find((row) => row.id === id)?.alwaysThinking === true,
                resolveEnabledIds: () => [], invalidateCredential: () => { } });
            await shim.ready;
            const built = qAdapter.createQoderAdapter({ regions: [{ region, shim, catalog: () => models }],
                preferMaximumContext: () => false, imageModeFor: () => 'auto', enabledIdsFor: () => [], regionEnabled: () => true, ...images });
            runtime = { adapter: guardWireQuota(built.adapter), models, close: () => shim.close(), invalidate: () => { models = runtime.models; built.invalidate(); } };
        }
        runtimes.set(account.id, runtime);
        return runtime;
    }
    async function refreshAccount(id, readCredits = true) {
        const underway = refreshes.get(id);
        if (underway)
            return underway;
        const task = (async () => {
            const account = store.list().find(row => row.id === id);
            if (!account)
                throw Error('账号不存在');
            const prior = state.get(id) ?? readCache(id);
            try {
                const credential = await resolveCredential(account);
                const models = account.family === 'workbuddy' ? await wbClient.fetchModels(credential, AbortSignal.timeout(30000))
                    : (await qUpstream.fetchModels(regionFor(account), credential, AbortSignal.timeout(30000))).map((row) => qCatalog.normalizeEntry(row));
                let credits;
                if (readCredits) {
                    try {
                        const usage = account.family === 'workbuddy' ? await wbClient.fetchCredits(credential)
                            : await qUpstream.fetchUsage(regionFor(account), credential, AbortSignal.timeout(20000));
                        if (account.family === 'workbuddy' && typeof usage?.total === 'number')
                            credits = usage.total;
                        if (account.family === 'qoder' && usage) {
                            const values = [usage.userQuota, usage.addOnQuota].filter(bucket => bucket && ['credits', 'credit'].includes(String(bucket.unit).toLowerCase()))
                                .map(bucket => bucket.remaining).filter((value) => typeof value === 'number' && Number.isFinite(value));
                            if (values.length)
                                credits = values.reduce((a, b) => a + b, 0);
                        }
                    }
                    catch { /* balances unknown, never fabricate zero or rotate */ }
                }
                const next = { models, ...(credits === undefined ? {} : { credits }), updatedAt: new Date().toISOString(), source: 'live-api', status: 'ready' };
                state.set(id, next);
                mkdirSync(root, { recursive: true });
                writeFileSync(cacheFile(id), JSON.stringify(next), 'utf8');
                const runtime = await runtimeFor(account);
                runtime.models = models;
                runtime.catalog?.set(models);
                runtime.invalidate?.();
            }
            catch (error) {
                state.set(id, { ...prior, status: 'error', error: safeError(error), source: prior.models?.length ? 'saved-api-catalog' : 'unknown' });
                // A failed model listing must not be replaced by another account's list or a static vendor guess.
                if (prior.models?.length)
                    await runtimeFor(account);
            }
            options.changed?.();
        })().finally(() => refreshes.delete(id));
        refreshes.set(id, task);
        return task;
    }
    async function importSource(sourceId, label) {
        const source = CONNECT_SOURCES.find(row => row.id === sourceId);
        if (!source)
            throw Error('未知登录来源');
        let credential;
        if (source.family === 'workbuddy') {
            const variant = wbVariants.WORKBUDDY_VARIANTS.find((row) => row.region === (source.region === 'cn' ? 'cn' : 'global'));
            const keyProvider = new wbCrypto.WorkBuddyAtRestKeyProvider({ product: wbVariants.electronProfileFor(variant),
                electronPath: source.region === 'cn' ? 'D:/workbuddy/WorkBuddy.exe' : 'D:/workbuddy ai/WorkBuddyAI/WorkBuddyAI.exe' });
            // Only current(), never upstream resolve(): refresh copies are stored solely in our DPAPI vault.
            const reader = new wbAuth.WorkBuddyCredentialStore({ variant, keyProvider, ownPath: join(root, 'never-used-own-copy.json'), refresh: (value) => wbClient.refreshToken(value) });
            credential = await reader.current();
        }
        else {
            const region = qAuth.REGIONS.find((row) => row.mode === (source.region === 'cn' ? 'cn' : 'global'));
            const descriptor = source.id === 'qoder-cn-ide' ? { ...region, appNames: ['Qoder CN IDE'], newAppNames: [] } : region;
            credential = await qAuth.loadCredentialAsync(descriptor, process.env.APPDATA, { force: true });
        }
        if (!credential)
            throw Error('该桌面来源尚未登录或当前登录态不可读取，请先在对应应用完成登录');
        const account = store.add({ family: source.family, region: source.region, label: label || source.label, source: source.id, credential });
        await refreshAccount(account.id);
        return account;
    }
    const pools = new Map();
    for (const family of ['workbuddy', 'qoder'])
        for (const region of ['cn', 'intl']) {
            const provider = providerFor(family, region);
            pools.set(provider, new PoolAdapter({ provider, name: `外部模型 · ${nameFor(family, region)}`, family, region, store,
                bindings: () => store.list().filter(row => row.family === family && row.region === region).map(row => ({ ...row,
                    models: (state.get(row.id)?.models ?? readCache(row.id).models ?? []).map((model) => model.id) })),
                factory: account => runtimeFor(account).then(row => row.adapter), onSelected: options.onSelected, onFinished: options.onFinished }));
        }
    const adapter = {
        providerInfo: (provider) => pools.get(provider).providerInfo(provider),
        providerRetryPolicy: () => resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'harness-pilot.connect'),
        imageRequestPricing: () => undefined,
        listModels: (provider) => pools.get(provider).listModels(provider),
        resolveModel: (provider, model, signal) => pools.get(provider).resolveModel(provider, model, signal),
        prepareCall: (provider, model, signal) => pools.get(provider).prepareCall(provider, model, signal),
    };
    const summary = () => ({ sources: CONNECT_SOURCES.map(source => ({ ...source, error: sourceErrors[source.id] })), config: store.config(), events: store.summary().events,
        accounts: store.list().map(account => {
            const value = state.get(account.id) ?? readCache(account.id);
            return { ...account,
                provider: providerFor(account.family, account.region), status: value.status ?? 'unknown', credits: value.credits, error: value.error, updatedAt: value.updatedAt,
                models: (value.models ?? []).map((row) => ({ id: row.id, name: row.name, billing: row.billing ?? {
                        free: row.isFree === true, ...(Number(row.priceFactor) > 0 ? { multiplier: row.priceFactor } : { rateUnknown: row.isFree !== true }),
                        ...(row.promotion ? { promotion: row.promotion } : {})
                    } })) };
        }) });
    return { adapter, store, summary, importSource,
        openLoginSource: async (sourceId) => {
            // Never accept a user-supplied command/path or manufacture an OAuth flow.
            const executables = {
                'workbuddy-cn': 'D:/workbuddy/WorkBuddy.exe', 'workbuddy-intl': 'D:/workbuddy ai/WorkBuddyAI/WorkBuddyAI.exe',
                'qoder-cn': 'D:/Qoder CN/Qoder CN.exe', 'qoder-cn-ide': 'D:/Qoder CNide/Qoder CN IDE.exe', 'qoder-intl': 'D:/Qoder/Qoder.exe',
            };
            const executable = executables[sourceId];
            if (!executable || !existsSync(executable))
                throw Error('对应原生桌面应用未安装');
            const env = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            delete env.NODE_OPTIONS;
            await new Promise((resolve, reject) => {
                const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false, env });
                child.once('error', reject);
                child.once('spawn', () => { child.unref(); resolve(); });
            });
        },
        refresh: async (id) => { for (const row of store.list().filter(row => !id || row.id === id))
            await refreshAccount(row.id); },
        initialize: async () => {
            if (store.list().length === 0)
                for (const source of CONNECT_SOURCES) {
                    try {
                        await importSource(source.id);
                    }
                    catch (error) {
                        sourceErrors[source.id] = safeError(error);
                    }
                }
            else
                for (const account of store.list()) {
                    const cache = readCache(account.id);
                    state.set(account.id, cache);
                    if (cache.models?.length)
                        await runtimeFor(account);
                }
            options.changed?.();
        },
        remove: async (id) => { store.remove(id); state.delete(id); options.changed?.(); },
        update: (id, patch) => { store.patch(id, patch); options.changed?.(); },
        configure: (value) => { store.configure(value); options.changed?.(); },
        close: async () => { await Promise.allSettled([...runtimes.values()].map(row => row.close())); runtimes.clear(); }, };
}
//# sourceMappingURL=service.js.map