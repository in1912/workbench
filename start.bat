@echo off
rem QuanGe Workbench launcher
cd /d %~dp0
echo Starting QuanGe Workbench: http://localhost:3000
node --no-warnings server/index.js
pause
