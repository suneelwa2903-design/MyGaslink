# Send-Alert.ps1 — Windows Telegram Alert
# Usage: .\Send-Alert.ps1 -Message "Your message"
# Reads credentials from .env.monitor in project root

param(
    [Parameter(Mandatory=$true)]
    [string]$Message
)

# Find .env.monitor by walking up from script location
$scriptDir  = $PSScriptRoot
$projectDir = Split-Path (Split-Path $scriptDir -Parent) -Parent
$envFile    = Join-Path $projectDir ".env.monitor"

if (-not (Test-Path $envFile)) {
    Write-Error ".env.monitor not found at $envFile"
    exit 1
}

# Parse .env.monitor
$env = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        $env[$matches[1].Trim()] = $matches[2].Trim()
    }
}

$token     = $env["TELEGRAM_BOT_TOKEN"]
$chatId    = $env["TELEGRAM_CHAT_ID"]
$project   = $env["PROJECT_NAME"]
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

if (-not $token -or -not $chatId) {
    Write-Error "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in .env.monitor"
    exit 1
}

$fullMessage = "[$project] $timestamp`n$Message"
$url         = "https://api.telegram.org/bot$token/sendMessage"
$body        = @{ chat_id = $chatId; text = $fullMessage; parse_mode = "HTML" }

try {
    $response = Invoke-RestMethod -Uri $url -Method POST -Body ($body | ConvertTo-Json) -ContentType "application/json"
    if ($response.ok) {
        Write-Host "Alert sent: $Message"
    } else {
        Write-Error "Telegram API error: $($response | ConvertTo-Json)"
        exit 1
    }
} catch {
    Write-Error "Failed to send alert: $_"
    exit 1
}
