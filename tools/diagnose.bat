@echo off
setlocal
rem Wrapper: makes adb.exe (sitting next to this .bat) discoverable to
rem diagnose-identity.mjs, then runs the Node script.

set "PATH=%~dp0;%PATH%"
set "ADB=%~dp0adb.exe"

node "%~dp0diagnose-identity.mjs" %*
endlocal
