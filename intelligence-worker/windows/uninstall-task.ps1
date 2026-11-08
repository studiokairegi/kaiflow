# Stop the legacy scheduled worker before removing its supervisor. Never remove a task
# while its Python child is still running; queue leases will recover any interrupted job.
$ErrorActionPreference = "Stop"
$workerTask = Get-ScheduledTask -TaskName "KairFlow Intelligence Worker" -ErrorAction SilentlyContinue
if ($workerTask -and $workerTask.State -eq "Running") {
  Stop-ScheduledTask -TaskName "KairFlow Intelligence Worker" -ErrorAction Stop
  Start-Sleep -Seconds 3
}
$orphan = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -match 'kairflow_intel\s+run'
}
if ($orphan) {
  throw "A KairFlow worker process is still running after the task stop request. The task and settings were left in place; stop the worker cleanly before retrying removal."
}
foreach ($n in "KairFlow Intelligence Worker", "KairFlow Ollama (local only)") {
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}
Remove-NetFirewallRule -DisplayName "Block Ollama inbound" -ErrorAction SilentlyContinue
Write-Host "Removed scheduled tasks. C:\ProgramData\KairFlowIntelligence (env file and logs) was left intact."
