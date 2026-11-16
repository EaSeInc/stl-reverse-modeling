@echo off
rem Просмотрщик как фоновая служба: поднимает сервер, если порт 9131 свободен.
rem Запускается при входе и сторожем из планировщика.
setlocal
set "REPO=%~dp0.."
set "PORT=9131"
set "PY=C:\Users\boot8\tools\meshrev\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python.exe"

rem уже слушает — ничего не делаем
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1 && exit /b 0

if not exist "%REPO%\logs" mkdir "%REPO%\logs"
set "PYTHONIOENCODING=utf-8"
cd /d "%REPO%"
start "" /b "%PY%" -u viewer\server.py --port %PORT% --root C:/Users/boot8/cad >> "%REPO%\logs\server.log" 2>&1
exit /b 0
