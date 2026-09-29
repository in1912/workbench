@echo off
rem CC-LIGHT daemon manual start (double-click; not needed if autostart registered)
rem Prefers pythonw from PATH (no console window), falls back to a common install path.
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw "%~dp0daemon.py"
) else (
  start "" "%LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe" "%~dp0daemon.py"
)
