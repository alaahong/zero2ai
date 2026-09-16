#!/usr/bin/env bash
# ZERO2AI 出口核查（POSIX）：断言进程的已建立连接只落在允许清单内。
#
# 用法：
#   verify-egress.sh --pid <PID> --allow llm-gw.corp.local,otel-collector.corp.local,proxy.corp.local
#   verify-egress.sh --pid <PID> --allow .corp.local          # 前缀加点 = 按域后缀放行
#
# 退出码：0 = 全部命中允许清单；1 = 存在非允许对端（打印明细）；2 = 用法/环境错误。
set -euo pipefail

PID=""
ALLOW=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pid) PID="${2:-}"; shift 2 ;;
    --allow) ALLOW="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$PID" && -n "$ALLOW" ]] || { echo "必须同时提供 --pid 与 --allow" >&2; exit 2; }

# 采集已建立连接的远端地址
if command -v ss >/dev/null 2>&1; then
  PEERS="$(ss -tnp 2>/dev/null | grep -F "pid=$PID," | awk '{print $5}' || true)"
elif command -v lsof >/dev/null 2>&1; then
  PEERS="$(lsof -nP -a -p "$PID" -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk 'NR>1 {print $9}' || true)"
else
  echo "需要 ss（iproute2）或 lsof" >&2; exit 2
fi

# 去掉端口，拆出主机部分
hosts() {
  printf '%s\n' "$PEERS" | sed -E 's/:[0-9]+$//; s/^\[//; s/\]$//' | grep -v '^$' | sort -u
}

is_allowed() {
  local host="$1" entry
  IFS=',' read -ra entries <<<"$ALLOW"
  for entry in "${entries[@]}"; do
    entry="${entry// /}"
    [[ -z "$entry" ]] && continue
    if [[ "$entry" == .* ]]; then
      # 域后缀放行：需要反查主机名
      local name
      name="$(getent hosts "$host" 2>/dev/null | awk '{print $2}' | head -1 || true)"
      [[ -n "$name" && "$name" == *"$entry" ]] && return 0
    else
      [[ "$host" == "$entry" ]] && return 0
      case "$entry" in *[!0-9a-fA-F:.]*) ;; *) continue ;; esac
    fi
  done
  return 1
}

unexpected=()
while read -r h; do
  is_allowed "$h" || unexpected+=("$h")
done < <(hosts)

echo "进程 $PID 的已建立连接对端："
hosts | sed 's/^/  /'

if (( ${#unexpected[@]} > 0 )); then
  echo "❌ 发现非允许对端（数据出域风险）：" >&2
  printf '  %s\n' "${unexpected[@]}" >&2
  echo "请检查：模型是否收敛到行内网关、disabledProviders 是否列全、share/collab 是否关闭。" >&2
  exit 1
fi
echo "✅ 全部连接均命中允许清单"
