@echo off
rem ===========================================================================
rem  start.cmd - single entry point for Claude Free Proxy
rem
rem    start.cmd             local mode   (127.0.0.1 only)
rem    start.cmd lan         LAN mode     (other devices can connect)
rem    start.cmd pack        package for another computer
rem
rem  This file is ASCII-only on purpose: cmd.exe decodes the script with the
rem  console codepage, so non-ASCII content here corrupts parsing. All Chinese
rem  UI text lives in start.mjs (Node outputs UTF-8, which chcp 65001 handles).
rem ===========================================================================
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install Node.js 22.19 or newer:  https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node start.mjs %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" if "%~1"=="" pause
exit /b %RC%
