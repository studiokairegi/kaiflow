# Single execution wrapper for the legacy scheduled-task mode.
# Task Scheduler is the sole restart supervisor; do not create a second restart loop here.
param(
  [string]$EnvFile = "C:\ProgramData\KairFlowIntelligence\worker.env",
  [string]$Python  = (Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"),
  [string]$Dir     = (Join-Path $PSScriptRoot "..")
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $EnvFile)) { throw "Env file not found: $EnvFile (see intelligence-worker\.env.example)" }
Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $k, $v = $line.Split("=", 2)
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), "Process")
  }
}
$ollama = [Environment]::GetEnvironmentVariable("KAIRFLOW_OLLAMA_URL", "Process")
if ($ollama -and $ollama -notmatch '^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/?$') { throw "KAIRFLOW_OLLAMA_URL must point to this computer." }
Set-Location $Dir
$log = Join-Path (Split-Path $EnvFile) "worker.log"
[Environment]::SetEnvironmentVariable("KAIRFLOW_WORKER_LOG_FILE", $log, "Process")
"$(Get-Date -Format s) starting worker" | Add-Content $log
& $Python -m kairflow_intel run 2>&1 | Add-Content $log
$workerExit = $LASTEXITCODE
"$(Get-Date -Format s) worker exited with code $workerExit" | Add-Content $log
if ($workerExit -eq 73) {
  "$(Get-Date -Format s) duplicate worker detected; not restarting this instance" | Add-Content $log
  exit 0
}
exit $workerExit
