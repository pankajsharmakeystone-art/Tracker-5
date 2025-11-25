param(
    [string]$SourcePath,
    [string]$InlineJson,
    [string]$DestinationPath,
    [switch]$SetEnv,
    [switch]$Force,
    [string]$VercelToken,
    [string]$VercelProject,
    [string]$VercelEnvKey = "FIREBASE_SERVICE_ACCOUNT_JSON"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-JsonFromVercel {
    param(
        [string]$Token,
        [string]$Project,
        [string]$EnvKey
    )

    if (-not $Token -or -not $Project) {
        return $null
    }

    $headers = @{ "Authorization" = "Bearer $Token" }
    $url = "https://api.vercel.com/v10/projects/$Project/env?decrypt=true"
    $response = Invoke-RestMethod -Method Get -Uri $url -Headers $headers
    $match = $response.env | Where-Object { $_.key -eq $EnvKey }
    if ($match) {
        return $match.value
    }
    throw "Env key '$EnvKey' not found in Vercel project $Project."
}

if (-not $SourcePath -and -not $InlineJson -and -not $VercelToken) {
    Write-Host "Provide -SourcePath, -InlineJson, or Vercel credentials (-VercelToken/-VercelProject)." -ForegroundColor Yellow
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

if (-not $InlineJson -and $VercelToken) {
    if (-not $VercelProject) {
        throw "When using -VercelToken you must also pass -VercelProject (the project slug)."
    }
    $InlineJson = Get-JsonFromVercel -Token $VercelToken -Project $VercelProject -EnvKey $VercelEnvKey
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
