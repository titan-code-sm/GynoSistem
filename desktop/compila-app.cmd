@echo off
rem Ricompila MED System su questo PC dalla versione attuale di index.html.
rem   compila-app.cmd          ->  MED System Gineco (ginecologia e ostetricia)
rem   compila-app.cmd base     ->  MED System (versione base, tutte le specialita')
rem L'installer finisce in C:\MEDSystemBuild\target\release\bundle\nsis
cd /d "%~dp0"
set MODELLO=%1
if "%MODELLO%"=="" set MODELLO=gineco
set CONFIG_EXTRA=
if /i "%MODELLO%"=="base" set CONFIG_EXTRA=--config src-tauri\tauri.base.conf.json
if not exist "C:\MEDSystemBuild\tools\node_modules\@tauri-apps\cli" (
  mkdir "C:\MEDSystemBuild\tools" 2>nul
  copy /y package.json "C:\MEDSystemBuild\tools\" >nul
  copy /y package-lock.json "C:\MEDSystemBuild\tools\" >nul
  pushd "C:\MEDSystemBuild\tools" && call npm ci && popd
)
node scripts\prepara-app.mjs %MODELLO% || goto errore
set CARGO_TARGET_DIR=C:\MEDSystemBuild\target
set PATH=%USERPROFILE%\.cargo\bin;%PATH%
node "C:\MEDSystemBuild\tools\node_modules\@tauri-apps\cli\tauri.js" build %CONFIG_EXTRA% || goto errore
explorer "C:\MEDSystemBuild\target\release\bundle\nsis"
exit /b 0
:errore
echo.
echo Compilazione non riuscita: controlla i messaggi qui sopra.
pause
exit /b 1
