@echo off
rem ============================================================
rem  Personal Workbench - external video player bridge setup
rem  Registers potplayer:// and vlc:// browser protocols (HKCU,
rem  per-user, no admin needed) for the Learning - Video Study
rem  page "Open in PotPlayer / VLC" buttons.
rem  Auto-detects installed players in standard folders, writes
rem  small handler scripts that strip the protocol prefix and
rem  pass the server URL straight to the player.
rem  Run again anytime to refresh. Use "/remove" to uninstall.
rem ============================================================
setlocal
echo === Workbench external video player bridge ===
echo.
set "HDIR=%LOCALAPPDATA%\personal-workbench"
if not exist "%HDIR%" mkdir "%HDIR%"

if /i "%~1"=="/remove" goto remove

rem ---- detect installed players ----
set "POT="
if exist "%ProgramFiles%\PotPlayer\PotPlayerMini64.exe" set "POT=%ProgramFiles%\PotPlayer\PotPlayerMini64.exe"
if not defined POT if exist "%ProgramFiles(x86)%\PotPlayer\PotPlayerMini64.exe" set "POT=%ProgramFiles(x86)%\PotPlayer\PotPlayerMini64.exe"
set "VLC="
if exist "%ProgramFiles%\VideoLAN\VLC\vlc.exe" set "VLC=%ProgramFiles%\VideoLAN\VLC\vlc.exe"
if not defined VLC if exist "%ProgramFiles(x86)%\VideoLAN\VLC\vlc.exe" set "VLC=%ProgramFiles(x86)%\VideoLAN\VLC\vlc.exe"

if not defined POT if not defined VLC goto nonefound

if not defined POT goto vlcpart

rem ---- PotPlayer: handler + HKCU protocol ----
>"%HDIR%\potplayer-open.cmd" echo @echo off
>>"%HDIR%\potplayer-open.cmd" echo setlocal
>>"%HDIR%\potplayer-open.cmd" echo set "u=%%~1"
>>"%HDIR%\potplayer-open.cmd" echo call set "u=%%u:potplayer:=%%"
>>"%HDIR%\potplayer-open.cmd" echo start "" "%POT%" "%%u%%"
reg add "HKCU\Software\Classes\potplayer" /ve /d "URL:PotPlayer" /f >nul
reg add "HKCU\Software\Classes\potplayer" /v "URL Protocol" /f >nul
reg add "HKCU\Software\Classes\potplayer\shell\open\command" /ve /d "\"%HDIR%\potplayer-open.cmd\" \"%%1\"" /f >nul
echo [OK] potplayer:// registered -^> %POT%

:vlcpart
if not defined VLC goto done
>"%HDIR%\vlc-open.cmd" echo @echo off
>>"%HDIR%\vlc-open.cmd" echo setlocal
>>"%HDIR%\vlc-open.cmd" echo set "u=%%~1"
>>"%HDIR%\vlc-open.cmd" echo call set "u=%%u:vlc:=%%"
>>"%HDIR%\vlc-open.cmd" echo start "" "%VLC%" "%%u%%"
reg add "HKCU\Software\Classes\vlc" /ve /d "URL:VLC" /f >nul
reg add "HKCU\Software\Classes\vlc" /v "URL Protocol" /f >nul
reg add "HKCU\Software\Classes\vlc\shell\open\command" /ve /d "\"%HDIR%\vlc-open.cmd\" \"%%1\"" /f >nul
echo [OK] vlc:// registered -^> %VLC%
goto done

:nonefound
echo [X] PotPlayer / VLC not found in standard install folders.
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
echo Done! Open the workbench Learning - Video Study page and click
echo "PotPlayer / VLC" on a video. The browser will ask "Open ...?",
echo click Open. HEVC 10bit 4K plays via the player's own decoder.
pause
