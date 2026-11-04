# Starts the KairFlow Intelligence worker with settings from a protected env file and restarts it if it ever exits.
# Run by the scheduled task created by install-task.ps1. You can also run it by hand to test.
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
# Safety: refuse to run if Ollama is pointed anywhere but this computer.
$ollama = [Environment]::GetEnvironmentVariable("KAIRFLOW_OLLAMA_URL", "Process")
if ($ollama -and $ollama -notmatch '^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/?$') { throw "KAIRFLOW_OLLAMA_URL must be loopback, got $ollama" }
Set-Location $Dir
$log = Join-Path (Split-Path $EnvFile) "worker.log"
while ($true) {
  "$(Get-Date -Format s) starting worker" | Add-Content $log
  & $Python -m kairflow_intel run 2>&1 | Add-Content $log
  "$(Get-Date -Format s) worker exited with code $LASTEXITCODE; restarting in 20 s" | Add-Content $log
  # keep the log from growing without bound (about 5 MB)
  if ((Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
  Start-Sleep -Seconds 20
}
