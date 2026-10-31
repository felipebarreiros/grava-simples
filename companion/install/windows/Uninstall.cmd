@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1"
set "installer_result=%errorlevel%"
pause
exit /b %installer_result%
