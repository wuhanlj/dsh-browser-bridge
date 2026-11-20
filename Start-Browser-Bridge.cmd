@echo off
setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%scripts\start-chrome.ps1" %*
if errorlevel 1 (
  echo.
  echo [bridge] Chrome launcher reported a problem - see the messages above.
  pause
)
echo.
echo [bridge] Starting the 360 browser for qianwen/deepseek...
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%scripts\start-360.ps1" %*
if errorlevel 1 (
  echo.
  echo [bridge] 360 launcher reported a problem - see the messages above.
)
endlocal
