# Start 9Router (production) if not already running, then open the dashboard.
# Used by the desktop shortcut; safe to click repeatedly while it is running.
# -NoBrowser suppresses opening the dashboard (used by tests/automation).
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'launcher-common.ps1')

# Desktop default: .env PORT, else 20128; pass it explicitly to custom-server.js.
$port = Get-9RouterPort $repo
$hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $lockKey = [System.IO.Path]::GetFullPath($repo).ToUpperInvariant() + ':' + $port
    $lockHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($lockKey))).Replace('-', '')
} finally { $hasher.Dispose() }
$startupLock = [System.Threading.Mutex]::new($false, ('Local\9RouterLauncher-' + $lockHash))
$lockAcquired = $false
try {
    try { $lockAcquired = $startupLock.WaitOne(60000) }
    catch [System.Threading.AbandonedMutexException] { $lockAcquired = $true }
    if (-not $lockAcquired) { throw "Another 9Router launcher is still starting this checkout. Try again after it finishes." }

    # Recheck inside the lock so double-clicks during startup cannot launch twice.
    $listeners = @(Get-9RouterListeners $port $repo)
    if (@($listeners | Where-Object { -not $_.Owned }).Count) {
        Write-Host "Port $port is occupied by a process that cannot be verified as this checkout's 9Router. Leaving it alone." -ForegroundColor Yellow
        exit 1
    }

    if ($listeners.Count) {
        Write-Host "9Router is already running on port $port."
    } else {
        Write-Host "Starting 9Router on port $port ..."
        $logDir = Join-Path $repo "logs"
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $entrypoint = Join-Path $repo 'custom-server.js'
        $server = Start-Process -FilePath $node -ArgumentList ('"{0}" --port {1}' -f $entrypoint, $port) -WorkingDirectory $repo -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server-error.log')

        $ok = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 1
            $listeners = @(Get-9RouterListeners $port $repo)
            if (@($listeners | Where-Object { -not $_.Owned }).Count) {
                Write-Host "Port $port was taken by an unverified process. Leaving it alone." -ForegroundColor Yellow
                exit 1
            }
            if ($listeners.Count) { $ok = $true; break }
            if ($server.HasExited) { break }
        }
        if (-not $ok) {
            Write-Host "Server did not come up on port $port. See logs\server.log and logs\server-error.log." -ForegroundColor Red
            exit 1
        }
        Write-Host "9Router is up on port $port."
    }

    if (-not $NoBrowser) {
        Start-Process "http://localhost:$port/dashboard"
    }
} finally {
    if ($lockAcquired) { $startupLock.ReleaseMutex() }
    $startupLock.Dispose()
}
