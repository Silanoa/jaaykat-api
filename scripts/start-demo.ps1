[CmdletBinding()]
param(
  [string]$NodeDir = (Join-Path $env:USERPROFILE "node22\node-v22.14.0-win-x64"),
  [string]$LogDir = $env:USERPROFILE,
  [int]$Port = 3000,
  [switch]$KeepTunnel
)

$ErrorActionPreference = "Stop"
$api = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $api ".env"
$node = Join-Path $NodeDir "node.exe"
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { $cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
$cfErr = Join-Path $LogDir "cf-err.txt"
$cfOut = Join-Path $LogDir "cf-out.txt"
$apiErr = Join-Path $LogDir "api-err.txt"
$apiOut = Join-Path $LogDir "api-out.txt"

foreach ($required in @($node, $envFile, $cloudflared)) {
  if (-not (Test-Path $required)) { throw "Introuvable : $required" }
}

function Get-TunnelUrl {
  if (-not (Test-Path $cfErr)) { return $null }
  $hit = Select-String -Path $cfErr -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -Last 1
  if ($hit) { return $hit.Matches[0].Value }
  return $null
}

function Wait-Until([scriptblock]$Test, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Test) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-Health([string]$Base) {
  try { return (Invoke-RestMethod "$Base/api/health" -TimeoutSec 5) } catch { return $null }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*src/server.ts*" -or $_.CommandLine -like "*src\server.ts*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$tunnel = Get-Process cloudflared -ErrorAction SilentlyContinue
$url = Get-TunnelUrl
if (-not ($KeepTunnel -and $tunnel -and $url)) {
  if ($tunnel) { $tunnel | Stop-Process -Force }
  if (Test-Path $cfErr) { Remove-Item $cfErr -Force }
  Start-Process -FilePath $cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$Port" `
    -WindowStyle Hidden -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr
  if (-not (Wait-Until { Get-TunnelUrl } 60)) { throw "Le tunnel n'a pas donné d'URL. Voir $cfErr" }
  $url = Get-TunnelUrl
}

$lines = @(Get-Content $envFile -Encoding UTF8)
$found = $false
$lines = $lines | ForEach-Object {
  if ($_ -match "^PUBLIC_URL=") { $found = $true; "PUBLIC_URL=$url" } else { $_ }
}
if (-not $found) { $lines += "PUBLIC_URL=$url" }
[IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding $false))

Start-Process -FilePath $node `
  -ArgumentList "--env-file=.env", "node_modules\tsx\dist\cli.mjs", "src/server.ts" `
  -WorkingDirectory $api -WindowStyle Hidden -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr

if (-not (Wait-Until { Get-Health "http://localhost:$Port" } 40)) { throw "L'API ne répond pas en local. Voir $apiErr" }
$local = Get-Health "http://localhost:$Port"
$remoteOk = Wait-Until { Get-Health $url } 60

Write-Host ""
Write-Host "API locale : ok, mode $($local.mode), paiement démo $($local.demoPayMode)"
if ($remoteOk) { Write-Host "Tunnel : ok" } else { Write-Host "Tunnel : l'URL ne répond pas encore, réessayez dans une minute" }
Write-Host "URL publique : $url"
Write-Host ""
Write-Host "À FAIRE : dans le dashboard Bitnob, mettre l'URL du webhook à jour :"
Write-Host "  $url/webhooks/bitnob"
Write-Host "Le secret de signature reste celui de .env (BITNOB_WEBHOOK_SECRET)."
