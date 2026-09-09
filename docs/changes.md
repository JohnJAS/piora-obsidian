# 变更记录

按任务记录有意义的修改，最新记录在前。不得将计划执行的验证写成已经通过。

## 2026-09-09：桌面插件原型与配套 Remote API

- 改动：新增 TypeScript/esbuild/Vitest 工具链、本机 HTTP/SSE 客户端、会话状态与幂等回执、聊天侧栏、凭证存储、笔记引用与确认写回、路径检查、构建和显式安装脚本；同步 README、设计状态与协作约定。
- 原因：将独立 Obsidian 接入方案推进为可构建原型，并由 Piora 配套 notes 策略提供服务端工具限制，而非只依赖提示词或 UI 确认。
- TDD：前序开发按功能先运行失败用例再实现；最近路径检查与安装用例的 Red 已在实现前确认。本次提交前执行 npm.cmd run check：9 个测试文件、48 项通过，类型检查与构建通过。前序 Red 命令逐次原始输出未存入仓库，本记录不将本次回归冒充重新执行的 Red。
- 配套验证：Piora 执行 node --test lib/remote-*.test.mjs lib/rpc-manager-behavior.test.mjs，32 项通过；node_modules/.bin/tsc.cmd --noEmit 与 npm.cmd run lint -- --quiet 通过。前序已用 node scripts/integration.mjs 验证真实 HTTP + 模拟模型，本次提交前未重跑该集成脚本。
- 限制：尚未在真实 Obsidian 宿主安装验收；模型调用测试使用合成夹具，不使用真实笔记或收费模型。排队、附件、检索、本机发现以及每令牌 policy/cwd 隔离尚未完成；桌面打包版需另行更新服务端，不因源码提交自动更新。

## 2026-09-09：建立 TDD 与文档同步约定

- 改动：新增根目录 `AGENTS.md`，规定 Red → Green → Refactor、行为回归测试、文档同步和交付检查；在 README 中增加协作入口。
- 原因：确保后续插件开发先验证行为，再实现，并将设计决策及验证证据保留在仓库中。
- 范围：仅新增协作规则和变更记录，不实现插件、不新增测试工具链、不改变既有 API 设计。
- 验证：UTF-8 编码、Markdown 围栏、文档相对链接与 diff 空白检查；不适用代码测试。
- 限制：当前仓库仍处于设计阶段；首次实现功能时需先建立最小测试工具链。
