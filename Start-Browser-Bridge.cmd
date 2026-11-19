@echo off
setlocal
set "SCRIPT=%~dp0scripts\start-chrome.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
if errorlevel 1 (
  echo.
  echo [bridge] Launch failed - see the messages above.
  pause
)
endlocal
