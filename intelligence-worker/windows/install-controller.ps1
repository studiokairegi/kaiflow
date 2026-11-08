# One-time setup. Installs a per-user controller at logon; no administrator shell needed.
# The controller only binds to 127.0.0.1 and accepts the Studio Kairegi app origin.
$ErrorActionPreference = "Stop"
$workerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$legacyTask = Get-ScheduledTask -TaskName "KairFlow Intelligence Worker" -ErrorAction SilentlyContinue
if ($legacyTask) {
  throw "The older KairFlow Intelligence Worker scheduled task exists. Disable/remove that task first to avoid running two workers, then rerun this installer."
}
$nssmService = Get-Service -Name "KairFlowIntelligence" -ErrorAction SilentlyContinue
if ($nssmService) { throw "The KairFlowIntelligence NSSM service exists. Remove that service before installing controller mode." }
$pythonProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^python(w)?\.exe$' }
$manualWorker = $pythonProcesses | Where-Object { $_.CommandLine -match 'kairflow_intel\s+run' }
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
$tokenFile = Join-Path $localDir "controller.token"
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf) -or (Get-Item -LiteralPath $tokenFile -ErrorAction SilentlyContinue).Length -lt 43) {
  $tokenBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
  [System.IO.File]::WriteAllText($tokenFile, [Convert]::ToBase64String($tokenBytes), [System.Text.Encoding]::ASCII)
  [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
}
# The controller credential is readable only by this Windows user and local administrators.
icacls $tokenFile /inheritance:r /grant:r "$($sid):(R)" "SYSTEM:(F)" "Administrators:(F)" | Out-Null
$controller = Join-Path $workerDir "controller.py"
$existingControllerTask = Get-ScheduledTask -TaskName "KairFlow Local Worker Controller" -ErrorAction SilentlyContinue
if ($existingControllerTask -and $existingControllerTask.State -eq "Running") {
  $controllerToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:17843/api/stop" -Method Post `
      -Headers @{ Origin = "https://app.studiokairegi.com"; Authorization = "Bearer $controllerToken" } `
      -ContentType "application/json" -Body "{}" -TimeoutSec 15
  }
  catch { throw "The existing controller did not accept an authenticated stop request. It was left running; stop it safely before reinstalling." }
  Stop-ScheduledTask -TaskName "KairFlow Local Worker Controller" -ErrorAction Stop
  Start-Sleep -Seconds 2
}
$manualController = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -match 'controller\.py'
}
if ($manualController) { throw "A local KairFlow controller process is already running. Stop it before installing the scheduled controller." }
$arguments = "`"$controller`" --worker-dir `"$workerDir`" --env-file `"$envFile`" --python `"$python`" --log-file `"$logFile`" --token-file `"$tokenFile`""
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $workerDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "KairFlow Local Worker Controller" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "KairFlow Local Worker Controller"
Write-Host "Installed and started the local controller. Worker settings: $envFile"
Write-Host "Local controller token file: $tokenFile"
Write-Host "Paste the contents of controller.token into KairFlow > Intelligence > Settings. Keep this token private; it controls the local worker."
Write-Host "Use Start Emma there after completing the worker settings file."
