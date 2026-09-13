# 发布流程

## 发布前

1. 在 `manifest.json`、`package.json` 和 `package-lock.json` 写入同一个 `X.Y.Z` 版本号。
2. 在 `docs/changes.md` 记录改动、验证和已知限制，并准备 Release 说明。
3. 确认工作区只包含本次发布改动。

```powershell
npm.cmd ci --legacy-peer-deps
npm.cmd run check
npm.cmd run check-version -- X.Y.Z
npm.cmd run package
```

## 发布版本

```powershell
git add .
git commit -m "release: vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

推送 `vX.Y.Z` 后，`.github/workflows/release.yml` 会在 GitHub Actions 中重新检查、打包并校验 ZIP，随后创建同名 GitHub Release，附带 ZIP 和 SHA-256 文件。不要复用已经发布的版本号；修复应递增 patch 版本。

## 发布后

- 检查 Actions、Release 资产和 SHA-256。
- 使用隔离测试 Vault 下载 ZIP，解压到 `.obsidian/plugins/piora-obsidian`，启用并完成连接/新建会话冒烟测试。
- 发布说明写明兼容的 Obsidian/Piora 版本、升级步骤、回滚方式和未完成验收项目。

当前仓库的 `v0.1.0` 是首个测试版目标；社区插件目录、代码签名和安装器完整事务回滚尚未纳入本次发布。
