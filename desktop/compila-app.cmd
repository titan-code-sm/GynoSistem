@echo off
rem Ricompila MED System Gineco su questo PC dalla versione attuale di index.html.
rem L'installer finisce in C:\MEDSystemBuild\target\release\bundle\nsis
cd /d "%~dp0"
if not exist "C:\MEDSystemBuild\tools\node_modules\@tauri-apps\cli" (
  mkdir "C:\MEDSystemBuild\tools" 2>nul
  copy /y package.json "C:\MEDSystemBuild\tools\" >nul
  copy /y package-lock.json "C:\MEDSystemBuild\tools\" >nul
  pushd "C:\MEDSystemBuild\tools" && call npm ci && popd
)
node scripts\prepara-app.mjs || goto errore
set CARGO_TARGET_DIR=C:\MEDSystemBuild\target
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
node "C:\MEDSystemBuild\tools\node_modules\@tauri-apps\cli\tauri.js" build || goto errore
explorer "C:\MEDSystemBuild\target\release\bundle\nsis"
exit /b 0
:errore
echo.
echo Compilazione non riuscita: controlla i messaggi qui sopra.
pause
exit /b 1
