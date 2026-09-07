@echo off
setlocal EnableDelayedExpansion

set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "SWMM=%ROOT%\vendor\epa-swmm"
set "LOCAL_ZIG=%ROOT%\vendor\toolchain\zig-windows-x86_64-0.13.0\zig.exe"

if not exist "%SWMM%\src\solver" (
  echo EPA SWMM source is not initialized. Run: npm run setup
  exit /b 2
)

if not exist "%SWMM%\bin" mkdir "%SWMM%\bin"
set "sources="
for %%f in ("%SWMM%\src\solver\*.c") do set "sources=!sources! "%%~ff""

if exist "%LOCAL_ZIG%" (
  set "ZIG_GLOBAL_CACHE_DIR=%ROOT%\vendor\toolchain\zig-cache-global"
  set "ZIG_LOCAL_CACHE_DIR=%SWMM%\zig-cache-local"
  "%LOCAL_ZIG%" cc -O2 -I"%SWMM%\src\solver" -I"%SWMM%\src\solver\include" -o "%SWMM%\bin\runswmm.exe" !sources! "%SWMM%\src\run\main.c" -lm
  exit /b !errorlevel!
)

where clang >nul 2>nul
if %errorlevel%==0 (
  clang -O2 -I"%SWMM%\src\solver" -I"%SWMM%\src\solver\include" -o "%SWMM%\bin\runswmm.exe" !sources! "%SWMM%\src\run\main.c" -lm
  exit /b !errorlevel!
)

where gcc >nul 2>nul
if %errorlevel%==0 (
  gcc -O2 -I"%SWMM%\src\solver" -I"%SWMM%\src\solver\include" -o "%SWMM%\bin\runswmm.exe" !sources! "%SWMM%\src\run\main.c" -lm
  exit /b !errorlevel!
)

echo No supported C compiler was found. Install the bundled Zig toolchain, clang, or gcc.
exit /b 3
