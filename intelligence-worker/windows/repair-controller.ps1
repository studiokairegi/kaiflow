# Repairs the controller-mode worker environment without changing worker.env.
# Run from an ordinary PowerShell in the repository's intelligence-worker folder.
$ErrorActionPreference = "Stop"
$workerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venv = Join-Path $workerDir ".venv"
$python = Join-Path $venv "Scripts\python.exe"
$systemPython = Get-Command python -ErrorAction SilentlyContinue
if (-not $systemPython) { throw "Python was not found on PATH." }

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  Write-Host "Creating $venv"
  & $systemPython.Source -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "Could not create the worker virtual environment." }
}

Write-Host "Installing worker dependencies..."
& $python -m pip install --disable-pip-version-check -r (Join-Path $workerDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

$envFile = Join-Path $env:LOCALAPPDATA "KairFlowIntelligence\worker.env"
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  throw "worker.env not found at $envFile"
}

$required = @(
  "KAIRFLOW_SUPABASE_URL",
  "KAIRFLOW_SUPABASE_ANON_KEY",
  "KAIRFLOW_AGENT_EMAIL",
  "KAIRFLOW_AGENT_PASSWORD"
)
$values = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $k, $v = $line.Split("=", 2)
    $values[$k.Trim()] = $v.Trim()
  }
}
foreach ($name in $required) {
  if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
    throw "$name is missing or empty in $envFile"
  }
}

Write-Host "OK: worker.env contains the required settings (secret values were not printed)."
Write-Host "OK: isolated worker Python: $python"
Write-Host "Next: stop the existing KairFlow controller/worker, then rerun install-controller.ps1 from this repository if needed."
