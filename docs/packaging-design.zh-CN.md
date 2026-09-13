# Piora for Obsidian：产品发包设计

## 目标

为桌面版 Obsidian 提供可重复构建、可回滚、不会覆盖用户数据的插件发布包。首期只发布插件资源，不把 Piora 服务端、模型、Remote Token 或 Vault 内容打进包内。

## 发布产物

每个版本发布以下文件：

- `piora-obsidian-vX.Y.Z.zip`：社区插件目录使用的标准包，根目录直接包含 `main.js`、`manifest.json`、`styles.css`。
- `piora-obsidian-vX.Y.Z.sha256`：ZIP 的 SHA-256 校验值。
- 不发布额外调试包；调试信息保留在构建流水线产物中。

ZIP 不包含 `src/`、测试、文档、`node_modules`、`.local/`、令牌、配置和 Vault 文件。`manifest.json` 的 `version` 是唯一发布版本号，文件名和 Git 标签使用同一个 `X.Y.Z`。

## 版本和兼容性

- 使用语义化版本：修复问题递增 patch，新增兼容能力递增 minor，破坏 Remote API 或设置迁移时递增 major。
- `minAppVersion` 保持与实际使用的 Obsidian API 一致；提升前必须完成最低版本宿主验收。
- 插件版本只代表插件，不自动捆绑或升级 Piora 服务。发布说明必须列出所需的 Piora Remote API 能力和建议服务端版本。
- Remote API 能力缺失时继续按现有降级/拒绝规则工作，不通过发包隐藏兼容性问题。

## 构建流程

发布前在干净工作区执行：

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run check
node scripts/package.mjs
```

`package.mjs` 应执行：清理临时目录、运行现有构建、读取并校验 manifest 版本、只收集三个运行时文件、拒绝符号链接和额外文件、生成确定性 ZIP、输出 SHA-256，并检查 ZIP 解压后结构与文件大小非零。脚本失败时不得生成或覆盖正式产物。

建议将 `package` 加入 `package.json`，并让脚本接受可选的 `--out-dir` 和 `--version`；默认版本必须来自 `manifest.json`，命令行版本与 manifest 不一致时失败。ZIP 内使用固定文件顺序、固定时间戳和固定 Unix 权限，保证同一提交可重复生成相同摘要。

构建环境记录 Node.js、npm、操作系统和 Git 提交号；不把这些信息写入插件运行时配置。发布流水线还应运行 `git diff --check`，并确认工作区没有未提交的源码或文档变更。

## 安装和升级

继续支持现有安装器，但将其定位为本地测试/手动安装工具：

- 默认拒绝覆盖已有插件目录。
- 显式传入 `--replace` 时先备份旧的 `main.js`、`manifest.json`、`styles.css`，再原子替换新文件。
- 安装器不启用插件、不修改 `data.json`、不修改笔记、不写入 Token。
- 安装前校验目标是 Vault 根目录且不经过链接；安装后检查三个文件和 manifest ID。
- 升级失败时恢复备份，并返回非零退出码。

社区插件包不包含安装器；用户通过 Obsidian 社区插件更新，或将 ZIP 解压到 `.obsidian/plugins/piora-obsidian` 后手动启用。发布说明明确提示重载/重启插件，并说明服务端需要单独升级。

## 发布渠道和签名

首期渠道为 GitHub Release + Obsidian 社区插件目录。每次发布创建 `vX.Y.Z` 标签和 Release，附 ZIP、SHA-256、变更说明、兼容的 Piora 服务端版本及已知限制。待确定正式组织和许可证后，再提交社区插件目录；在此之前不宣称已进入社区市场。

首期至少提供哈希校验。代码签名、签名密钥托管和自动更新签名作为后续增强，不在插件内自行实现，也不把 Token 当作发布认证。

## 正式版本和 GitHub Release 模型

许可证采用 MIT，版权归仓库声明的作者所有，许可证文件为根目录 `LICENSE`。版本号采用 `X.Y.Z`，`manifest.json` 是唯一版本来源；发布前由 `scripts/check-version.mjs` 校验 manifest 与 `vX.Y.Z` 标签一致。日常开发不修改版本号，准备发布时先更新 manifest、变更记录和兼容性说明，再创建标签。

GitHub Actions 分为两个工作流：

- `CI` 在 main 推送和 Pull Request 上运行依赖安装、测试、类型检查、构建和空白检查，只读仓库权限。
- `Release` 只响应 `v*.*.*` 标签，重复执行同样检查和版本校验，生成 ZIP/ SHA-256，解压验证仅含三个运行时文件，然后用 GitHub CLI 创建 Release 并自动生成变更说明。

Release 资产固定为 ZIP 和 SHA-256。Release 标题为 `Piora for Obsidian vX.Y.Z`；正文需补充兼容的 Obsidian/Piora 版本、升级/回滚步骤、已知限制和是否为预览版。正式版使用普通 tag，候选版使用 `vX.Y.Z-rc.N` 并暂不触发当前严格的正式发布工作流，待需要时另设 prerelease 规则。

发布权限只授予受保护分支的维护者；Actions 使用最小 `contents: write` 权限，不保存或读取 Remote Token，不接触 Vault。发布失败不会创建 Release；修复后删除错误 tag 并重新创建同版本前必须确认远端没有已发布资产，已发布版本原则上只通过递增 patch 修复。

## CI/CD 设计

Pull Request 阶段运行依赖安装、测试、类型检查、构建和 `git diff --check`，不上传发布包。推送 `v*.*.*` 标签后执行发布流水线：校验标签与 manifest 版本、在干净 runner 中构建、生成 ZIP 和 SHA-256、解压自检、执行安装器回归，然后创建 GitHub Release 草稿。维护者检查变更说明和验收清单后再发布；流水线不自动提交版本号、不自动修改 Token 或 Vault。

Release 内容固定包含：下载链接、SHA-256、兼容的 Obsidian/Piora 版本、升级步骤、已知限制、回滚步骤和安全说明。若社区目录审核尚未通过，Release 必须明确写“手动安装”，不能暗示已支持自动更新。

## 回滚和故障处理

用户升级前备份插件目录中的三个运行时文件和 manifest 版本；升级失败恢复同一批备份。若新插件已加载但运行异常，用户可退出 Obsidian 后恢复备份，或从上一版 Release 重新安装。配置、会话回执和 Vault 笔记不属于插件包回滚范围，发布说明必须提醒服务端会话不会因插件回滚而删除。

## 发包 review（基于当前仓库）

当前仓库适合作为“发布候选构建基础”，但还不能直接称为完整产品发包：

- `scripts/build.mjs` 已能生成 `dist/main.js`、`manifest.json`、`styles.css`，`npm.cmd run check` 已覆盖测试、类型检查和构建。
- `scripts/install.mjs` 已实现默认拒绝覆盖、`--replace` 备份和路径边界检查，适合隔离测试 Vault 的手动安装。
- `scripts/package.mjs` 尚不存在，`package.json` 也没有 `package` 脚本，因此当前文档中的正式打包命令还不能执行。
- 安装器在逐文件替换中途失败时，现有实现没有完整的事务回滚流程；正式发布前应增加临时目录整体替换、备份恢复和失败清理测试。
- 当前没有 CI 发布流水线、许可证文件、第三方依赖声明、GitHub Release 模板或社区插件目录元数据。
- `manifest.json` 仍是 `0.1.0`，作者/发布组织和最低 Obsidian 版本尚未完成产品确认。

因此建议的实现顺序是：先实现并测试 `package.mjs`，再补安装器事务回滚；随后加入 CI 和许可证/依赖声明，最后用隔离 Vault 完成安装、升级、回滚和真实宿主冒烟测试，再创建第一个正式版本标签。

## 发布验收

发布候选必须满足：

1. `npm.cmd run check` 通过，且 `node scripts/package.mjs` 产物可重复生成。
2. ZIP 只含三个运行时文件，manifest ID、版本和入口正确。
3. 在干净测试 Vault 安装、启用、升级和回滚均成功；已有设置、会话回执和笔记保持不变。
4. 真实宿主完成至少一次连接、创建会话、发送消息和插件重载验收；未完成的聊天、写回、附件或压力项目必须在 Release 中明确列出。
5. 不使用真实 Vault、真实笔记、个人 Token 或付费模型生成发布验证材料。

## 未决事项

- 最终插件显示名称、发布组织和仓库归属。
- 开源许可证及第三方依赖声明。
- 是否加入 Windows/macOS/Linux 的 CI 矩阵。
- 是否在社区目录审核通过后开启自动更新。
