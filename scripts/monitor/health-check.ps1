# health-check.ps1 — Windows local health check
# Runs on Windows Task Scheduler every 5 minutes
# For Linux server health checks, use health-check.sh (SSH/deployed)

$scriptDir  = $PSScriptRoot
$projectDir = Split-Path (Split-Path $scriptDir -Parent) -Parent
$envFile    = Join-Path $projectDir ".env.monitor"
$alertScript = Join-Path $scriptDir "..\alerts\Send-Alert.ps1"
$logFile    = Join-Path $projectDir "logs\monitor\health.log"

# Ensure log dir exists
New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null

# Parse .env.monitor
$env = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $env[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
}

$errors = 0

function Send-Alert-Message($msg) {
    & $alertScript -Message $msg 2>$null
}

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'): $msg"
    Add-Content $logFile $line
}

# ── 1. API Health Check ────────────────────────────────────────────────
if ($env["SERVICE_URL"]) {
    try {
        $resp = Invoke-WebRequest -Uri "$($env.SERVICE_URL)/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -ne 200) {
            Send-Alert-Message "🔴 API DOWN — $($env.SERVICE_URL) returned HTTP $($resp.StatusCode)"
            $errors++
        }
    } catch {
        Send-Alert-Message "🔴 API UNREACHABLE — $($env.SERVICE_URL)`n$_"
        $errors++
    }
}

# ── 2. Disk Usage ──────────────────────────────────────────────────────
$threshold = if ($env["DISK_THRESHOLD"]) { [int]$env["DISK_THRESHOLD"] } else { 80 }
$drive     = Split-Path $projectDir -Qualifier
$disk      = Get-PSDrive ($drive.TrimEnd(':'))

if ($disk) {
    $usedPct = [math]::Round(($disk.Used / ($disk.Used + $disk.Free)) * 100)
    if ($usedPct -gt $threshold) {
        Send-Alert-Message "⚠️ DISK HIGH — ${drive} at ${usedPct}% (threshold: ${threshold}%)"
        $errors++
    }
}

# ── 3. Process Check (optional) ───────────────────────────────────────
if ($env["REQUIRED_PROCESS"]) {
    $proc = Get-Process -Name $env["REQUIRED_PROCESS"] -ErrorAction SilentlyContinue
    if (-not $proc) {
        Send-Alert-Message "🔴 PROCESS DOWN — $($env.REQUIRED_PROCESS) not running"
        $errors++
    }
}

Write-Log "Health check: $errors issues found"
exit $errors
