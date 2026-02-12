---
name: add-command
description: 为机器人添加新的斜杠命令，自动在所有平台注册并添加测试
---

# Add Command Skill

为 cc-bot 添加新的斜杠命令，确保在所有平台（飞书 + Telegram）中正确注册。

## 使用方式

```
/add-command /ping 返回 pong 用于检测机器人是否在线
/add-command /lang 切换回复语言
```

## 执行步骤

### 1. 确认命令设计

向用户确认：
- 命令名称（如 `/ping`）
- 是否需要参数（如 `/model [name]` 有可选参数）
- 命令功能描述
- 是否需要调用 Claude（像 `/compact` 和 `/todos` 那样需要 `handleClaudeRequest`）

### 2. 在 CommandHandler 中添加处理方法

文件：`src/commands/handler.ts`

在 `CommandHandler` 类中添加新的 `handleXxx` 方法：

```typescript
async handlePing(chatId: string): Promise<boolean> {
  await this.deps.sender.sendTextReply(chatId, 'pong');
  return true;
}
```

**注意**：
- 方法签名根据需要包含 `chatId`、`userId`、`args` 等参数
- 如果需要调用 Claude，额外接收 `handleClaudeRequest: ClaudeRequestHandler` 参数（参考 `handleCompact` 和 `handleTodos`）
- 始终返回 `Promise<boolean>`

### 3. 更新帮助文本

在同一文件的 `handleHelp` 方法中，将新命令添加到帮助列表。

### 4. 在两个平台的事件处理器中注册命令

需要在两个文件中添加命令路由：

**飞书**：`src/feishu/event-handler.ts`

在 `im.message.receive_v1` 事件处理器中，找到命令处理区域（在 `// Handle terminal-only commands` 之前），添加：

```typescript
// Handle /ping command
if (text.trim() === '/ping') {
  await commandHandler.handlePing(chatId);
  return;
}
```

**Telegram**：`src/telegram/event-handler.ts`

在 `bot.on(message('text'))` 处理器中，同样位置添加相同的路由逻辑：

```typescript
// Handle /ping
if (text === '/ping') {
  await commandHandler.handlePing(chatId);
  return;
}
```

**带参数的命令**（参考 `/cd` 和 `/model` 的模式）：

```typescript
if (text === '/xxx' || text.startsWith('/xxx ')) {
  const args = text.slice(4); // 4 = '/xxx'.length
  await commandHandler.handleXxx(chatId, userId, args);
  return;
}
```

### 5. 如果是仅终端命令

如果命令不适合在消息平台使用，只需在 `src/constants.ts` 的 `TERMINAL_ONLY_COMMANDS` 集合中添加即可，无需其他步骤。

### 6. 添加测试

在 `tests/unit/` 中为新命令添加测试。参考现有测试文件的 mock 模式。

项目使用 vitest，测试文件位于 `tests/unit/` 目录，与 `src/` 结构对应。

### 7. 验证

```bash
pnpm build    # 确保编译通过
pnpm test     # 确保测试通过
```

## 注意事项

- 两个平台的事件处理器中命令路由逻辑必须保持一致
- 飞书事件处理器中文本需要 `text.trim()`，Telegram 已在入口处 trim
- 命令处理逻辑放在 `CommandHandler` 中保持平台无关
- 帮助文本使用中文描述
