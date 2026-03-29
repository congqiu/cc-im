#!/bin/bash
# 本地开发：构建并管理服务
# 用法：
#   ./local-daemon.sh           构建并以守护模式启动
#   ./local-daemon.sh stop      停止服务
#   ./local-daemon.sh status    查看运行状态
#   ./local-daemon.sh install   构建并注册为开机自启服务
#   ./local-daemon.sh uninstall 卸载开机自启服务
set -e

cd "$(dirname "$0")"

ACTION="${1:-daemon}"

# stop 和 status 不需要构建
case "$ACTION" in
  stop|status)
    node dist/cli.js "$ACTION"
    ;;
  *)
    pnpm build
    case "$ACTION" in
      install|uninstall)
        node dist/cli.js "$ACTION"
        ;;
      *)
        node dist/cli.js stop 2>/dev/null || true
        node dist/cli.js -d
        ;;
    esac
    ;;
esac
