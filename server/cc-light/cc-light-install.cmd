@echo off
rem ============================================================
rem  CC-LIGHT / Agent light - INSTALL (Windows)
rem  Put this file in the same folder as daemon.py (the cc-light
rem  folder from the zip), then double-click.
rem  Does: 1) find Python  2) pip install bleak (if missing)
rem        3) register logon autostart task "CC-Light-Daemon"
rem        4) start the daemon now
rem        5) Claude Code hooks   6) Codex CLI hooks
rem        7) WorkBuddy plugin    8) CodeBuddy hooks
rem        9) Cursor hooks       10) DeepSeek Harness plugin
rem       11) Hermes plugin      12) Gemini CLI hooks
rem       13) Qwen Code hooks
rem  (steps 5-13 are optional, ask Y/N one by one)
rem ============================================================
setlocal
cd /d "%~dp0"
echo === Agent light installer (9 agents) ===
echo.

rem ---- 1. find pythonw ----
set "PYW="
where pythonw >nul 2>nul && for /f "delims=" %%i in ('where pythonw') do set "PYW=%%i"
if not defined PYW for %%v in (313 312 311 310 39) do if not defined PYW if exist "%LOCALAPPDATA%\Programs\Python\Python%%v\pythonw.exe" set "PYW=%LOCALAPPDATA%\Programs\Python\Python%%v\pythonw.exe"
if not defined PYW (
  echo [X] pythonw not found. Install Python 3.9+ ^(64-bit^) first, then run this again.
  pause & exit /b 1
)
echo [1/13] Python found: %PYW%

rem ---- 2. bleak dependency (offline wheels first, network fallback) ----
set "PY=%PYW:pythonw.exe=python.exe%"
"%PY%" -c "import bleak" >nul 2>nul
if errorlevel 1 (
  echo [2/13] Installing bleak ...
  if exist "wheels\*.whl" "%PY%" -m pip install -q --no-index --find-links wheels bleak 2>nul
  "%PY%" -c "import bleak" >nul 2>nul
  if errorlevel 1 (
    "%PY%" -m pip install -q bleak
    "%PY%" -c "import bleak" >nul 2>nul || (echo [X] bleak install failed, check network. & pause & exit /b 1)
  )
) else (
  echo [2/13] bleak OK
)

rem ---- 3. register logon autostart task ----
schtasks /Create /F /TN "CC-Light-Daemon" /TR "\"%PYW%\" \"%~dp0daemon.py\"" /SC ONLOGON /RL LIMITED >nul
if errorlevel 1 (
  echo [!] schtasks failed, will still try to start the daemon now.
) else (
  echo [3/13] Autostart task registered: CC-Light-Daemon
)

rem ---- 4. start daemon now ----
tasklist /FI "IMAGENAME eq pythonw.exe" | "%SystemRoot%\System32\find.exe" /i "pythonw" >nul && netstat -ano | "%SystemRoot%\System32\find.exe" "127.0.0.1:7878" >nul && (
  echo [4/13] Daemon seems already running.
) || (
  start "" "%PYW%" "%~dp0daemon.py"
  echo [4/13] Daemon started.
)

rem ---- 5. Claude Code hooks (optional, needs Node.js) ----
where node >nul 2>nul
if errorlevel 1 (
  echo [5/13] Node.js not found, skip Claude Code hooks.
  goto codex_hooks
)
set "HOOKS="
set /p HOOKS=Also install Claude Code hooks? [Y/N]:
if /i "%HOOKS%"=="Y" node "%~dp0install-hooks.js"
:codex_hooks

rem ---- 6. Codex CLI hooks (optional; .codex folder exists = Codex installed) ----
where node >nul 2>nul
if errorlevel 1 (
  echo [6/13] Node.js not found, skip Codex hooks.
  goto wb_hooks
)
if not exist "%USERPROFILE%\.codex" (
  echo [6/13] Codex CLI not detected ^(.codex folder missing^), skip.
  goto wb_hooks
)
set "CXHOOKS="
set /p CXHOOKS=Also install Codex CLI hooks? [Y/N]:
if /i "%CXHOOKS%"=="Y" node "%~dp0install-hooks.js" --codex
echo   ^(Codex hooks need one-time trust: run codex, type /hooks, Trust.^)

rem ---- 7. WorkBuddy plugin hooks (optional; .workbuddy\plugins = WorkBuddy) ----
:wb_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [7/13] Node.js not found, skip WorkBuddy hooks.
  goto codebuddy_hooks
)
if not exist "%USERPROFILE%\.workbuddy\plugins\installed_plugins.json" (
  echo [7/13] WorkBuddy not detected ^(.workbuddy folder missing^), skip.
  goto codebuddy_hooks
)
set "WBHOOKS="
set /p WBHOOKS=Also install WorkBuddy plugin hooks? [Y/N]:
if /i "%WBHOOKS%"=="Y" node "%~dp0install-hooks.js" --workbuddy
echo   ^(WorkBuddy needs a full restart to load the plugin.^)

rem ---- 8. CodeBuddy Code hooks (optional; .codebuddy folder = CodeBuddy) ----
:codebuddy_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [8/13] Node.js not found, skip CodeBuddy hooks.
  goto cursor_hooks
)
if not exist "%USERPROFILE%\.codebuddy" (
  echo [8/13] CodeBuddy not detected ^(.codebuddy folder missing^), skip.
  goto cursor_hooks
)
set "CBHOOKS="
set /p CBHOOKS=Also install CodeBuddy Code hooks? [Y/N]:
if /i "%CBHOOKS%"=="Y" node "%~dp0install-hooks.js" --codebuddy
echo   ^(CodeBuddy hooks load on new codebuddy session; /hooks lists them.^)

rem ---- 9. Cursor hooks (optional; .cursor folder exists = Cursor 1.7+) ----
:cursor_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [9/13] Node.js not found, skip Cursor hooks.
  goto dsh_hooks
)
if not exist "%USERPROFILE%\.cursor" (
  echo [9/13] Cursor not detected ^(.cursor folder missing^), skip.
  goto dsh_hooks
)
set "CUHOOKS="
set /p CUHOOKS=Also install Cursor hooks? [Y/N]:
if /i "%CUHOOKS%"=="Y" node "%~dp0install-hooks.js" --cursor
echo   ^(Cursor auto-reloads hooks.json, no restart needed.^)

rem ---- 10. DeepSeek Harness plugin (optional; dsh command on PATH) ----
:dsh_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [10/13] Node.js not found, skip DeepSeek Harness plugin.
  goto hermes_hooks
)
where dsh >nul 2>nul
if errorlevel 1 (
  echo [10/13] DeepSeek Harness not detected ^(dsh command missing^), skip.
  echo    ^(Install first: npm install -g @deepseek-ai/dsh, run dsh web once.^)
  goto hermes_hooks
)
set "DSHHOOKS="
set /p DSHHOOKS=Also install DeepSeek Harness ^(dsh^) plugin? [Y/N]:
if /i "%DSHHOOKS%"=="Y" node "%~dp0install-hooks.js" --dsh
echo   ^(Restart dsh ^(dsh web^) to load the plugin.^)

rem ---- 11. Hermes Agent plugin (optional; .hermes folder = Hermes) ----
:hermes_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [11/13] Node.js not found, skip Hermes plugin.
  goto gemini_hooks
)
if not exist "%USERPROFILE%\.hermes" (
  echo [11/13] Hermes not detected ^(.hermes folder missing^), skip.
  goto gemini_hooks
)
set "HMHOOKS="
set /p HMHOOKS=Also install Hermes Agent plugin? [Y/N]:
if /i "%HMHOOKS%"=="Y" node "%~dp0install-hooks.js" --hermes

rem ---- 12. Gemini CLI hooks (optional; .gemini folder = Gemini CLI) ----
:gemini_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [12/13] Node.js not found, skip Gemini CLI hooks.
  goto qwen_hooks
)
if not exist "%USERPROFILE%\.gemini" (
  echo [12/13] Gemini CLI not detected ^(.gemini folder missing^), skip.
  goto qwen_hooks
)
set "GMHOOKS="
set /p GMHOOKS=Also install Gemini CLI hooks? [Y/N]:
if /i "%GMHOOKS%"=="Y" node "%~dp0install-hooks.js" --gemini
echo   ^(New gemini sessions pick up hooks; check /hooks inside gemini.^)

rem ---- 13. Qwen Code hooks (optional; .qwen folder = Qwen Code) ----
:qwen_hooks
where node >nul 2>nul
if errorlevel 1 (
  echo [13/13] Node.js not found, skip Qwen Code hooks.
  goto verify
)
if not exist "%USERPROFILE%\.qwen" (
  echo [13/13] Qwen Code not detected ^(.qwen folder missing^), skip.
  goto verify
)
set "QWHOOKS="
set /p QWHOOKS=Also install Qwen Code hooks? [Y/N]:
if /i "%QWHOOKS%"=="Y" node "%~dp0install-hooks.js" --qwen
echo   ^(New qwen sessions pick up hooks; runs async, zero blocking.^)
:verify

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
echo Done. The light now follows Claude Code / Codex / WorkBuddy /
echo CodeBuddy / Cursor / DeepSeek Harness / Hermes / Gemini CLI /
echo Qwen Code (new sessions; Codex needs /hooks trust; WorkBuddy
echo and dsh need restart; Cursor auto-reloads).
echo Uninstall: double-click cc-light-uninstall.cmd
pause
