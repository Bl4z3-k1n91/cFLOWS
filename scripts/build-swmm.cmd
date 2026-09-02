@echo off
setlocal EnableDelayedExpansion
set "ZIG_GLOBAL_CACHE_DIR=D:\sih 2026\vendor\toolchain\zig-cache-global"
set "ZIG_LOCAL_CACHE_DIR=D:\sih 2026\vendor\epa-swmm\zig-cache-local"
cd /d "D:\sih 2026\vendor\epa-swmm"
if not exist bin mkdir bin
set "sources="
for %%f in (src\solver\*.c) do set "sources=!sources! %%f"
"D:\sih 2026\vendor\toolchain\zig-windows-x86_64-0.13.0\zig.exe" cc -O2 -Isrc\solver -Isrc\solver\include -o bin\runswmm.exe !sources! src\run\main.c -lm
exit /b %errorlevel%
