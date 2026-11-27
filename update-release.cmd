@echo off
setlocal
pushd "%~dp0" || exit /b 1
call npm.cmd run update -- --reauth-on-workflow-error
set "release_exit=%errorlevel%"
popd
pause
exit /b %release_exit%
