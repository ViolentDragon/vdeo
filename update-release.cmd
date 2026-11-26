@echo off
pushd "%~dp0" || exit /b 1
call npm.cmd run update
set "release_exit=%errorlevel%"
popd
pause
exit /b %release_exit%
