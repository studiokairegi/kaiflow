$ErrorActionPreference = "Stop"
$ErrorActionPreference = "Stop"

$taskName = "KairFlow Local Worker Controller"
$controllerUrl = "http://127.0.0.1:17843/api/stop"

try {
    $null = Invoke-RestMethod -Uri $controllerUrl -Method Post -Headers @{ Origin = "https://app.studiokairegi.com" } -ContentType "application/json" -Body "{}" -TimeoutSec 15
    Write-Host "Emma worker stop request completed."
}
catch {
    throw "Could not contact the local controller. The scheduled task was NOT removed."
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Removed the KairFlow Local Worker Controller task. Settings and logs were left intact."
