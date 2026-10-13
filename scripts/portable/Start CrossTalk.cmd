@echo off
setlocal
cd /d "%~dp0"
title CrossTalk

if not exist "%~dp0runtime\node.exe" (
  echo.
  echo   This copy of CrossTalk is incomplete: runtime\node.exe is missing.
  echo   Extract the whole ZIP again, then double-click this file.
  echo.
  pause
  exit /b 1
)

"%~dp0runtime\node.exe" "%~dp0app\launch.mjs" %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo   CrossTalk stopped with an error. Read the message above, then press any key to close.
  pause >nul
)
exit /b %CODE%
