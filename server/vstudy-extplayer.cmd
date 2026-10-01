@echo off
rem ============================================================
rem  Personal Workbench - external video player bridge setup
rem  Registers potplayer:// and vlc:// browser protocols (HKCU,
rem  per-user, no admin needed) for the "Open in PotPlayer / VLC"
rem  buttons on the Video Study and Video Center pages.
rem  Auto-detects installed players (standard folders first, then a
rem  registry fallback), writes small handler scripts that strip the
rem  protocol prefix and pass the server URL straight to the player.
rem  Run again anytime to refresh. Use "/remove" to uninstall.
rem  NOTE: a browser only knows protocols registered here. For a
rem  player that is not installed the matching button stays silently
rem  dead - clicking an unknown protocol does nothing at all.
rem ============================================================
setlocal
echo === Workbench external video player bridge ===
echo.
set "HDIR=%LOCALAPPDATA%\personal-workbench"
if not exist "%HDIR%" mkdir "%HDIR%"

if /i "%~1"=="/remove" goto remove

rem ---- detect installed players ----
rem Standard folders first (fast), then the registry as a fallback.
rem Real-world case: PotPlayer's default install dir is
rem %ProgramFiles%\DAUM\PotPlayer, which a plain
rem %ProgramFiles%\PotPlayer probe misses - the script then found
rem nothing, registered nothing and exited without making that clear.
set "POT="
if exist "%ProgramFiles%\PotPlayer\PotPlayerMini64.exe" set "POT=%ProgramFiles%\PotPlayer\PotPlayerMini64.exe"
if not defined POT if exist "%ProgramFiles(x86)%\PotPlayer\PotPlayerMini64.exe" set "POT=%ProgramFiles(x86)%\PotPlayer\PotPlayerMini64.exe"
if not defined POT if exist "%ProgramFiles%\DAUM\PotPlayer\PotPlayerMini64.exe" set "POT=%ProgramFiles%\DAUM\PotPlayer\PotPlayerMini64.exe"
if not defined POT if exist "%ProgramFiles(x86)%\DAUM\PotPlayer\PotPlayerMini64.exe" set "POT=%ProgramFiles(x86)%\DAUM\PotPlayer\PotPlayerMini64.exe"
if not defined POT call :apppath PotPlayerMini64.exe POT
set "VLC="
if exist "%ProgramFiles%\VideoLAN\VLC\vlc.exe" set "VLC=%ProgramFiles%\VideoLAN\VLC\vlc.exe"
if not defined VLC if exist "%ProgramFiles(x86)%\VideoLAN\VLC\vlc.exe" set "VLC=%ProgramFiles(x86)%\VideoLAN\VLC\vlc.exe"
if not defined VLC call :apppath vlc.exe VLC

if not defined POT if not defined VLC goto nonefound

if not defined POT goto nopot

rem ---- PotPlayer: handler + HKCU protocol ----
rem The handler strips the "potplayer:" prefix with a PLAIN set, never `call set`:
rem call re-parses the substituted value and batch context expands undefined
rem %E4%-style tokens to nothing - that silently destroys percent-encoded URLs,
rem i.e. every non-ASCII (Chinese) file name, and the player then opens a 404.
>"%HDIR%\potplayer-open.cmd" echo @echo off
>>"%HDIR%\potplayer-open.cmd" echo setlocal
>>"%HDIR%\potplayer-open.cmd" echo set "u=%%~1"
>>"%HDIR%\potplayer-open.cmd" echo set "u=%%u:potplayer:=%%"
>>"%HDIR%\potplayer-open.cmd" echo start "" "%POT%" "%%u%%"
reg add "HKCU\Software\Classes\potplayer" /ve /d "URL:PotPlayer" /f >nul
reg add "HKCU\Software\Classes\potplayer" /v "URL Protocol" /f >nul
reg add "HKCU\Software\Classes\potplayer\shell\open\command" /ve /d "\"%HDIR%\potplayer-open.cmd\" \"%%1\"" /f >nul
echo [OK] potplayer:// registered -^> %POT%
goto vlcpart

:nopot
echo [!] PotPlayer not found - the "PotPlayer" button will do nothing.
echo     Install it, then run this script again.

:vlcpart
if not defined VLC goto novlc
>"%HDIR%\vlc-open.cmd" echo @echo off
>>"%HDIR%\vlc-open.cmd" echo setlocal
>>"%HDIR%\vlc-open.cmd" echo set "u=%%~1"
>>"%HDIR%\vlc-open.cmd" echo set "u=%%u:vlc:=%%"
>>"%HDIR%\vlc-open.cmd" echo start "" "%VLC%" "%%u%%"
reg add "HKCU\Software\Classes\vlc" /ve /d "URL:VLC" /f >nul
reg add "HKCU\Software\Classes\vlc" /v "URL Protocol" /f >nul
reg add "HKCU\Software\Classes\vlc\shell\open\command" /ve /d "\"%HDIR%\vlc-open.cmd\" \"%%1\"" /f >nul
echo [OK] vlc:// registered -^> %VLC%
goto done

:novlc
echo [!] VLC not found - the "VLC" button will do nothing.
echo     Install it from https://www.videolan.org and run this script again.
goto done

:nonefound
echo [X] PotPlayer / VLC not found in the standard folders or the registry.
echo     Install one of them first, then run this script again.
pause
exit /b 1

:remove
reg delete "HKCU\Software\Classes\potplayer" /f >nul 2>nul
reg delete "HKCU\Software\Classes\vlc" /f >nul 2>nul
del /q "%HDIR%\potplayer-open.cmd" >nul 2>nul
del /q "%HDIR%\vlc-open.cmd" >nul 2>nul
echo [OK] potplayer:// and vlc:// protocols removed.
pause
exit /b 0

:done
echo.
echo Done! Open the workbench Video Study / Video Center page and click
echo "PotPlayer" or "VLC" on a video. The browser will ask "Open ...?",
echo click Open. HEVC 10bit 4K plays via the player's own decoder.
pause
exit /b 0

rem ---- registry fallback: resolve an installed player's exe path ----
rem %1 = exe file name, %2 = output variable name. Reads App Paths first,
rem then HKCR\Applications\<exe>\shell\open\command. Returns empty when the
rem player is not installed. Needed because players do not always land in
rem the folders probed above (PotPlayer -> DAUM, custom install directories).
:apppath
setlocal enabledelayedexpansion
set "ln="
for /f "tokens=2*" %%A in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%~1" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "ln=%%B"
if not defined ln for /f "tokens=2*" %%A in ('reg query "HKCR\Applications\%~1\shell\open\command" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "ln=%%B"
if not defined ln ( endlocal & exit /b 1 )
set "ln=!ln:*"=!"
set "ln=!ln:"=|!"
set "p="
for /f "tokens=1 delims=|" %%C in ("!ln!") do set "p=%%C"
if not defined p ( endlocal & exit /b 1 )
if not exist "!p!" ( endlocal & exit /b 1 )
endlocal & set "%~2=%p%"
exit /b 0
