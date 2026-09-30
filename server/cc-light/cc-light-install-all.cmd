@echo off
rem ============================================================
rem  CC-LIGHT / Agent light - INSTALL ALL AGENT HOOKS (one shot)
rem  Detects every installed CLI (Claude Code / Codex / WorkBuddy /
rem  CodeBuddy / Cursor / DeepSeek Harness / Hermes / Gemini CLI /
rem  Qwen Code) and installs the light hooks for each - no Y/N
rem  prompts, missing CLIs are skipped. Nothing is uninstalled.
rem  Put this file next to install-hooks.js, then double-click.
rem ============================================================
setlocal
cd /d "%~dp0"
if not exist "%~dp0install-hooks.js" (
  echo [X] install-hooks.js not found next to this script.
  echo     This file must stay inside the cc-light folder - please download the
  echo     full cc-light.zip package from the workbench Agent light tab, extract
  echo     it, and run this script inside the extracted cc-light folder.
  pause & exit /b 1
)
where node >nul 2>nul || (
  echo [X] Node.js not found, cannot install hooks.
  pause & exit /b 1
)
echo === Agent light: install hooks for ALL detected agents ===
echo.
node "%~dp0install-hooks.js" --all
echo.
echo Reminders:
echo   Codex: open codex, type /hooks, arrow-select our hook, Trust, new session.
echo   WorkBuddy / dsh: fully restart them to load the hooks.
echo   Cursor / Gemini / Qwen / CodeBuddy: new session picks hooks up.
pause
