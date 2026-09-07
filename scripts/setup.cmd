@echo off
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
cd /d "%ROOT%"

git submodule update --init --recursive
if errorlevel 1 exit /b %errorlevel%

call "%ROOT%\scripts\build-swmm.cmd"
if errorlevel 1 exit /b %errorlevel%

node "%ROOT%\scripts\preflight.js"
exit /b %errorlevel%
