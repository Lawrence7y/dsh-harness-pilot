/** 文本清理：CLI harness 常用 ANSI 颜色，回给模型前必须去掉，否则噪音进上下文。 */
/** 去掉 ANSI 转义（CSI / OSC）与孤立回车。 */
export function stripAnsi(text) {
    return text
        // OSC（窗口标题等）：ESC ] … BEL 或 ESC \
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        // CSI 序列与单字符 ESC 序列
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b[@-Z\\-_]|\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r(?!\n)/g, '\n');
}
/** 去 ANSI + 去掉首尾空白。 */
export function cleanOutput(text) {
    return stripAnsi(text).trim();
}
