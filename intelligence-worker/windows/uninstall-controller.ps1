$ErrorActionPreference = "Stop"

$taskName = "KairFlow Local Worker Controller"
$controllerUrl = "http://127.0.0.1:17843/api/stop"
$tokenFile = Join-Path $env:LOCALAPPDATA "KairFlowIntelligence\controller.token"
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) { throw "Controller token file is missing; refusing to send an unauthenticated stop request." }
$controllerToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
if (-not $controllerToken) { throw "Controller token file is empty; refusing to send an unauthenticated stop request." }

try {
    $stopResult = Invoke-RestMethod -Uri $controllerUrl -Method Post -Headers @{ Origin = "https://app.studiokairegi.com"; Authorization = "Bearer $controllerToken" } -ContentType "application/json" -Body "{}" -TimeoutSec 15
    if ($stopResult.worker_running -or $stopResult.duplicate_worker_detected) {
        throw "A worker is still running or another worker owns the singleton lock; refusing to remove its supervisor. Resolve the worker process and retry."
    }
    Write-Host "Emma worker stop request completed."
}
catch {
    throw "Could not contact the local controller. The scheduled task was NOT removed."
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Removed the KairFlow Local Worker Controller task. Settings and logs were left intact."
