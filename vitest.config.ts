import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/cli.ts',
        'src/feishu/client.ts',
        'src/shared/types.ts',
        'src/hook/hook-script.ts',
        // 这些文件有复杂的错误处理或外部依赖，难以全面测试
        'src/telegram/client.ts',
        // 飞书事件处理器包含大量平台特有逻辑（图片处理、卡片交互等），测试复杂度高
        'src/feishu/event-handler.ts',
      ],
      reporter: ['text', 'html', 'json'],
      all: true,
      lines: 80,
      functions: 80,
      branches: 70,
      statements: 80,
    },
  },
});
