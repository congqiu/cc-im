---
name: release
description: 发布新版本，推送 tag 到 GitHub 触发 CI/CD 自动发布到 npm
---

# Release Skill

通过推送 git tag 到 GitHub，触发 GitHub Actions 自动构建并发布到 npm。

## 使用方式

```
/release                                   # 交互式选择版本类型
/release patch                             # 发布补丁版本（1.0.0 -> 1.0.1）
/release minor                             # 发布次要版本（1.0.0 -> 1.1.0）
/release major                             # 发布主要版本（1.0.0 -> 2.0.0）
/release 2.0.0                             # 发布指定版本号
```

## 执行步骤

### 1. 检查当前状态

运行以下命令了解项目状态：

```bash
git status
git log --oneline -5
node -e "console.log(require('./package.json').version)"
```

### 2. 处理未提交的变更

如果存在未提交的变更，调用 `/commit` skill 完成代码提交。

如果没有未提交的变更，跳过此步骤。

### 3. 确认版本号

```bash
# 查看当前版本
node -e "console.log(require('./package.json').version)"
```

- 如果用户指定了版本类型（patch/minor/major）或具体版本号，直接使用
- 如果用户未指定，根据自上次发布以来的 commit 内容推荐版本类型：
  - 存在 `feat:` 类型 commit → 推荐 `minor`
  - 仅有 `fix:` / `refactor:` / `chore:` 等 → 推荐 `patch`
  - 存在 breaking change → 推荐 `major`
- 向用户确认最终版本号

### 4. 运行完整测试

发布前必须通过所有测试：

```bash
pnpm test
pnpm build
```

**如果测试或构建失败，必须修复后才能发布。**

### 5. 更新 CHANGELOG.md 和版本号，创建 tag

将 CHANGELOG 更新和版本号变更合并为一个 commit：

1. 读取 `CHANGELOG.md` 当前内容
2. 将 `## [Unreleased]` 部分重命名为 `## [<新版本号>] - <今天日期 YYYY-MM-DD>`
3. 在其上方插入新的空 `## [Unreleased]` 部分
4. 更新 `package.json` 中的版本号（使用 `npm version <版本号> --no-git-tag-version`，仅修改文件不创建 commit 和 tag）
5. 一次性提交并打 tag：

```bash
npm version <版本号> --no-git-tag-version
git add CHANGELOG.md package.json
git commit -m "chore: release v<新版本号>"
git tag v<新版本号>
```

**CHANGELOG 格式规范**：
- 分类标题使用：`### 新功能`、`### 修复`、`### 重构`、`### 性能`、`### 其他`
- 对应 commit 前缀：`feat:` → 新功能、`fix:` → 修复、`refactor:` → 重构、`perf:` → 性能、其余 → 其他
- 如果 Unreleased 部分为空，根据自上次发布以来的 commit 自动生成条目

### 6. 推送到 GitHub 触发发布

```bash
git push
git push --tags
```

推送 `v*` tag 后，GitHub Actions（`.github/workflows/ci.yml` 中的 publish job）会自动：
- 运行 CI（构建 + 测试）
- 通过后使用 `NPM_TOKEN` secret 发布到 npm

### 7. 验证发布结果

```bash
git log --oneline -3
git tag -l --sort=-v:refname | head -5
```

向用户报告：新版本号、tag 推送状态，并提示可在 GitHub Actions 页面查看发布进度。

## 注意事项

- 发布前必须确保工作区干净、测试和构建通过
- 版本号遵循语义化版本规范（Semantic Versioning）
- 实际 npm 发布由 GitHub Actions 完成，需确保仓库已配置 `NPM_TOKEN` secret
- 发布后无法撤销，请谨慎操作
