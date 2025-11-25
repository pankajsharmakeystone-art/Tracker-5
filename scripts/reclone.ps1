param(
    [string]$RepoUrl = "https://github.com/pankajsharmakeystone-art/Tracker-5.git",
    [string]$Branch = "master",
    [string]$DestinationName,
    [switch]$CreateBackup,
    [string]$BackupName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git must be available on PATH to re-clone the repository."
}

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    throw "PSScriptRoot is unavailable. Run this script with 'pwsh -File scripts/reclone.ps1'."
}
$repoRoot = Split-Path $scriptRoot -Parent
$parentDir = Split-Path $repoRoot -Parent

if (-not $DestinationName) {
    $DestinationName = "Tracker-5-clean-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$destinationPath = Join-Path $parentDir $DestinationName

if (Test-Path $destinationPath) {
    throw "Destination path '$destinationPath' already exists. Choose a unique -DestinationName."
}

if ($CreateBackup) {
    if (-not $BackupName) {
        $BackupName = "Tracker-5-backup-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss')
    }
    $backupPath = Join-Path $parentDir $BackupName
    Write-Host "Creating backup at $backupPath ..."
    Copy-Item -Path $repoRoot -Destination $backupPath -Recurse -Force
    Write-Host "Backup created."
}

Write-Host "Cloning $RepoUrl ($Branch) into $destinationPath ..."
$cloneArgs = @("clone", "--branch", $Branch, "--origin", "origin", $RepoUrl, $destinationPath)
$gitClone = Start-Process -FilePath git -ArgumentList $cloneArgs -Wait -PassThru -NoNewWindow
if ($gitClone.ExitCode -ne 0) {
    throw "git clone failed with exit code $($gitClone.ExitCode)."
}

Write-Host "Clone completed. Fresh workspace is ready at $destinationPath" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. Close editors/terminals using the old workspace."
Write-Host "  2. Open the new folder ($DestinationName) and reinstall dependencies (npm install, etc.)."
Write-Host "  3. Recreate any untracked files such as .env or firebase key paths outside of git."
