# Removes the scheduled tasks (and the firewall rule). Leaves C:\ProgramData\KairFlowIntelligence (your env file and log) in place.
foreach ($n in "KairFlow Intelligence Worker", "KairFlow Ollama (local only)") { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue }
Remove-NetFirewallRule -DisplayName "Block Ollama inbound" -ErrorAction SilentlyContinue
Write-Host "Removed."
