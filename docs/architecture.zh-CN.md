# Piora for Obsidian：架构与模块链路

## 1. 目标与边界

插件是 Obsidian 与本机 Piora Remote HTTP API 之间的客户端适配层：Obsidian 负责界面、Vault 内容和用户确认，Piora 负责会话、模型、Agent 运行和服务端权限。插件不嵌入 Piora 网页、不实现第二套 Agent 引擎，也不把整个 Vault 自动上传。

首版的安全默认值是 `notes` 会话：服务端禁用工具和扩展，插件只发送用户显式选择的笔记、选区、未保存编辑器内容和附件。`agent` 会话可能直接修改本机文件，创建前必须显示风险并取得确认。

## 2. 运行时分层

```text
Obsidian API / Vault / Editor
          │
          ▼
main.ts（生命周期、命令、设置、侧栏、写回）
          │
          ├── core.ts              交互状态与请求编排
          ├── session.ts            会话、模型、消息、队列、回执
          ├── client.ts             Remote HTTP、SSE、身份头和限额
          ├── live-state.ts         流式正文与工具快照校准
          ├── reply-contexts.ts     命令与笔记/附件快照绑定
          └── presentation.ts       视图、差异、设置与提示
          │
          ├── credentials.ts        SecretStorage / 内存凭证
          ├── creation-storage.ts   新建会话意图与恢复回执
          ├── task-storage.ts       排队命令与取消状态
          ├── discovery.ts          本机 Piora 登记发现
          ├── note-search.ts        有界本地检索
          ├── attachments.ts        附件格式、大小和序列化
          ├── tool-calls.ts         工具过程投影与历史合并
          └── vault-path.ts          Vault 边界、realpath 和写回保护
          │
          ▼
      Piora Remote API
```

## 3. 核心请求链路

### 连接

1. 设置保存地址和非秘密偏好；令牌通过 `credentials.ts` 写入宿主 SecretStorage，能力不可用时仅保存在内存。
2. `client.ts` 匿名请求 `/identity`，取得 `serverId`；首次连接需要显式信任地址，后续每个请求携带 `X-Piora-Server-Id`。
3. 携带 Bearer Token 请求 `/capabilities`，检查 scope、会话策略、正文流和附件能力；不满足能力时明确降级或拒绝。
4. `session.ts` 获取模型/会话列表，`main.ts` 将状态映射到侧栏和设置界面。

### 新建与发送

```text
用户点击新建/发送
  → core/session 生成幂等键和快照
  → creation-storage/task-storage 先落盘恢复意图
  → client POST /sessions 或 /messages
  → Piora 返回 sessionId/commandId
  → 本地回执与选择状态落盘
  → SSE 生命周期 + content-events 正文/工具流
  → history/state 最终校准
```

回执不是模型成功结果：`202` 只表示服务接受投递。重启或断线时使用原幂等键核对，不自动重发未知正文；单条取消只取消目标命令，不清空后续队列。

### 内容流

`live-state.ts` 以 `sessionId + streamId + runId + sequence` 校验快照。旧连接、迟到 HTTP 响应或旧运行实例不能覆盖新正文。工具卡片只投影白名单字段，输出有界并按 `toolCallId` 与历史结果合并。缺少 `contentStreamIdentity` 时显示“历史同步”，不伪造实时状态。

### 笔记写回

```text
编辑器/选区捕获
  → reply-contexts 保存不可变快照
  → 用户发送并收到最终回复
  → 生成差异预览
  → 用户确认替换/插入/新建
  → vault-path 校验 Vault 边界、realpath、当前内容快照
  → Vault.process 原子写入，交给 Obsidian undo
```

快照不匹配、文件移动、越出 Vault 或目标已存在时拒绝写回；预览取消和插件卸载不会修改笔记。

## 4. 模块职责与不变量

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `main.ts` | Obsidian 生命周期、命令、设置和视图组装 | 直接实现 HTTP 协议细节 |
| `client.ts` | 地址规范化、身份头、JSON/SSE、响应限额 | 保存令牌或决定 UI 写回 |
| `core.ts` / `session.ts` | 会话状态、模型、发送/排队/引导、回执 | 绕过服务端权限 |
| `credentials.ts` | SecretStorage、内存令牌、忘记/记忆策略 | 撤销 Piora 端令牌 |
| `reply-contexts.ts` | 将命令绑定到笔记/选区/附件快照 | 自动读取整个 Vault |
| `note-search.ts` | 有界文件名/正文关键词检索 | 语义检索或自动发送 |
| `attachments.ts` | PNG/JPEG/GIF/WebP 与 UTF-8 文本校验 | PDF/Office 转换 |
| `vault-path.ts` | 路径边界、快照校验、原子写回 | 文件系统沙箱 |
| `live-state.ts` / `tool-calls.ts` | 流和工具状态投影 | 猜测丢失的服务端事件 |

关键不变量：令牌不进入普通配置和日志；serverId 变化即拒绝继续；未知命令不自动重发；写回必须经过用户确认和最新快照校验；notes 策略不因客户端字段变化而升级权限。

## 5. 数据与权限边界

- 普通插件配置保存地址、serverId 绑定、模型偏好和有界回执元数据，不保存令牌、笔记正文、附件 Base64 或待发送正文。
- 每个请求受 256 KiB JSON 限额约束；单附件最多 128 KiB，每条消息最多 8 项。
- 本地检索最多检查 500 个候选、8 MiB 读取预算、单笔记 256 KiB，并支持取消。
- Piora 服务端仍是最终权限边界；`cwd` 不是沙箱。完整 Agent 只在用户明确确认后创建。

## 6. 开发与验证

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run check
node scripts/install.mjs "D:/path/to/test-vault"
```

测试分为纯模块单元测试、受控 Obsidian 替身测试和 `scripts/integration.mjs` 的隔离 HTTP 集成测试。真实宿主验收必须使用独立 Vault、合成笔记和专用 Remote Token；不要用真实 Vault 或付费模型替代测试。详细证据、已知限制和未承诺格式见 `docs/acceptance.zh-CN.md`。
