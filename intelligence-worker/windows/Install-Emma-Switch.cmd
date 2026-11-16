@echo off
rem Double-click this once. It lets the Emma switch in KairFlow turn Emma back on after you switch her fully off.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-launcher.ps1"
echo.
pause
