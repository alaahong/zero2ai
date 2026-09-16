<#
应用 / 回滚「ZERO2AI 表面内化」基线补丁序列（Windows）。

用法：
  .\apply-baseline.ps1                    # 应用到本仓库
  .\apply-baseline.ps1 -Check             # 只做可应用性检查
  .\apply-baseline.ps1 -Target D:\corp\zero2ai -Revert
#>
[CmdletBinding()]
param(
  [string]$Target,
  [switch]$Check,
  [switch]$Revert
)

$ErrorActionPreference = "Stop"
$SelfDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PatchDir = Join-Path $SelfDir "baseline"
if (-not $Target) { $Target = Split-Path -Parent $SelfDir }

Push-Location $Target
try {
  git rev-parse --git-dir > $null 2>&1
  if ($LASTEXITCODE -ne 0) { throw "目标不是 git 仓库: $Target" }

  if (-not $Check -and (git status --porcelain)) {
    throw "目标工作区不干净，先提交或暂存改动再应用基线"
  }

  $patches = Get-ChildItem -Path $PatchDir -Filter *.patch | Sort-Object Name
  if ($Revert) { $patches = $patches | Sort-Object Name -Descending }

  foreach ($p in $patches) {
    if ($Check) {
      git apply --check --whitespace=nowarn $p.FullName
      if ($LASTEXITCODE -ne 0) { throw "FAILED  $($p.Name)" }
      Write-Host "OK      $($p.Name)"
    }
    else {
      if ($Revert) { git apply -R --whitespace=nowarn $p.FullName } else { git apply --whitespace=nowarn $p.FullName }
      if ($LASTEXITCODE -ne 0) { throw "FAILED  $($p.Name)" }
      Write-Host ("{0} {1}" -f $(if ($Revert) { "reverted" } else { "applied " }), $p.Name)
    }
  }

  if ($Check) { Write-Host "全部补丁可应用（未落盘）" }
  elseif ($Revert) { Write-Host "基线已从 $Target 回滚" }
  else {
    Write-Host "基线已应用到 $Target"
    Write-Host "建议随后执行：bun install --frozen-lockfile ; bun run check"
  }
}
finally { Pop-Location }
