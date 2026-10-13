@echo off
setlocal
cd /d "%~dp0"
title CrossTalk

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   CrossTalk needs Node.js 22 or newer, but Node.js was not found.
  echo   Install the current LTS release from https://nodejs.org/
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\launch.mjs" %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo   CrossTalk stopped with an error. Read the message above, then press any key to close.
  pause >nul
)
exit /b %CODE%
