Remove-Item -Path "HKCU:\Software\Classes\kairflow-emma" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Removed the kairflow-emma: link. The Emma switch can still pause and resume Emma while the controller is running."
