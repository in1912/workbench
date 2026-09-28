@echo off
chcp 65001 >nul
title 小米摄像头凭证 · 本地登录注入
cd /d "%~dp0.."
"C:\Users\W\.workbuddy\binaries\node\versions\22.22.2\node.exe" scripts\micloud-login-tool.cjs
pause
