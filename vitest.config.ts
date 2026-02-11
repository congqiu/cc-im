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
