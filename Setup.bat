@echo off
title WhatsApp Panel - setup
cd /d "%~dp0"
where node >/dev/null 2>/dev/null || (echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
echo Installing what the panel needs (first time only, a few minutes)...
call npm install || goto :fail
echo Downloading the Chrome browser the panel uses...
call npx puppeteer browsers install chrome || goto :fail
echo.
echo Setup finished. Double-click "Start WhatsApp Panel.bat" to open the panel.
pause
exit /b 0
:fail
echo.
echo Setup failed. Copy the red text above and ask for help.
pause
exit /b 1
