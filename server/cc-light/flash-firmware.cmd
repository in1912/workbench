@echo off
rem ============================================================
rem  CC-LIGHT / Agent light - FLASH FIRMWARE (one click)
rem  Keep this file in the same folder as main.py and the
rem  firmware .bin (the cc-light folder from the zip).
rem  Connect the board with a USB DATA cable, double-click.
rem  Does: 1) find Python  2) install esptool + mpremote
rem           (offline from wheels\ if present, else network)
rem        3) ask COM port  4) erase flash
rem        5) write MicroPython  6) upload main.py  7) reset
rem ============================================================
setlocal
cd /d "%~dp0"
echo === Agent light firmware flasher ===
echo.

rem ---- 1. find python ----
set "PY="
where python >nul 2>nul && for /f "delims=" %%i in ('where python') do set "PY=%%i"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY (
  echo [X] python not found. Install Python 3.9+ (64-bit) first, then run this again.
  pause & exit /b 1
)
echo [1/6] Python found: %PY%

rem ---- 2. esptool + mpremote (offline wheels first, network fallback) ----
if exist "wheels\*.whl" (
  "%PY%" -m pip install -q --no-index --find-links wheels esptool mpremote 2>nul
)
"%PY%" -c "import esptool, mpremote" >nul 2>nul
if errorlevel 1 (
  echo [2/6] Installing esptool + mpremote from network ...
  "%PY%" -m pip install -q esptool mpremote
  "%PY%" -c "import esptool, mpremote" >nul 2>nul || (echo [X] esptool/mpremote install failed. & pause & exit /b 1)
) else (
  echo [2/6] esptool + mpremote ready.
)

rem ---- 3. COM port ----
echo.
echo Plug the board in with a USB DATA cable (charge-only cables do not work).
echo Device Manager should list it as "USB Serial Device (COMx)".
echo Detected serial ports:
powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames()"
echo.
set "COM="
set /p COM=Enter COM port (e.g. COM3):
if "%COM%"=="" (echo [X] no COM port given. & pause & exit /b 1)

echo.
echo [3/6] This ERASES the board and flashes MicroPython on %COM%.
set "GO="
set /p GO=Continue? [Y/N]:
if /i not "%GO%"=="Y" (echo Aborted, nothing was changed. & pause & exit /b 1)

echo [4/6] Erasing flash ...
"%PY%" -m esptool --chip esp32c3 --port %COM% erase_flash
if errorlevel 1 (
  echo [X] erase failed. If it keeps printing "Connecting...":
  echo     hold BOOT, tap RST once, release BOOT, then run this again.
  pause & exit /b 1
)

echo [5/6] Writing MicroPython firmware (about 30s) ...
"%PY%" -m esptool --chip esp32c3 --port %COM% --baud 921600 write_flash 0x0 "%~dp0ESP32_GENERIC_C3-20260824-v1.29.0.bin"
if errorlevel 1 (echo [X] write failed. & pause & exit /b 1)

echo [6/6] Uploading main.py and rebooting the board ...
"%PY%" -m mpremote connect %COM% cp "%~dp0main.py" :main.py
"%PY%" -m mpremote connect %COM% exec "import machine; machine.reset()"

echo.
echo Done! The board now: self-test blink R - Y - G, then demo cycle.
echo You can unplug it now and power it from any USB charger.
echo Next: double-click cc-light-install.cmd to link it to Claude Code.
pause
