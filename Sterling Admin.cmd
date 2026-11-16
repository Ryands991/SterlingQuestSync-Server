@echo off
rem Opens Sterling Admin, the owner's tool for this server. Runs only on this PC.
cd /d "%~dp0"
where node >NUL 2>NUL || (echo Node.js is missing. Install it from nodejs.org, then try again. & pause & exit /b 1)
if not exist node_modules (call npm install || goto :fail)
call npm run --silent admin-ui || goto :fail
exit /b 0
:fail
echo Something failed above. Copy this window to Claude.
pause
exit /b 1
