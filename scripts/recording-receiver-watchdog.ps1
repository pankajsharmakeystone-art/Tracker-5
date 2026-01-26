param(
    [string]$ReceiverUrl = $env:RECORDING_RECEIVER_HEALTH_URL,
    [int]$IntervalSeconds = 60,
    [int]$TimeoutSeconds = 5
)

if (-not $ReceiverUrl -or $ReceiverUrl.Trim().Length -eq 0) {
    $ReceiverUrl = "http://localhost:5055/health"
}

$ScriptRoot = $PSScriptRoot
$ReceiverScript = Join-Path $ScriptRoot "recording-receiver.js"
$PidFile = Join-Path $ScriptRoot "recording-receiver.pid"

function Start-Receiver {
    if (-not (Test-Path $ReceiverScript)) {
        Write-Host "[watchdog] Receiver script not found: $ReceiverScript"
        return $false
    }

    Write-Host "[watchdog] Starting receiver..."
    $process = Start-Process -FilePath "node" -ArgumentList @($ReceiverScript) -PassThru -WindowStyle Hidden
    if ($process -and $process.Id) {
        Set-Content -Path $PidFile -Value $process.Id
        Write-Host "[watchdog] Receiver started with PID $($process.Id)"
        return $true
    }

    Write-Host "[watchdog] Failed to start receiver."
    return $false
}

function Stop-Receiver {
    if (-not (Test-Path $PidFile)) {
        return
    }

    $pid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($pid) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "[watchdog] Stopping receiver PID $pid"
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
    }

    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Test-Health {
    try {
        $response = Invoke-WebRequest -Uri $ReceiverUrl -Method GET -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

Write-Host "[watchdog] Monitoring $ReceiverUrl (interval: $IntervalSeconds s, timeout: $TimeoutSeconds s)"

while ($true) {
    $healthy = Test-Health

    if (-not $healthy) {
        Write-Host "[watchdog] Health check failed. Restarting receiver..."
        Stop-Receiver
        Start-Receiver | Out-Null
    }

    Start-Sleep -Seconds $IntervalSeconds
}
