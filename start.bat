@echo off
setlocal
cd /d "%~dp0"
set "TEACHER_PASSWORD=Admin#1234"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with the npm package manager enabled.
  pause
  exit /b 1
)

if not exist node_modules\qrcode\package.json goto installDependencies
if not exist node_modules\@netlify\blobs\package.json goto installDependencies
goto startServer

:installDependencies
  echo Installing project dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )

:startServer

call npm.cmd start
if errorlevel 1 (
  echo The attendance app could not start. Check whether port 3001 is already in use.
  pause
  exit /b 1
)

pause
