# Shared desktop-launcher checks. Only an absolute script argument proves ownership.
function Get-9RouterPort([string]$Repo) {
    $port = 20128
    $envFile = Join-Path $Repo ".env"
    if (Test-Path -LiteralPath $envFile) {
        # Read only PORT; never include .env contents in an error or log.
        foreach ($line in [System.IO.File]::ReadLines($envFile)) {
            if ($line -match '^\s*(?:export\s+)?PORT\s*=\s*(.*?)\s*$') {
                $value = ($Matches[1] -split '#', 2)[0].Trim().Trim('"', "'")
                if ($value -notmatch '^\d+$' -or -not [int]::TryParse($value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
                    throw "PORT in .env must be an integer between 1 and 65535."
                }
                return $port
            }
        }
    }
    return $port
}

function Test-9RouterProcessOwnership($ProcessInfo, [string]$Repo) {
    if (-not $ProcessInfo -or $ProcessInfo.Name -ine 'node.exe' -or -not $ProcessInfo.CommandLine) {
        return $false
    }
    $entrypoint = [System.IO.Path]::GetFullPath((Join-Path $Repo 'custom-server.js'))
    $escaped = [regex]::Escape($entrypoint)
    $scriptArgument = '"' + $escaped + '"'
    if ($entrypoint -notmatch '\s') { $scriptArgument += '|' + $escaped }
    # Match the first script argument, not a path in --eval, another argument or a suffix.
    return $ProcessInfo.CommandLine -imatch ('^\s*(?:"[^"]+"|[^\s"]+)\s+(?:' + $scriptArgument + ')(?:\s|$)')
}

function Get-9RouterListeners([int]$Port, [string]$Repo) {
    $connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port)
    foreach ($processId in @($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        [pscustomobject]@{
            ProcessId = $processId
            Owned = Test-9RouterProcessOwnership $info $Repo
            CreationDate = if ($info) { $info.CreationDate } else { $null }
        }
    }
}

function Stop-9RouterOwnedProcess($Listener, [string]$Repo) {
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($Listener.ProcessId)" -ErrorAction SilentlyContinue
    if (-not $info) { return $true }
    if (-not $Listener.Owned -or -not $Listener.CreationDate -or
        $info.CreationDate -ne $Listener.CreationDate -or -not (Test-9RouterProcessOwnership $info $Repo)) {
        return $false
    }
    $process = Get-Process -Id $Listener.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { return $true }
    # Compare the process object too, so a recycled PID between the two lookups is refused.
    # CIM stores microseconds; Process.StartTime may retain an extra 100ns digit.
    $startStamp = $process.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff')
    $infoStamp = $info.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff')
    if ($startStamp -ne $infoStamp) { return $false }
    Stop-Process -InputObject $process -Force -ErrorAction Stop
    return $true
}
