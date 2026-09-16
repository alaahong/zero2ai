#!/usr/bin/env bash
# ZERO2AI 受控启动器（POSIX）
#
# 目的：把「默认收紧」变成「默认即策略」——用户直接敲 zero2ai 会落到上游默认（approvalMode=yolo、
#       全工具可用）；只有通过本脚本启动才带上固定参数与受控配置。
#
# 强制力边界（务必知悉）：
#   本脚本不是沙箱。用户若能自行找到并执行二进制，就能绕过这里的一切参数。
#   真正的强制 = 本脚本 + 不把二进制暴露到普通用户 PATH + 目录 ACL + 终端白名单。
#
# 用法：
#   zero2ai-launch.sh [--list-tools] [任何 zero2ai 原生参数]
set -euo pipefail

ZERO2AI_BIN="${ZERO2AI_BIN:-/opt/corp/zero2ai/bin/zero2ai}"
POLICY_FILE="${ZERO2AI_POLICY:-/etc/corp/zero2ai/baseline.yml}"
ENV_FILE="${ZERO2AI_ENV_FILE:-/etc/corp/zero2ai/env}"
# 受管策略：管理员下发的审批上限，用户参数与 --yolo 均无法绕过（文件缺失/损坏会直接报错）
MANAGED_POLICY="${ZERO2AI_MANAGED_POLICY:-/etc/corp/zero2ai/managed-policy.json}"

# 会话允许的工具集（逗号分隔）。名字写错时引擎会直接报错并列出全部合法工具名，不会静默降级。
TOOL_ALLOWLIST="${ZERO2AI_TOOLS:-read,grep,glob,edit,write,bash,lsp,todo,ask}"

[[ -x "$ZERO2AI_BIN" ]] || { echo "zero2ai 二进制不可执行: $ZERO2AI_BIN" >&2; exit 127; }
[[ -r "$POLICY_FILE" ]] || { echo "策略文件不存在: $POLICY_FILE" >&2; exit 127; }
[[ -r "$MANAGED_POLICY" ]] || { echo "受管策略不存在: $MANAGED_POLICY" >&2; exit 127; }
export ZERO2AI_MANAGED_POLICY="$MANAGED_POLICY"

# shellcheck disable=SC1090
[[ -r "$ENV_FILE" ]] && . "$ENV_FILE"

# 合规兜底：无论用户在 shell 里设过什么，这里一律清掉
unset PI_REQ_DEBUG || true
unset OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT || true
unset PI_AUTO_QA_PUSH || true

if [[ "${1:-}" == "--list-tools" ]]; then
  # 用一个不存在的工具名触发校验错误，引擎会回显完整合法工具清单（fail-closed，不执行任何操作）
  "$ZERO2AI_BIN" --tools __probe__ --version 2>&1 | sed -n '1,5p'
  exit 0
fi

exec "$ZERO2AI_BIN" \
  --config "$POLICY_FILE" \
  --approval-mode always-ask \
  --tools "$TOOL_ALLOWLIST" \
  --no-extensions \
  "$@"
