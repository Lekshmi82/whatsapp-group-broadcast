@echo off
title WhatsApp Panel (keep this window open)
cd /d "%~dp0"
where node >/dev/null 2>/dev/null || (echo Node.js is not installed. Install the LTS version from https://nodejs.org first. & pause & exit /b 1)
if not exist node_modules (echo First start: running setup... & call "%~dp0Setup.bat")
node panel\server.js
echo.
echo The panel has stopped.
pause
