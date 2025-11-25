param(
    [string]$SourcePath,
    [string]$InlineJson,
    [string]$DestinationPath,
    [switch]$SetEnv,
    [switch]$Force,
    [string]$VercelToken,
    [string]$VercelProject,
    [string]$VercelEnvKey = "FIREBASE_SERVICE_ACCOUNT_JSON",
    [string]$HttpUrl,
    [hashtable]$HttpHeaders,
    [string]$ProviderCommand,
    [string]$RunCommand,
    [switch]$Cleanup,
    [switch]$RemoveEnvOnCleanup
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

function Get-JsonFromHttp {
    param(
        [string]$Url,
        [hashtable]$Headers
    )

    if (-not $Url) { return $null }
    $response = Invoke-WebRequest -Method Get -Uri $Url -Headers $Headers -UseBasicParsing
    return $response.Content
}

function Get-JsonFromCommand {
    param(
        [string]$Command
    )

    if (-not $Command) { return $null }
    $output = Invoke-Expression $Command
    if ($output -is [array]) {
        return ($output | Out-String).Trim()
    }
    return [string]$output
}

if (-not $SourcePath -and -not $InlineJson -and -not $VercelToken -and -not $HttpUrl -and -not $ProviderCommand) {
    Write-Host "Provide -SourcePath, -InlineJson, Vercel inputs, -HttpUrl, or -ProviderCommand." -ForegroundColor Yellow
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

if (-not $InlineJson -and $HttpUrl) {
    $InlineJson = Get-JsonFromHttp -Url $HttpUrl -Headers $HttpHeaders
}

if (-not $InlineJson -and $ProviderCommand) {
    $InlineJson = Get-JsonFromCommand -Command $ProviderCommand
}

if (-not $InlineJson -and -not $SourcePath) {
    throw "Unable to resolve Firebase service account JSON from provided inputs."
}

$destinationDir = Split-Path $DestinationPath -Parent
if (-not (Test-Path $destinationDir)) {
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
}

$destinationEqualsSource = $false
if ($SourcePath) {
    if (-not (Test-Path $SourcePath)) {
        throw "Source path '$SourcePath' was not found."
    }
    if ((Resolve-Path $SourcePath) -eq (Resolve-Path $DestinationPath)) {
        $destinationEqualsSource = $true
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

$commandExitCode = 0
try {
    Write-Host "Firebase key ready at $DestinationPath" -ForegroundColor Green

    if ($RunCommand) {
        Write-Host "Running command: $RunCommand" -ForegroundColor Cyan
        $LASTEXITCODE = 0
        Invoke-Expression $RunCommand
        $commandExitCode = $LASTEXITCODE
        if ($commandExitCode -ne 0) {
            throw "Command failed with exit code $commandExitCode"
        }
    } else {
        Write-Host "No command specified. Remember to delete the temporary file if necessary." -ForegroundColor Yellow
    }
}
finally {
    if ($Cleanup -and -not $destinationEqualsSource -and (Test-Path $DestinationPath)) {
        Remove-Item -LiteralPath $DestinationPath -Force
        Write-Host "Cleaned up $DestinationPath" -ForegroundColor Yellow
    }
    if ($Cleanup -and $SetEnv) {
        if ($RemoveEnvOnCleanup) {
            [Environment]::SetEnvironmentVariable("FIREBASE_KEY_PATH", $null, "User")
            Remove-Item Env:FIREBASE_KEY_PATH -ErrorAction SilentlyContinue
            Write-Host "Cleared FIREBASE_KEY_PATH." -ForegroundColor Yellow
        } else {
            Write-Host "FIREBASE_KEY_PATH still points to $DestinationPath (file removed)." -ForegroundColor Yellow
        }
    }
}

if ($RunCommand) {
    exit $commandExitCode
}
