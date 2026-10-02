/**
 * Shared vocabulary for every harness transport.
 *
 * 一条设计原则：transport 只负责「把任务送进去、把输出取出来」，不认识 DSH。
 * 这样每个 transport 都能被单独测试，也能在 provider / tool 两条调用路径上复用。
 */
/** `auto` 通道梯子顺序（前一个不可用就降到下一个）。 */
export const DEFAULT_TRANSPORT_ORDER = ['acp', 'headless', 'pty', 'cdp', 'window'];
