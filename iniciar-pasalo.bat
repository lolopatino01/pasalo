@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Pasalo

echo.
echo   Pasalo
echo   ======
echo.

rem "inicio" = lo arranca Windows al prender la compu, sin ventana: no abre el navegador ni espera una tecla.
set "INICIO="
if /i "%~1"=="inicio" set "INICIO=1"

rem Si ya esta andando (por ejemplo, porque arranco con Windows), solo abro el navegador.
rem 127.0.0.1 y no localhost: PowerShell prueba primero ::1 y tarda mas que el limite.
powershell -NoProfile -Command "try{$null=Invoke-WebRequest http://127.0.0.1:3000/health -UseBasicParsing -TimeoutSec 2; exit 0}catch{exit 1}"
if not errorlevel 1 (
  if not defined INICIO (
    echo Pasalo ya esta andando. Abro el navegador.
    start "" http://localhost:3000
    timeout /t 2 >nul
  )
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  ) else (
    echo Instalando Node.js. Si Windows pide permiso, acepta.
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  )
)
where node >nul 2>nul
if errorlevel 1 (
  echo No se pudo instalar Node.js. Bajalo de https://nodejs.org e intenta de nuevo.
  if not defined INICIO pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm install --no-audit --no-fund >install.log 2>&1
)
rem El zip de Releases viene armado y sin src: no hace falta compilar.
if exist src\ (
  echo Compilando la app...
  call npm run build >build.log 2>&1
  if errorlevel 1 echo (No se pudo compilar, uso la version que ya venia armada. Detalle en build.log)
)

rem Tailscale en Windows no conecta si su app no esta abierta: la abro, espero a que conecte y publico el puerto con https.
set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if exist "%TS%" (
  echo Conectando Tailscale...
  powershell -NoProfile -Command "if(-not (Get-Process tailscale-ipn -EA 0)){Start-Process '%ProgramFiles%\Tailscale\tailscale-ipn.exe'}; for($i=0;$i -lt 30;$i++){& '%TS%' status *> $null; if($LASTEXITCODE -eq 0){& '%TS%' serve --bg 3000 *> $null; exit 0}; Start-Sleep 1}; Write-Host 'Tailscale no conecto: abri la app Tailscale (icono al lado del reloj) y fijate que diga Connected. Por wifi igual anda.' -ForegroundColor Yellow"
) else (
  echo Tailscale no esta instalado: solo anda por wifi, sin https. Bajalo de https://tailscale.com/download
)

echo.
echo   Si Windows pregunta por el firewall, permiti el acceso en redes privadas.
echo   Deja esta ventana abierta mientras uses Pasalo. Cerrala para apagarlo.
echo.
if not defined INICIO start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://localhost:3000'"
powershell -NoProfile -Command "node server\index.js 2>&1 | Tee-Object -FilePath servidor.log -Append"
if not defined INICIO pause
