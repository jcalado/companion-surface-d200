@echo off
setlocal
set "PATH=%~dp0;%PATH%"
set "ADB=%~dp0adb.exe"
node "%~dp0fix-keymode.mjs" %*
endlocal
