/**
 * Harness 联邦层（federation）的共享词汇。
 *
 * 三层严格分开，任何一层都不得假装成另一层：
 *   1. HarnessRecord   —— 「这台机器上装了什么 CLI、什么版本、能不能连、能力边界」
 *   2. AccountProfile  —— 「这个 Harness 的哪个账号、凭据放在哪、哪些真隔离」
 *   3. ProviderRecord  —— 「这个账号下有哪些供应商与模型，以及四种可用性状态」
 *
 * 本文件是整个联邦层的**契约**：实现文件只允许 import 本文件的类型与 `node:*`。
 * 这样联邦层可以脱离 DSH 宿主单独运行与验收（`node probe/verify-federation.mjs`）。
 */
/** 脱敏：给用户看的账号短名，禁止泄露令牌或完整身份。 */
export function redactAccountLabel(id, fingerprint) {
    return fingerprint === undefined || fingerprint.length === 0 ? id : `${id} (${fingerprint.slice(0, 4)}…${fingerprint.slice(-4)})`;
}
/** 令牌形状的文本一律先脱敏再落盘/进日志。 */
export function redactSecrets(text) {
    return text
        .replace(/eyJ[A-Za-z0-9_.-]{20,}/g, '[redacted-jwt]')
        .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
        .replace(/((?:access_token|refresh_token|api_key|apikey|authorization|secret)["'\s:=]+)[^\s,}"']+/gi, '$1[redacted]');
}
//# sourceMappingURL=types.js.map