@echo off
rem ============================================================
rem  CC-LIGHT / Agent light - INSTALL
rem  Put this file in the same folder as daemon.py (the cc-light
rem  folder from the zip), then double-click.
rem  Does: 1) find Python  2) pip install bleak (if missing)
rem        3) register logon autostart task "CC-Light-Daemon"
rem        4) start the daemon now  5) optionally install
rem           Claude Code hooks (needs Node.js)
rem ============================================================
setlocal
cd /d "%~dp0"
echo === Agent light installer ===
echo.

rem ---- 1. find pythonw ----
set "PYW="
where pythonw >nul 2>nul && for /f "delims=" %%i in ('where pythonw') do set "PYW=%%i"
if not defined PYW (
  if exist "C:\Users\W\AppData\Local\Programs\Python\Python312\pythonw.exe" set "PYW=C:\Users\W\AppData\Local\Programs\Python\Python312\pythonw.exe"
)
if not defined PYW (
  echo [X] pythonw not found. Install Python 3.12+ first, then run this again.
  pause & exit /b 1
)
echo [1/5] Python found: %PYW%

rem ---- 2. bleak dependency (check with console python) ----
set "PY=%PYW:pythonw.exe=python.exe%"
"%PY%" -c "import bleak" >nul 2>nul
if errorlevel 1 (
  echo [2/5] Installing bleak ...
  "%PY%" -m pip install -q bleak
  "%PY%" -c "import bleak" >nul 2>nul || (echo [X] bleak install failed, check network. & pause & exit /b 1)
) else (
  echo [2/5] bleak OK
)

rem ---- 3. register logon autostart task ----
schtasks /Create /F /TN "CC-Light-Daemon" /TR "\"%PYW%\" \"%~dp0daemon.py\"" /SC ONLOGON /RL LIMITED >nul
if errorlevel 1 (
  echo [!] schtasks failed, will still try to start the daemon now.
) else (
  echo [3/5] Autostart task registered: CC-Light-Daemon
)

rem ---- 4. start daemon now ----
tasklist /FI "IMAGENAME eq pythonw.exe" | find /i "pythonw" >nul && netstat -ano | find "127.0.0.1:7878" >nul && (
  echo [4/5] Daemon seems already running.
) || (
  start "" "%PYW%" "%~dp0daemon.py"
  echo [4/5] Daemon started.
)

rem ---- 5. Claude Code hooks (optional, needs Node.js) ----
where node >nul 2>nul
if errorlevel 1 (
  echo [5/5] Node.js not found, skip Claude Code hooks.
) else (
  set /p HOOKS=Also install Claude Code hooks? [Y/N]:
  if /i "%HOOKS%"=="Y" node "%~dp0install-hooks.js"
)

echo.
echo === Verifying (wait 8s) ===
timeout /t 8 /nobreak >nul
if exist daemon.log (
  echo ---- last lines of daemon.log ----
  powershell -NoProfile -Command "Get-Content -Path 'daemon.log' -Tail 4"
  echo ---------------------------------
  findstr /C:"BLE connected" daemon.log >nul && echo [OK] Connected to board "Agent light".
)
echo.
echo Done. The light is now following Claude Code (new claude sessions only).
echo Uninstall: double-click cc-light-uninstall.cmd
pause
