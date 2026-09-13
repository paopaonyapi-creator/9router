# Stop the 9Router server started by start-9router.ps1 (or any server on its port).
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

$port = 20128
$envFile = Join-Path $repo ".env"
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern "^PORT=(\d+)" | Select-Object -First 1
    if ($m) { $port = $m.Matches[0].Groups[1].Value }
}

$conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "9Router is not running (nothing listening on port $port)."
    exit 0
}

$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "node") {
        Stop-Process -Id $procId -Force
        Write-Host "Stopped 9Router (pid $procId)."
    } else {
        $name = if ($proc) { $proc.ProcessName } else { "unknown" }
        Write-Host "Port $port is held by $name (pid $procId) - not a node process, leaving it alone." -ForegroundColor Yellow
    }
}
