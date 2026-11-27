@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not exist "node_modules\.bin\vite.cmd" (
  call npm.cmd ci
  if errorlevel 1 goto finish
)
call npm.cmd run start:browser
:finish
set "browser_exit=%errorlevel%"
popd
if not "%browser_exit%"=="0" pause
exit /b %browser_exit%
