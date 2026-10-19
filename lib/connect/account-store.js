import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
function dpapi(value, decrypt) {
    if (process.platform !== 'win32')
        throw new Error('账号凭据存储需要 Windows CurrentUser DPAPI');
    // Payload travels on stdin, never argv, output logs, or a plaintext disk file.
    const operation = decrypt ? 'Unprotect' : 'Protect';
    const script = `Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $o=[Security.Cryptography.ProtectedData]::${operation}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
    const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: value.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error)
        throw new Error('Windows DPAPI 操作失败，凭据未写入');
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(result.stdout.trim()))
        throw new Error('Windows DPAPI 未返回有效数据');
    return Buffer.from(result.stdout.trim(), 'base64');
}
function identity(credential) {
    const keys = ['uid', 'userId', 'userID', 'user_id', 'accountId', 'account_id', 'UserId', 'Uid'];
    const visit = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 4)
            return undefined;
        const record = value;
        for (const key of keys) {
            const id = record[key];
            if ((typeof id === 'string' || typeof id === 'number') && String(id).trim())
                return String(id).trim();
        }
        for (const key of ['user', 'account', 'profile', 'data', 'credential', 'auth', 'loginData']) {
            const id = visit(record[key], depth + 1);
            if (id)
                return id;
        }
        return undefined;
    };
    const value = visit(credential, 0);
    if (!value)
        throw new Error('无法确定账号身份：需要 uid/userId，拒绝按 token 冒充新账号');
    return createHash('sha256').update(value).digest('hex');
}
export class AccountStore {
    root;
    protect;
    unprotect;
    state;
    constructor(root, options = {}) {
        if (Boolean(options.protect) !== Boolean(options.unprotect))
            throw new Error('protect/unprotect 必须同时提供');
        this.protect = options.protect ?? ((value) => dpapi(value, false));
        this.unprotect = options.unprotect ?? ((value) => dpapi(value, true));
        this.root = resolve(root);
        mkdirSync(this.root, { recursive: true });
        this.state = existsSync(this.path())
            ? JSON.parse(this.unprotect(readFileSync(this.path())).toString('utf8'))
            : { version: 1, accounts: [], config: { autoSwitchEnabled: false, maxSwitches: 2 }, events: [] };
        if (this.state.version !== 1 || !Array.isArray(this.state.accounts))
            throw new Error('不支持的账号池数据格式');
    }
    path(id) {
        if (id !== undefined && !/^[a-z0-9-]+$/i.test(id))
            throw new Error('无效账号 ID');
        return join(this.root, id ? `${id}.dpapi` : 'accounts.dpapi');
    }
    write(path, value) {
        const ciphertext = this.protect(Buffer.from(JSON.stringify(value), 'utf8'));
        const temp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temp, ciphertext, { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
    }
    save() { this.write(this.path(), this.state); }
    list() { return structuredClone(this.state.accounts); }
    add(input) {
        if (!['workbuddy', 'qoder'].includes(input.family) || !['cn', 'intl'].includes(input.region))
            throw new Error('无效的服务或区域');
        const fingerprint = identity(input.credential);
        const existing = this.state.accounts.find((a) => a.family === input.family && a.region === input.region && a.fingerprint === fingerprint);
        if (existing) {
            this.updateCredential(existing.id, input.credential);
            return { ...existing };
        }
        const now = new Date().toISOString();
        const account = { id: randomUUID(), family: input.family, region: input.region,
            label: input.label?.slice(0, 120) || `${input.family} ${input.region} ${fingerprint.slice(0, 8)}`,
            fingerprint, enabled: true, priority: 100, source: input.source?.slice(0, 120) || 'manual', createdAt: now, updatedAt: now };
        this.write(this.path(account.id), input.credential);
        this.state.accounts.push(account);
        this.save();
        return { ...account };
    }
    readCredential(id) {
        if (!this.state.accounts.some((a) => a.id === id))
            throw new Error('账号不存在');
        return JSON.parse(this.unprotect(readFileSync(this.path(id))).toString('utf8'));
    }
    updateCredential(id, value) {
        const account = this.state.accounts.find((a) => a.id === id);
        if (!account)
            throw new Error('账号不存在');
        if (identity(value) !== account.fingerprint)
            throw new Error('刷新后的账号身份发生变化，拒绝覆盖原账号');
        this.write(this.path(id), value);
        account.updatedAt = new Date().toISOString();
        this.save();
    }
    patch(id, value) {
        const account = this.state.accounts.find((a) => a.id === id);
        if (!account)
            throw new Error('账号不存在');
        if (value.label !== undefined)
            account.label = String(value.label).slice(0, 120);
        if (value.enabled !== undefined)
            account.enabled = Boolean(value.enabled);
        if (value.priority !== undefined && Number.isFinite(value.priority))
            account.priority = value.priority;
        account.updatedAt = new Date().toISOString();
        this.save();
        return { ...account };
    }
    remove(id) {
        this.path(id);
        const previous = this.state.accounts.length;
        this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
        if (previous === this.state.accounts.length)
            return;
        this.save();
        if (existsSync(this.path(id)))
            unlinkSync(this.path(id));
    }
    config() { return { ...this.state.config }; }
    configure(value) {
        this.state.config = {
            autoSwitchEnabled: value.autoSwitchEnabled ?? this.state.config.autoSwitchEnabled,
            maxSwitches: value.maxSwitches === undefined ? this.state.config.maxSwitches : Math.max(0, Math.min(2, Math.floor(Number.isFinite(value.maxSwitches) ? value.maxSwitches : 0))),
        };
        this.save();
        return this.config();
    }
    record(event) {
        // Never persist raw provider exceptions. Reasons are owned, bounded codes only.
        const clean = (v) => v?.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 180);
        this.state.events.push({ type: event.type, at: new Date().toISOString(), from: clean(event.from), to: clean(event.to), reason: clean(event.reason), model: clean(event.model), sessionId: clean(event.sessionId), accountId: clean(event.accountId), requestedModel: clean(event.requestedModel), provider: clean(event.provider) });
        this.state.events = this.state.events.slice(-200);
        this.save();
    }
    summary() {
        return { accounts: this.list(), config: this.config(), events: structuredClone(this.state.events) };
    }
}
//# sourceMappingURL=account-store.js.map