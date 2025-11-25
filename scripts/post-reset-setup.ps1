param(
    [switch]$InstallNpm,
    [switch]$InstallFunctions,
    [switch]$InstallElectron,
    [switch]$GenerateEnv,
    [string]$EnvTemplate = ".env.example",
    [string]$EnvTarget = ".env.local"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $repoRoot

function Run-Step($label, [ScriptBlock]$action) {
    Write-Host "--- $label ---" -ForegroundColor Cyan
    & $action
    Write-Host "✓ $label complete" -ForegroundColor Green
}

if ($InstallNpm) {
    Run-Step "npm install (root)" { npm install }
}

if ($InstallElectron) {
    $electronDir = Join-Path $repoRoot "electron"
    Run-Step "npm install (electron)" { pushd $electronDir; npm install; popd }
}

if ($InstallFunctions) {
    $functionsDir = Join-Path $repoRoot "functions"
    Run-Step "npm install (functions)" { pushd $functionsDir; npm install; popd }
}

if ($GenerateEnv) {
    if (-not (Test-Path $EnvTemplate)) {
        throw "Env template '$EnvTemplate' not found."
    }
    if (Test-Path $EnvTarget) {
        Write-Host "Env target '$EnvTarget' already exists; skipping copy." -ForegroundColor Yellow
    } else {
        Copy-Item $EnvTemplate $EnvTarget
        Write-Host "Created $EnvTarget from $EnvTemplate. Update secrets manually." -ForegroundColor Green
    }
}
