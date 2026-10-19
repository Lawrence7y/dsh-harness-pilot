/**
 * 账号切换事件账本。
 *
 * 用户的硬性要求：切换事件必须包含
 *   **切换原因、前后脱敏账号、时间、恢复方式、结果**，
 * 并且要能在**会话、子代理页面、团队成员详情**里看得到。
 *
 * 两条纪律：
 *   1. **只存脱敏账号**。原始 accountId 一律不落盘 —— 落盘的东西会被导出、被截图、
 *      被贴进 issue，所以脱敏必须发生在**写入之前**，而不是显示的时候。
 *   2. **有上限**。切换事件会随任务量增长；这里做环形裁剪，且保留最近的完整记录。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const EMPTY = { version: 1, events: [], updatedAt: new Date(0).toISOString() };
export function loadSwitchLog(file) {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const events = Array.isArray(raw.events) ? raw.events.filter(isRecord) : [];
        return { version: 1, events, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : EMPTY.updatedAt };
    }
    catch {
        return EMPTY;
    }
}
function isRecord(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.id === 'string' && typeof v.at === 'string' && typeof v.result === 'string';
}
/**
 * 追加一条切换事件。
 *
 * @param maxEvents 超过就丢最旧的（**保留最新的**，因为排查看的是最近发生了什么）。
 */
export function appendSwitchEvent(state, event, maxEvents = 500, now = new Date()) {
    const at = event.at ?? now.toISOString();
    const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { ...event, id, at };
    const events = [...state.events, record];
    const trimmed = events.length > maxEvents ? events.slice(events.length - maxEvents) : events;
    return { version: 1, events: trimmed, updatedAt: at };
}
export function saveSwitchLog(file, state) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
/**
 * 按作用域取事件（会话 / 任务 / 团队成员详情页用）。
 * 返回**新的在前**，便于直接渲染。
 */
export function eventsFor(state, scope) {
    return state.events
        .filter(e => e.scope.kind === scope.kind && e.scope.id === scope.id)
        .sort((a, b) => b.at.localeCompare(a.at));
}
/** 某个任务已经自动切换过几次 —— 上限与退避判定要用。 */
export function autoSwitchCount(state, scopeId) {
    return state.events.filter(e => e.scope.id === scopeId && e.trigger === 'auto-quota' && e.result === 'switched').length;
}
/** 最近一次切换时间（毫秒）；没有则 undefined。 */
export function lastSwitchAtMs(state, scopeId) {
    const times = state.events
        .filter(e => e.scope.id === scopeId && e.result === 'switched')
        .map(e => Date.parse(e.at))
        .filter(t => Number.isFinite(t));
    return times.length === 0 ? undefined : Math.max(...times);
}
/**
 * 落盘前的最后一道检查：**不得**出现未脱敏的账号标识。
 * 这是「脱敏必须发生在写入之前」的强制点，而不是靠调用方自觉。
 */
export function findUnredacted(state, rawAccountIds) {
    const hits = [];
    for (const event of state.events) {
        for (const raw of rawAccountIds) {
            if (raw.length === 0)
                continue;
            if (event.fromAccount.includes(raw) || event.toAccount.includes(raw)) {
                hits.push(`${event.id}: ${raw}`);
            }
        }
    }
    return hits;
}
export { existsSync };
//# sourceMappingURL=switchlog.js.map