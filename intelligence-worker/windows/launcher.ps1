# Started by the "Turn Emma on" switch in KairFlow (through the kairflow-emma: link registered by install-launcher.ps1).
# It does exactly one thing: start the already-installed controller task if it is not running. It reads no input from the web page.
$ErrorActionPreference = "SilentlyContinue"
$taskName = "KairFlow Local Worker Controller"
$task = Get-ScheduledTask -TaskName $taskName
if ($task -and $task.State -ne "Running") { Start-ScheduledTask -TaskName $taskName }
