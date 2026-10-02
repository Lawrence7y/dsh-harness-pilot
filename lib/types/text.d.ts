/** 文本清理：CLI harness 常用 ANSI 颜色，回给模型前必须去掉，否则噪音进上下文。 */
/** 去掉 ANSI 转义（CSI / OSC）与孤立回车。 */
export declare function stripAnsi(text: string): string;
/** 去 ANSI + 去掉首尾空白。 */
export declare function cleanOutput(text: string): string;
