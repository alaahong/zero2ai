#!/usr/bin/env bash
# 回滚「ZERO2AI 表面内化」基线补丁序列（按逆序反向应用）。
#
# 用法：
#   revert-baseline.sh
#   revert-baseline.sh --target /path/to/repo
#
# 注意：只回滚本序列引入的改动；应用之后的目标仓库如有其他本地提交，需自行处理冲突。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$SELF_DIR/baseline"
TARGET="$(cd "$SELF_DIR/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$(cd "${2:?--target 需要目录}" && pwd)"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

cd "$TARGET"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "目标不是 git 仓库: $TARGET" >&2; exit 2; }

# 逆序回滚
mapfile -t patches < <(ls -1 "$PATCH_DIR"/*.patch | sort -r)
for p in "${patches[@]}"; do
  name="$(basename "$p")"
  if git apply -R --whitespace=nowarn "$p"; then
    echo "reverted $name"
  else
    echo "FAILED to revert $name" >&2
    exit 1
  fi
done
echo "基线已从 $TARGET 回滚"
