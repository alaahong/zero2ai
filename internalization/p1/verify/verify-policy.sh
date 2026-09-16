#!/usr/bin/env bash
# ZERO2AI 策略验收（POSIX）
#
# 用法：
#   verify-policy.sh --bin /opt/corp/zero2ai/bin/zero2ai --policy /etc/corp/zero2ai/baseline.yml
#
# 断言全部基于「引擎自己解析出的生效值」（zero2ai config get），不依赖提示词或模型行为。
# 退出码：0 = 全部通过；1 = 有断言失败；2 = 用法/环境错误。
set -euo pipefail

BIN=""
POLICY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin) BIN="${2:-}"; shift 2 ;;
    --policy) POLICY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$BIN" && -n "$POLICY" ]] || { echo "必须提供 --bin 与 --policy" >&2; exit 2; }

pass=0; fail=0
get() { "$BIN" --config "$POLICY" config get "$1" 2>/dev/null | tr -d '\r' | tail -1; }

check_eq() { # key expected
  local actual; actual="$(get "$1")"
  if [[ "$actual" == "$2" ]]; then
    echo "  ✅ $1 = $actual"; pass=$((pass + 1))
  else
    echo "  ❌ $1 = '$actual'，期望 '$2'"; fail=$((fail + 1))
  fi
}

echo "== 审批与工具策略 =="
check_eq tools.approvalMode always-ask
check_eq tools.approval.eval deny
check_eq tools.approval.computer deny
check_eq tools.approval.web_search deny

echo "== 外发/更新面 =="
check_eq startup.checkUpdate false
check_eq marketplace.autoUpdate off
check_eq dev.autoqa false

echo "== 出口收敛（disabledProviders 覆盖度）=="
raw="$("$BIN" --config "$POLICY" config get disabledProviders --json 2>/dev/null | tr -d '\r')"
count=$(( $(printf '%s' "$raw" | grep -o '"' | wc -l) / 2 ))
if (( count >= 60 )); then
  echo "  ✅ disabledProviders 条目数 = $count（内置 provider 共 76，保留网关与本地推理）"; pass=$((pass + 1))
else
  echo "  ❌ disabledProviders 条目数 = $count，疑似漏列（该键是整体替换语义，漏列即仍可用）"; fail=$((fail + 1))
fi

echo "== 工具白名单 fail-closed 行为 =="
if out="$("$BIN" --tools __probe__ --version 2>&1)"; then
  echo "  ❌ 非法工具名未被拒绝（期望非零退出）"; fail=$((fail + 1))
else
  if printf '%s' "$out" | grep -q 'Valid tools:'; then
    echo "  ✅ 非法工具名被拒绝且回显合法清单"; pass=$((pass + 1))
  else
    echo "  ❌ 被拒绝但未回显合法工具清单，无法核对白名单拼写"; fail=$((fail + 1))
  fi
fi

echo
echo "通过 $pass 项，失败 $fail 项"
cat <<'NOTE'

需人工复核的两项（无机械断言）：
  1) 显式 deny 的不可绕过性：以交互会话尝试触发被 deny 的工具，确认提示"被策略阻止"。
  2) 沙箱外层：确认进程被限制在受控 VM/容器内，且出网 ACL 只放行模型网关与 collector
     （用 verify-egress 在会话运行中采样）。
NOTE

(( fail == 0 ))
