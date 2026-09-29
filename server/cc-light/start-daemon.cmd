@echo off
rem CC-LIGHT 守护进程一键启动（双击即可）
rem 优先用 PATH 里的 pythonw（无黑窗），找不到再试本机固定安装路径；路径都不对时
rem 请把下一行的 Python 路径改成你的安装位置。
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw "%~dp0daemon.py"
) else (
  start "" "C:\Users\W\AppData\Local\Programs\Python\Python312\pythonw.exe" "%~dp0daemon.py"
)
