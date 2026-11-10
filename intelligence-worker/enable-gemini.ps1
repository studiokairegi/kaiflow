# Run from an elevated (Administrator) PowerShell:
#   cd <path>\intelligence-worker ; .\enable-gemini.ps1
# Prompts for the Gemini key (hidden), saves it to worker.env, runs the Gemini selftest, restarts the worker task.
param(
  [string]$EnvFile = "C:\ProgramData\KairFlowIntelligence\worker.env",
  [string]$Dir     = $PSScriptRoot
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $EnvFile)) { throw "Env file not found: $EnvFile" }

$sec = Read-Host "Paste Gemini API key" -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
if (-not $key) { throw "No key entered." }

# Replace any existing key line, otherwise append. The key is never printed.
$lines = @(Get-Content $EnvFile | Where-Object { $_ -notmatch '^\s*KAIRFLOW_GEMINI_API_KEY\s*=' })
$lines += "KAIRFLOW_GEMINI_API_KEY=$key"
Set-Content -Path $EnvFile -Value $lines -Encoding UTF8
Write-Host "Saved key to $EnvFile"

# Load worker.env into this process, same as run-worker.ps1, then run the selftest.
Get-Content $EnvFile | ForEach-Object {
  $l = $_.Trim()
  if ($l -and -not $l.StartsWith("#") -and $l.Contains("=")) {
    $k, $v = $l.Split("=", 2); [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), "Process")
  }
}
Set-Location $Dir
& (Join-Path $Dir ".venv\Scripts\python.exe") -m kairflow_intel selftest gemini
if ($LASTEXITCODE -ne 0) { Write-Host "Selftest failed. Key saved but worker NOT restarted. Send me the FAIL line (it contains no key)."; exit 1 }

$t = Get-ScheduledTask -TaskName "KairFlow Intelligence Worker" -ErrorAction SilentlyContinue
if ($t) {
  Stop-ScheduledTask  -TaskName "KairFlow Intelligence Worker" -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName "KairFlow Intelligence Worker"
  Write-Host "Worker task restarted."
} else {
  Write-Host "No scheduled task found. Restart the worker from the app: Settings > Stop Emma / Start Emma."
}
