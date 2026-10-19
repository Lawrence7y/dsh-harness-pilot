/**
 * 运行时设置：设置页里可编辑、立即生效、重启后仍在的插件设置。
 *
 * 与 Config（cordis/Schemastery，改了要重载插件）分开：这些是用户会随手调的行为开关，
 * 落在 `<home>/plugins/harness-pilot/runtime-settings.json`，HTTP `/harness-pilot/api/settings`
 * 读写，client 设置页渲染成表单。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const DEFAULT_SETTINGS = {
    notifyOnComplete: true,
    deliverResult: true,
    maxResultChars: 20000,
    maxConcurrent: 4,
    defaultTaskTimeoutMs: 600000,
    resumeInstruction: '',
    // 0 = 不截断（本字段已不再生效，见接口注释）。
    sessionModelLimit: 0,
};
/** 插件数据目录（任务落盘 + 运行时设置）。可用 HARNESS_PILOT_HOME 覆盖。 */
export function pluginHome() {
    const override = process.env.HARNESS_PILOT_HOME;
    if (typeof override === 'string' && override.trim().length > 0)
        return override.trim();
    return join(homedir(), '.dsh', 'plugins', 'harness-pilot');
}
export function settingsPath() {
    return join(pluginHome(), 'runtime-settings.json');
}
function clampNumber(value, fallback, min, max) {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}
/** 任意输入收敛成一份完整、合法的设置（缺字段补默认，越界钳位，类型错当缺省）。 */
export function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
    const input = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    return {
        notifyOnComplete: typeof input.notifyOnComplete === 'boolean' ? input.notifyOnComplete : base.notifyOnComplete,
        deliverResult: typeof input.deliverResult === 'boolean' ? input.deliverResult : base.deliverResult,
        maxResultChars: clampNumber(input.maxResultChars, base.maxResultChars, 500, 200000),
        maxConcurrent: typeof input.maxConcurrent === 'number' && Number.isFinite(input.maxConcurrent) && input.maxConcurrent >= 0
            ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(input.maxConcurrent)) : base.maxConcurrent,
        defaultTaskTimeoutMs: clampNumber(input.defaultTaskTimeoutMs, base.defaultTaskTimeoutMs, 5000, 24 * 60 * 60 * 1000),
        resumeInstruction: typeof input.resumeInstruction === 'string' ? input.resumeInstruction.slice(0, 4000) : base.resumeInstruction,
        sessionModelLimit: clampNumber(input.sessionModelLimit, base.sessionModelLimit, 0, 2000),
    };
}
/** 读盘上的设置；文件不存在/损坏时回默认（不抛）。 */
export function loadSettings() {
    try {
        if (!existsSync(settingsPath()))
            return { ...DEFAULT_SETTINGS };
        return normalizeSettings(JSON.parse(readFileSync(settingsPath(), 'utf8')));
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
/** 原子写回（tmp + rename），返回最终生效的设置。 */
export function saveSettings(raw, base = DEFAULT_SETTINGS) {
    const next = normalizeSettings(raw, base);
    const path = settingsPath();
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
    renameSync(tmp, path);
    return next;
}
//# sourceMappingURL=settings.js.map