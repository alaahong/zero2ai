<#
ZERO2AI 出口核查（Windows / PowerShell）：断言进程已建立连接只落在允许清单内。

用法：
  .\verify-egress.ps1 -ProcessName zero2ai -Allow llm-gw.corp.local,otel-collector.corp.local,.corp.local
  .\verify-egress.ps1 -ProcessId 1234 -Allow .corp.local     # 前缀加点 = 按域后缀放行

退出码：0 = 全部命中；1 = 存在非允许对端；2 = 用法/环境错误。
#>
[CmdletBinding()]
param(
  [int]$ProcessId = 0,
  [string]$ProcessName,
  [Parameter(Mandatory = $true)][string]$Allow
)

$ErrorActionPreference = "Stop"

if ($ProcessId -eq 0) {
  if (-not $ProcessName) { Write-Error "需要 -ProcessId 或 -ProcessName"; exit 2 }
  $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proc) { Write-Error "未找到进程: $ProcessName"; exit 2 }
  $ProcessId = $proc.Id
}

$entries = $Allow.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }

function Test-Allowed([string]$Remote) {
  foreach ($e in $entries) {
    if ($e.StartsWith('.')) {
      # 域后缀放行：反查主机名
      $name = $null
      try { $name = [System.Net.Dns]::GetHostEntry($Remote).HostName } catch { }
      if ($name -and $name.EndsWith($e)) { return $true }
    }
    elseif ($Remote -eq $e) { return $true }
  }
  return $false
}

$conns = Get-NetTCPConnection -OwningProcess $ProcessId -State Established -ErrorAction SilentlyContinue |
  Where-Object { $_.RemoteAddress -notin @('0.0.0.0', '::', '127.0.0.1', '::1') }

if (-not $conns) { Write-Host "进程 $ProcessId 无外部已建立连接（正常）"; exit 0 }

$unexpected = @()
foreach ($c in $conns) {
  $ok = Test-Allowed $c.RemoteAddress
  Write-Host ("  {0}:{1} {2}" -f $c.RemoteAddress, $c.RemotePort, ($(if ($ok) { 'OK' } else { 'UNEXPECTED' })))
  if (-not $ok) { $unexpected += $c.RemoteAddress }
}

if ($unexpected.Count -gt 0) {
  Write-Host "发现非允许对端（数据出域风险）：" -ForegroundColor Red
  $unexpected | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Write-Host "请检查：模型是否收敛到行内网关、disabledProviders 是否列全、share/collab 是否关闭。"
  exit 1
}
Write-Host "全部连接均命中允许清单" -ForegroundColor Green
