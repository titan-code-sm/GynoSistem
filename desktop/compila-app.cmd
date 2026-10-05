@echo off
rem Ricompila MED System Gineco su questo PC dalla versione attuale di index.html.
rem L'installer finisce in C:MEDSystemBuild	argeteleaseundle
sis
cd /d "%~dp0"
if not exist "C:MEDSystemBuild	ools
ode_modules@tauri-appscli" (
  mkdir "C:MEDSystemBuild	ools" 2>nul
  copy /y package.json "C:MEDSystemBuild	ools" >nul
  copy /y package-lock.json "C:MEDSystemBuild	ools" >nul
  pushd "C:MEDSystemBuild	ools" && call npm ci && popd
)
node scriptsprepara-app.mjs || goto errore
set CARGO_TARGET_DIR=C:MEDSystemBuild	arget
set PATH=%USERPROFILE%.cargoin;%PATH%
node "C:MEDSystemBuild	ools
ode_modules@tauri-appscli	auri.js" build || goto errore
explorer "C:MEDSystemBuild	argeteleaseundle
sis"
exit /b 0
:errore
echo.
echo Compilazione non riuscita: controlla i messaggi qui sopra.
pause
exit /b 1
