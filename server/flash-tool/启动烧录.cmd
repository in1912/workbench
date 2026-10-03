@echo off
chcp 65001 >nul
title 智能家居烧录工具包
cd /d "%~dp0"

echo.
echo   ============================================================
echo     智能家居烧录工具包
echo   ============================================================
echo.
echo   即将启动本地烧录网页（会自动打开浏览器）...
echo   如果浏览器没弹出来，看下面提示的地址，手动复制到 Edge / Chrome 打开。
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 PowerShell，无法启动本地服务。
  echo          请在 Windows 10/11 上运行本工具包。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Root "%~dp0"
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo   [提示] 本地服务已退出（代码 %EXITCODE%）。
) else (
  echo   本地服务已停止。
)
echo.
pause
