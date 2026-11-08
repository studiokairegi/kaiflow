# One-time setup, run in an ADMINISTRATOR PowerShell. Creates:
#   * a protected folder + env file template for the worker settings (readable only by SYSTEM and Administrators)
#   * a scheduled task that starts the worker at every boot (no login needed) and restarts it if it fails
#   * (optional) a task that starts Ollama at boot bound to this computer only, and a firewall rule blocking port 11434 inbound
# It does NOT start any email sending: sending stays OFF until you turn it on inside KairFlow.
param([switch]$ManageOllama, [string]$OllamaExe = "C:\Users\$env:USERNAME\AppData\Local\Programs\Ollama\ollama.exe")
$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run this in an Administrator PowerShell." }
$controllerTask = Get-ScheduledTask -TaskName "KairFlow Local Worker Controller" -ErrorAction SilentlyContinue
if ($controllerTask) { throw "The KairFlow Local Worker Controller task exists. Remove that controller installation before installing the legacy scheduled-worker mode." }
$nssmService = Get-Service -Name "KairFlowIntelligence" -ErrorAction SilentlyContinue
if ($nssmService) { throw "The KairFlowIntelligence NSSM service exists. Remove that service before installing scheduled-worker mode." }
$pythonProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^python(w)?\.exe$' }
$runningWorker = $pythonProcesses | Where-Object { $_.CommandLine -match 'kairflow_intel\s+run' }
$runningController = $pythonProcesses | Where-Object { $_.CommandLine -match 'controller\.py' }
if ($runningWorker -or $runningController) { throw "A KairFlow worker or controller is already running. Stop it before installing scheduled-worker mode." }
$dir = "C:\ProgramData\KairFlowIntelligence"; $envFile = Join-Path $dir "worker.env"
New-Item -ItemType Directory -Force $dir | Out-Null
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $PSScriptRoot "..\.env.example") $envFile
  Write-Host "Created $envFile. Fill in the values (the agent password goes here, nowhere else), then save."
}
# Only SYSTEM and Administrators may read the file that holds the agent password.
icacls $dir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

$python = Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"
$python = [System.IO.Path]::GetFullPath($python)
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "External Python not found: $python" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\run-worker.ps1`" -EnvFile `"$envFile`" -Python `"$python`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "KairFlow Intelligence Worker" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Task 'KairFlow Intelligence Worker' registered (starts at boot, restarts on failure)."

if ($ManageOllama) {
  if (-not (Test-Path $OllamaExe)) { throw "Ollama not found at $OllamaExe. Pass -OllamaExe with the right path." }
  $oa = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c set OLLAMA_HOST=127.0.0.1:11434 && `"$OllamaExe`" serve"
  Register-ScheduledTask -TaskName "KairFlow Ollama (local only)" -Action $oa -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  if (-not (Get-NetFirewallRule -DisplayName "Block Ollama inbound" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "Block Ollama inbound" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Block | Out-Null
  }
  Write-Host "Ollama will start at boot on 127.0.0.1 only; inbound port 11434 is blocked."
}
Write-Host "Test now:  Start-ScheduledTask -TaskName 'KairFlow Intelligence Worker'   then read $dir\worker.log"
