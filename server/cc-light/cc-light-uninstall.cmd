@echo off
rem ============================================================
rem  CC-LIGHT / Agent light - UNINSTALL
rem  Put this file in the same folder as daemon.py, double-click.
rem  Does: 1) turn board off  2) stop running daemon
rem        3) delete autostart task "CC-Light-Daemon"
rem        4) remove Claude Code / Codex / WorkBuddy / CodeBuddy / Cursor /
rem           DeepSeek Harness / Hermes / Gemini CLI / Qwen Code hooks
rem  The folder itself can be deleted afterwards by hand.
rem ============================================================
setlocal
cd /d "%~dp0"
echo === Agent light uninstaller ===
echo.

rem ---- 1. tell the board to go dark (best effort, daemon still alive) ----
where node >nul 2>nul && node "%~dp0send.js" off
timeout /t 1 /nobreak >nul

rem ---- 2. stop daemon processes running our daemon.py ----
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\" | Where-Object { $_.CommandLine -like '*daemon.py*' -and ($_.CommandLine -like '*cc-light*' -or $_.CommandLine -like '*ESP32\light*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'stopped pid ' + $_.ProcessId }"
echo [1/3] Daemon stopped.

rem ---- 3. delete autostart task ----
schtasks /Delete /TN "CC-Light-Daemon" /F >nul 2>nul
if errorlevel 1 (echo [2/3] Autostart task not found.) else (echo [2/3] Autostart task deleted.)

rem ---- 4. remove hooks (Claude Code, then Codex CLI) ----
where node >nul 2>nul && node "%~dp0install-hooks.js" --remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --codex-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --workbuddy-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --codebuddy-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --cursor-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --dsh-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --hermes-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --gemini-remove
where node >nul 2>nul && node "%~dp0install-hooks.js" --qwen-remove
echo [3/3] Hooks removed (if they were installed).

echo.
echo Uninstalled. You can delete this folder now.
echo (Board keeps its firmware; to reuse later just run cc-light-install.cmd again.)
pause
