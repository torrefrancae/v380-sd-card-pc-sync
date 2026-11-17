@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo Install ffmpeg and add it to PATH, then run this file again.
  echo https://www.gyan.dev/ffmpeg/builds/
  pause
  exit /b 1
)
if not exist node_modules call npm install
call npx tsx src/server.ts
pause
