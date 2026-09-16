<#
ZERO2AI 受控启动器（Windows / PowerShell）

目的：把「默认收紧」变成「默认即策略」。用户直接运行 zero2ai 会落到上游默认
      （approvalMode=yolo、全工具可用）；只有通过本脚本启动才带上固定参数与受控配置。

强制力边界：本脚本不是沙箱。真正的强制 = 本脚本 + 不把二进制放进普通用户 PATH +
            目录 ACL（NTFS，因为 chmod 语义在 Windows 无效）+ 终端白名单。

用法：
  .\zero2ai-launch.ps1 [--list-tools] [任何 zero2ai 原生参数]
#>
[CmdletBinding()]
param(
  [switch]$ListTools,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"

$Zero2AiBin = if ($env:ZERO2AI_BIN) { $env:ZERO2AI_BIN } else { "D:\corp\zero2ai\bin\zero2ai.exe" }
$PolicyFile = if ($env:ZERO2AI_POLICY) { $env:ZERO2AI_POLICY } else { "D:\corp\zero2ai\baseline.yml" }
$EnvFile = if ($env:ZERO2AI_ENV_FILE) { $env:ZERO2AI_ENV_FILE } else { "D:\corp\zero2ai\env.ps1" }
$ToolAllowlist = if ($env:ZERO2AI_TOOLS) { $env:ZERO2AI_TOOLS } else { "read,grep,glob,edit,write,bash,lsp,todo,ask" }
# 受管策略：管理员下发的审批上限，--yolo 与用户配置均无法绕过（缺失/损坏即报错）
$ManagedPolicy = if ($env:ZERO2AI_MANAGED_POLICY) { $env:ZERO2AI_MANAGED_POLICY } else { "D:\corp\zero2ai\managed-policy.json" }

if (-not (Test-Path -LiteralPath $Zero2AiBin)) { throw "zero2ai 二进制不存在: $Zero2AiBin" }
if (-not (Test-Path -LiteralPath $PolicyFile)) { throw "策略文件不存在: $PolicyFile" }
if (-not (Test-Path -LiteralPath $ManagedPolicy)) { throw "受管策略不存在: $ManagedPolicy" }
$env:ZERO2AI_MANAGED_POLICY = $ManagedPolicy

if (Test-Path -LiteralPath $EnvFile) { . $EnvFile }

# 合规兜底：无论用户在会话里设过什么，一律清除
Remove-Item Env:PI_REQ_DEBUG -ErrorAction SilentlyContinue
Remove-Item Env:OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT -ErrorAction SilentlyContinue
Remove-Item Env:PI_AUTO_QA_PUSH -ErrorAction SilentlyContinue

if ($ListTools) {
  # 传一个不存在的工具名触发校验，引擎会回显合法工具清单（fail-closed，不执行任何工具）
  & $Zero2AiBin --tools __probe__ --version 2>&1 | Select-Object -First 5
  exit 0
}

$nativeArgs = @(
  "--config", $PolicyFile,
  "--approval-mode", "always-ask",
  "--tools", $ToolAllowlist,
  "--no-extensions"
) + $Rest

& $Zero2AiBin @nativeArgs
exit $LASTEXITCODE
