#!/usr/bin/env bash
# ZERO2AI 离线构建链验收（POSIX）
#
# 用法：
#   verify-offline-build.sh                 # 真实执行
#   verify-offline-build.sh --dry-run       # 只打印将要执行的命令
#
# 前置条件（必须在隔离网内准备就绪，否则本脚本只会在第一步失败）：
#   - Bun >= 1.4（内网安装源）、Node 无关
#   - Rust nightly-2026-08-12 + rustup 组件（rustfmt/clippy）+ 目标三元组
#   - 内网 npm（BUN_CONFIG_REGISTRY 或 .npmrc）与 crates 镜像（或 cargo vendor + source replacement）
#   - 与上游一致的 VS Build Tools（Windows 原生构建 ARM64 时需要）
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

run() {
  if (( DRY_RUN )); then printf '  [dry-run] %s\n' "$*"; else printf '\n== %s\n' "$*"; "$@"; fi
}

echo "仓库根：$REPO_ROOT"
echo "步骤 1/6 依赖安装（锁定）"
run bun install --frozen-lockfile

echo "步骤 2/6 Rust 依赖拉取（离线镜像或 vendor）"
run cargo fetch --locked

echo "步骤 3/6 编译模型兼容规则（纯本地，改 KDL 后必跑）"
run bun run gen:compat

echo "步骤 4/6 构建原生插件与单文件二进制"
run bun --cwd=packages/natives run build
run bun --cwd=packages/coding-agent run build

echo "步骤 5/6 二进制自检（worker 与子进程探针）"
run ./packages/coding-agent/dist/zero2ai --smoke-test

echo "步骤 6/6 版本自检"
run ./packages/coding-agent/dist/zero2ai --version

cat <<'NOTE'

构建产物路径以 build-binary.ts 的输出名为准（win32 交叉构建会带目标后缀，如 zero2ai-win32-x64）。
构建期必须零外联；建议与出口核查并用：
  sudo tcpdump -i any -n 'not host <内网镜像> and not host <crates 镜像>'
提交前还需回到主流程跑（均在仓库根）：
  bun run test        # TS + Rust 同一进度流
  bun run test:rs     # nextest + doctest 补充
  bun run check       # oxlint + oxfmt + 全包类型检查
NOTE
