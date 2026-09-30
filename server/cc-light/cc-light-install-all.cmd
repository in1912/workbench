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
