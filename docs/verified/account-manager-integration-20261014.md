# 账号管理器接入说明（2026-10-14）

本轮新增的是账号管理器桥接和Qoder区域分离。管理器账号不自动注册为已验证的CLI执行档案；额度耗尽自动换号仍不对这些新管理器账号开放。

## 使用入口

刷新DSH窗口后进入：设置 → 外部 harness 管理 → 账号管理 → 外部账号管理器。

- Buddy Switch：填写本机WebUI服务地址，例如http://127.0.0.1:57890，保存连接。可以按国内/国际查看账号、导入本机登录、发起OAuth登录、检查登录结果、删除管理器档案和手动切换。需要本机Buddy Switch服务已经运行；插件不会自动启动第三方后台签到、轮换或扫描功能。
- Antigravity：填写agy-switch.exe console程序的绝对路径。可读取账号和当前管理器记录；手动切换需明确允许同步并可能重启Antigravity App，且共享范围内有CLI时会拒绝。新增/登录账号仍在该管理器自身TUI/GUI中完成。
- Qoder：在原有账号档案表中新建qoder-cn或qoder-intl档案，两区域默认值和CLI入口分离，反区创建/更新被拒绝。国际CLI 1.0.45的--config-dir和空目录status已实测；国际账号登录和国内/国际同时执行尚未验收。

## 源码参考

- Buddy Switch：https://github.com/changexbc/workbuddy-switch ，固定main提交22b318c1f44b335c2222e444abcc2d0f74e160f7，MIT。参考窄本机HTTP协议，没有引入其桌面UI。验证使用官方npm console 0.1.62。
- agy-switch：https://github.com/anglee0323/agy-switch ，验证console 4.9.0。仅适配外部CLI协议，不复制其CC BY-NC-SA源码进BSD插件。
- agys：https://github.com/quaywin/agys ，参考完整环境根方案。本机Windows agy1.3.4空HOME等根仍可返回已认证回复，不能将此方案标为本机账号隔离成功。
- CreditDaddy：https://github.com/techysy/CreditDaddy 与Qoder-Switch：https://github.com/70548887/Qoder-Switch 的Qoder实现分别是App认证重写和IDE MITM，未移植到CLI；现有原生配置目录方案更贴合当前执行链。

## 运行边界

只允许固定loopback HTTP地址；无通用路由转发、凭据导出、原始响应透传。UID/email/token只在管理器进程或响应内存中处理，插件API只返回脱敏标签与稳定opaque handle。进程检测失败会拒绝共享切换。

每次CLI派发和长期交互会话持有共享范围读租约，切换持写租约；同范围占用时拒绝，不关闭CLI。Buddy调用/api/switch强制restart:false，绝不调用会关闭所有CLI的/api/codebuddy-cli/switch。

管理器动作成功仅说明管理器完成动作，不说明CLI实际采用。共享认证变化后，旧团队冻结配方不能保证原账号，需重新验证或新建成员。目前没有对旧团队增加完整的账号变更失效检查；故不得将本功能外推为旧团队安全自动续接。自动开关保持禁止，不把管理器到期优先轮换冒充额度耗尽重试。

## 本轮验证

- 编译成功；三个客户端工件一致，保留Pi新增的Collapsible、空模型解释和账号三态。
- verify-account-managers：39条通过，实际构建模块、插件HTTP处理器、执行/长期会话租约、占用拒绝及脱敏；上游外部服务为受控HTTP。
- verify-qoder-region-offline：32条实际源码检查通过；原有verify-account-crud通过。
- 官方Buddy0.1.62真实沙箱：两个区域文件写入、加密信封保留、导入/删除通过；全部是自有虚构账号，不是用户真实登录切换验收。
- 官方agy-switch4.9.0真实空账号库list/current通过；修复了current不接受--target参数的版本协议差异。
- 真实Chrome：保存连接、读取沙箱账号、显示登录/导入/切换控件、正确显示409占用拒绝、App影响选项、Pi折叠保留通过；测试后连接配置恢复。
- OS进程检测：自有Node复制并命名agy-core.exe，检测false→true→false通过；未调用真实厂商模型。
- 活宿主：41个服务端模块与磁盘集合一致，anyStale=false。

仍未完成真实账号的登录后CLI身份绑定、管理器账号的额度耗尽自动换号、多账号共享槽并行隔离。不要以空列表、HTTP200或沙箱成功代替这些结果。
