@echo off
rem Calorie Quest: start the dev app from any terminal.
rem   dev.cmd          install deps (first time) and run `npm run tauri dev`
rem   dev.cmd --check  only report which npm would be used
rem Uses npm from PATH when available; otherwise looks for an fnm-managed Node,
rem including one that a packaged app installed into its virtualized AppData.
setlocal
set "NODE_DIR="
where npm >nul 2>&1
if %errorlevel%==0 goto :found

for /d %%d in ("%APPDATA%\fnm\node-versions\v*") do set "NODE_DIR=%%d\installation"
if not defined NODE_DIR (
  for /d %%p in ("%LOCALAPPDATA%\Packages\Claude_*") do (
    for /d %%d in ("%%p\LocalCache\Roaming\fnm\node-versions\v*") do set "NODE_DIR=%%d\installation"
  )
)
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"
where npm >nul 2>&1
if not %errorlevel%==0 (
  echo npm not found. Install Node.js first:  winget install OpenJS.NodeJS.LTS
  exit /b 1
)

:found
if "%~1"=="--check" (
  echo NODE_DIR=%NODE_DIR%
  call npm --version
  exit /b 0
)
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run tauri dev
