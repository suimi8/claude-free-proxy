<#
  accounts.ps1 —— 多账号管理 CLI（直接打反代的 /v1/accounts 端点）

  前提：反代已在运行（start.cmd）

  用法：
    .\accounts.ps1 -List
    .\accounts.ps1 -Add -Label example -SessionKey $env:SESSION_KEY -Key $env:PROXY_API_KEY
    .\accounts.ps1 -Disable <id>
    .\accounts.ps1 -Enable <id>
    .\accounts.ps1 -Remove <id>
    .\accounts.ps1 -Strategy least-loaded

  sessionKey 从哪来：
    浏览器登录 claude.ai 后，开发者工具 -> Application -> Cookies -> claude.ai -> sessionKey
    （只要 sessionKey 就够了，org 会自动发现）
#>
param(
  [switch]$List,
  [switch]$Add,
  [string]$Label = "",
  [string]$SessionKey = "",
  [string]$Org = "",
  [string]$UpstreamBase = "",
  [string]$Disable = "",
  [string]$Enable = "",
  [string]$Remove = "",
  [string]$Strategy = "",
  [int]$Port = 8787,
  [string]$Key = ""
)

$ErrorActionPreference = "Stop"
$Px = "http://127.0.0.1:$Port"
$hdr = @{ "Content-Type" = "application/json" }
if ($Key) { $hdr["Authorization"] = "Bearer $Key" }

function Show($obj) { $obj | ConvertTo-Json -Depth 8 }

if ($List -or (-not $Add -and -not $Disable -and -not $Enable -and -not $Remove -and -not $Strategy)) {
  $s = Invoke-RestMethod "$Px/v1/accounts" -Headers $hdr -TimeoutSec 20
  Write-Host ("strategy={0}  accounts={1}  enabled={2}  eligible_now={3}  concurrency={4}/acct" -f `
      $s.strategy, $s.total, $s.enabled, $s.eligible_now, $s.per_account_concurrency) -ForegroundColor Cyan
  $s.accounts | Format-Table id, label, source, enabled, org, session_key, inflight, `
    cooldown_remaining_s, ok, fail, last_error -AutoSize | Out-String -Width 200 | Write-Host
  if ($s.accounts.quota_5h) {
    Write-Host "5h 配额：" -ForegroundColor Cyan
    foreach ($a in $s.accounts) {
      if ($a.quota_5h) {
        Write-Host ("  {0,-16} {1}  util={2:P0}  resets={3}" -f $a.label, $a.quota_5h.status, `
            $a.quota_5h.utilization, ([DateTimeOffset]::FromUnixTimeSeconds($a.quota_5h.resets_at).LocalDateTime)) `
          -ForegroundColor DarkGray
      }
    }
  }
  return
}

if ($Add) {
  if (-not $SessionKey) { Write-Host "[!] 必须给 -SessionKey" -ForegroundColor Red; exit 1 }
  $body = @{ label = $Label; sessionKey = $SessionKey }
  if ($Org) { $body.org = $Org }
  if ($UpstreamBase) { $body.base = $UpstreamBase }
  $r = Invoke-RestMethod "$Px/v1/accounts" -Method Post -Headers $hdr `
    -Body ($body | ConvertTo-Json) -TimeoutSec 60
  Write-Host ("{0} id={1} label={2} org={3}" -f $(if ($r.created) { "已添加" } else { "已存在(已更新)" }), `
      $r.account.id, $r.account.label, $r.account.org) -ForegroundColor Green
  return
}

if ($Disable) {
  $r = Invoke-RestMethod "$Px/v1/accounts/$Disable" -Method Patch -Headers $hdr `
    -Body '{"enabled":false}' -TimeoutSec 20
  Write-Host "已停用 $($r.account.label) ($Disable)" -ForegroundColor Yellow; return
}
if ($Enable) {
  $r = Invoke-RestMethod "$Px/v1/accounts/$Enable" -Method Patch -Headers $hdr `
    -Body '{"enabled":true}' -TimeoutSec 20
  Write-Host "已启用 $($r.account.label) ($Enable)" -ForegroundColor Green; return
}
if ($Remove) {
  $r = Invoke-RestMethod "$Px/v1/accounts/$Remove" -Method Delete -Headers $hdr -TimeoutSec 20
  Write-Host "已删除 $Remove" -ForegroundColor Yellow; return
}
if ($Strategy) {
  $r = Invoke-RestMethod "$Px/v1/pool" -Method Post -Headers $hdr `
    -Body (@{ strategy = $Strategy } | ConvertTo-Json) -TimeoutSec 20
  Write-Host "策略已切换为 $($r.strategy)" -ForegroundColor Green; return
}
