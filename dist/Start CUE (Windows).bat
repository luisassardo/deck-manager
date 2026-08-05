@echo off
REM CUE - double-click to start. Windows.
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo   CUE needs Node.js, which is not installed yet.
  echo.
  echo   Install it once from https://nodejs.org  ^(choose the LTS version^),
  echo   then double-click this file again.
  echo.
  choice /C YN /M "Open the download page now"
  if errorlevel 2 goto :end
  start "" "https://nodejs.org/en/download"
  goto :end
)

node start.mjs %*
echo.
echo   CUE has stopped. You can close this window.
pause >nul

:end
