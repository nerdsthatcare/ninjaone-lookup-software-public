@echo off
REM ============================================================
REM  Build NinjaSoftwareLookup.exe + installer
REM  Run on Windows. Requires:
REM    - Go 1.21+         https://go.dev/dl/
REM    - Inno Setup 6     https://jrsoftware.org/isdl.php   (for the installer)
REM    - goversioninfo    auto-installed by this script     (for EXE icon + version info)
REM  Optional:
REM    - signtool.exe     from the Windows SDK              (for code signing)
REM      Set CODESIGN_PFX and CODESIGN_PASS env vars to sign automatically.
REM ============================================================

setlocal EnableDelayedExpansion
cd /d "%~dp0"

where go >nul 2>&1
if errorlevel 1 (
    echo Go is not installed or not on PATH.
    echo Install Go 1.21+ from https://go.dev/dl/ and try again.
    pause
    exit /b 1
)

REM ---- [1/3] Embed icon + version info into the EXE -----------
echo [1/3] Preparing version-info resource ...
where goversioninfo >nul 2>&1
if errorlevel 1 (
    echo     Installing goversioninfo ...
    go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
    if errorlevel 1 (
        echo     *** Failed to install goversioninfo. Building without embedded icon. ***
        goto :skipversioninfo
    )
    REM Make sure the freshly-installed binary is on PATH for this run.
    set "PATH=%USERPROFILE%\go\bin;%PATH%"
)
goversioninfo -platform-specific=true -o resource.syso versioninfo.json
if errorlevel 1 (
    echo     *** goversioninfo failed. Building without embedded icon. ***
)
:skipversioninfo

REM ---- [2/3] Compile the Go binary ----------------------------
echo.
echo [2/3] Building NinjaSoftwareLookup.exe ...
set CGO_ENABLED=0
REM Note: we deliberately do NOT pass "-s -w" (symbol/debug strip).
REM Stripped Go binaries trip heuristic AV (Trend Vision One, SmartScreen, etc.)
REM more aggressively than un-stripped ones. The size cost is ~30%, well worth it.
go build -trimpath -ldflags "-H=windowsgui" -o NinjaSoftwareLookup.exe .
if errorlevel 1 (
    echo.
    echo *** Go build failed. ***
    pause
    exit /b 1
)
echo     Done: NinjaSoftwareLookup.exe

REM ---- Optional: sign the EXE ---------------------------------
call :signfile "NinjaSoftwareLookup.exe"

REM ---- [3/3] Build the installer ------------------------------
echo.
echo [3/3] Building installer ...

call :findiscc
if "%ISCC%"=="" (
    echo     Inno Setup not found - skipping installer.
    echo     Checked: PATH, Program Files (x86^), Program Files, %%LocalAppData%%,
    echo              and the Inno Setup registry keys for versions 5 and 6.
    echo     To build a setup.exe, install from https://jrsoftware.org/isdl.php
    echo.
    echo Done. EXE ready: NinjaSoftwareLookup.exe
    pause
    exit /b 0
)
echo     Using: %ISCC%

if not exist "dist" mkdir "dist"
"%ISCC%" installer.iss
if errorlevel 1 (
    echo.
    echo *** Installer build failed. ***
    pause
    exit /b 1
)

REM ---- Optional: sign the setup.exe ---------------------------
call :signfile "dist\NinjaSoftwareLookup-Setup-1.0.0.exe"

echo.
echo ============================================================
echo  Build complete.
echo    EXE:        NinjaSoftwareLookup.exe
echo    Installer:  dist\NinjaSoftwareLookup-Setup-1.0.0.exe
echo ============================================================
pause
exit /b 0


REM ============================================================
REM  :findiscc  —  Locate ISCC.exe (the Inno Setup compiler).
REM  Sets the ISCC variable. Leaves it empty if not found.
REM  Search order:
REM    1. PATH                             (where ISCC.exe)
REM    2. Common install dirs for v5 and v6 in:
REM         %ProgramFiles(x86)%, %ProgramFiles%, %LocalAppData%\Programs
REM    3. Registry uninstall keys (HKLM 64/32-bit + HKCU)
REM ============================================================
:findiscc
set "ISCC="

REM 1. PATH lookup
for /f "delims=" %%I in ('where ISCC.exe 2^>nul') do (
    if "!ISCC!"=="" set "ISCC=%%I"
)
if not "%ISCC%"=="" exit /b 0

REM 2. Common install locations
for %%V in (6 5) do (
    for %%R in ("%ProgramFiles(x86)%" "%ProgramFiles%" "%LocalAppData%\Programs") do (
        if exist "%%~R\Inno Setup %%V\ISCC.exe" (
            set "ISCC=%%~R\Inno Setup %%V\ISCC.exe"
            exit /b 0
        )
    )
)

REM 3. Registry — Inno Setup writes InstallLocation under its uninstall key.
for %%K in (
    "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1"
    "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1"
    "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 5_is1"
    "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 5_is1"
    "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1"
    "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 5_is1"
) do (
    for /f "tokens=2,*" %%A in ('reg query %%K /v InstallLocation 2^>nul ^| findstr /i InstallLocation') do (
        if exist "%%B\ISCC.exe" (
            set "ISCC=%%B\ISCC.exe"
            exit /b 0
        )
        if exist "%%BISCC.exe" (
            set "ISCC=%%BISCC.exe"
            exit /b 0
        )
    )
)
exit /b 0


REM ============================================================
REM  :signfile  —  Authenticode-sign a file if a cert is configured.
REM  Set these environment variables before running build.bat:
REM    CODESIGN_PFX   = path to your .pfx certificate
REM    CODESIGN_PASS  = the certificate password
REM  Otherwise this step is silently skipped.
REM ============================================================
:signfile
if "%CODESIGN_PFX%"=="" exit /b 0
if not exist "%CODESIGN_PFX%" (
    echo     [sign] cert not found at %CODESIGN_PFX% - skipping
    exit /b 0
)
set "SIGNTOOL=signtool.exe"
where %SIGNTOOL% >nul 2>&1
if errorlevel 1 (
    echo     [sign] signtool.exe not on PATH - skipping
    exit /b 0
)
echo     [sign] Signing %~1 ...
%SIGNTOOL% sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
    /f "%CODESIGN_PFX%" /p "%CODESIGN_PASS%" ^
    /d "NinjaOne Software Lookup" "%~1"
if errorlevel 1 (
    echo     [sign] *** Signing failed for %~1 ***
)
exit /b 0
