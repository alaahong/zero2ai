#!/usr/bin/env bash
# 应用「ZERO2AI 表面内化」基线补丁序列。
#
# 用途：把本仓库当前的改名结果移植到另一个 checkout（例如内网 fork 的初始提交、
#       或上游 rebase 后的重放）。补丁由 `git diff HEAD --binary --no-renames` 生成，
#       不含 internalization/ 自身。
#
# 用法：
#   apply-baseline.sh                     # 应用到本仓库（脚本所在目录的上一级）
#   apply-baseline.sh --check             # 只做可应用性检查，不落盘
#   apply-baseline.sh --target /path/to/repo
#
# 前置：目标 checkout 处于未改动状态（`git status` 干净）。基线以当时的 HEAD 为基准，
#       上游若已前进，重新应用可能冲突——冲突即需人工 rebase（这正是设计意图：冲突点最小化）。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$SELF_DIR/baseline"
TARGET="$(cd "$SELF_DIR/.." && pwd)"
MODE="apply"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --target) TARGET="$(cd "${2:?--target 需要目录}" && pwd)"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

command -v git >/dev/null || { echo "需要 git" >&2; exit 2; }
cd "$TARGET"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "目标不是 git 仓库: $TARGET" >&2; exit 2; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠ 目标工作区不干净，先提交或暂存改动再应用基线：" >&2
  git status --short | head -5 >&2
  exit 2
fi

applied=0
for p in "$PATCH_DIR"/*.patch; do
  name="$(basename "$p")"
  if [[ "$MODE" == "check" ]]; then
    if git apply --check --whitespace=nowarn "$p"; then
      echo "OK      $name"
    else
      echo "FAILED  $name" >&2
      exit 1
    fi
  else
    if git apply --whitespace=nowarn "$p"; then
      echo "applied $name"
      applied=$((applied + 1))
    else
      echo "FAILED  $name（已应用 $applied 个补丁，可用 revert-baseline.sh 回滚）" >&2
      exit 1
    fi
  fi
done

if [[ "$MODE" == "check" ]]; then
  echo "全部补丁可应用（未落盘）"
else
  echo "基线已应用到 $TARGET，共 $applied 个补丁"
  echo "建议随后执行：bun install --frozen-lockfile && bun run check"
fi
