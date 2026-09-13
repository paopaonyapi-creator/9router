# Start 9Router (production) if not already running, then open the dashboard.
# Used by the desktop shortcut; safe to click repeatedly while it is running.
# -NoBrowser suppresses opening the dashboard (used by tests/automation).
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

# Port precedence mirrors custom-server.js: .env PORT, else 20128.
$port = 20128
$envFile = Join-Path $repo ".env"
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern "^PORT=(\d+)" | Select-Object -First 1
    if ($m) { $port = $m.Matches[0].Groups[1].Value }
}

function Test-PortListening([int]$p) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

if (Test-PortListening $port) {
    Write-Host "9Router is already running on port $port."
} else {
    Write-Host "Starting 9Router on port $port ..."
    $logDir = Join-Path $repo "logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $cmd = "npm run start > logs\server.log 2>&1"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WorkingDirectory $repo -WindowStyle Hidden

    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        if (Test-PortListening $port) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host "Server did not come up on port $port within 60s. See logs\server.log" -ForegroundColor Red
        exit 1
    }
    Write-Host "9Router is up on port $port."
}

if (-not $NoBrowser) {
    Start-Process "http://localhost:$port/dashboard"
}
