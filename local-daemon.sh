#!/bin/bash
# 本地开发：构建并以守护模式启动最新代码
set -e

cd "$(dirname "$0")"

# 停止已有进程
node dist/cli.js stop 2>/dev/null || true

# 构建
pnpm build

# 守护模式启动
node dist/cli.js -d
