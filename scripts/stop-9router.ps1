# Stop only the verified 9Router server belonging to this checkout.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'launcher-common.ps1')

$port = Get-9RouterPort $repo
$listeners = @(Get-9RouterListeners $port $repo)
if (-not $listeners.Count) {
    Write-Host "9Router is not running (nothing listening on port $port)."
    exit 0
}

$unverified = $false
foreach ($listener in $listeners) {
    if (Stop-9RouterOwnedProcess $listener $repo) {
        Write-Host "Stopped 9Router (pid $($listener.ProcessId))."
    } else {
        $unverified = $true
        Write-Host "Port $port is held by a process that cannot be verified as this checkout's 9Router (pid $($listener.ProcessId)). Leaving it alone." -ForegroundColor Yellow
    }
}
if ($unverified) { exit 1 }
