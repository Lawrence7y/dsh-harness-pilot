# 原生 CLI 模型目录接线（2026-10-14）

模型选择保持宿主 `pilot-cli` 单一 provider 与原版 ModelCatalog；条目使用 `目标::模型`，实际 CLI 参数仍由既有派发路径写入。取消旧每目标 12 条截断，原版搜索选择器能够取得完整可选目录。

来源与边界：

- Claude Code：官方稳定 `sonnet/opus/haiku/opusplan` 别名，加原生 settings.model、模型专用环境字段与 availableModels 白名单。官方来源 https://code.claude.com/docs/en/model-config。版本特有的新别名没有自动加入；目录不证明已登录。
- Codex：读取其 CODEX_HOME 内 config.toml 当前模型名称、models_cache.json 的 slug/id。visibility=hide 的内部模型不作为用户候选。本机 cache 可见 7 项；config 当前模型去重。读取不暴露 identity、API key、URL、模型描述正文或配置内容。
- WorkBuddy：固定 4 个 CLI 档位可选择，原生 models.json 全目录另作为 display-only 展示；底层 r-* ID 不传给 --model。
- ZCode：原生 provider.models 与当前 model 可以显示；当前安装未提供 --model，不能伪造为可选模型。只显示真实当前模型，不为改变模型写入全局 config。
- Qoder、Antigravity、Pi、OpenCode：复用各自真实模型列表命令，不拿宿主 DSH 列表代填。单个命令失败时可降级该 CLI 自身缓存/配置，但保留失败原因，不提高认证状态。

新增实际源码探针 `verify-native-model-catalog-offline.mjs` 19 断言 PASS；tsc --noEmit PASS。该探针 vendorCalls=0，它验证目录、安全提取、选择槽，不等于所有模型推理成功。真实模型调用及原生子代理首轮由最终集成验证承担。

宿主 rc.2 事实：dsh-api-session-controller/lib/index.js buildModelCatalog 遍历 listProviders/listModels/resolveModelInfo；空列表组被删除，resolveModelInfo 抛错会令整个组记录 failures。独立子代理白名单由 dsh-tool-subagent/lib/model-selection-settings.js 的 subagentModelSelection.current() 提供，enabled=false 或 route 不在 allowedModels 时，原生工具模型选择不可用；不能将主会话目录能见等同于子代理已生效。

已释放源码域；没有构建 lib、修改部署 profile、重启宿主或调用外部开发代理。
