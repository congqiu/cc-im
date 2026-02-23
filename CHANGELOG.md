# Changelog

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新功能

- 添加 /history 命令和 /pwd 子目录列表
- CardKit API 添加重试机制
- 添加日志等级配置支持
- 启动通知增加版本信息和运行时长
- 轮次追踪与上下文警告
- CLI 支持守护进程模式（`-d`/`--daemon` 启动后台运行，`cc-im stop` 停止）
- `/model` 命令支持按用户和按话题粒度设置模型
- 支持 `CLAUDE_MODEL` 环境变量设置默认模型
- 飞书话题中的图片消息（post 富文本）自动解析图片和文字

### 修复

- `cleanOldImages` 在目录不存在时自动创建，避免启动报错

- 修复 Telegram bot 启动超时问题
- 传递 claudeTimeoutMs 给 runClaude 并改进 Telegram 工具调用进度显示
- 修复 onComplete/onError 竞态：立即标记 settled 防止重复执行
- CardKit card.create 移除重试（创建操作不幂等，重试会产生孤儿卡片）
- 修复 /history 翻页提示：仅在有下一页时显示
- 修复 formatToolStats 在 0 轮次时的显示
- Telegram bot.launch() 致命错误时退出进程而非仅记录日志
- 修复 CardKit disableStreaming 的 settings JSON 格式
- 权限服务器启动失败时正确抛出错误（而非静默挂起）
- 飞书/Telegram 客户端在未初始化时调用 getClient()/getBot() 抛出明确错误

### 重构

- 提取共享任务清理模块（`src/shared/task-cleanup.ts`）和消息去重模块（`src/shared/message-dedup.ts`），消除两个平台事件处理器中的重复代码
- 移除 `/todos` 命令
- 空 catch 块添加 debug 级别日志（`cli.ts`、`utils.ts`）
- 启用 TypeScript `noImplicitReturns` 和 `noFallthroughCasesInSwitch`
- `/history` 消息预览截断阈值从 120 提升到 300 字符
- 提取共享 Claude 任务执行层（`src/shared/claude-task.ts`），消除飞书和 Telegram 事件处理器中的重复代码
- `/model` 模型存储从全局配置文件改为 SessionManager（按用户/话题粒度），移除 `saveRuntimeConfig()`
- 提取公共 `truncateText()` 工具函数，消除三处重复的截断逻辑
- 改进工具调用通知格式
- getHistory 返回值改为 discriminated union（HistoryResult）
- listSubDirs 改为异步操作
- 错误日志增加 sessionId 便于排查
- SessionManager 会话保存改为同步写入
- Telegram 去重 Map 增加容量上限（1000 条）
- convSessionMap 增加容量上限（200 条），防止内存泄漏

### 其他

- 移除 `uuid` 依赖

## [1.0.1] - 2026-02-20

### 重构

- 统一环境变量前缀为 CC_IM 并补充消息撤回清理与文档更新

### 其他

- 更新发布策略为推送 tag 触发 GitHub Actions

## [1.0.0] - 2026-02-20

### 新功能

- 飞书端使用 CardKit v1 API 实现流式打字机效果
- 飞书话题会话支持与代码质量改进
- 添加工具使用统计功能
- 完成卡片展示思考过程折叠面板
- 图片消息支持、流式工具通知与生命周期通知改进
- 添加 Telegram 平台支持及智能速率限制处理
- 添加 vitest 单元测试，覆盖全部核心模块
- 添加 Claude Code 等效斜杠命令支持
- 支持同用户不同 session 并发执行
- 改进会话清除功能的可靠性和用户体验
- 添加卡片停止按钮功能
- 增强可靠性和错误处理机制
- 添加 CLI 入口点支持 npx 运行和多项增强
- 增强安全性和稳定性
- 重构命令系统与增强平台稳定性
- 在完成消息中显示模型名称

### 修复

- 移除 provenance 参数，私有仓库不支持

### 重构

- 重命名项目为 cc-im
- 统一命令分发、增强安全性与健壮性

### 性能

- 改善飞书卡片等待期间的用户体验

## [0.0.1] - 2026-02-10

### 新功能

- 初始化飞书-Claude Code 桥接服务
- 添加日志文件系统，替换所有 console 调用
- 优化流式消息更新体验

