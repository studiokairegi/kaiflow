# One-time setup. Installs a per-user controller at logon; no administrator shell needed.
# The controller only binds to 127.0.0.1 and accepts the Studio Kairegi app origin.
$ErrorActionPreference = "Stop"
$workerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$legacyTask = Get-ScheduledTask -TaskName "KairFlow Intelligence Worker" -ErrorAction SilentlyContinue
if ($legacyTask) {
  throw "The older KairFlow Intelligence Worker scheduled task exists. Disable/remove that task first to avoid running two workers, then rerun this installer."
}
$manualWorker = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -match 'kairflow_intel\s+run'
}
if ($manualWorker) {
  throw "A KairFlow worker is already running. Stop it in its CMD/PowerShell window (Ctrl+C) before installing the app controller."
}
$python = Join-Path $workerDir ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  $systemPython = Get-Command python -ErrorAction SilentlyContinue
  if (-not $systemPython) {
    throw "Python was not found. Install Python or create intelligence-worker\.venv."
  }
  $python = $systemPython.Source
}
$localDir = Join-Path $env:LOCALAPPDATA "KairFlowIntelligence"
New-Item -ItemType Directory -Force $localDir | Out-Null
$envFile = Join-Path $localDir "worker.env"
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $workerDir ".env.example") $envFile
  Write-Host "Created $envFile. Fill in the agent credentials and settings before starting Emma."
}
# Keep the agent password readable only by this Windows user and local system administrators.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $localDir /inheritance:r /grant:r "$($sid):(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
$logFile = Join-Path $localDir "worker.log"
$controller = Join-Path $workerDir "controller.py"
$arguments = "`"$controller`" --worker-dir `"$workerDir`" --env-file `"$envFile`" --python `"$python`" --log-file `"$logFile`""
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $workerDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "KairFlow Local Worker Controller" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "KairFlow Local Worker Controller"
Write-Host "Installed and started the local controller. Settings: $envFile"
Write-Host "Open KairFlow > Intelligence > Settings. Use Start Emma there after completing the settings file."
