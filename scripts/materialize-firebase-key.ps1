param(
    [string]$SourcePath,
    [string]$InlineJson,
    [string]$DestinationPath,
    [switch]$SetEnv,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $SourcePath -and -not $InlineJson) {
    Write-Host "Provide either -SourcePath <service-account.json> or -InlineJson '<json>'" -ForegroundColor Yellow
    exit 1
}

if (-not $DestinationPath) {
    $DestinationPath = Join-Path $env:LOCALAPPDATA "Tracker5\firebase-service-account.json"
}

$destinationDir = Split-Path $DestinationPath -Parent
if (-not (Test-Path $destinationDir)) {
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
}

if ((Test-Path $DestinationPath) -and -not $Force) {
    throw "Destination file '$DestinationPath' already exists. Use -Force to overwrite."
}

if ($SourcePath) {
    if (-not (Test-Path $SourcePath)) {
        throw "Source path '$SourcePath' was not found."
    }
    Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
} else {
    Set-Content -Path $DestinationPath -Value $InlineJson -Encoding UTF8
}

if ($SetEnv) {
    [Environment]::SetEnvironmentVariable("FIREBASE_KEY_PATH", $DestinationPath, "User")
    $env:FIREBASE_KEY_PATH = $DestinationPath
    Write-Host "Set FIREBASE_KEY_PATH for current session and user profile." -ForegroundColor Cyan
}

Write-Host "Firebase key written to $DestinationPath" -ForegroundColor Green
Write-Host "Remember to delete the temporary file after building if the machine is shared." -ForegroundColor Yellow
