---
name: commit
description: 智能提交代码，自动进行代码质量检查并生成符合项目规范的 commit 信息
---

# Commit Skill

提交代码前进行代码质量检查和规范的 commit 信息生成。

## 使用方式

```
/commit                                    # 自动生成 commit 信息
/commit 修复登录问题                       # 使用指定的 commit 信息
/commit fix: 修复登录问题                  # 使用带 type 的完整信息
```

## 执行步骤

### 1. 获取变更信息

运行以下命令获取当前变更：

```bash
git status
git diff --staged
git diff
git log --oneline -5                      # 查看最近提交风格
```

### 2. 代码质量检查

运行项目的质量检查命令：

```bash
# TypeScript 类型检查
pnpm build

# 运行测试（如果有测试文件变更）
CHANGED_FILES=$(git diff --name-only --diff-filter=ACMR HEAD)
if echo "$CHANGED_FILES" | grep -qE '\.(test|spec)\.ts$'; then
  pnpm test
fi
```

**如果检查失败，必须修复后才能提交。**

### 3. 代码审查

审查变更的代码，关注以下方面：

- 是否有明显的 bug 或逻辑错误
- 是否符合 TypeScript 最佳实践
- 是否有潜在的性能问题
- 是否有安全隐患（特别是凭证泄露）

### 4. 文档同步检查

**必须检查以下文档是否需要更新**：

- **`CLAUDE.md`**：如果变更涉及架构、配置、命令、常量、新模块、API 变化等，必须同步更新 CLAUDE.md 中的相关描述
- **`README.md`**：如果变更涉及用户可见的功能、配置项、使用方式等，必须同步更新 README.md
- **`CHANGELOG.md`**：将变更记录添加到 `## [Unreleased]` 部分的对应分类下

**检查方法**：

1. 读取变更的文件列表，判断是否涉及以下内容：
   - 新增/删除/重命名模块或文件 → 更新 CLAUDE.md 架构描述
   - 新增/修改命令（`commands/handler.ts`）→ 更新 CLAUDE.md 命令列表和 README.md 命令参考
   - 新增/修改配置项（`config.ts`、`constants.ts`）→ 更新 CLAUDE.md 配置/常量说明
   - 新增/修改环境变量 → 更新 CLAUDE.md 环境变量列表
   - 修改流式输出、卡片、权限等核心流程 → 更新 CLAUDE.md 对应架构章节
   - 任何用户可感知的变更 → 更新 README.md

2. 如果需要更新文档，先阅读现有文档相关部分，然后进行同步修改
3. 文档变更必须与代码变更一起提交，不要分开

**如果判断不需要更新文档，向用户说明原因。**

### 5. 生成 Commit 信息

**如果用户提供了完整的 commit 信息**：直接使用。

**如果用户只提供了 subject**（如 `修复登录问题`）：根据变更自动推断 type。

**如果用户未提供任何信息**：根据变更内容自动生成。

Commit 信息格式：

```
<type>: <subject>
```

**Type 类型**：

- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档修改
- `style`: 格式修改（不影响代码逻辑）
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关
- `perf`: 性能优化
- `revert`: 回滚

**规范**：

- 使用中文描述，符合项目语言习惯
- Header 最多 72 字符
- 每行最多 100 字符
- 参考最近的提交风格保持一致

### 6. 确认并提交

向用户展示：

1. 将要提交的文件列表
2. 生成的 commit 信息
3. 代码审查发现的问题（如有）

用户确认后执行：

```bash
git add <具体文件>
git commit -m "<commit信息>"
```

## 注意事项

- **优先添加具体文件**，避免使用 `git add -A`
- 不要提交 `.env`、`.history/` 等敏感文件
- 本项目使用 **中文** commit 信息
- 提交前确保 TypeScript 编译通过
- 提交前确保相关测试通过
- 文档变更（CLAUDE.md、README.md、CHANGELOG.md）必须与代码变更同步提交
- 提交后不要自动 push，除非用户明确要求
- 遵循本项目的提交风格，参考最近几次提交
