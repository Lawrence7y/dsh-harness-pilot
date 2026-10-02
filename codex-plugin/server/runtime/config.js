function windowSpec(patch = {}) {
    return {
        title: '',
        process: '',
        launch: '',
        submitKeys: ['enter'],
        openInputKeys: [],
        newlineKeys: ['shift+enter'],
        promptEchoGraceMs: 10000,
        appearTimeoutMs: 20000,
        settleMs: 1500,
        ...patch,
    };
}
function cdpSpec(patch = {}) {
    return {
        launchArgs: [],
        port: 0,
        busySelector: '',
        transcriptSelector: '',
        inputSelector: '',
        sendSelector: '',
        ...patch,
    };
}
function target(patch) {
    const { window: windowPatch, cdp: cdpPatch, ...rest } = patch;
    const defaults = {
        name: patch.name,
        transport: 'auto',
        description: 'Qoder CN 桌面端；Electron 独立 App，聊天发送按钮通过 aria-label 定位。',
        command: '',
        args: [],
        acpArgs: [],
        acpModel: '',
        modelArgs: [],
        modelsCommand: '',
        modelsArgs: [],
        modelsCacheMs: 300000,
        modelsTimeoutMs: 25000,
        promptViaStdin: false,
        cwd: '',
        env: {},
        timeoutMs: 600000,
        order: ['acp', 'headless', 'pty', 'cdp', 'window'],
        window: windowSpec(),
        cdp: cdpSpec(),
    };
    return {
        ...defaults,
        ...rest,
        window: windowSpec(windowPatch),
        cdp: cdpSpec(cdpPatch),
    };
}
/** 本机路径（由一次只读普查确定；换机器时在 profile 里覆盖即可）。 */
const WB_NODE_MODULES = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2\\node_modules';
const ZCODE_CLI = 'D:\\zai\\ZCode\\resources\\glm\\zcode.cjs';
const CODEBUDDY_CLI = 'D:\\workbuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy';
const QODER_CLI = 'D:\\Qoder\\resources\\app\\resources\\bin\\x86_64_windows\\qodercli.exe';
/**
 * 内置目标目录。
 *
 * 顺序即真相：能走 ACP 就先 ACP（流式、结构化），其次一次性打印，再退到 PTY，
 * 最后才是 GUI 的 CDP / 窗口。
 */
export const KNOWN_TARGETS = [
    // ── OpenCode 系（ACP + 一次性打印 + ConPTY）──
    target({
        name: 'opencode',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'opencode',
        args: ['run'],
        acpArgs: ['acp'],
        // opencode 的 ACP 默认模型走 OpenRouter（本机余额不足）；ACP 无 --model，只能会话内切。
        acpModel: 'opencode-go/deepseek-v4.1-flash',
        modelArgs: ['--model', '{model}'],
        modelsCommand: 'opencode',
        modelsArgs: ['models'],
        order: ['acp', 'headless', 'pty'],
        window: { process: 'opencode', title: '/opencode/i' },
    }),
    target({
        name: 'opencode-flash',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'opencode',
        args: ['run', '--model', 'opencode-go/deepseek-v4.1-flash'],
        acpArgs: ['acp'],
        acpModel: 'opencode-go/deepseek-v4.1-flash',
        modelArgs: ['--model', '{model}'],
        modelsCommand: 'opencode',
        modelsArgs: ['models'],
        order: ['headless', 'pty'],
        window: { process: 'opencode', title: '/opencode/i' },
    }),
    target({
        name: 'opencode-tui',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'opencode',
        args: [],
        modelArgs: ['--model', '{model}'],
        modelsCommand: 'opencode',
        modelsArgs: ['models'],
        order: ['pty'],
        window: { process: 'opencode', title: '/opencode/i' },
    }),
    // ── 国内 harness 的 CLI 版（ACP 或一次性打印）──
    target({
        name: 'mimo-cli',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'mimo',
        args: ['run'],
        acpArgs: ['acp'],
        modelArgs: ['--model', '{model}'],
        modelsCommand: 'mimo',
        modelsArgs: ['models'],
        order: ['acp', 'headless', 'pty'],
        window: { process: 'mimo', title: '/mimo/i' },
    }),
    target({
        name: 'codebuddy',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'node',
        args: [CODEBUDDY_CLI, '-p'],
        acpArgs: [CODEBUDDY_CLI, '--acp'],
        order: ['acp', 'headless', 'pty'],
    }),
    target({
        name: 'zcode-cli',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'D:\\zai\\ZCode\\ZCode.exe',
        args: [ZCODE_CLI, '-p'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        order: ['headless', 'pty'],
    }),
    target({
        name: 'qoder-cli',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: QODER_CLI,
        args: ['-p'],
        // Go 版 qodercli 的 --model 取固定档位（auto/efficient/gmodel/…），不是 provider/model
        modelArgs: ['--model', '{model}'],
        order: ['headless', 'pty'],
        timeoutMs: 900000,
    }),
    target({
        name: 'qodercli',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'C:\\Users\\Administrator\\.qodersec\\bin\\qodercli.exe',
        args: ['-p'],
        modelArgs: ['-m', '{model}'],
        modelsCommand: 'C:\\Users\\Administrator\\.qodersec\\bin\\qodercli.exe',
        modelsArgs: ['--list-models'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'qoderclicn',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'C:\\Users\\Administrator\\.qodersec\\bin\\qoderclicn.exe',
        args: ['-p'],
        modelArgs: ['-m', '{model}'],
        modelsCommand: 'C:\\Users\\Administrator\\.qodersec\\bin\\qoderclicn.exe',
        modelsArgs: ['--list-models'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'kimi',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'C:\\Users\\Administrator\\.kimi-code\\bin\\kimi.exe',
        args: ['-p'],
        acpArgs: ['acp'],
        modelArgs: ['-m', '{model}'],
        order: ['acp', 'headless', 'pty'],
    }),
    target({
        name: 'grok-cli',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'C:\\Users\\Administrator\\AppData\\Local\\grok\\grok.exe',
        args: ['-p'],
        modelArgs: ['-m', '{model}'],
        modelsCommand: 'grok',
        modelsArgs: ['models'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'agy',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'agy',
        args: ['-p'],
        modelArgs: ['--model', '{model}'],
        modelsCommand: 'agy',
        modelsArgs: ['models'],
        modelsTimeoutMs: 150000,
        order: ['headless', 'pty'],
        timeoutMs: 900000,
        window: { process: 'agy', title: '/agy|antigravity/i' },
    }),
    target({
        name: 'pi',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'pi',
        args: ['-p'],
        modelArgs: ['--model', '{model}'],
        modelsCommand: 'pi',
        modelsArgs: ['--list-models'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'command-code',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'node',
        args: [`${WB_NODE_MODULES}\\command-code\\dist\\index.mjs`, '-p'],
        order: ['headless', 'pty'],
    }),
    // ── 国外 CLI ──
    target({
        name: 'claude',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: `${WB_NODE_MODULES}\\@anthropic-ai\\claude-code\\bin\\claude.exe`,
        args: ['-p'],
        modelArgs: ['--model', '{model}'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'codex',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\bffc5354119c8421\\codex.exe',
        args: ['exec'],
        modelArgs: ['-m', '{model}'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'gemini',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'gemini',
        args: ['-p'],
        order: ['headless', 'pty'],
    }),
    target({
        name: 'qwen',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        command: 'qwen',
        args: ['-p'],
        order: ['headless', 'pty'],
    }),
    // ── GUI / Electron harness：CDP 读 DOM 优先，窗口级操控兜底 ──
    target({
        name: 'zcode',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\zai\\ZCode\\ZCode.exe',
        window: { process: 'ZCode.exe', title: '/ZCode/i', openInputKeys: ['ctrl+n'] },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9333 },
    }),
    target({
        name: 'mimo-ai',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\mimo\\Xiaomi MiMo AI\\Xiaomi MiMo AI.exe',
        window: { process: 'Xiaomi MiMo AI.exe', title: '/MiMo/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9335 },
    }),
    target({
        name: 'mimo',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\mimo\\Xiaomi MiMo\\Xiaomi MiMo.exe',
        window: { process: 'Xiaomi MiMo.exe', title: '/MiMo/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9334 },
    }),
    target({
        name: 'workbuddy',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\workbuddy\\WorkBuddy.exe',
        window: { process: 'WorkBuddy', title: '/WorkBuddy/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9340 },
    }),
    target({
        name: 'qoder',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\Qoder\\Qoder.exe',
        window: { process: 'Qoder.exe', title: '/Qoder/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9342 },
    }),
    target({
        name: 'qoder-cn',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\Qoder CN IDE\\Qoder CN IDE.exe',
        window: { process: 'Qoder CN IDE.exe', title: '/Qoder/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9336 },
    }),
    target({
        name: 'qoder-cn-app',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\Qoder CN\\Qoder CN.exe',
        window: { process: 'Qoder CN.exe', title: '/^Qoder CN$/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9344, sendSelector: '[aria-label="发送消息"]' },
    }),
    target({
        name: 'antigravity',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        window: { process: 'Antigravity.exe', title: '/Antigravity/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9337 },
    }),
    target({
        name: 'minimax',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\minimax\\MiniMax Code\\MiniMax Code.exe',
        window: { process: 'MiniMax Code.exe', title: '/MiniMax/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9338 },
    }),
    target({
        name: 'grok',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\Grok bot\\Grok Bot.exe',
        window: { process: 'Grok Bot.exe', title: '/Grok/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9339 },
    }),
    target({
        name: 'cursor',
        description: '本机 harness；可用性、模型与权限以实时探测为准',
        transport: 'cdp',
        order: ['cdp', 'window'],
        command: 'D:\\cursor\\Cursor.exe',
        window: { process: 'Cursor.exe', title: '/Cursor/i' },
        cdp: { launchArgs: ['--remote-debugging-port=<port>'], port: 9341 },
    }),
];
function mergeTarget(base, patch) {
    return {
        ...base,
        ...patch,
        window: { ...base.window, ...(patch.window ?? {}) },
        cdp: { ...base.cdp, ...(patch.cdp ?? {}) },
        env: { ...base.env, ...(patch.env ?? {}) },
        name: base.name,
    };
}
/** 合并内置目录与用户配置；`apply()` 直接调用（无 loader 默认值）时也能得到完整配置。 */
export function resolveConfig(raw) {
    const input = (raw ?? {});
    const merged = new Map();
    for (const entry of KNOWN_TARGETS)
        merged.set(entry.name, entry);
    for (const entry of input.targets ?? []) {
        if (entry === undefined || entry === null || typeof entry.name !== 'string' || entry.name.length === 0)
            continue;
        const existing = merged.get(entry.name);
        merged.set(entry.name, existing === undefined ? target(entry) : mergeTarget(existing, entry));
    }
    const resolvedTargets = [...merged.values()];
    const defaultTarget = input.defaultTarget !== undefined && input.defaultTarget.length > 0
        ? input.defaultTarget
        : (resolvedTargets[0]?.name ?? '');
    return {
        targets: input.targets ?? [],
        defaultTarget,
        pythonPath: input.pythonPath ?? '',
        maxReplyChars: input.maxReplyChars ?? 16000,
        maxScreenChars: input.maxScreenChars ?? 8000,
        cdpPortBase: input.cdpPortBase ?? 9333,
        apiToken: input.apiToken ?? '',
        resolvedTargets,
    };
}
/** 按名字或别名找一个目标（大小写不敏感）。 */
export function findTarget(config, name) {
    const needle = name.trim().toLowerCase();
    return config.resolvedTargets.find(entry => entry.name.toLowerCase() === needle);
}
