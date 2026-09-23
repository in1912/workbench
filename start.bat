@echo off
rem Personal Workbench launcher (v1.6.3) - Windows
cd /d %~dp0
where node >nul 2>nul || (echo [ERROR] Node.js not found. Install Node.js 22 LTS from https://nodejs.org first. & pause & exit /b 1)
node -e "const v=Number(process.versions.node.split('.')[0]);if(v<22){console.error('[ERROR] Node.js 22.5+ required, current: '+process.versions.node);process.exit(1)}" || (pause & exit /b 1)
if not exist node_modules (
  echo First run: installing dependencies, please wait...
  call npm install --no-audit --no-fund
)
if not exist web\dist echo [WARN] web\dist missing. Run: npm run build:web
echo Starting Workbench at http://localhost:3000
echo Default account: admin / admin123  ^(change it in Settings after login^)
node --no-warnings server/index.js
pause
