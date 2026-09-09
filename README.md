# Piora for Obsidian

将 Piora 接入 Obsidian 的独立插件方案：Obsidian 负责聊天、笔记上下文和修改确认，Piora 负责模型调用、会话与 Agent 执行。

> 当前状态：桌面插件原型，已有构建产物和自动化测试；尚未完成真实 Obsidian 宿主验收，不是正式发行版。需要配套的 Piora 服务端改动，已安装的桌面版不会自动获得这些接口。

## 目标

- 直接连接 Piora Remote HTTP API，不嵌入网页、不启动第二套 Agent 引擎。
- 在 Obsidian 中聊天、引用笔记、预览差异和确认写回。
- 默认不发送整个 Vault；先支持桌面端、本机连接。

## 文档与路线

- [设计方案（中文）](docs/design.zh-CN.md)：架构、接口边界、交互、安全策略和验收标准。
- [协作约定](AGENTS.md)：TDD、文档同步与完成检查。
- [变更记录](docs/changes.md)：任务改动、原因和验证记录。
- P0：可信环境下的连接与聊天原型。
- P1：笔记引用、确认写回、服务端受限会话策略。
- P2：流式正文、工具卡片、模型选择、排队与引导。
- P3：多笔记检索、附件、安全本机发现及可选完整 Agent 能力。

## 开发与安装

需要 Node.js/npm，以及桌面版 Obsidian（manifest 最低版本为 1.11.4）。在仓库根目录执行，PowerShell 使用 npm.cmd 代替 npm：

~~~sh
npm ci --legacy-peer-deps
npm run check
node scripts/install.mjs "D:/example-vault"
~~~

安装器只将 dist 中的 main.js、manifest.json 和 styles.css 安装到目标 Vault 的 .obsidian/plugins/piora-obsidian，不启用插件、不修改笔记或 data.json。已有安装默认拒绝覆盖；明确更新时添加 --replace，旧资源会备份到插件目录。请先使用测试 Vault，并在 Obsidian 的社区插件设置中手动启用 Piora。

在插件设置中填写 Piora 的本机地址与专用能力令牌，点击连接测试，再打开 Piora 聊天侧栏创建会话。地址可带 /api/remote/v1 前缀。完整功能需要 capabilities.read、session.create、session.state.read、session.history.read、session.message.send、session.messages.read、session.events.read、session.steer、session.abort；已有会话仍须令牌授权。

默认创建 notes 笔记助手会话；服务端未声明该能力时拒绝创建，不静默降级到完整 Agent。支持显式引用当前笔记、选区或逐项选择其他笔记；回复可预览差异并确认替换、插入或新建。替换时快照不匹配会拒绝写入。完整 Agent 模式需要确认，可能绕过插件直接修改文件。

令牌使用宿主 SecretStorage（可用且启用时），否则仅存内存，不写入普通插件配置。关闭秘密存储不自动清除之前的存储值。普通配置会保存会话和任务回执元数据，不保存待确认消息正文；重启后的不确定任务需人工核对。

## 验证与限制

- npm run check 执行测试、类型检查和 esbuild 打包，不运行 Piora 的 next build。
- node scripts/integration.mjs ../Piora 是 Windows 本机集成检查，需要已安装依赖的配套 Piora 源码；在 .local 中创建隔离副本，使用 30142 端口与模拟模型，不调用真实付费模型。该端口需空闲。
- 已实现会话、正文流、工具摘要、停止/引导、模型选择、笔记引用与确认写回；排队 UI、附件、自动检索、安全本机发现和稳定 serverId 尚未实现。
- 自动化替身测试不等于宿主验收；目前没有自动安装到用户 Vault，也没有完成真实编辑器撤销、布局和完整交互验收。

## 安全边界

Piora 必须在后台运行。API 令牌不等于执行沙箱，`cwd` 不是安全隔离边界。正式提供安全的笔记助手模式前，需服务端阻止工具、Shell 和扩展绕过修改确认。完整 Agent 模式必须显式启用并说明直接修改文件的风险。

配套 Piora 源码已增加持久化 notes 策略：禁用工具与扩展、拒绝 Shell 及提权命令，并在恢复会话时继续执行限制。但 session.create 令牌仍可创建完整 Agent 会话，尚无每令牌 policy/cwd 限制，不能视为面向不可信客户端的沙箱。

本仓库尚未提供正式安装包或开源许可证，发行与许可方式仍待确认。
