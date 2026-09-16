#!/usr/bin/env pwsh
# ZERO2AI 环境变量基线（Windows / PowerShell）——由受控启动器 dot-source。
#
# 语义提醒：PI_CONFIG_DIR 是与 os.homedir() 拼接的「相对段」，不要写绝对路径。

# ── 目录重定向 ───────────────────────────────────────────────────────────
$env:PI_CONFIG_DIR = ".zero2ai-corp"                         # 相对 $env:USERPROFILE
$env:PI_CODING_AGENT_DIR = "D:\corp\zero2ai\agent"           # 可用绝对路径
$env:PI_CONFIG_FILES = "D:\corp\zero2ai\baseline.yml"        # Windows 用 ';' 分隔多个

# ── 出口 ────────────────────────────────────────────────────────────────
$env:PI_PROXY = "http://proxy.corp.local:3128"
$env:NO_PROXY = "localhost,127.0.0.1,.corp.local,10.0.0.0/8"
$env:NODE_EXTRA_CA_CERTS = "D:\corp\pki\ca-bundle.pem"

# ── 模型网关 ────────────────────────────────────────────────────────────
$env:LITELLM_BASE_URL = "https://llm-gw.corp.local/v1"
$env:LITELLM_API_KEY = "__FROM_VAULT__"
$env:CORP_LLM_API_KEY = "__FROM_VAULT__"

# ── 集中凭据 ────────────────────────────────────────────────────────────
$env:ZERO2AI_AUTH_BROKER_URL = "https://auth-broker.corp.local"
$env:ZERO2AI_AUTH_BROKER_TOKEN = "__FROM_VAULT__"

# ── 可观测 ──────────────────────────────────────────────────────────────
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.corp.local:4318"
$env:OTEL_SERVICE_NAME = "zero2ai"

$env:ZERO2AI_CREDENTIAL_STORE = "broker-only"   # 禁止本机落盘凭据（broker 主机不要设）
# ── 托管策略（管理员下发，用户不可绕过）──────────────────────────────
$env:ZERO2AI_MANAGED_POLICY = "D:\corp\zero2ai\managed-policy.json"

# ── L2 收紧开关（08-l2-harden.patch 引入）──────────────────────────────
$env:ZERO2AI_DISABLE_MODEL_CATALOG = "1"
# $env:ZERO2AI_MODEL_CATALOG_URL = "https://mirror.corp.local/models.json.zstd"
$env:ZERO2AI_LOG_LEVEL = "info"
# $env:ZERO2AI_UPDATE_NPM_REGISTRY / ZERO2AI_UPDATE_GITHUB_API / ZERO2AI_UPDATE_GITHUB_REPO

# ── 合规红线：强制清除 ──────────────────────────────────────────────────
Remove-Item Env:OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT -ErrorAction SilentlyContinue
Remove-Item Env:PI_REQ_DEBUG -ErrorAction SilentlyContinue
Remove-Item Env:PI_AUTO_QA_PUSH -ErrorAction SilentlyContinue
$env:PI_AUTO_QA = "0"
$env:PI_BROWSER_RELAY = "0"
