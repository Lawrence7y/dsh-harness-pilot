import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, win32 } from 'node:path';
import { redactAccount } from './federation/poolconfig.js';
import { readBuddyQuota } from './federation/buddy-quota.js';
const DEFAULT_CONFIG = { buddyUrl: '', agyCommand: '' };
const MAX_BYTES = 1024 * 1024;
const obj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const str = (value) => typeof value === 'string' ? value : '';
const handleFor = (kind, region, id) => 'mgr-' + createHash('sha256').update(kind + '\0' + region + '\0' + id).digest('hex').slice(0, 24);
export function normalizeBuddyUrl(value) {
    if (value === '')
        return '';
    const match = /^http:\/\/(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?\/?$/.exec(value);
    if (!match)
        throw new Error('服务地址只允许 http://127.0.0.1:端口 或 localhost，不允许路径、凭据或远程地址');
    const port = match[2] === undefined ? 80 : Number(match[2]);
    if (!(port >= 1 && port <= 65535))
        throw new Error('本机服务端口无效');
    return 'http://127.0.0.1:' + port;
}
export function validateAgyCommand(value) {
    if (value === '')
        return '';
    if (!isAbsolute(value) || !/^agy-switch\.exe$/i.test(win32.basename(value)))
        throw new Error('请选择 agy-switch.exe 的绝对路径，不能使用 GUI 程序或 shell 脚本');
    return value;
}
/** Narrow transport, numeric loopback only. Redirects are errors and errors never echo response bodies. */
export function localManagerJson(base, path, method, body) {
    const normalized = normalizeBuddyUrl(base);
    if (!normalized)
        return Promise.reject(new Error('尚未配置 Buddy Switch 服务地址'));
    const wire = body === undefined ? undefined : JSON.stringify(body);
    if (wire !== undefined && Buffer.byteLength(wire) > 4096)
        return Promise.reject(new Error('管理请求过大'));
    return new Promise((resolve, reject) => {
        const req = request(normalized + path, { method, headers: { accept: 'application/json', ...(wire === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) }) } }, res => {
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => { size += chunk.length; if (size > MAX_BYTES) {
                req.destroy();
                reject(new Error('管理器响应超过限制'));
            }
            else
                chunks.push(chunk); });
            res.on('error', () => reject(new Error('管理器响应中断')));
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)
                    return reject(new Error('管理器请求失败（HTTP ' + String(res.statusCode ?? 0) + '），请在管理器查看详情'));
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (obj(data).ok === false)
                        throw new Error('refused');
                    resolve(data);
                }
                catch {
                    reject(new Error('管理器返回无效或拒绝的 JSON'));
                }
            });
        });
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        req.on('error', () => reject(new Error('无法连接本机账号管理器或请求超时')));
        if (wire !== undefined)
            req.write(wire);
        req.end();
    });
}
export function runAgyManager(command, args) {
    validateAgyCommand(command);
    if (!command)
        return Promise.reject(new Error('尚未配置 agy-switch.exe'));
    return new Promise((resolve, reject) => execFile(command, [...args], { windowsHide: true, timeout: 60000, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
            if (args[0] === 'current' || args[0] === 'quota') {
                try {
                    const result = obj(JSON.parse(stderr));
                    if (result.schema_version === 1 && obj(result.error).code === 3)
                        return resolve({ schema_version: 1, account: null, notFound: true });
                }
                catch { /* no raw diagnostics leave this boundary */ }
            }
            return reject(new Error(args[0] === 'switch' ? 'agy-switch 切换失败，可能部分生效；请核查后再操作（不会自动重试）' : 'agy-switch 读取失败，请检查管理器路径和版本'));
        }
        try {
            const value = JSON.parse(stdout);
            if (obj(value).schema_version !== 1 || obj(value).error !== undefined)
                throw new Error('schema');
            resolve(value);
        }
        catch {
            reject(new Error('agy-switch 输出格式不兼容'));
        }
    }));
}
/** Shared-slot read leases last for the whole CLI/session lifetime; writers never interrupt readers. */
export class ManagerSlotLeases {
    readers = new Map();
    writers = new Set();
    beginUse(resource) {
        if (this.writers.has(resource))
            throw new Error('账号共享槽正在切换，本次执行明确拒绝；稍后重试');
        const token = randomUUID(), readers = this.readers.get(resource) ?? new Set();
        readers.add(token);
        this.readers.set(resource, readers);
        let released = false;
        return () => { if (released)
            return; released = true; readers.delete(token); if (readers.size === 0)
            this.readers.delete(resource); };
    }
    beginWrite(resource) {
        if (this.writers.has(resource) || (this.readers.get(resource)?.size ?? 0) > 0)
            throw new Error('该账号共享槽仍被 CLI/会话占用，已拒绝切换；不会关闭或重启任务');
        this.writers.add(resource);
        let released = false;
        return () => { if (released)
            return; released = true; this.writers.delete(resource); };
    }
    snapshot() {
        return [...new Set([...this.readers.keys(), ...this.writers])].map(resource => ({ resource, uses: this.readers.get(resource)?.size ?? 0, switching: this.writers.has(resource) }));
    }
}
export function managerResourceForTarget(target) {
    const exe = win32.basename(target.command).toLowerCase(), name = target.name.toLowerCase();
    if (target.args.some(arg => win32.basename(arg).toLowerCase() === 'workbuddy-managed.cjs')) {
        if (target.args.includes('workbuddy-ai-b'))
            return 'buddy:ai';
        if (target.args.includes('workbuddy-a'))
            return 'buddy:cn';
        return 'buddy:shared';
    }
    if (exe === 'workbuddyai.exe' || name === 'wb-managed-ai-b')
        return 'buddy:ai';
    if (exe === 'workbuddy.exe' || name === 'wb-managed-a')
        return 'buddy:cn';
    if (/^(?:agy|antigravity)(?:[-_.].*)?$/.test(name) || /^(?:agy|agy-core|antigravity)\.exe$/.test(exe))
        return 'agy:shared';
    return undefined;
}
/** Only boolean slot occupancy leaves this process query; no command lines are returned/logged. */
export function managerExternalOccupied(resource) {
    if (process.platform !== 'win32')
        return Promise.reject(new Error('当前平台尚未接入 CLI 占用检查，拒绝切换'));
    const script = `$ErrorActionPreference='Stop'; $cn=$false; $ai=$false; $agy=$false; Get-CimInstance Win32_Process | ForEach-Object { $n=$_.Name; $c=$_.CommandLine; if ($c -match 'workbuddy-managed\\.cjs') { if ($c -match 'workbuddy-ai-b') {$ai=$true} elseif ($c -match 'workbuddy-a') {$cn=$true} else {$cn=$true;$ai=$true} }; if (($n -match '^(node|codebuddy)\\.exe$') -and ($c -match '(codebuddy|workbuddy).*(cli|bin[/\\\\])')) {$cn=$true;$ai=$true}; if (($n -match '^(agy|agy-core)\\.exe$') -or (($n -eq 'node.exe') -and ($c -match '(agy|antigravity).*(cli|headless)'))) {$agy=$true} }; @{cn=$cn;ai=$ai;agy=$agy}|ConvertTo-Json -Compress`;
    return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
        if (error)
            return reject(new Error('无法确认本机 CLI 是否空闲，拒绝切换'));
        try {
            const data = obj(JSON.parse(stdout));
            const key = resource === 'buddy:cn' ? 'cn' : resource === 'buddy:ai' ? 'ai' : 'agy';
            if (typeof data[key] !== 'boolean')
                throw new Error('unknown');
            resolve(data[key]);
        }
        catch {
            reject(new Error('CLI 占用检测结果无效，拒绝切换'));
        }
    }));
}
export class AccountManagers {
    deps;
    config = { ...DEFAULT_CONFIG };
    refs = new Map();
    logins = new Map();
    slots = new ManagerSlotLeases();
    constructor(deps = {}) {
        this.deps = deps;
        if (deps.file && existsSync(deps.file)) {
            try {
                this.configure(obj(JSON.parse(readFileSync(deps.file, 'utf8'))), false);
            }
            catch { /* invalid configuration remains disabled */ }
        }
    }
    configure(input, persist = true) {
        for (const key of ['buddyUrl', 'agyCommand'])
            if (input[key] !== undefined && typeof input[key] !== 'string')
                throw new Error('管理器连接配置必须为字符串');
        const next = { buddyUrl: input.buddyUrl === undefined ? this.config.buddyUrl : normalizeBuddyUrl(str(input.buddyUrl)), agyCommand: input.agyCommand === undefined ? this.config.agyCommand : validateAgyCommand(str(input.agyCommand)) };
        if (this.slots.snapshot().some(slot => slot.switching))
            throw new Error('切换进行中，暂时不能修改管理器配置');
        if (persist && this.deps.file) {
            mkdirSync(dirname(this.deps.file), { recursive: true });
            writeFileSync(this.deps.file, JSON.stringify(next, null, 2), { encoding: 'utf8' });
        }
        this.config = next;
        this.refs.clear();
        this.logins.clear();
        return { ...next };
    }
    /**
     * 管理器**积分快照**（Buddy Switch 桌面版落盘的官方积分，只读）。
     *
     * 与本类的 HTTP 通道（`buddyUrl → /api/…`）**不是一回事**，两条路径必须分清：
     *   · HTTP 通道 ⇒ 能列账号 / 能切账号，但**只在 webui 构建里存在**（本机装的是 Tauri 桌面版，不监听端口）；
     *   · 本快照  ⇒ 只有「每个账号的官方积分 + 采集时间 + 区域」，**不能切账号**，但**本机真实可用**。
     * 因此 `state()` 同时给出两者，并明确说明「未绑定 ⇒ 不参与自动切换」。
     */
    quotaSnapshot() {
        const snapshot = readBuddyQuota();
        return {
            ...snapshot,
            canSwitch: this.config.buddyUrl.length > 0,
            switchChannel: this.config.buddyUrl.length > 0
                ? 'HTTP（webui 构建）'
                : '未接通（本机装的是桌面版，只走 Tauri IPC，不监听端口；HTTP 通道只在 webui 构建里存在）',
            participatesInAutoSwitch: false,
        };
    }
    state() {
        return {
            config: { ...this.config },
            leases: this.slots.snapshot(),
            safeAutoSwitch: false,
            cliAdoption: 'unverified',
            note: '管理器账号与执行档案分开；管理器切换结果不证明新 CLI 已采用该账号。',
            buddyQuota: this.quotaSnapshot(),
        };
    }
    beginExecution(target) {
        const resource = managerResourceForTarget(target);
        const resources = resource === 'buddy:shared' ? ['buddy:cn', 'buddy:ai'] : resource === undefined ? [] : [resource];
        const releases = [];
        try {
            for (const key of resources)
                releases.push(this.slots.beginUse(key));
        }
        catch (error) {
            for (const release of releases)
                release();
            throw error;
        }
        return () => { for (const release of releases)
            release(); };
    }
    buddy(path, method, body) { return (this.deps.buddy ?? localManagerJson)(this.config.buddyUrl, path, method, body); }
    agy(args) { return (this.deps.agy ?? runAgyManager)(this.config.agyCommand, args); }
    metadata(kind, raw, region, currentId = '') {
        const row = obj(raw), id = str(row.id) || str(row.uid);
        if (!id)
            return undefined;
        const uid = str(row.uid) || id, handle = handleFor(kind, region, id);
        this.refs.set(handle, { kind, id, uid, region, disabled: row.disabled === true || row.validation_blocked === true });
        return { handle, label: redactAccount(uid) + ' · ' + handle.slice(-6), region, current: row.is_current === true || id === currentId || uid === currentId, disabled: row.disabled === true || row.validation_blocked === true, cliAdoption: 'unverified' };
    }
    async list(kind, region = 'cn') {
        let rows, current = '';
        if (kind === 'buddy') {
            const data = obj(await this.buddy('/api/accounts?variant=' + region, 'GET'));
            rows = Array.isArray(data.accounts) ? data.accounts : [];
            current = str(data.current) || str(obj(data.current).uid);
            rows = rows.filter(row => str(obj(row).variant) === region);
        }
        else {
            const data = obj(await this.agy(['accounts', 'list', '--json']));
            rows = Array.isArray(data.accounts) ? data.accounts : [];
            region = 'cn'; // unused by AGY; the shared credential scope is intentionally separate.
        }
        const scope = kind === 'buddy' ? region : 'app';
        for (const [handle, ref] of this.refs)
            if (ref.kind === kind && ref.region === scope)
                this.refs.delete(handle);
        return { manager: kind, region: scope, accounts: rows.map(row => this.metadata(kind, row, scope, current)).filter(Boolean), cliAdoption: 'unverified', safeAutoSwitch: false };
    }
    async current(kind, region = 'cn') {
        const data = obj(kind === 'buddy' ? await this.buddy('/api/status?variant=' + region, 'GET') : await this.agy(['current', '--json']));
        const raw = kind === 'buddy' ? data.current : data.account;
        return { manager: kind, current: this.metadata(kind, raw, kind === 'buddy' ? region : 'app') ?? null, running: data.running === true, source: 'manager-record', cliAdoption: 'unverified', note: '这是管理器记录，不能替代 CLI 实际身份验证。' };
    }
    ref(handle, kind) { const ref = this.refs.get(handle); if (!ref || ref.kind !== kind)
        throw new Error('账号选项已失效，请先刷新管理器列表'); if (ref.disabled)
        throw new Error('该管理器账号已停用或受限，拒绝切换'); return ref; }
    async writing(resource, action) {
        const release = this.slots.beginWrite(resource);
        try {
            if (await (this.deps.externalOccupied ?? managerExternalOccupied)(resource))
                throw new Error('检测到该共享认证范围仍有 CLI 运行，已拒绝修改；不会关闭进程');
            return await action();
        }
        finally {
            release();
        }
    }
    async switch(kind, handle, options = {}) {
        if (options.automatic)
            throw new Error('管理器账号尚未验证 CLI 采用，禁止加入自动切换执行链');
        const ref = this.ref(handle, kind), resource = kind === 'buddy' ? 'buddy:' + ref.region : 'agy:shared';
        if (kind === 'agy' && options.confirmAppImpact !== true)
            throw new Error('此切换会同步 App 与 agy 并可能关闭重启 App；需明确确认 App 影响');
        return this.writing(resource, async () => {
            await this.list(kind, ref.region === 'ai' ? 'ai' : 'cn');
            this.ref(handle, kind);
            if (kind === 'buddy')
                await this.buddy('/api/switch', 'POST', { accountId: ref.id, restart: false, shareSessions: false, copySessionIds: [] });
            else
                await this.agy(['switch', ref.id, '--target', 'app', '--json']);
            return { manager: kind, switched: true, handle, cliAdoption: 'unverified', appImpact: kind === 'agy', note: '管理器切换动作完成；请启动新的 CLI 并验证身份，现有执行档案只是槽位配方；原有冻结成员恢复时不能保证仍是原登录账号，需要新建或重新验证。' };
        });
    }
    async importLocal(region) { return this.writing('buddy:' + region, async () => { await this.buddy('/api/import-local', 'POST', { variant: region }); return { imported: true, region, note: '已导入管理器；请刷新列表。未注册为可执行账号档案。' }; }); }
    async delete(handle) { const ref = this.ref(handle, 'buddy'); return this.writing('buddy:' + ref.region, async () => { await this.buddy('/api/delete', 'POST', { accountId: ref.id }); this.refs.delete(handle); return { deleted: true, handle, note: '仅删除管理器档案，不等于退出厂商登录。' }; }); }
    async oauthStart(region) {
        const data = obj(await this.buddy('/api/oauth/start', 'POST', { variant: region }));
        const id = str(data.loginId), uri = str(data.verificationUri);
        let parsed;
        try {
            parsed = new URL(uri);
        }
        catch {
            throw new Error('管理器未返回有效登录网址');
        }
        if (!id || parsed.protocol !== 'https:' || parsed.username || parsed.password)
            throw new Error('管理器登录返回格式无效');
        const handle = handleFor('oauth', region, id);
        for (const [key, login] of this.logins)
            if (login.expiresAt <= Date.now())
                this.logins.delete(key);
        if (this.logins.size >= 8)
            throw new Error('登录请求过多，请等待已有请求完成或过期');
        this.logins.set(handle, { id, region, expiresAt: Date.now() + Math.max(30, Math.min(600, typeof data.expiresIn === 'number' ? data.expiresIn : 300)) * 1000 });
        return { loginHandle: handle, verificationUri: parsed.href, expiresIn: typeof data.expiresIn === 'number' ? data.expiresIn : null, region };
    }
    async oauthStatus(handle) {
        const login = this.logins.get(handle);
        if (!login || login.expiresAt <= Date.now())
            throw new Error('登录请求已失效，请重新发起');
        const data = obj(await this.buddy('/api/oauth/status', 'POST', { loginId: login.id }));
        if (data.done !== true)
            return { done: false, loginHandle: handle };
        this.logins.delete(handle);
        return { done: true, account: this.metadata('buddy', data.result, login.region) ?? null, cliAdoption: 'unverified' };
    }
}
//# sourceMappingURL=account-managers.js.map