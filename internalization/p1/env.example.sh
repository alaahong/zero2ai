#!/usr/bin/env sh
# ZERO2AI 环境变量基线（POSIX）——部署为 /etc/corp/zero2ai/env，由受控启动器 source。
#
# 关键语义（均为本仓库实测）：
#   PI_CONFIG_DIR        必须是「相对 home 的路径段」，因为它与 os.homedir() 拼接；
#                        给绝对路径会得到 <home>/<绝对路径> 的畸形结果（Windows 上尤其明显）。
#   PI_CODING_AGENT_DIR  可给绝对路径，直接覆盖 agent 目录。
#   PI_CONFIG_FILES      OS 路径分隔符列表（POSIX 用 ':'，Windows 用 ';'），按顺序叠加。

# ── 目录重定向：全部落在受控盘，避免散落用户主目录 ──────────────────────────
PI_CONFIG_DIR=".zero2ai-corp"; export PI_CONFIG_DIR
PI_CODING_AGENT_DIR="/opt/corp/zero2ai/agent"; export PI_CODING_AGENT_DIR

# ── 策略基线（只读，由管理员维护）─────────────────────────────────────────
PI_CONFIG_FILES="/etc/corp/zero2ai/baseline.yml"; export PI_CONFIG_FILES

# ── 出口：唯一模型网关 + 行内正向代理 + 私有 CA ─────────────────────────────
# PI_PROXY           进程级代理；PI_PROXY_<PROVIDER> 可按 provider 单独指定
# NO_PROXY           回环与私网段恒直连（引擎内已对 127.0.0.1/元数据地址强制直连）
PI_PROXY="http://proxy.corp.local:3128"; export PI_PROXY
NO_PROXY="localhost,127.0.0.1,.corp.local,10.0.0.0/8"; export NO_PROXY
NODE_EXTRA_CA_CERTS="/etc/corp/pki/ca-bundle.pem"; export NODE_EXTRA_CA_CERTS

# ── 模型网关（二选一；用 models.yml 声明自定义 provider 时无需以下两行）──────
LITELLM_BASE_URL="https://llm-gw.corp.local/v1"; export LITELLM_BASE_URL
LITELLM_API_KEY="__FROM_VAULT__"; export LITELLM_API_KEY
CORP_LLM_API_KEY="__FROM_VAULT__"; export CORP_LLM_API_KEY

# ── 集中凭据：开发机不持 refresh token（强烈建议启用）───────────────────────
ZERO2AI_AUTH_BROKER_URL="https://auth-broker.corp.local"; export ZERO2AI_AUTH_BROKER_URL
ZERO2AI_AUTH_BROKER_TOKEN="__FROM_VAULT__"; export ZERO2AI_AUTH_BROKER_TOKEN

# ── 可观测：导出到行内 collector（仅支持 OTLP/HTTP protobuf）──────────────
OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector.corp.local:4318"; export OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_SERVICE_NAME="zero2ai"; export OTEL_SERVICE_NAME

# ZERO2AI_CREDENTIAL_STORE=broker-only   禁止在本机落盘任何凭据（开发机必设；broker 主机不要设）
: "${ZERO2AI_CREDENTIAL_STORE:=broker-only}"
export ZERO2AI_CREDENTIAL_STORE
# ── 托管策略（管理员下发，用户不可绕过）──────────────────────────────
ZERO2AI_MANAGED_POLICY="/etc/corp/zero2ai/managed-policy.json"; export ZERO2AI_MANAGED_POLICY

# ── L2 收紧开关（08-l2-harden.patch 引入）──────────────────────────────
# ZERO2AI_DISABLE_MODEL_CATALOG=1        关闭公网模型目录刷新（离线环境必设）
# ZERO2AI_MODEL_CATALOG_URL=<镜像地址>   改指内网目录镜像（与开关二选一）
# ZERO2AI_LOG_LEVEL=info                 本地日志级别（error|warn|info|debug，默认 debug 全写）
# ZERO2AI_UPDATE_NPM_REGISTRY            自更新 npm 源（默认公网）
# ZERO2AI_UPDATE_GITHUB_API / _REPO      自更新发布元数据源与仓库
: "${ZERO2AI_DISABLE_MODEL_CATALOG:=1}"
export ZERO2AI_DISABLE_MODEL_CATALOG
: "${ZERO2AI_LOG_LEVEL:=info}"
export ZERO2AI_LOG_LEVEL

# ── 明确禁止设置（合规红线，启动器会 unset 兜底）───────────────────────────
# OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT  # 打开会把提示词内容写进 span
# PI_REQ_DEBUG=1                                      # 会把完整请求体+响应写到当前工作目录
# PI_AUTO_QA_PUSH=1                                  # 强制向 Auto-QA 端点推送
unset PI_REQ_DEBUG OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT PI_AUTO_QA_PUSH 2>/dev/null || true
PI_AUTO_QA="0"; export PI_AUTO_QA
PI_BROWSER_RELAY="0"; export PI_BROWSER_RELAY
