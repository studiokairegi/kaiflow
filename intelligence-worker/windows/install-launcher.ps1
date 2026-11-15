# One-time, no administrator needed. Registers the per-user "kairflow-emma:" link so the Emma switch in KairFlow can turn the controller back
# on after it was switched off completely (a web page cannot start a program that is not running).
# The link is only able to run launcher.ps1, which only starts the installed controller task. Remove with uninstall-launcher.ps1.
$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "launcher.ps1"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "launcher.ps1 was not found next to this script." }
$key = "HKCU:\Software\Classes\kairflow-emma"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(default)" -Value "URL:KairFlow Emma"
New-ItemProperty -Path $key -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "$key\shell\open\command" -Force | Out-Null
$command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
Set-ItemProperty -Path "$key\shell\open\command" -Name "(default)" -Value $command
Write-Host "Done. The Emma switch in KairFlow can now turn Emma on again after a full shutdown."
Write-Host "The first time, your browser may ask to open this link: choose 'Always allow'."
