---
name: release
description: 发布新版本到 npm，包括版本更新、构建、测试和发布
---

# Release Skill

一站式完成版本发布到 npm。

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

### 5. 更新版本号

使用 npm version 命令更新版本号：

```bash
# 使用版本类型
npm version patch -m "chore: release v%s"
# 或使用具体版本号
npm version 2.0.0 -m "chore: release v%s"
```

这会自动：
- 更新 package.json 中的版本号
- 创建 git commit（`chore: release v<version>`）
- 创建 git tag（`v<version>`）

### 6. 发布到 npm

```bash
npm publish
```

### 7. 推送到远程仓库

```bash
git push
git push --tags
```

### 8. 验证发布结果

发布完成后验证：

```bash
git log --oneline -3
git tag -l --sort=-v:refname | head -5
npm view cc-im version                   # 验证 npm 上的版本
```

向用户报告发布结果，包括：

- 新版本号
- npm 发布状态
- git 推送状态
- npm 包链接：https://www.npmjs.com/package/cc-im

## 注意事项

- 发布前必须确保所有变更已提交（工作区干净）
- 发布前必须通过完整测试和构建
- 版本号遵循语义化版本规范（Semantic Versioning）
- 发布过程中每个关键步骤都需要用户确认
- 如果发布失败，分析错误原因并指导用户修复
- 确保已登录 npm（`npm whoami`）
- 确保有发布权限
- 发布后无法撤销，请谨慎操作
